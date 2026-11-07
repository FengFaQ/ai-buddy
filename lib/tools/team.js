/**
 * Team collaboration tools: message sending and task collaboration.
 *
 * These extend the original 20 with the organizational layer: addressing a
 * specific member, parking for a human, requesting a teammate, and the leader's
 * adjudication of those requests.
 *
 * The design decision that shapes most of this file: **the leader's authority is
 * expressed as a tool, not as an implicit permission.** A member calling
 * `approve_request` fails; the tool checks the caller's roster role. That keeps
 * "only the leader decides" enforceable in code rather than in a prompt, even
 * though the leader is given the same full tool set as everyone else — it simply
 * cannot use the adjudication tool from a member seat.
 *
 * One schema rule learned the hard way: DSH validates a tool's `output.schema`
 * against what `execute` actually returns, and a `null` where the schema says
 * `string` fails the registration outright — the tool silently disappears from
 * the model's tool list. So every optional string field here is returned as `''`
 * (or omitted entirely), never `null`, and the schema stays a plain `string`.
 */

import { asRecord, asStringArray, isNonEmptyString, clip, nowIso } from '../util.js'

function fail(message) {
  throw new Error(message)
}

function requireString(args, key, hint) {
  const value = asRecord(args)[key]
  if (!isNonEmptyString(value)) fail(`${key} 必填：${hint}`)
  return String(value).trim()
}

function optionalString(args, key) {
  const value = asRecord(args)[key]
  return isNonEmptyString(value) ? String(value).trim() : undefined
}

function textOutput(schema, render) {
  return { schema, render }
}

