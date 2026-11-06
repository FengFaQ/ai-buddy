/**
 * ai-buddy — plugin entry.
 *
 * Responsibility split, so this file stays readable:
 *
 *   - the `Store` owns persistence (JSON truth + Markdown summaries);
 *   - `lib/core/*` owns domain rules (feed / plan / task / assets / locks /
 *     checkpoint / resume / prompts);
 *   - `lib/tools/` owns the model-facing surface;
 *   - `lib/web.js` owns the human surface;
 *   - **this file owns the wiring**: which service is optional, which timer
 *     drives which sweep, which Host event feeds which recovery path.
 *
 * Three decisions worth defending:
 *
 * 1. **No `Config` export.** A Loader-validated schema would unmount the whole
 *    plugin when a profile override carries one stale or misspelled key. The
 *    workbench would then vanish for a reason the user cannot see. Instead
 *    `resolveConfig` clamps and defaults, and the Settings tab writes live
 *    values. A workbench that loads with slightly wrong knobs beats one that
 *    does not load.
 *
 * 2. **Every service is optional.** `inject` names only what cannot be missing
 *    (none of it, in fact): each service is taken through `ctx.get(...)` and
 *    every use is guarded. A Host without `webServer` still gets the 20 tools.
 *
 * 3. **Recovery is driven by Host events where they exist and by one timer
 *    where they do not.** `turn/end` carries the precise `interrupted` signal
 *    §7.2 demands, so it is the primary input; `agent/request-error` carries the
 *    server rejection that §7.5 needs for the lock's second condition. The timer
 *    only does bookkeeping (lock expiry sweep, stable-window reset) and the
 *    post-restart resume pass, which by definition cannot be event-driven.
 */

import os from 'node:os'
import path from 'node:path'
import { resolveConfig, dataDirOf } from './config.js'
import { Store } from './store.js'
import { isNonEmptyString, clip, nowIso, parseSince } from './util.js'
import * as feed from './core/feed.js'
import * as plan from './core/plan.js'
import * as task from './core/task.js'
import * as assets from './core/assets.js'
import * as locks from './core/locks.js'
import * as checkpoint from './core/checkpoint.js'
import * as resume from './core/resume.js'
import * as prompts from './core/prompts.js'
import * as team from './core/team.js'
import * as requests from './core/requests.js'
import { createTeamRuntime } from './host/team-runtime.js'
import { createUserMessage, deliver } from './core/messages.js'
import { watchPass, WATCH_INTERVAL_MS } from './host/watch.js'
import { registerTools, jsonSafe as jsonSafeTeam } from './tools/index.js'
import { createTeamTools } from './tools/team.js'

export const name = 'ai-buddy'

/**
 * Timer cadences.
 *
 * The sweep is frequent because a stale execution lock blocks a peer; the
 * resume pass is slow because it must never look like a busy-loop to the user
 * watching the feed, and the stable-window check only matters in minutes.
 */
const SWEEP_INTERVAL_MS = 30_000
const RESUME_TICK_INTERVAL_MS = 60_000

