/**
 * The leader's background watch (§ discussion logic, § sub-agent team).
 *
 * Two jobs, both invisible to the human until something needs them:
 *
 * 1. **Mention watchdog.** When a human `@`s a member that is not running, the
 *    leader wakes it. The mention route already tries to deliver, so this covers
 *    the cases that path cannot: a delivery that found no session, a member that
 *    slept after the mention, a mention posted by an agent instead of a human.
 *
 * 2. **Coordinator sub-agent.** The leader should not poll the plan and feed
 *    itself — that burns the leader's context on listening. Instead a dedicated
 *    *coordinator* seat under the leader does the watching, and reports only when
 *    there is something to report. It also owns the waiting: any task that needs
 *    to wait on a human or on another agent is handed to the coordinator, so the
 *    leader stays free to make decisions.
 *
 * The coordinator is an ordinary team member with `role: 'coordinator'`, which
 * keeps it inside the same roster, the same wake/sleep machinery, and the same
 * permission model as everyone else. Inventing a parallel "sub-agent" concept
 * outside the roster would duplicate all of that.
 */

import { clip, isNonEmptyString, nowIso } from '../util.js'

/** How often the leader's watch runs. */
export const WATCH_INTERVAL_MS = 30_000

/**
 * Create (or reuse) the leader's coordinator seat.
 *
 * Idempotent: called on every team start and after every reconcile. A team that
 * already has its coordinator is left untouched.
 */
export async function ensureCoordinator(ctx, deps, projectId) {
  const { store, log, teamCore, teamRuntime, feed } = deps
  let team
  try {
    team = teamCore.load(store, projectId)
  } catch (error) {
    log?.(`ai-buddy watch: could not read roster for ${projectId}: ${error?.message ?? error}`)
    return undefined
  }
  if (team.initialized !== true) return undefined

  const existing = team.members.find((m) => m.role === 'coordinator')
  if (existing !== undefined) {
    // Re-spawn if its session went away; otherwise leave it alone.
    if (isNonEmptyString(existing.sessionId) && teamRuntime.findAgent(existing.sessionId) !== undefined) {
      return existing
    }
    try {
      await teamRuntime.wake(projectId, existing.name)
      return teamCore.member(teamCore.load(store, projectId), existing.name)
    } catch (error) {
      log?.(`ai-buddy watch: could not wake the coordinator: ${error?.message ?? error}`)
      return existing
    }
  }

  const leader = teamCore.leader(team)
  if (leader === undefined) return undefined
  const name = teamCore.suggestMemberName(team, '调度')

  let seat
  try {
    seat = teamCore.addMember(store, projectId, {
      name,
      title: '后台调度：监控计划与讨论，处理等待类事务，及时向 leader 汇报',
      reportsTo: leader.name,
      role: 'coordinator',
    })
  } catch (error) {
    log?.(`ai-buddy watch: could not add the coordinator: ${error?.message ?? error}`)
    return undefined
  }

  const coordinator = teamCore.member(seat, name)
  try {
    const spawned = await teamRuntime.spawn(projectId, name, {
      prompt: coordinatorBrief(name, leader.name),
    })
    log?.(`ai-buddy watch: coordinator ${name} started (${spawned.sessionId})`)
  } catch (error) {
    log?.(`ai-buddy watch: coordinator spawn failed: ${error?.message ?? error}`)
  }

  try {
    feed.post(store, store.config ?? {}, projectId, {
      actor: { type: 'system', id: 'ai-buddy', name: 'ai-buddy' },
      content: `已为 leader 启动后台调度员 ${name}：它负责监控计划与讨论、处理等待类事务，并在有情况时向 leader 汇报。`,
      category: 'team.join',
      source: 'auto',
    })
  } catch { /* feed is best-effort here */ }

  return coordinator
}