function renderSummary(lines) {
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

/**
 * Build the team tools.
 *
 * `deps` extends the base tool dependencies with `teamRuntime` (the Host-side
 * spawn/send/sleep/wake layer) and `core.team` / `core.requests`.
 */
export function createTeamTools(deps) {
  const {
    store, config, core, log,
    actorFor, projectIdFor, conversationFor, teamRuntime,
  } = deps
  const team = core.team

  function projectOf(agent) {
    const projectId = projectIdFor(agent)
    if (!isNonEmptyString(projectId)) {
      fail('当前会话没有绑定任何项目。请先由人类在工作台初始化团队与项目。')
    }
    if (store.getProject(projectId) === undefined) {
      fail(`项目 ${projectId} 不存在`)
    }
    return projectId
  }

  function actorOf(agent) {
    try {
      return actorFor(agent)
    } catch {
      return { type: 'agent', id: 'unknown', name: 'unknown' }
    }
  }

  function roster(projectId) {
    return team.view(team.load(store, projectId), teamRuntime.liveAgentMap())
  }

  /** The caller's own seat, which is what authority is checked against. */
  function callerSeat(projectId, agent) {
    const view = roster(projectId)
    const conversationId = conversationFor(agent)
    if (isNonEmptyString(conversationId)) {
      const bySession = view.members.find((m) => m.sessionId === conversationId)
      if (bySession !== undefined) return { seat: bySession, view }
    }
    const actor = actorOf(agent)
    const byName = view.members.find((m) => m.name === actor.name)
    return { seat: byName, view }
  }

  function requireLeader(projectId, agent) {
    const { seat } = callerSeat(projectId, agent)
    if (seat === undefined) {
      fail('你不在团队名册中，无法执行领导者操作。')
    }
    if (seat.role !== 'leader') {
      fail(
        `只有团队领导者可以执行该操作；当前调用者是「${seat.name}」（角色：${seat.role}）。` +
          '请把请求发给 leader，由它裁决。',
      )
    }
    return seat
  }

  // ------------------------------------------------------- 1. message sending

  const sendMessage = {
    name: 'send_message_to_member',
    description:
      '在 ai-buddy 团队讨论区发布一条消息，并可以 @ 指定成员。被 @ 的成员会收到一条插入消息，' +
      '在他当前回合的最近步骤边界生效——就像人类在对话中插队发话一样。' +
      '用于：向下属下达指令、向领导者汇报、向同伴求证。' +
      '注意：这作用于 ai-buddy 团队名册里的成员（名字来自 list_team）。' +
      '要给你在本对话里 spawn 的子智能体发消息，用官方的 send_message（agent_id 来自 list_agents）——两者是不同的体系。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '消息内容。写清楚要对方做什么、截止条件。' },
        mention: { type: 'string', description: '可选：要 @ 的成员名。被 @ 的成员会立刻收到这条消息并被打断当前节奏。' },
        category: {
          type: 'string',
          enum: ['task.assign', 'progress', 'question', 'review', 'announcement'],
          description: '消息类型，默认 progress。',
        },
        deliver: {
          type: 'boolean',
          description: '是否真的把消息投递给被 @ 的成员，默认 true。置 false 只发到动态不打扰对方。',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: textOutput(
      {
        type: 'object',
        properties: {
          feed_event_id: { type: 'string' },
          mentioned: { type: 'string' },
          delivered: { type: 'boolean' },
          transport: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['feed_event_id'],
        additionalProperties: false,
      },
      (_args, value) => renderSummary([
        `已发布团队消息 \`${value.feed_event_id}\``,
        value.mentioned ? `@${value.mentioned}` : '',
        value.delivered
          ? `已投递给 ${value.mentioned}（通道：${value.transport || 'direct'}）`
          : (value.note ?? ''),
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const content = requireString(args, 'content', '不能发空消息')
      const mention = optionalString(args, 'mention')
      const category = optionalString(args, 'category') ?? 'progress'
      const shouldDeliver = asRecord(args).deliver !== false
      const view = roster(projectId)

      if (mention !== undefined && !view.members.some((m) => m.name === mention)) {
        const names = view.members.map((m) => m.name).join('、')
        fail(`团队中没有名为「${mention}」的成员。现有成员：${names || '（无）'}`)
      }

      const posted = core.feed.post(store, config, projectId, {
        actor,
        // The mention prefix goes in exactly once. Agents routinely write the
        // `@name` into their own content (the composer and every example in
        // the system prompt show that form), so an unconditional prefix here
        // produced `@系统守护 @系统守护 …` in the feed — and the duplicated
        // token was what members quoted back.
        content:
          mention === undefined || content.trimStart().startsWith(`@${mention}`)
            ? content
            : `@${mention} ${content}`,
        category: 'team.message',
        source: 'agent',
        meta: { mention: mention ?? '', msgCategory: category },
      })

      let delivered = false
      let transport = ''
      let note = ''
      if (mention !== undefined && shouldDeliver) {
        try {
          const result = await teamRuntime.send(projectId, {
            to: mention,
            content: `[${category}] 来自 ${actor.name} 的消息：\n${content}`,
            from: actor.name,
            senderSessionId: conversationFor(exec.agent),
          })
          delivered = result.delivered === true
          transport = result.transport ?? ''
          if (!delivered) note = result.hint ?? '对方当前没有活动会话，消息已留在动态里。'
        } catch (error) {
          note = `投递失败：${error?.message ?? error}。消息已留在动态里，对方下次活跃时能看到。`
        }
      }

      return {
        feed_event_id: posted.event.id,
        mentioned: mention ?? '',
        delivered,
        transport,
        note,
      }
    },
  }

  // -------------------------------------------------------- await human reply

  const awaitHumanReply = {
    name: 'await_human_reply',
    description:
      '当你需要人类决策、并且已经在动态里发布了问题之后调用。这会把你自己置为「等待人类」并休眠，' +
      '停止空转消耗 token。人类回复后会被唤醒。' +
      '注意：休眠前务必先通过 send_message_to_member 把问题发到动态并 @human，' +
      '否则人类看不到你的问题。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要向人类提的问题摘要（会写进动态）。' },
        context: { type: 'string', description: '可选：背景与你已经尝试过的方案，方便人类快速判断。' },
        sleep: { type: 'boolean', description: '是否立即休眠自己，默认 true。置 false 只登记等待状态。' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    output: textOutput(
      {
        type: 'object',
        properties: {
          waiting: { type: 'boolean' },
          dormant: { type: 'boolean' },
          feed_event_id: { type: 'string' },
        },
        required: ['waiting'],
        additionalProperties: false,
      },
      (_args, value) => renderSummary([
        `已进入等待人类回复状态（动态 \`${value.feed_event_id}\`）`,
        value.dormant ? '你已被置为休眠，人类回复后会被唤醒。' : '已登记等待，你仍可继续处理其他工作。',
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const question = requireString(args, 'question', '必须写明要问什么')
      const context = optionalString(args, 'context')
      const shouldSleep = asRecord(args).sleep !== false
      const { seat } = callerSeat(projectId, exec.agent)

      const posted = core.feed.post(store, config, projectId, {
        actor,
        content: `@human 需要人类决策：${question}${context ? `\n\n背景：${context}` : ''}`,
        category: 'team.human_request',
        source: 'agent',
        pinned: true,
        meta: { mention: 'human', member: seat?.name ?? actor.name },
      })

      if (seat !== undefined) {
        team.setStatus(store, projectId, {
          name: seat.name,
          status: shouldSleep ? 'dormant' : 'waiting_human',
          currentTask: null,
        })
      }

      if (shouldSleep && seat !== undefined && teamRuntime !== undefined) {
        try {
          await teamRuntime.sleep(projectId, seat.name, question)
        } catch (error) {
          log?.(`ai-buddy team: sleep after human request failed: ${error?.message ?? error}`)
        }
      }

      return {
        waiting: true,
        dormant: shouldSleep,
        feed_event_id: posted.event.id,
      }
    },
  }

  // ------------------------------------------------- 2. task collaboration

  const requestTeammate = {
    name: 'request_teammate',
    description:
      '向领导者提出招募/协作请求：你需要帮手完成某件事。领导者会裁决——' +
      '不合理会打回，合理的会派给现有成员或引入新成员。' +
      '这是唯一正确的「拉人」方式；不要在 leader 未批准的情况下自己建会话。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '需要帮手做的事，一句话概括。' },
        reason: { type: 'string', description: '为什么你自己做不了 / 为什么要并行。' },
        skill: { type: 'string', description: '需要什么样的能力（供领导者判断是派现有成员还是招新人）。' },
        urgency: { type: 'string', enum: ['low', 'normal', 'high'], description: '紧急程度，默认 normal。' },
        plan_item_id: { type: 'string', description: '可选：关联的计划条目。' },
      },
      required: ['title', 'reason'],
      additionalProperties: false,
    },
    output: textOutput(
      {
        type: 'object',
        properties: {
          request_id: { type: 'string' },
          status: { type: 'string' },
          feed_event_id: { type: 'string' },
        },
        required: ['request_id', 'status'],
        additionalProperties: false,
      },
      (_args, value) => renderSummary([
        `已提交协作请求 \`${value.request_id}\`，状态：${value.status}`,
        '等待领导者裁决。裁决结果会出现在动态里。',
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const title = requireString(args, 'title', '写清楚要做什么')
      const reason = requireString(args, 'reason', '写清楚为什么需要帮手')
      const skill = optionalString(args, 'skill')
      const urgency = optionalString(args, 'urgency') ?? 'normal'
      const planItemId = optionalString(args, 'plan_item_id')
      const { seat, view } = callerSeat(projectId, exec.agent)

      const request = core.requests.create(store, config, projectId, {
        actor,
        from: seat?.name ?? actor.name,
        kind: 'teammate',
        title,
        reason,
        skill,
        urgency,
        planItemId,
        leader: view.leader?.name ?? null,
      })

      const posted = core.feed.post(store, config, projectId, {
        actor,
        content:
          `@${view.leader?.name ?? 'leader'} 申请增援：${title}\n` +
          `理由：${reason}${skill ? `\n所需能力：${skill}` : ''}`,
        category: 'team.request',
        source: 'agent',
        pinned: urgency === 'high',
        planItemId: planItemId ?? null,
        meta: { requestId: request.id, urgency },
      })

      // Nudge the leader directly: a request sitting silently in the feed while
      // the leader idles is the failure this tool exists to prevent.
      if (view.leader !== undefined && view.leader.sessionId !== null) {
        try {
          await teamRuntime.send(projectId, {
            to: view.leader.name,
            content:
              `新的协作请求 \`${request.id}\` 等待你裁决：\n` +
              `- 提出者：${seat?.name ?? actor.name}\n- 事项：${title}\n- 理由：${reason}` +
              `${skill ? `\n- 所需能力：${skill}` : ''}\n\n` +
              '请用 approve_request 裁决（批准后指定 assign_to 或 recruit_new）。',
            from: actor.name,
            senderSessionId: conversationFor(exec.agent),
          })
        } catch (error) {
          log?.(`ai-buddy team: leader notify failed: ${error?.message ?? error}`)
        }
      }

      return {
        request_id: request.id,
        status: request.status,
        feed_event_id: posted.event.id,
      }
    },
  }

  const approveRequest = {
    name: 'approve_request',
    description:
      '【仅领导者】裁决一个协作请求。可以批准并派给现有成员，或批准并引入新成员，也可以打回。' +
      '打回时必须写明理由，让提出者知道该怎么改。',
    parameters: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: '请求 id。' },
        decision: { type: 'string', enum: ['approve', 'reject'], description: '批准或打回。' },
        assign_to: { type: 'string', description: 'decision=approve 且派给现有成员时，填该成员名。' },
        recruit_new: {
          type: 'object',
          description:
            'decision=approve 且需要新成员时填写。name 由你自行为新成员取一个人类易读的名字' +
            '（2-4 个汉字或一个短英文名，别用 budget-writer 这类 slug）；留空则由系统从名字池里挑一个。',
          properties: {
            name: { type: 'string', description: '新成员名（团队内唯一，人类易读）。' },
            title: { type: 'string', description: '职责描述。' },
            reportsTo: { type: 'string', description: '可选：汇报对象，默认你自己。' },
          },
          additionalProperties: false,
        },
        reason: { type: 'string', description: 'decision=reject 时必填：打回理由。' },
      },
      required: ['request_id', 'decision'],
      additionalProperties: false,
    },
    output: textOutput(
      {
        type: 'object',
        properties: {
          request_id: { type: 'string' },
          status: { type: 'string' },
          assigned_to: { type: 'string' },
          recruited: { type: 'string' },
          session_id: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['request_id', 'status'],
        additionalProperties: false,
      },
      (_args, value) => renderSummary([
        `请求 \`${value.request_id}\` → ${value.status}`,
        value.assigned_to ? `已派给现有成员：${value.assigned_to}` : '',
        value.recruited ? `已招募新成员：${value.recruited}${value.session_id ? `（会话 ${value.session_id}）` : ''}` : '',
        value.note ?? '',
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const requestId = requireString(args, 'request_id', '必须指定请求')
      const decision = requireString(args, 'decision', '必须是 approve 或 reject')
      const leaderName = requireLeader(projectId, exec.agent).name
      const view = roster(projectId)

      const request = core.requests.get(store, projectId, requestId)
      if (request === undefined) fail(`请求 ${requestId} 不存在`)
      if (request.status !== 'pending') fail(`请求 ${requestId} 已经是 ${request.status} 状态，不能重复裁决`)

      if (decision === 'reject') {
        const reason = requireString(args, 'reason', '打回必须写明理由')
        const updated = core.requests.resolve(store, config, projectId, {
          requestId,
          status: 'rejected',
          decidedBy: leaderName,
          reason,
        })
        core.feed.post(store, config, projectId, {
          actor,
          content: `@${request.from} 你的协作请求「${request.title}」被打回。理由：${reason}`,
          category: 'team.reject',
          source: 'agent',
          meta: { requestId },
        })
        if (request.from !== null) {
          try {
            await teamRuntime.send(projectId, {
              to: request.from,
              content: `协作请求 \`${requestId}\`（${request.title}）被打回。\n理由：${reason}\n请调整后重新提交，或换一种做法。`,
              from: leaderName,
              senderSessionId: conversationFor(exec.agent),
            })
          } catch (error) {
            log?.(`ai-buddy team: reject notify failed: ${error?.message ?? error}`)
          }
        }
        return {
          request_id: requestId,
          status: updated.status,
          assigned_to: '',
          recruited: '',
          session_id: '',
          note: '已打回并通知提出者。',
        }
      }

      // ---- approve ----
      const assignTo = optionalString(args, 'assign_to')
      const recruitNew = asRecord(asRecord(args).recruit_new)
      const wantsRecruit = isNonEmptyString(recruitNew.name)
        || asRecord(args).recruit_new !== undefined

      if (assignTo === undefined && !wantsRecruit) {
        fail(
          '批准时必须指定 assign_to（派给现有成员）或 recruit_new（引入新成员）。' +
            'recruit_new.name 可以留空，系统会自动取一个人类易读的名字。',
        )
      }
      if (assignTo !== undefined && !view.members.some((m) => m.name === assignTo)) {
        fail(`团队中没有名为「${assignTo}」的成员。请先用 recruit_new 引入，或从现有成员中选择。`)
      }

      // The leader is invited to name the new member itself; when it declines
      // (or picks something unusable) a name is drawn from the pool. Names are
      // always resolved here so the seat and the session agree from the start.
      const recruitName = wantsRecruit
        ? team.suggestMemberName(
            team.load(store, projectId),
            optionalString(args, 'recruit_new_name') ?? recruitNew.name,
          )
        : undefined
      if (recruitName !== undefined && view.members.some((m) => m.name === recruitName)) {
        fail(`团队中已存在名为「${recruitName}」的成员。改用 assign_to 派给他。`)
      }

      let recruited = ''
      let sessionId = ''
      if (recruitName !== undefined) {
        team.addMember(store, projectId, {
          name: recruitName,
          title: recruitNew.title,
          reportsTo: isNonEmptyString(recruitNew.reportsTo) ? recruitNew.reportsTo : leaderName,
          workspace: view.workspace,
        })
        recruited = recruitName
        // Spawn lazily and tolerate failure: the seat must exist even if the
        // Host cannot create a session right now, otherwise the org chart
        // silently loses the hire.
        try {
          const spawned = await teamRuntime.spawn(projectId, recruitName)
          sessionId = spawned.sessionId
        } catch (error) {
          log?.(`ai-buddy team: could not spawn new member ${recruitName}: ${error?.message ?? error}`)
        }
      }

      const assignee = assignTo ?? recruitName
      const updated = core.requests.resolve(store, config, projectId, {
        requestId,
        status: 'approved',
        decidedBy: leaderName,
        assignee,
        reason: optionalString(args, 'reason') ?? '',
      })

      core.feed.post(store, config, projectId, {
        actor,
        content: recruited
          ? `批准协作请求「${request.title}」，引入新成员 ${recruited} 负责。`
          : `批准协作请求「${request.title}」，派给现有成员 ${assignee}。`,
        category: 'team.approve',
        source: 'agent',
        meta: { requestId, assignee: assignee ?? '' },
      })

      if (assignee !== undefined) {
        try {
          await teamRuntime.send(projectId, {
            to: assignee,
            content:
              `你被指派了一项任务：${request.title}\n` +
              `原始请求来自 ${request.from ?? '团队成员'}，理由：${request.reason ?? '—'}` +
              `${request.skill ? `\n所需能力：${request.skill}` : ''}\n\n` +
              '请先 read_plan 与 read_feed 确认当前状态，再开始工作。',
            from: leaderName,
            senderSessionId: conversationFor(exec.agent),
          })
        } catch (error) {
          log?.(`ai-buddy team: assign notify failed: ${error?.message ?? error}`)
        }
      }

      return {
        request_id: requestId,
        status: updated.status,
        assigned_to: assignTo ?? '',
        recruited,
        session_id: sessionId,
        note: '',
      }
    },
  }

  // ------------------------------------------------------- 3. member removal

  const removeMember = {
    name: 'remove_member',
    description:
      '【仅领导者】移除一个团队成员。移除前会自动把该成员的对话备份成资产存进资产库，' +
      '所以这是一个可回滚的操作。有下属的成员不能被直接移除，需要先重新分配其下属。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要移除的成员名。' },
        reason: { type: 'string', description: '移除理由，会记入动态。' },
      },
      required: ['name', 'reason'],
      additionalProperties: false,
    },
    output: textOutput(
      {
        type: 'object',
        properties: {
          removed: { type: 'string' },
          backup_asset_id: { type: 'string' },
          backup_note: { type: 'string' },
        },
        required: ['removed'],
        additionalProperties: false,
      },
      (_args, value) => renderSummary([
        `已移除成员 ${value.removed}`,
        value.backup_asset_id
          ? `对话已备份为资产 \`${value.backup_asset_id}\`（见资产库 team-backups/）`
          : (value.backup_note ?? '该成员没有可备份的会话。'),
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const name = requireString(args, 'name', '必须指定成员')
      const reason = requireString(args, 'reason', '必须说明移除理由')
      requireLeader(projectId, exec.agent)

      // Backup first. If the backup fails the removal does NOT proceed, because
      // "deleted but not archived" is the one outcome the brief forbids.
      let backup
      try {
        backup = await teamRuntime.backupConversation(projectId, name)
      } catch (error) {
        fail(`备份 ${name} 的对话失败，已中止移除：${error?.message ?? error}`)
      }

      team.removeMember(store, projectId, { name })

      core.feed.post(store, config, projectId, {
        actor,
        content:
          `已移除成员 ${name}。理由：${reason}` +
          (backup?.backedUp ? `\n对话已备份为资产 \`${backup.assetId}\`。` : ''),
        category: 'team.remove',
        source: 'agent',
        pinned: true,
        assetId: backup?.assetId ?? null,
        meta: { removed: name, backupAssetId: backup?.assetId ?? '' },
      })

      return {
        removed: name,
        backup_asset_id: backup?.assetId ?? '',
        backup_note: backup?.backedUp ? '' : `未备份：${backup?.reason ?? 'unknown'}`,
      }
    },
  }

  // --------------------------------------------------------- 4. review member

  const reviewMember = {
    name: 'review_member',
    description:
      '【仅领导者】审查一个成员的工作效率并给予建议。结果会记入该成员的档案并出现在动态里。' +
      '建议应当具体可执行——「加油」不是建议。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要审查的成员名。' },
        score: { type: 'number', description: '效率评分 0-100。' },
        verdict: { type: 'string', description: '一句话结论，如「进度正常」「明显滞后」。' },
        advice: { type: 'string', description: '给该成员的具体建议。' },
        deliver: { type: 'boolean', description: '是否把建议直接发给该成员，默认 true。' },
      },
      required: ['name', 'advice'],
      additionalProperties: false,
    },
    output: textOutput(
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          score: { type: 'number' },
          delivered: { type: 'boolean' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      (_args, value) => renderSummary([
        `已审查 ${value.name}${value.score === undefined ? '' : `（评分 ${value.score}）`}`,
        value.delivered ? '建议已直接发送给该成员。' : '建议已记录在案（未打扰对方）。',
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const name = requireString(args, 'name', '必须指定成员')
      const advice = requireString(args, 'advice', '必须给出具体建议')
      const leaderSeat = requireLeader(projectId, exec.agent)
      const verdict = optionalString(args, 'verdict') ?? ''
      const hasScore = asRecord(args).score !== undefined && Number.isFinite(Number(asRecord(args).score))
      const score = hasScore ? Number(asRecord(args).score) : undefined

      team.review(store, projectId, {
        name,
        by: leaderSeat.name,
        score,
        verdict,
        advice,
      })

      core.feed.post(store, config, projectId, {
        actor,
        content:
          `效率审查 — ${name}${score === undefined ? '' : `：${score}/100`}` +
          `${verdict ? `（${verdict}）` : ''}\n建议：${advice}`,
        category: 'team.review',
        source: 'agent',
        meta: { member: name, score: score ?? 0 },
      })

      let delivered = false
      if (asRecord(args).deliver !== false) {
        try {
          const result = await teamRuntime.send(projectId, {
            to: name,
            content:
              `领导者 ${leaderSeat.name} 对你的工作做了审查` +
              `${score === undefined ? '' : `（${score}/100）`}${verdict ? `：${verdict}` : '。'}\n\n` +
              `建议：${advice}\n\n请据此调整。如有异议，用 send_message_to_member 回复 leader。`,
            from: leaderSeat.name,
            senderSessionId: conversationFor(exec.agent),
          })
          delivered = result.delivered === true
        } catch (error) {
          log?.(`ai-buddy team: review delivery failed: ${error?.message ?? error}`)
        }
      }

      // A member with no score must omit the field entirely rather than send
      // `null`, which would violate the number schema.
      return score === undefined
        ? { name, delivered }
        : { name, score, delivered }
    },
  }

  // ------------------------------------------------------ 5. roster inspection

  /**
   * Interrupt a member's current turn, by member name.
   *
   * This exists because the Host's own `interrupt_agent` — registered by
   * `dsh-tool-subagent-control` (and, in other profiles, the experimental
   * agent-team plugin) — only accepts targets its *own* subsystem returned: a
   * session id from `list_agents`, or a teammate target from `spawn_teammate`.
   * ai-buddy members are named in the roster (`小算`), and neither of those
   * registries knows them, so the model's natural call died with "not found".
   *
   * The tool name is deliberately NOT `interrupt_agent`: a second tool of the
   * same name would collide at registration, and more importantly the model
   * could not tell which one to call. The split is by *vocabulary*, and the
   * descriptions on both sides say so: `interrupt_agent` = the subagents you
   * spawned inside your own conversation (ids from `list_agents`);
   * `interrupt_member` = the named teammates of the ai-buddy roster (names
   * from `list_team`).
   */
  const interruptMember = {
    name: 'interrupt_member',
    description:
      '中断一个团队成员当前正在执行的回合（按成员名）。回合会在最近的步骤边界停下，' +
      '收件箱里还没处理的消息保留；成员本身保持在线。只有领导者可以调用。' +
      '注意：这作用于 ai-buddy 团队名册中的成员（用 list_team 看名字）。' +
      '要中断你在自己对话里 spawn 出来的子智能体，用官方的 interrupt_agent（id 来自 list_agents）——' +
      '两者是不同的体系，互不通用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '要中断的成员名（见 list_team）。' },
        reason: { type: 'string', description: '可选：中断原因，会记录在动态里。' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: textOutput(
      {
        type: 'object',
        properties: {
          name: { type: 'string' },
          interrupted: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['name', 'interrupted'],
        additionalProperties: false,
      },
      (_args, value) => renderSummary([
        value.interrupted
          ? `已向 ${value.name} 发出中断：当前回合将在最近的步骤边界停下。`
          : `未中断 ${value.name}：${value.reason ?? '该成员当前没有正在运行的回合。'}`,
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      requireLeader(projectId, exec.agent)
      const name = requireString(args, 'name', '必须指定成员名')
      const reason = optionalString(args, 'reason') ?? ''

      const result = await teamRuntime.interrupt(projectId, name, reason)

      if (result.interrupted === true) {
        core.feed.post(store, config, projectId, {
          actor: actorOf(exec.agent),
          content: `领导者中断了 ${name} 正在执行的回合${reason ? `（${reason}）` : ''}。`,
          category: 'team.review',
          source: 'agent',
          meta: { member: name },
        })
      }

      return {
        name,
        interrupted: result.interrupted === true,
        // The schema is a plain string; map the machine reasons to readable
        // ones and never emit null.
        reason:
          result.reason === 'no_session' ? '该成员还没有会话。'
          : result.reason === 'not_running' ? '该成员当前没有正在运行的回合。'
          : result.reason === 'interrupt_unavailable' ? '宿主的子智能体服务不可用，无法中断。'
          : result.reason === 'interrupt_failed' ? '中断请求失败，详见服务端日志。'
          : reason,
      }
    },
  }

  // ------------------------------------------------------ 6. roster inspection

  const listTeam = {
    name: 'list_team',
    description:
      '查看 ai-buddy 团队名册：每个成员的角色、汇报关系、当前状态（工作中/等待人类/空闲/休眠/离线）和正在做的事。' +
      '领导者用它掌握全局；成员用它了解同事与自己的上级。' +
      '返回的成员名（如「小算」）用于 send_message_to_member / interrupt_member —— ' +
      '这些是 ai-buddy 团队体系，不是你在本对话里 spawn 的子智能体（那套用 list_agents / send_message / interrupt_agent）。',
    parameters: {
      type: 'object',
      properties: {
        includeStats: { type: 'boolean', description: '是否包含统计与最近审查，默认 true。' },
      },
      additionalProperties: false,
    },
    output: textOutput(
      {
        type: 'object',
        properties: {
          initialized: { type: 'boolean' },
          counts: { type: 'object' },
          members: { type: 'array', items: { type: 'object' } },
          hint: { type: 'string' },
        },
        required: ['initialized', 'members'],
        additionalProperties: false,
      },
      (_args, value) => renderSummary([
        value.initialized
          ? `团队 ${value.members.length} 人 — 工作中 ${value.counts?.working ?? 0}，` +
            `等待人类 ${value.counts?.waitingHuman ?? 0}，休眠 ${value.counts?.dormant ?? 0}，` +
            `空闲 ${value.counts?.idle ?? 0}`
          : (value.hint || '团队尚未初始化。'),
        ...value.members.map((m) => (
          `- ${m.name}${m.role === 'leader' ? '（领导者）' : ''} · ${m.status}` +
          `${m.currentTask ? ` · 正在：${m.currentTask}` : ''}` +
          `${m.reportsTo ? ` · 汇报给 ${m.reportsTo}` : ''}`
        )),
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const view = roster(projectId)
      const includeStats = asRecord(args).includeStats !== false
      return {
        initialized: view.initialized === true,
        counts: view.counts,
        members: view.members.map((m) => ({
          name: m.name,
          role: m.role,
          title: m.title,
          status: m.status,
          reportsTo: m.reportsTo ?? '',
          currentTask: m.currentTask ?? '',
          sessionId: m.sessionId ?? '',
          ...(includeStats
            ? { stats: m.stats, review: m.review, lastReviewAt: m.lastReviewAt ?? '' }
            : {}),
        })),
        hint: view.initialized === true
          ? ''
          : '团队尚未初始化。请人类在工作台点「初始化团队」创建 leader。',
      }
    },
  }

  return [
    sendMessage, awaitHumanReply,
    requestTeammate, approveRequest,
    removeMember, reviewMember,
    interruptMember,
    listTeam,
  ]
}

export const TEAM_TOOL_NAMES = [
  'send_message_to_member', 'await_human_reply',
  'request_teammate', 'approve_request',
  'remove_member', 'review_member',
  'interrupt_member',
  'list_team',
]

export { nowIso, clip }
