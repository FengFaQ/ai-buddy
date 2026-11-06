/**
 * The Host-side team runtime: the only file that actually creates, wakes, parks
 * and disposes AI sessions.
 *
 * Everything below `lib/core/` deliberately cannot touch Cordis, so the split is
 * absolute: `lib/core/team.js` decides *what should happen* to the roster, and
 * this file carries it out against real Host services. That is what keeps the
 * roster unit-testable while the side effects stay in one auditable place.
 *
 * Four operations, each with a failure mode worth naming:
 *
 *   spawn   create a session for a seat. A failure leaves `sessionId: null` and
 *           the seat `offline` — never a half-spawned seat.
 *   send    deliver a message into a member's conversation. Routing goes through
 *           the guarded delivery layer in `lib/host/messages.js` — `followup`
 *           for an idle member (open a turn), `steer` for a busy one (cut into
 *           the turn in progress) — and through `subagents.sendMessage` when the
 *           member is a continuable child: the first is how a peer "cuts in",
 *           the second is how a parent steers a child.
 *   sleep   park a member that is waiting on a human. The session is disposed so
 *           it stops costing anything, but the seat (and its session id) stay,
 *           which is what makes waking possible.
 *   wake    resume a parked member from its persisted session.
 *
 * Permission and model are inherited, not chosen: the profile's default policy
 * already applies to a fresh session, and copying the leader's model is what
 * makes a team behave consistently. This file therefore never calls
 * `approval.setPolicy`.
 */

import { randomUUID } from 'node:crypto'
import { clip, isNonEmptyString, asRecord, ensureDir } from '../util.js'
import { MessageLedger, createUserMessage, deliver } from '../core/messages.js'

const MESSAGE_ORIGIN = 'ai-buddy-team'