/** The prompt the coordinator receives. */
function coordinatorBrief(selfName, leaderName) {
  return [
    `你是团队的后台调度员 **${selfName}**，直接向领导者 **${leaderName}** 汇报。`,
    '',
    '你的职责是「监听」和「等待」，不是做业务：',
    '',
    '1. **监控**：定期用 read_feed / read_plan / list_team 检查动态、计划和成员状态。',
    '2. **通报**：只在出现下列情况时，用 send_message_to_member 向 leader 汇报，不要刷屏：',
    '   - 有计划条目被阻塞或逾期',
    '   - 有成员长时间无进展，或状态异常（被锁、离线）',
    '   - 有新的协作请求等待裁决',
    '   - 人类在动态里 @ 了某个未在运行的成员（这类由你立即唤醒它，并告知 leader）',
    '3. **等待类事务**：凡是需要等待人类回复或等待其他 AI 完成的事项，都由你接管跟踪；' +
    '   确认完成后回报 leader，leader 不必自己空等。',
    '4. 你自己**不要**直接做业务任务，也不要替成员写代码或改文件。',
    '',
    '工作节奏：收到唤醒就检查一轮；没事就调用 await_human_reply 或直接结束回合，不要空转。',
    '汇报要短：一句话说清「发生了什么、需要 leader 做什么」。',
  ].join('\n')
}

/**
 * Wake members that a human mentioned but that are not running.
 *
 * Reads the recent feed for `@name` from human events, checks whether that seat
 * is live, and re-delivers if not. Deliberately bounded: only the most recent
 * window, and each mention is only retried when the seat is genuinely down —
 * re-delivering to a working member would duplicate the instruction.
 */
export async function wakeMentioned(ctx, deps, projectId) {
  const { store, log, teamCore, teamRuntime, feed } = deps
  let team
  try {
    team = teamCore.load(store, projectId)
  } catch {
    return []
  }
  if (team.initialized !== true) return []

  const now = Date.now()
  let events = []
  try {
    events = feed.read(store, store.config ?? {}, projectId, { limit: 40 })
  } catch {
    return []
  }

  // Only human-authored mentions in the last 30 minutes: an agent mentioning a
  // peer is the peer's business, and old mentions have already been handled.
  const recent = events.filter((e) => {
    if (e?.actor?.type !== 'human') return false
    const at = Date.parse(e.at ?? '')
    if (!Number.isFinite(at) || now - at > 30 * 60 * 1000) return false
    return typeof e.content === 'string' && e.content.includes('@')
  })

  const woken = []
  for (const event of recent) {
    const mention = String(event.meta?.mention ?? '')
      || (event.content.match(/@([^\s，。,.!?！？]+)/) ?? [])[1]
      || ''
    if (mention === '' || mention === 'human') continue

    const seat = team.members.find((m) => m.name === mention)
    if (seat === undefined) continue
    if (seat.role === 'leader') continue

    const isLive = isNonEmptyString(seat.sessionId) && teamRuntime.findAgent(seat.sessionId) !== undefined
    const isParked = seat.status === 'dormant' || seat.status === 'waiting_human'
    // A live, working member already received the mention when it was posted.
    if (isLive && !isParked) continue

    try {
      const result = await teamRuntime.send(projectId, {
        to: mention,
        content: `[补投] 人类在动态里 @ 了你：${clip(event.content, 400)}\n请立即处理，并在动态里回应。`,
        from: 'coordinator',
      })
      if (result?.delivered === true) {
        woken.push(mention)
        log?.(`ai-buddy watch: woke ${mention} for a missed mention`)
        try {
          feed.post(store, store.config ?? {}, projectId, {
            actor: { type: 'system', id: 'ai-buddy', name: 'ai-buddy' },
            content: `@${mention} 当时未在运行，已由调度唤醒并补投人类的指令。`,
            category: 'team.message',
            source: 'auto',
          })
        } catch { /* best effort */ }
      }
    } catch (error) {
      log?.(`ai-buddy watch: could not wake ${mention}: ${error?.message ?? error}`)
    }
  }
  return woken
}

/**
 * The last state each project's coordinator reported, keyed by project id.
 *
 * BUG-4 in the field report: with a stuck state (a blocked plan item nobody
 * can fix, a pending request nobody adjudicates), the 30-second watch
 * re-delivered the *same* findings to the leader every pass — 11+ identical
 * messages, each one a real model turn. The state had not changed; only the
 * clock had.
 *
 * So a report is sent only when the findings **differ** from the previous
 * pass. A finding that persists silently is correct behaviour: the human sees
 * it in the workbench's plan and request panels, and the leader already has
 * it in context.
 */
const lastReportedFindings = new Map()

/**
 * Report conditions the leader should act on.
 *
 * Bounded to genuine problems: a blocked plan item, a request awaiting
 * adjudication, a member stuck offline. This is the coordinator's "tell the
 * leader something happened" path, so it must stay quiet when nothing is wrong.
 */