/** The core modules, bundled so tools/web take one dependency, not eight. */
function coreBundle() {
  return { feed, plan, task, assets, locks, checkpoint, resume, prompts, team, requests }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig ?? {}, process.env)
  const log = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      /* logger is optional */
    }
  }

  // ------------------------------------------------------------------ store

  let store
  try {
    store = new Store({ dir: dataDirOf(config, process.env), config })
  } catch (error) {
    log(`ai-buddy: could not open the data directory: ${error?.message ?? error}`)
    return
  }
  ctx.effect(() => () => store.dispose(), 'ai-buddy: store')

  // --------------------------------------------------------- project/actor

  /**
   * The project a conversation belongs to.
   *
   * Resolution order is deliberate: an explicit task binding wins, because a
   * conversation that was handed a task must act inside THAT project even when
   * the process has several. Only when nothing is bound do we fall back to the
   * single default project — and a multi-project host returns undefined rather
   * than guessing, so a tool fails with a clear message instead of writing into
   * the wrong project's feed.
   */
  function projectIdFor(agent) {
    const conversationId = conversationIdOf(agent)
    if (isNonEmptyString(conversationId)) {
      for (const project of store.listProjects()) {
        const bound = store.readTasks(project.id).find((t) => t.conversationId === conversationId)
        if (bound !== undefined) return project.id
      }
    }
    const all = store.listProjects()
    return all.length === 1 ? all[0].id : undefined
  }

  /** The Host SessionId this agent runs on — the conversation id, verbatim. */
  function conversationIdOf(agent) {
    const id = agent?.id
    return isNonEmptyString(id) ? String(id) : undefined
  }

  /**
   * Actor identity: who is calling, as the name every module stores.
   *
   * `id` and `name` are deliberately the SAME string. Three modules compare
   * actor ids against stored names:
   *
   *   - `locks.request({ agent })` stores the holder as a name;
   *   - `plan.updateStatus` requires `actor.id === executionLock.holder`;
   *   - `assets.canRead` matches `allowedAgents` entries, which are names.
   *
   * Resolution order, most specific first:
   *
   *   1. **The team roster.** A team member's session id is bound to its seat
   *      (`team.bindSession`), so the session alone identifies the member.
   *      This is the path every real team call takes — and the one that used
   *      to be missing, which made every member (and the leader) resolve to
   *      `agent-session-`: the old fallback sliced the session id to 8 chars,
   *      and `session-…`.slice(0, 8) is exactly `"session-"`. The fallback
   *      below keeps that class of failure out of the name entirely.
   *   2. **The bound task's owner.** A conversation that was handed a task
   *      speaks as that task's owner.
   *   3. **The session id itself**, unsliced. A fallback that mangles the only
   *      durable identity the caller has is worse than no fallback: at least
   *      the raw session id is stable and greppable.
   */
  function actorFor(agent) {
    const sessionId = conversationIdOf(agent) ?? 'unknown'

    // 1. The team roster: a bound seat is the strongest identity.
    for (const project of store.listProjects()) {
      let teamState
      try {
        teamState = team.load(store, project.id)
      } catch {
        continue
      }
      if (teamState?.initialized !== true) continue
      const seat = (teamState.members ?? []).find((m) => m.sessionId === sessionId)
      if (seat !== undefined && isNonEmptyString(seat.name)) {
        return { type: 'agent', id: seat.name, name: seat.name, sessionId }
      }
    }

    // 2. The bound task's owner.
    const projectId = projectIdFor(agent)
    if (isNonEmptyString(projectId)) {
      const bound = store.readTasks(projectId).find((t) => t.conversationId === sessionId)
      if (bound !== undefined && isNonEmptyString(bound.ownerAgent)) {
        return { type: 'agent', id: bound.ownerAgent, name: bound.ownerAgent, sessionId }
      }
    }

    // 3. The session id itself, verbatim — never a mangled slice of it.
    return { type: 'agent', id: sessionId, name: sessionId, sessionId }
  }

  // ------------------------------------------------------------ tool wiring

  // The team runtime is created before the tools because the team tools call
  // into it; it resolves Host services lazily, so constructing it before those
  // services are ready is safe.
  const teamRuntime = createTeamRuntime(ctx, {
    store,
    config,
    core: coreBundle(),
    log,
  })

  const deps = {
    store,
    config,
    core: coreBundle(),
    log,
    actorFor,
    projectIdFor,
    conversationFor: conversationIdOf,
    teamRuntime,
  }

  ctx.effect(
    () => registerTools(ctx, deps),
    'ai-buddy: agent tools',
  )

  // The team tools are registered separately so a failure to build them cannot
  // take the original 20 down with it: the collaboration core must keep working
  // even if the organizational layer has a bad day.
  ctx.effect(() => {
    const tools = ctx.get('tools')
    if (tools === undefined || typeof tools.register !== 'function') return () => {}
    let definitions
    try {
      definitions = createTeamTools(deps)
    } catch (error) {
      log(`ai-buddy: could not build team tools: ${error?.message ?? error}`)
      return () => {}
    }
    const disposers = []
    for (const definition of definitions) {
      try {
        // Same lossless-JSON guard the base tools use; see lib/tools/index.js.
        const wrapped = {
          ...definition,
          async execute(args, exec) {
            return jsonSafeTeam(await definition.execute(args, exec))
          },
        }
        disposers.push(tools.register(wrapped))
      } catch (error) {
        log(`ai-buddy: failed to register team tool ${definition.name}: ${error?.message ?? error}`)
      }
    }
    return () => {
      for (const disposer of disposers) {
        try {
          disposer()
        } catch {
          /* already gone */
        }
      }
    }
  }, 'ai-buddy: team tools')

  // ------------------------------------------------------- system prompt §7

  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'ai-buddy',
          // Placed late: the collaboration rules are an overlay on the general
          // instructions and must not outrank the agent's own constitution.
          order: 900,
          text: () => prompts.sectionBody(config),
        }),
      'ai-buddy: prompt section',
    )
  })

  // -------------------------------------------------------- web workbench §4

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      let dispose
      try {
        // Loaded lazily so a missing/half-written web module cannot stop the
        // tools from mounting — the agent surface is the load-bearing half.
        const register = async () => {
          try {
            const module = await import('./web.js')
            const disposer = module.registerWeb(webCtx, {
              store,
              config,
              core: coreBundle(),
              projectIdFor,
              actorFor,
              log,
              getConfig: () => config,
              teamRuntime,
            })
            dispose = typeof disposer === 'function' ? disposer : () => {}
          } catch (error) {
            log(`ai-buddy: workbench routes unavailable: ${error?.message ?? error}`)
          }
        }
        register()
      } catch (error) {
        log(`ai-buddy: workbench import failed: ${error?.message ?? error}`)
      }
      return () => {
        try {
          dispose?.()
        } catch {
          /* already gone */
        }
      }
    }, 'ai-buddy: workbench routes')
  })

  // ------------------------------------------- recovery inputs (§7.1, §7.5)

  /** Per-conversation in-memory retry bookkeeping, never persisted. */
  const retryState = new Map()

  /**
   * The precise `interrupted` signal.
   *
   * `turn/end` reasons are a closed set. Only `interrupted` means "the process
   * or transport died mid-turn", which is what §7.2 licenses a resume for.
   * `aborted` is the user pressing stop — resuming it would fight the human.
   * `error` is handled by the request-error path with its own classification.
   */
  function watchTurnEnd(agent, session, event) {
    if (event?.type !== 'turn/end') return
    const reason = event.data?.reason
    const kind = reason?.kind
    const conversationId = conversationIdOf(agent)
    const projectId = projectIdFor(agent)
    if (!isNonEmptyString(projectId) || !isNonEmptyString(conversationId)) return

    // Team status is derived from the same signal, before any early return: a
    // member that finished a turn is idle regardless of why the turn ended, and
    // the roster is the thing the workbench reads to answer "what is each AI
    // doing right now".
    syncMemberActivity(projectId, conversationId, kind)

    if (kind === 'interrupted') {
      resume.recordResumeAttempt(store, config, projectId, conversationId, {
        attemptId: `turn-${event.data?.turn ?? '?'}`,
        outcome: 'interrupted_again',
        failure: { code: 'interrupted', message: '回合被意外中断' },
      })
      return
    }
    if (kind === 'completed') {
      // A completed turn proves the conversation is healthy, but it is not yet
      // "stable": the reset belongs to the stable window (§7.5 counting rules),
      // otherwise a conversation that completes one turn then dies again would
      // never accumulate a failure count.
      resume.recordStable(store, config, projectId, conversationId)
      return
    }
    if (kind === 'aborted') {
      // Remember that the human stopped it, so the post-restart pass skips it.
      const state = retryState.get(conversationId) ?? {}
      retryState.set(conversationId, { ...state, userAbortedAt: Date.now() })
    }
  }

  /**
   * Keep the roster's per-member state in step with the live session.
   *
   * A `turn/start` means "working"; any `turn/end` means "not working any more".
   * Sticky states are left alone: a member parked for a human must not be
   * flipped to `idle` by its own last turn ending, because the reason it is
   * waiting has nothing to do with that turn.
   */
  function syncMemberActivity(projectId, conversationId, kind) {
    try {
      const current = team.load(store, projectId)
      if (current.initialized !== true) return
      const seat = current.members.find((m) => m.sessionId === conversationId)
      if (seat === undefined) return
      if (seat.status === 'dormant' || seat.status === 'waiting_human') return
      const nextStatus = kind === 'turn-start' ? 'working' : 'idle'
      if (seat.status !== nextStatus) {
        team.setStatus(store, projectId, { name: seat.name, status: nextStatus })
      }
    } catch (error) {
      log(`ai-buddy: member activity sync failed: ${error?.message ?? error}`)
    }
  }

  /**
   * Server-rejection classification for the interruption lock's second
   * condition (§7.5).
   *
   * A transient blip must not arm the lock; only a rejection that will recur on
   * the next identical attempt may. `classifyFailure` holds that judgement, so
   * this listener never re-implements it.
   */
  function watchRequestError(agent, payload) {
    const failure = payload?.failure
    if (failure === undefined || failure === null) return
    const conversationId = conversationIdOf(agent)
    const projectId = projectIdFor(agent)
    if (!isNonEmptyString(projectId) || !isNonEmptyString(conversationId)) return
    const classification = resume.classifyFailure(failure)
    const state = retryState.get(conversationId) ?? {}
    retryState.set(conversationId, {
      ...state,
      lastFailure: {
        code: failure.code,
        message: failure.message,
        status: failure.status,
        classification,
        at: Date.now(),
      },
    })
    if (classification === 'dead_end') {
      resume.recordResumeAttempt(store, config, projectId, conversationId, {
        attemptId: `req-${failure.requestId ?? Date.now()}`,
        outcome: 'rejected',
        failure,
      })
    }
  }

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    try {
      // `agent/created` fires for every live agent; the per-agent listener is
      // registered on agent.ctx so it disappears with the agent.
      const agentCtx = agent.ctx
      if (agentCtx === undefined || typeof agentCtx.effect !== 'function') return
      agentCtx.effect(
        () =>
          agentCtx.on('session/event', (session, event) => {
            try {
              watchTurnEnd(agent, session, event)
            } catch (error) {
              log(`ai-buddy: turn-end handler failed: ${error?.message ?? error}`)
            }
          }),
        'ai-buddy: turn-end watcher',
      )
      agentCtx.effect(
        () =>
          agentCtx.on('agent/request-error', (eventPayload) => {
            try {
              watchRequestError(agent, eventPayload)
            } catch (error) {
              log(`ai-buddy: request-error handler failed: ${error?.message ?? error}`)
            }
          }),
        'ai-buddy: request-error watcher',
      )
    } catch (error) {
      log(`ai-buddy: agent watcher setup failed: ${error?.message ?? error}`)
    }
  })

  // ---------------------------------------------------------------- timers

  const startedAt = Date.now()

  /**
   * Register a repeating task through the Host's timer service.
   *
   * The service is taken with `ctx.get('timer')` rather than `ctx.interval`:
   * the Cordis getter form throws "cannot get property timer without inject"
   * when `timer` is not in this plugin's `inject` list, and adding a hard
   * `inject: ['timer']` would keep the whole plugin inactive in a profile that
   * legitimately omits the timer row. Degrading to "no periodic work" is the
   * right trade: every sweep is also reachable from a tool call, so losing the
   * timer costs freshness, never correctness.
   */
  function every(label, delay, callback) {
    const timer = ctx.get('timer')
    if (timer === undefined || typeof timer.interval !== 'function') {
      log(`ai-buddy: timer service unavailable; ${label} disabled`)
      return
    }
    ctx.effect(() => timer.interval(callback, delay), `ai-buddy: ${label}`)
  }

  /**
   * Re-spawn seats that lost their live agent.
   *
   * A plugin reload, a Host restart, or an agent that was released all leave a
   * seat with a `sessionId` but no live agent. The roster would then show a team
   * that exists on paper and cannot act — the worst state for this feature,
   * because the human sees members and assumes they are working.
   *
   * So on activation the team is reconciled once: every seat whose session is
   * gone gets a fresh session, in roster order, leader first. It is deliberately
   * NOT automatic on every tick: a member that a human put to sleep must stay
   * asleep, and silently re-spawning it would fight that decision.
   *
   * **But it is opt-in.** `config.team.autoSpawn` defaults to `false`, because
   * enabling this plugin must not open conversations on its own: a session is a
   * real, billable conversation with a real model. With the default, a seat
   * comes to life only when the human asks for it — by initializing the team,
   * by mentioning a member, or by waking one from the team panel.
   */
  async function reconcileTeamSeats() {
    if (teamRuntime === undefined) return
    if (config.team?.autoSpawn !== true) {
      log('ai-buddy: automatic session creation is off (team.autoSpawn); seats wake on demand')
      return
    }
    for (const project of store.listProjects()) {
      let teamState
      try {
        teamState = team.load(store, project.id)
      } catch (error) {
        log(`ai-buddy: could not read the team roster for ${project.id}: ${error?.message ?? error}`)
        continue
      }
      if (teamState.initialized !== true) continue

      for (const seat of teamState.members) {
        // A dormant seat is an instruction, not an accident: leave it alone.
        if (seat.status === 'dormant' || seat.status === 'waiting_human') continue
        const live = seat.sessionId === null ? undefined : teamRuntime.findAgent(seat.sessionId)
        if (live !== undefined) continue
        try {
          const spawned = await teamRuntime.spawn(project.id, seat.name)
          log(`ai-buddy: re-spawned ${seat.name} (${spawned.sessionId}) after activation`)
        } catch (error) {
          log(`ai-buddy: could not re-spawn ${seat.name}: ${error?.message ?? error}`)
        }
      }
    }
  }

  // Runs once, shortly after activation: the Host's agent factory is registered
  // by another plugin and may not be available in the same tick as this one.
  let reconciled = false
  every('team reconcile', 8_000, () => {
    if (reconciled) return
    reconciled = true
    reconcileTeamSeats().catch((error) => {
      log(`ai-buddy: team reconcile failed: ${error?.message ?? error}`)
    })
  })

  /**
   * The leader's background watch.
   *
   * Split out of `index.js` into `lib/host/watch.js` because it is a different
   * kind of work from the wiring above: it decides *policy* (who to wake, when
   * to speak up) rather than *plumbing*. Two jobs run on this cadence:
   *
   *   - wake members a human mentioned while they were not running, and
   *   - let the leader's coordinator report conditions worth acting on.
   *
   * It is intentionally slower than the lock sweep: nothing here is urgent to
   * the second, and each pass can start an agent turn — which costs real tokens.
   */
  const watchDeps = {
    store,
    config,
    log,
    teamCore: team,
    teamRuntime,
    feed,
    planCore: plan,
    requestsCore: requests,
  }
  let watchBusy = false
  every('leader watch', WATCH_INTERVAL_MS, () => {
    if (watchBusy) return
    watchBusy = true
    watchPass(ctx, watchDeps)
      .catch((error) => log(`ai-buddy: watch pass failed: ${error?.message ?? error}`))
      .finally(() => { watchBusy = false })
  })

  /**
   * Lock bookkeeping.
   *
   * Deliberately cheap and unconditional: an execution right nobody refreshed
   * must not outlive its timeout, and the interruption lock's stable window is
   * the only thing that ever resets a failure count without a human.
   */
  every('lock sweep', SWEEP_INTERVAL_MS, () => {
    try {
      for (const project of store.listProjects()) {
        const released = locks.sweep(store, config, project.id)
        for (const taskId of released) {
          const bound = store.readTasks(project.id).find((t) => t.id === taskId)
          if (bound?.conversationId) {
            resume.recordStable(store, config, project.id, bound.conversationId)
          }
        }
        for (const state of store.listResumeStates(project.id)) {
          if (!isNonEmptyString(state?.conversationId)) continue
          resume.recordStable(store, config, project.id, state.conversationId)
        }
      }
    } catch (error) {
      log(`ai-buddy: sweep failed: ${error?.message ?? error}`)
    }
  })

  /**
   * The post-restart resume pass.
   *
   * This is the only place a resume message is injected without a human in the
   * loop, so every boundary §7.2 lists is applied before the first candidate is
   * even considered: the silent window, the activity window, the user-abort
   * memory, the sliding auto-resume cap, the resume lock, and the interruption
   * lock.
   */
  let resumePassDone = false
  every('resume pass', RESUME_TICK_INTERVAL_MS, () => {
    const elapsed = Date.now() - startedAt
    if (!resumePassDone) {
      if (elapsed < config.resume.silentWindowMs) return
      resumePassDone = true
    }
    /**
     * The sweep is awaited, and the timer callback never returns a rejected
     * promise.
     *
     * `timer.interval` calls this callback on its own schedule; if the
     * callback returned a rejected promise, that rejection would be
     * unhandled — and Node's default `--unhandled-rejections=throw` turns it
     * into an uncaught exception that ends the Host process. The `.catch()`
     * below is what keeps a failed recovery sweep a *logged* event.
     */
    runResumePass().catch((error) => {
      log(`ai-buddy: resume pass failed: ${error?.message ?? error}`)
    })
  })

  /**
   * One restart-recovery sweep.
   *
   * This is **async on purpose**. The injection below awaits
   * `resume.injectResume`, and an un-awaited async call turns any rejection
   * into an *unhandled promise rejection* — which Node escalates to an
   * uncaught exception, ending the Host process. A resume must never be able
   * to do that, so the whole sweep is awaited by its caller and every
   * rejection stays inside a `try/catch`.
   */
  async function runResumePass() {
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.list !== 'function') return
    const live = agents.list()
    if (live.length === 0) return

    for (const project of store.listProjects()) {
      const candidates = resume.planResume(store, config, {
        now: Date.now(),
        restartAt: startedAt,
        isRunning: (sessionId) => {
          const agent = live.find((a) => String(a.id) === String(sessionId))
          return agent !== undefined && agent.status === 'running'
        },
        sessionLastActivityAt: () => {
          // DSH exposes no cross-session activity timestamp to a plugin without
          // subscribing to every session's log, so the persisted resume state
          // is the activity signal: a conversation only has a resume record
          // because something actually happened in it.
          return Date.now()
        },
        wasUserAborted: (sessionId) => {
          const state = retryState.get(sessionId)
          if (state?.userAbortedAt === undefined) return false
          return Date.now() - state.userAbortedAt < config.resume.activeWindowMs
        },
      })

      for (const candidate of candidates) {
        const conversationId = candidate.conversationId
        const agent = live.find((a) => String(a.id) === String(conversationId))
        if (agent === undefined) continue

        const lock = resume.acquireResumeLock(store, project.id, conversationId, 'auto-restart')
        if (lock?.acquired !== true) continue

        try {
          const brief = resume.brief(store, config, project.id, conversationId)
          feed.post(store, config, project.id, {
            actor: { type: 'system', id: 'ai-buddy', name: 'ai-buddy' },
            content: `恢复开始（重启后自动续跑）：来自检查点 ${brief?.checkpoint?.checkpoint_id ?? '无'}，已核对交叉模块状态。`,
            category: 'resume.start',
            source: 'auto',
            taskId: store.readTasks(project.id).find((t) => t.conversationId === conversationId)?.id,
          })
          /**
           * **This must be awaited.**
           *
           * `injectResume` is async, and the `try/catch` around it only sees a
           * *synchronous* throw. Without the `await`, a rejection became an
           * unhandled promise rejection — and Node's default
           * `--unhandled-rejections=throw` turns that into an uncaught
           * exception, which terminates the Host process. That is precisely how
           * this plugin took DSH down twice: the fault was raised inside the
           * Host's agent loop (`message "undefined" is already pending`) and
           * nothing on this side could contain it.
           *
           * A resume is a convenience. It must never be able to end the Host.
           */
          await resume.injectResume(agent, brief, {
            createUserMessage: createUserMessageFactory(conversationId),
            deliver,
          })
        } catch (error) {
          log(`ai-buddy: resume injection failed for ${conversationId}: ${error?.message ?? error}`)
          resume.recordResumeAttempt(store, config, project.id, conversationId, {
            attemptId: `pass-${Date.now()}`,
            outcome: 'rejected',
            failure: { code: 'resume_inject_failed', message: String(error?.message ?? error) },
          })
        } finally {
          resume.releaseResumeLock(store, project.id, conversationId, 'auto-restart')
        }
      }
    }
  }

  /**
   * Build the `UserMessage` a resume injects.
   *
   * The shape is owned by `lib/host/messages.js`, and the reasoning there is
   * load-bearing: `agent.followup()` keys the Host's pending inbox by
   * `message.id`, and a message without one makes the Host throw
   * `message "undefined" is already pending` from inside the agent loop — past
   * any handler this plugin could install, so the whole Host process exits.
   * The same missing field makes the stored session unreadable
   * (`session event at seq N lacks an identified message`).
   *
   * The shape is replicated rather than imported because this plugin has no
   * module path to `@deepseek-ai/dsh-llm` (bundled packages resolve from the dsh
   * installation, not the profile). `id` is a plain UUID v4, which is exactly
   * what the Host writes.
   */
  function createUserMessageFactory(conversationId) {
    return (text) => createUserMessage(text, `ai-buddy-resume-${String(conversationId).slice(0, 8)}`)
  }

  // ------------------------------------------------------------ public API

  return {
    store,
    config,
    projectIdFor,
    actorFor,
    /** Exposed for the workbench and for tests; not part of the tool surface. */
    core: coreBundle(),
  }
}

export { resolveConfig, dataDirOf }