export function createTeamRuntime(ctx, deps) {
  const { store, config, log } = deps
  const { team: teamCore, feed } = deps.core

  /**
   * Every message id this runtime has already delivered, per conversation.
   *
   * The Host's durable inbox rejects a repeated id (`message "<id>" is already
   * pending`), and that rejection is raised *inside* the agent loop, where the
   * plugin cannot contain it — it kills the Host. The ledger makes a repeated
   * id impossible to mint rather than merely improbable.
   */
  const ledger = new MessageLedger()

  /**
   * `sessionId -> AgentHandle` for every agent this runtime created.
   *
   * The handle is the only thing that can release an agent on demand, so
   * without it a "sleeping" member keeps running. Entries are removed when the
   * handle is disposed, and the map dies with this runtime instance — which is
   * correct, because the agents it names die with the same plugin activation.
   */
  const handles = new Map()

  /** Live Host services, resolved lazily: a Host may assemble them late. */
  function services() {
    return {
      agents: ctx.get('agents'),
      agentLoop: ctx.get('agentLoop'),
      subagents: ctx.get('subagents'),
      workingDirectory: ctx.get('workingDirectory'),
      agentDefaultModel: ctx.get('agentDefaultModel'),
      workspaceRegistry: ctx.get('workspaceRegistry'),
    }
  }

  /**
   * Ensure the team's directory is a registered Workspace.
   *
   * Setting `meta.cwd` on the session is NOT enough to make DSH group the
   * session: the sidebar groups by the **workspace registry**, which indexes
   * sessions by canonical directory. A session whose cwd is a directory nobody
   * registered shows up as an ungrouped conversation — which is exactly what a
   * human sees as "this AI has no working directory".
   *
   * `workspaceRegistry.create()` is create-or-reuse: it canonicalises the path,
   * registers a workspace if none owns it, and returns the entity. Calling it on
   * every spawn is therefore safe and idempotent.
   *
   * **The directory itself is created first, if it does not exist.** This is
   * not tidiness — it is correctness. The Host resolves the session's working
   * directory when the first turn starts, and a missing directory ends that
   * turn with
   *
   *   working-directory: directory does not exist: "…"
   *
   * The session is created, the bootstrap prompt is delivered, and the turn
   * dies before the model ever sees it. The human sees a member that "started"
   * and then said nothing, with the real reason buried in a turn error.
   *
   * A human picking a directory in the setup page means "work here". Creating
   * that directory is the only sensible reading; refusing to work in a
   * directory that does not exist yet is not.
   */
  async function ensureWorkspace(path) {
    if (!isNonEmptyString(path)) return undefined
    try {
      ensureDir(path)
    } catch (error) {
      log?.(`ai-buddy team: could not create the team directory "${path}": ${error?.message ?? error}`)
      return undefined
    }
    const { workspaceRegistry } = services()
    if (workspaceRegistry === undefined || typeof workspaceRegistry.create !== 'function') {
      log?.('ai-buddy team: workspaceRegistry unavailable; sessions will not be grouped')
      return undefined
    }
    try {
      return await workspaceRegistry.create(path)
    } catch (error) {
      log?.(`ai-buddy team: could not register workspace "${path}": ${error?.message ?? error}`)
      return undefined
    }
  }

  /**
   * Resolve the model a new seat should run on.
   *
   * Two sources, in this order:
   *   1. the model the human picked when initializing the team — this is the
   *      documented contract: a human decides what the leader runs on;
   *   2. the deployment default (`agentDefaultModel`), used only when the human
   *      said nothing, so a team can still be created in a hurry.
   *
   * Members are NOT resolved independently: `spawn` copies the leader's model
   * into every member seat at creation time (see `addMember`), so the whole team
   * runs on one model unless the human changes it later.
   */
  function resolveModel(modelSelection) {
    const pinned = asRecord(modelSelection)
    if (isNonEmptyString(pinned.provider) && isNonEmptyString(pinned.model)) {
      return {
        provider: pinned.provider,
        model: pinned.model,
        ...(isNonEmptyString(pinned.reasoningEffort) ? { reasoningEffort: pinned.reasoningEffort } : {}),
      }
    }
    const { agentDefaultModel } = services()
    if (agentDefaultModel !== undefined && typeof agentDefaultModel.currentSelection === 'function') {
      try {
        const current = agentDefaultModel.currentSelection()
        if (isNonEmptyString(current?.provider) && isNonEmptyString(current?.model)) {
          return {
            provider: current.provider,
            model: current.model,
            ...(isNonEmptyString(current.reasoningEffort) ? { reasoningEffort: current.reasoningEffort } : {}),
          }
        }
      } catch (error) {
        log?.(`ai-buddy team: could not read the default model: ${error?.message ?? error}`)
      }
    }
    return undefined
  }

  /** The model to use for one specific seat: its own pin, else the team's. */
  function modelForSeat(teamState, seat) {
    const seatPin = asRecord(seat?.modelSelection)
    if (isNonEmptyString(seatPin.provider) && isNonEmptyString(seatPin.model)) {
      return resolveModel(seatPin)
    }
    return resolveModel(teamState?.leaderModel)
  }

  /** `Map<sessionId, {status}>` for the roster view. */
  function liveAgentMap() {
    const { agents } = services()
    const map = new Map()
    if (agents === undefined || typeof agents.list !== 'function') return map
    for (const agent of agents.list()) {
      if (!isNonEmptyString(agent?.id)) continue
      map.set(String(agent.id), { status: agent.status ?? 'idle', agent })
    }
    return map
  }

  function findAgent(sessionId) {
    const { agents } = services()
    if (agents === undefined || typeof agents.get !== 'function') return undefined
    return agents.get(sessionId)
  }

  /**
   * Wait for an agent to become visible in the registry.
   *
   * `agentLoop.resume` resolves after publishing, but the registry lookup is a
   * separate index that can lag by a tick or two. Polling a bounded number of
   * times is the difference between "the member woke up and got the message" and
   * "the member woke up, the message was dropped, and the human thinks @ is
   * broken".
   */
  async function waitForAgent(sessionId, attempts = 12, delayMs = 150) {
    if (!isNonEmptyString(sessionId)) return undefined
    for (let i = 0; i < attempts; i++) {
      const agent = findAgent(sessionId)
      if (agent !== undefined) return agent
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    return undefined
  }

  /**
   * Build the `UserMessage` the team delivers to a member.
   *
   * The shape is owned by `lib/host/messages.js`, which documents *why* every
   * field is mandatory: the Host keys its durable inbox by `message.id`
   * (`message "<id>" is already pending`) and its session validator requires an
   * identified message (`<subject> lacks an identified message`). Both faults
   * are raised inside the Host, past the plugin's own error handling, so they
   * take the whole process down.
   *
   * The Host's own `createUserMessage` would fill this in, but this plugin has
   * no import path to `@deepseek-ai/dsh-llm` — the bundled host packages live
   * inside the DSH installation, not in the profile's `node_modules`, so a
   * profile plugin cannot resolve them. The shape is therefore replicated
   * faithfully (UUID v4 identity, `role`, content blocks, `source.kind`).
   */
  function makeMessage(text, from, conversationId) {
    const message = createUserMessage(text, `${MESSAGE_ORIGIN}:${from ?? 'system'}`)
    // The ledger is the last line of defence against a repeated id: if this
    // conversation already carries this identity, mint a fresh one rather than
    // hand the Host a duplicate.
    const key = isNonEmptyString(conversationId) ? conversationId : 'unknown'
    if (ledger.has(key, message.id)) {
      return createUserMessage(text, `${MESSAGE_ORIGIN}:${from ?? 'system'}`)
    }
    ledger.remember(key, message.id)
    return message
  }

  /**
   * The prompt a freshly spawned member receives.
   *
   * `self` is the seat being briefed; `leader` is the team's leader. When the
   * two are the same person the prompt must NOT say "your supervisor is
   * yourself" — that was a real defect, and it is also the difference between a
   * member's brief and the leader's brief, which need different instructions.
   */
  function bootstrapPrompt(projectId, self, leaderView) {
    const team = teamCore.view(teamCore.load(store, projectId), liveAgentMap())
    const isLeader = self.name === leaderView?.name
    const peers = team.members
      .filter((m) => m.name !== self.name)
      .map((m) => `- ${m.name}${m.role === 'leader' ? '（领导者）' : ''}：${m.title || '成员'}`)
      .join('\n')

    if (isLeader) {
      const base = [
        `你是 AI 协作团队的**领导者 ${self.name}**。`,
        '',
        '你的职责是统筹，不是亲手执行：',
        '1. 人类发布任务或计划时，由你决定派给现有成员，还是引入新成员。',
        '2. 成员提交协作请求（request_teammate）时，由你裁决：不合理就打回并说明理由，' +
          '合理就派给现有成员（approve_request 的 assign_to）或引入新人（recruit_new）。',
        '3. 定期用 review_member 审查成员效率并给出具体建议。',
        '4. 用 list_team 掌握全局：谁在做什么、谁在等人类、谁休眠了。',
        '5. 需要人类决策时，先在动态里 @human 说明，再用 await_human_reply 进入等待。',
        '',
        '**重要边界**：你拥有和成员一样的全部工具，但原则上不要亲自写代码、改文件或替成员完成具体任务。' +
        '你的价值在于分配、审查和对外沟通——具体执行交给成员。只有在没有合适成员、且任务极小时才自己动手，并在动态里说明原因。',
        '',
        '当前团队：',
        peers || '（还没有其他成员。有人提出请求时，用 approve_request 引入第一批成员。）',
        '',
        '你先待命，等待人类的指令或成员的请求。',
      ].filter(Boolean).join('\n')

      /**
       * The human's brief goes **after** the built-in instructions.
       *
       * Order matters: the base text explains the collaboration mechanics this
       * plugin implements (tools, wake-on-mention, adjudication), which the
       * leader must know before any human preference is meaningful. Putting the
       * human's words last also makes them the most recent instruction in the
       * prompt, which is where steering is most effective.
       */
      const brief = typeof team.leaderBrief === 'string' ? team.leaderBrief.trim() : ''
      if (brief === '') return base
      return `${base}\n\n---\n\n## 人类对本次协作的具体要求\n\n${brief}`
    }

    return [
      `你是 AI 协作团队「${projectId}」的成员 **${self.name}**。`,
      self.title ? `你的职责：${self.title}` : '',
      leaderView ? `你的上级是 **${leaderView.name}**（团队领导者）。` : '',
      '',
      '团队其他成员：',
      peers || '（暂无）',
      '',
      '工作方式：',
      '1. 通过 ai-buddy 的工具与团队协作：动态、计划、任务、资产四个模块共享同一份项目状态。',
      '2. 完成一个阶段任务或取得重大进展时，用 post_update_to_feed 在动态里通报。',
      '3. 需要人类决策时，先用 send_message_to_member 在动态里 @human 说明问题，' +
        '再调用 await_human_reply 进入等待，不要空转消耗 token。',
      '4. 需要帮手时，用 request_teammate 提出招募请求，由 leader 裁决——' +
        '不要自己建会话，也不要绕过 leader 直接找其他成员分配工作。',
      '5. 收到任务先用 read_plan / read_feed 确认当前状态，不要重复别人已经完成的工作。',
      '6. 想了解同事与自己的位置时，用 list_team。',
      '',
      '你的对话与项目状态已经绑定，随时可以开始。',
    ].filter(Boolean).join('\n')
  }

  /**
   * Create a live session for one seat.
   *
   * `agentLoop.create(id, options, meta)` requires the caller to supply the
   * session identity — it does not mint one. (The plugin-facing
   * `agents.create` path does mint one, but it takes a different set of options
   * and publishes through the factory, which is a heavier contract than this
   * needs.) Passing `undefined` there produces a degenerate id like `session-1`,
   * which is not a usable SessionId and which collides across seats. So the id
   * is generated here in the exact shape DSH uses: `session-<uuid>`.
   *
   * The rest of the options come from the roster: a member inherits the
   * leader's model and the team's workspace, which is what "inherits the
   * leader's settings" means concretely.
   */
  async function spawn(projectId, memberName, options = {}) {
    const { agentLoop, workingDirectory } = services()
    if (agentLoop === undefined || typeof agentLoop.create !== 'function') {
      throw new Error('ai-buddy team: the agentLoop service is unavailable; cannot create a session')
    }

    const team = teamCore.load(store, projectId)
    const target = teamCore.member(team, memberName)
    if (target === undefined) throw new Error(`ai-buddy team: no member named "${memberName}"`)

    const workspace = options.workspace ?? target.workspace ?? team.workspace ?? undefined
    const agentOptions = modelForSeat(team, teamCore.member(team, memberName)) ?? {}
    if (!isNonEmptyString(agentOptions.provider) || !isNonEmptyString(agentOptions.model)) {
      // Fail loudly instead of creating an agent that cannot answer: the error
      // the Host produces later ("has no provider/model") points at the session
      // id, which is far less actionable than the cause.
      throw new Error(
        'ai-buddy team: 没有可用的模型配置。请在初始化团队时选择 leader 的模型，' +
          '或在 profile 的 agent-default-model 里设置 provider/model。',
      )
    }

    // Register the directory as a Workspace BEFORE creating the session, so the
    // new session's canonical cwd already belongs to a workspace and DSH groups
    // it in the sidebar on first render.
    const registered = await ensureWorkspace(workspace)

    const sessionId = `session-${randomUUID()}`

    // `createAgent` (not `create`) because it returns an **AgentHandle** whose
    // `dispose()` actually releases the agent. `create()` returns a bare Agent
    // owned by the calling fiber, which a plugin cannot let go of on demand —
    // so a "dormant" seat built on `create()` stays live and merely *claims* to
    // be asleep. That was a real defect: the roster showed `dormant` while
    // `agents.get()` still returned a running agent.
    const handle = await agentLoop.createAgent(ctx, {
      sessionId,
      meta: workspace === undefined ? {} : { cwd: workspace },
      agentOptions,
    })
    const agent = handle.agent

    // Remember the handle so `sleep` can dispose exactly this agent later. The
    // map is per-runtime-instance and rebuilt by `reconcile`, so it never
    // outlives the plugin activation that owns those agents.
    handles.set(String(agent.id), handle)

    // `createAgent` sets the session header's cwd; the workspace's own
    // accounting is a separate index. Attaching explicitly closes the race
    // where the startup index has not yet observed the new session's header.
    if (registered !== undefined && typeof registered.attachSession === 'function') {
      try {
        await registered.attachSession(String(agent.id))
      } catch (error) {
        log?.(`ai-buddy team: could not attach ${sessionId} to its workspace: ${error?.message ?? error}`)
      }
    }

    // Bind the seat before announcing the prompt: a member that starts working
    // before its seat has a session would be invisible to the roster, and the
    // leader's review would see a ghost.
    teamCore.bindSession(store, projectId, {
      name: memberName,
      sessionId: String(agent.id),
      workspace: workspace ?? null,
    })

    const leaderView = teamCore.leader(team)
    const prompt = options.prompt ?? bootstrapPrompt(
      projectId,
      teamCore.member(teamCore.load(store, projectId), memberName),
      leaderView,
    )
    /**
     * Deliver the opening brief.
     *
     * The delivery goes through the guarded layer so a fault inside the Host's
     * inbox cannot escape: the bootstrap is a convenience, and a failed
     * bootstrap must leave a *live but silent* member — never a dead Host.
     */
    const bootstrap = await deliver(agent, makeMessage(prompt, 'bootstrap', sessionId), {
      transport: 'followup',
    })
    if (!bootstrap.delivered) {
      log?.(
        `ai-buddy team: bootstrap message failed for ${memberName}: ` +
          `${bootstrap.reason ?? 'unknown'}${bootstrap.error ? ` (${bootstrap.error})` : ''}`,
      )
    }

    if (workspace !== undefined && workingDirectory !== undefined) {
      try {
        await workingDirectory.set(agent, workspace)
      } catch (error) {
        log?.(`ai-buddy team: could not pin workspace for ${memberName}: ${error?.message ?? error}`)
      }
    }

    return { sessionId: String(agent.id), agent }
  }

  /**
   * Deliver a message into a member's conversation.
   *
   * Two transports, deliberately:
   *   - a live agent is driven by the guarded delivery layer: `followup` when
   *     it is idle (open a turn) and `steer` when it is already working (cut
   *     into the turn in progress, rather than opening a competing one);
   *   - a continuable child with no live agent is reached through
   *     `subagents.sendMessage`, which cold-resumes it.
   * A dormant member is woken explicitly instead, so a message never silently
   * creates a session the human did not ask for.
   */
  async function send(projectId, args = {}) {
    const opts = asRecord(args)
    const targetName = isNonEmptyString(opts.to) ? opts.to : ''
    const text = isNonEmptyString(opts.content) ? opts.content : ''
    if (text === '') throw new Error('ai-buddy team: a message needs content')

    const team = teamCore.load(store, projectId)
    const target = teamCore.member(team, targetName)
    if (target === undefined) throw new Error(`ai-buddy team: no member named "${targetName}"`)

    let sessionId = target.sessionId
    let agent = isNonEmptyString(sessionId) ? findAgent(sessionId) : undefined
    let woke = false

    /**
     * A message is a request for that member to act, so a seat that cannot act
     * yet must be made able to. Two cases:
     *
     *   - **dormant** (deliberately parked, agent disposed): waking is the whole
     *     point of addressing it. `wake` resumes the same session, so the member
     *     returns with its context rather than starting over.
     *   - **has a seat but no live agent** (plugin reload, agent released):
     *     same treatment, `resume` is idempotent when the session is already
     *     live.
     *
     * Without this, mentioning a sleeping member was silently accepted and
     * nothing happened — the reported bug.
     */
    if (agent === undefined) {
      try {
        const resumed = await wake(projectId, targetName)
        sessionId = resumed.sessionId
        // `resume` publishes the agent through the factory, and the registry
        // entry can land a tick later. Poll briefly instead of assuming it is
        // visible the instant the promise resolves — otherwise the first message
        // to a just-woken member is dropped, which is exactly the symptom of
        // "@ does nothing".
        agent = await waitForAgent(sessionId, 20, 150)
        woke = true
      } catch (error) {
        log?.(`ai-buddy team: could not wake ${targetName} to deliver a message: ${error?.message ?? error}`)
      }
    }

    if (agent !== undefined && typeof agent.followup === 'function') {
      /**
       * The guarded delivery layer picks the transport:
       *
       *   - an **idle** member gets `followup`, which opens a turn — "ask this
       *     member to work" means exactly that;
       *   - a **busy** member gets `steer`, which cuts into the turn in
       *     progress at its next step boundary. A `followup` here would open a
       *     second, competing turn (the Host's own note: "再 followup 会变成两条
       *     并行的意图"), which is how one human instruction turns into two
       *     half-finished pieces of work.
       *
       * Either way the call cannot throw into the Host: a message the Host
       * cannot key is rejected inside the agent loop, past any handler the
       * plugin could install, and that kills the process.
       */
      const result = await deliver(agent, makeMessage(text, opts.from ?? 'human', sessionId))
      if (!result.delivered) {
        log?.(
          `ai-buddy team: could not deliver to ${targetName}: ` +
            `${result.reason ?? 'unknown'}${result.error ? ` (${result.error})` : ''}`,
        )
        return {
          delivered: false,
          reason: result.reason ?? 'delivery_failed',
          hint: '消息未送达：宿主拒绝了这条消息（通常是会话正在收尾）。稍后重试或唤醒该成员。',
          transport: result.transport,
          sessionId,
          woke,
        }
      }
      teamCore.setStatus(store, projectId, { name: targetName, status: 'working' })
      return { delivered: true, transport: result.transport, sessionId, woke }
    }

    if (!isNonEmptyString(sessionId)) {
      return {
        delivered: false,
        reason: 'no_session',
        hint: '该成员还没有会话，且自动创建失败。请在团队面板手动唤醒它。',
        woke,
      }
    }

    // Last resort: the subagent transport can cold-resume a continuable child.
    const { subagents } = services()
    const sender = isNonEmptyString(opts.senderSessionId)
      ? findAgent(opts.senderSessionId)
      : undefined
    if (subagents !== undefined && sender !== undefined && typeof subagents.sendMessage === 'function') {
      try {
        const messageId = await subagents.sendMessage(
          sender,
          sessionId,
          [{ type: 'text', text }],
          { signal: opts.signal ?? new AbortController().signal },
        )
        return { delivered: true, transport: 'subagents', sessionId, messageId: String(messageId), woke }
      } catch (error) {
        log?.(`ai-buddy team: subagent send failed: ${error?.message ?? error}`)
      }
    }

    return {
      delivered: false,
      reason: 'no_agent',
      hint: '该成员会话存在但无法投递（可能正在启动）。稍后再试，或打开它的对话手动发送。',
      woke,
    }
  }

  /**
   * Park a member that is waiting on a human.
   *
   * The session is disposed (so it stops consuming anything) but the seat keeps
   * the session id, which is the whole trick: `wake` resumes *that* session, so
   * the member comes back with its context instead of starting over.
   */
  async function sleep(projectId, memberName, reason = '') {
    const team = teamCore.load(store, projectId)
    const target = teamCore.member(team, memberName)
    if (target === undefined) throw new Error(`ai-buddy team: no member named "${memberName}"`)
    if (target.role === 'leader') {
      throw new Error('ai-buddy team: the leader must stay awake to coordinate; it cannot sleep')
    }

    const sessionId = target.sessionId
    let released = false
    if (isNonEmptyString(sessionId)) {
      // 1. Stop the current turn. Disposing a mid-turn agent can leave a
      //    half-written assistant message; interrupting first lets the turn
      //    close cleanly, and the dispose below then frees everything else.
      const agent = findAgent(sessionId)
      if (agent !== undefined) {
        try {
          const { subagents } = services()
          if (subagents !== undefined && typeof subagents.interrupt === 'function') {
            subagents.interrupt(sessionId, { kind: 'user', parentSessionId: sessionId })
          }
        } catch (error) {
          log?.(`ai-buddy team: interrupt before sleep failed: ${error?.message ?? error}`)
        }
      }

      // 2. Actually release the agent. This is the step whose absence made
      //    `dormant` a lie: the seat said "asleep" while the agent kept running.
      const handle = handles.get(String(sessionId))
      if (handle !== undefined) {
        try {
          await handle.dispose()
          released = true
        } catch (error) {
          log?.(`ai-buddy team: could not dispose ${memberName}: ${error?.message ?? error}`)
        } finally {
          handles.delete(String(sessionId))
        }
      }
    }

    // Only report `dormant` when the agent is genuinely gone. If a handle was
    // missing (an agent this runtime did not create) the seat falls back to
    // `offline`, which is the honest description.
    const liveAfter = isNonEmptyString(sessionId) ? findAgent(sessionId) : undefined
    const dormant = liveAfter === undefined

    teamCore.setStatus(store, projectId, {
      name: memberName,
      status: dormant ? 'dormant' : 'offline',
      currentTask: null,
      currentPlanItemId: null,
    })
    return { dormant, sessionId: sessionId ?? null, reason, released }
  }

  /** Resume a parked member from its persisted session. */
  async function wake(projectId, memberName) {
    const { agentLoop } = services()
    const team = teamCore.load(store, projectId)
    const target = teamCore.member(team, memberName)
    if (target === undefined) throw new Error(`ai-buddy team: no member named "${memberName}"`)

    const sessionId = target.sessionId
    if (isNonEmptyString(sessionId)) {
      const already = findAgent(sessionId)
      if (already !== undefined) {
        teamCore.setStatus(store, projectId, { name: memberName, status: 'idle' })
        return { woken: false, alreadyLive: true, sessionId }
      }
    }

    if (agentLoop === undefined || typeof agentLoop.resume !== 'function') {
      throw new Error('ai-buddy team: the agentLoop service is unavailable; cannot wake a member')
    }
    if (!isNonEmptyString(sessionId)) {
      // Never had a session: spawn instead of failing, so a seat created but
      // never used still becomes usable.
      const created = await spawn(projectId, memberName)
      return { woken: true, spawned: true, sessionId: created.sessionId }
    }

    try {
      // `resume` also returns an AgentHandle, so a woken member can be put back
      // to sleep later. Using the bare agent here would recreate the very bug
      // this method exists to fix.
      const handle = await agentLoop.resume(ctx, { resumeSessionId: sessionId })
      const agent = handle?.agent ?? handle
      const actualId = String(agent?.id ?? sessionId)
      if (handle !== undefined && typeof handle.dispose === 'function') {
        handles.set(actualId, handle)
      }
      teamCore.bindSession(store, projectId, { name: memberName, sessionId: actualId })
      return { woken: true, spawned: false, sessionId: actualId }
    } catch (error) {
      log?.(`ai-buddy team: resume failed for ${memberName}: ${error?.message ?? error}`)

      /**
       * Resume can fail for a session this Host no longer has: a plugin reload
       * disposes the previous generation's agents, an archived session may have
       * been pruned, and a seat created before a restart points at a session the
       * new process never loaded.
       *
       * A wake that cannot resume must still produce a working member — the
       * human asked for one by addressing it. Falling back to a fresh session
       * loses that conversation's history but keeps the team functional, which
       * is the right trade: a member that cannot be reached at all is worse than
       * one that starts a new thread.
       */
      try {
        const created = await spawn(projectId, memberName, {
          prompt:
            `你是 ${memberName}。之前的会话无法恢复（${error?.message ?? 'unknown'}），` +
            '你以新会话继续参与团队协作。先用 list_team 与 read_plan 了解当前状态，' +
            '再处理分配给你的工作。',
        })
        return { woken: true, spawned: true, sessionId: created.sessionId, resumed: false }
      } catch (spawnError) {
        throw new Error(
          `无法唤醒 ${memberName}：恢复会话失败（${error?.message ?? error}），` +
            `新建会话也失败（${spawnError?.message ?? spawnError}）。`,
        )
      }
    }
  }

  /**
   * Archive a member's conversation into the asset library before removal.
   *
   * The brief requires that removing a member backs up its conversation. The
   * backup is a real asset, so the transcript stays reviewable in the asset
   * panel after the seat is gone — that is what makes deletion safe enough to
   * allow at all.
   */
  async function backupConversation(projectId, memberName) {
    const team = teamCore.load(store, projectId)
    const target = teamCore.member(team, memberName)
    if (target === undefined) return { backedUp: false, reason: 'unknown_member' }

    const sessionId = target.sessionId
    if (!isNonEmptyString(sessionId)) {
      return { backedUp: false, reason: 'no_session' }
    }

    // The transcript is assembled from what this plugin can see: the member's
    // own feed events, its tasks, and its roster record. The raw session log is
    // owned by DSH and not readable through a plugin service, so this is an
    // activity transcript rather than a byte-for-byte message log — stated
    // plainly here so nobody mistakes it for a full replay.
    const feedEvents = feed.read(store, config, projectId, { limit: 500 })
      .filter((event) => event?.actor?.name === memberName)
    const tasks = store.readTasks(projectId)
      .filter((task) => task.ownerAgent === memberName)
    const checkpoints = isNonEmptyString(sessionId)
      ? store.listCheckpoints(projectId, sessionId, 200)
      : []

    const lines = [
      `# 成员对话备份 — ${memberName}`,
      '',
      `- 备份时间：${new Date().toISOString()}`,
      `- 会话 id：${sessionId}`,
      `- 角色：${target.role}，汇报对象：${target.reportsTo ?? '—'}`,
      `- 状态：${target.status}`,
      '',
      '## 参与的任务',
      ...(tasks.length === 0
        ? ['（无）']
        : tasks.map((task) => `- \`${task.id}\` ${task.title}（${task.status}）`)),
      '',
      '## 检查点',
      ...(checkpoints.length === 0
        ? ['（无）']
        : checkpoints.map((cp) => `- ${cp.timestamp} ${cp.event_type} — ${clip(cp.context_summary, 200)}`)),
      '',
      '## 动态发言',
      ...(feedEvents.length === 0
        ? ['（无）']
        : feedEvents.map((event) => `- ${event.at} [${event.category}] ${clip(event.content, 400)}`)),
      '',
    ]

    const { assets } = deps.core
    const saved = assets.save(store, config, projectId, {
      actor: { type: 'human', id: 'human', name: 'Human' },
      name: `成员备份-${memberName}-${sessionId.slice(0, 8)}.md`,
      folder: 'team-backups',
      bytes: Buffer.from(lines.join('\n'), 'utf8'),
      contentType: 'text/markdown',
    })
    return {
      backedUp: true,
      assetId: saved?.asset?.id ?? null,
      assetName: saved?.asset?.name ?? null,
      feedEvents: feedEvents.length,
      checkpoints: checkpoints.length,
    }
  }

  return {
    services,
    liveAgentMap,
    findAgent,
    spawn,
    send,
    sleep,
    wake,
    backupConversation,
  }
}