export async function reportToLeader(ctx, deps, projectId) {
  const { store, config, log, teamCore, teamRuntime, feed, planCore, requestsCore } = deps
  let team
  try {
    team = teamCore.load(store, projectId)
  } catch {
    return false
  }
  if (team.initialized !== true) return false
  const leader = teamCore.leader(team)
  if (leader === undefined || !isNonEmptyString(leader.name)) return false

  const findings = []

  try {
    const items = planCore.read(store, config, projectId, {})
    const blocked = items.filter((i) => (i.blockedBy ?? []).length > 0 && i.status !== 'done')
    const locked = items.filter((i) => i.status === 'locked_by_interrupt')
    if (locked.length > 0) findings.push(`${locked.length} 个计划条目因中断锁定而停摆，需要人类解锁`)
    else if (blocked.length > 0) findings.push(`${blocked.length} 个计划条目被上游阻塞`)
  } catch { /* plan unavailable */ }

  try {
    const pending = requestsCore.list(store, projectId, { status: 'pending' })
    if (pending.length > 0) {
      findings.push(`${pending.length} 个协作请求等待裁决：${pending.map((r) => r.title).join('、')}`)
    }
  } catch { /* requests unavailable */ }

  const offline = team.members.filter(
    (m) => m.role === 'member' && m.status === 'offline',
  )
  if (offline.length > 0) {
    findings.push(`${offline.map((m) => m.name).join('、')} 当前离线`)
  }

  if (findings.length === 0) {
    lastReportedFindings.delete(projectId)
    return false
  }

  /**
   * Suppress an unchanged report. The signature is the findings themselves, so
   * any real change — a new blocker, a request resolved, a member back online
   * — produces a new signature and gets through.
   */
  const signature = findings.join('\n')
  if (lastReportedFindings.get(projectId) === signature) return false

  /**
   * Only report to a leader that is **already running**.
   *
   * `teamRuntime.send` wakes its target, and waking a seat that never had a
   * session *spawns* one — a real conversation with a real model. A background
   * watch has no business opening one: it would turn "enable the plugin" into
   * "spend quota every 30 seconds".
   *
   * So the report is delivered only when the leader has a live agent. If it
   * does not, the findings are simply not delivered — the human sees them in
   * the workbench's recovery and plan panels anyway.
   */
  const leaderSession = leader.sessionId
  if (!isNonEmptyString(leaderSession)) return false
  if (teamRuntime.findAgent(leaderSession) === undefined) return false

  try {
    const result = await teamRuntime.send(projectId, {
      to: leader.name,
      content: `后台调度报告：\n${findings.map((f) => `- ${f}`).join('\n')}\n\n请决定如何处理。`,
      from: 'coordinator',
    })
    if (result?.delivered === true) {
      // Record the signature only after delivery actually happened: a failed
      // send must be retried on the next pass, not suppressed by it.
      lastReportedFindings.set(projectId, signature)
      log?.(`ai-buddy watch: reported ${findings.length} finding(s) to ${leader.name}`)
      return true
    }
  } catch (error) {
    log?.(`ai-buddy watch: report to leader failed: ${error?.message ?? error}`)
  }
  return false
}

/**
 * Run one full watch pass over every initialized project.
 *
 * The watch is **policy**, and it is gated on the human's consent:
 *
 *   - `ensureCoordinator` creates a seat *and* a live session, so it runs only
 *     when `team.autoSpawn` is on;
 *   - `wakeMentioned` re-delivers a human `@mention` to a member that was not
 *     running — which starts a conversation, so it needs its own opt-in
 *     (`team.autoWakeMentions`);
 *   - `reportToLeader` only *reads* state and posts to the feed, so it is
 *     always safe.
 *
 * With both flags off (the default) the watch still runs, but it can only
 * observe. That is the point: enabling this plugin must not spend the user's
 * model quota without being asked.
 */
export async function watchPass(ctx, deps) {
  const { store, log, config } = deps
  const autoSpawn = config?.team?.autoSpawn === true
  const autoWake = config?.team?.autoWakeMentions === true

  for (const project of store.listProjects()) {
    try {
      if (autoSpawn) await ensureCoordinator(ctx, deps, project.id)
      if (autoWake) await wakeMentioned(ctx, deps, project.id)
      await reportToLeader(ctx, deps, project.id)
    } catch (error) {
      log?.(`ai-buddy watch: pass failed for ${project.id}: ${error?.message ?? error}`)
    }
  }
}

export { nowIso }
