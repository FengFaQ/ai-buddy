/**
 * Prompt text for the recovery subsystem (§6.8).
 *
 * This module is the *entire* mitigation for the failure mode the brief calls
 * out: an interrupted conversation coming back with "继续" and cheerfully
 * redoing work that already landed — a duplicate handoff, a second post to the
 * feed, an asset overwrite that clobbers another agent's edits.
 *
 * So `resumeMessage` is not a nudge, it is a checklist. A resumed agent is
 * running with no memory of the turn that died; the only way it can be safe is
 * to reconstruct the world from the four modules the workbench shares. Five
 * steps, because each one covers a module the agent cannot see from its own
 * transcript:
 *
 *   1. feed      — what other AIs did while it was gone (and whether a human
 *                  left an instruction that outranks its plan)
 *   2. plan      — whether its item still exists, who owns it, whether an
 *                  upstream dependency is still open
 *   3. assets    — whether the blob it was about to write moved or vanished
 *   4. rights    — whether it still holds the execution right at all; acting
 *                  without it is the collision the lock model exists to stop
 *   5. workspace — whether its own local state (files, git, background jobs)
 *                  already contains the work, which is the one source of truth
 *                  no other module can check for it
 *
 * The idempotency verdict (§7.3) is rendered as an explicit instruction, because
 * "confirmed" and "unconfirmed" demand opposite behaviour and an agent that has
 * to infer the difference will guess wrong in the expensive direction.
 *
 * Both renderers are pure string builders: no store access, no clock, no I/O,
 * so the tests can assert on the exact rendered text.
 */

import { clip, asRecord, asStringArray, isNonEmptyString } from '../util.js'

const SEP = '─'.repeat(46)

function line(...parts) {
  return parts.filter((part) => part !== undefined && part !== null && part !== '').join('')
}

function actorName(actor) {
  if (actor === null || actor === undefined) return 'unknown'
  if (typeof actor === 'string') return actor
  return actor.name ?? actor.id ?? 'unknown'
}

function bullet(text) {
  return `  · ${text}`
}

/**
 * Render one feed event for the brief. Compact on purpose: the resuming agent
 * needs to know *who* did *what*, and the full text if it was a human
 * instruction — everything else it can re-read with the feed tool.
 */
function feedLine(event) {
  const at = typeof event?.at === 'string' ? event.at.replace('T', ' ').slice(0, 19) : '?'
  const actor = actorName(event?.actor)
  const kind = event?.kind ?? 'member'
  const pinned = event?.pinned ? ' [需人工关注]' : ''
  return `  · [${at}] ${actor}（${kind}/${event?.category ?? '?'}）${pinned}${clip(event?.content ?? '', 240)}`
}

function planLine(id, item) {
  const flags = []
  if (Array.isArray(item.blockedBy) && item.blockedBy.length > 0) flags.push(`阻塞于 ${item.blockedBy.join('、')}`)
  if (item.changedSinceCheckpoint) flags.push(`checkpoint 时为 ${item.checkpointStatus}`)
  const suffix = flags.length > 0 ? ` — ${flags.join('；')}` : ''
  return `  · ${item.id}「${item.title}」状态=${item.status} 负责=${item.assignee ?? '未指派'}${suffix}`
}

function assetLine(change) {
  if (change.kind === 'deleted') {
    return `  · ${change.assetId}「${change.name}」已被删除（v${change.from}）`
  }
  if (change.kind === 'added') {
    return `  · ${change.assetId}「${change.name}」新增 v${change.to}`
  }
  return `  · ${change.assetId}「${change.name}」版本 v${change.from} → v${change.to}`
}

/**
 * The idempotency instruction. The action decides the imperative; the table in
 * `resume.js` decides the action. Keeping the mapping here (and only here)
 * means the matrix can be edited without hunting for prose in four places.
 */
function verdictBlock(idempotency) {
  const verdict = asRecord(idempotency)
  const action = verdict.action ?? 'verify_first'
  const type = verdict.evidence?.operationType ?? 'unknown'
  const ref = verdict.evidence?.targetRef ?? null
  const status = verdict.evidence?.resultStatus ?? 'unconfirmed'
  const target = ref === null || ref === undefined ? '（未指定目标）' : String(ref)

  const instructions = {
    skip: [
      '动作：skip —— **do not repeat**（不要重复执行）。该操作已确认生效。',
      '如果你认为还需要继续，先说明为什么现有结果不满足要求，再请求人工确认。',
    ],
    verify_first: [
      '动作：verify_first —— **verify first, do not repeat**（先核对，再决定是否执行）。',
      '先用工具读取真实状态；只有在核对后确认操作未生效时才可重做，并在动态中说明核对依据。',
    ],
    retry: [
      '动作：retry —— 该操作没有生效，可以在核对后重做一次。',
      '重做前仍须完成下面的五项核对，避免把「没生效」误判成「没做过」。',
    ],
    request_human: [
      '动作：request_human —— **request human decision**（请求人工裁决）。',
      '状态已被其他参与者改变，不要擅自覆盖；把冲突点写清楚，等人工作出决定。',
    ],
  }
  const chosen = instructions[action] ?? instructions.verify_first

  return [
    '## 幂等判定（必须先读）',
    '',
    `- 上次操作：${type} → 目标 ${target}`,
    `- 实际状态：${status}`,
    `- 判定依据：${clip(String(verdict.detail ?? verdict.reason ?? ''), 400)}`,
    ...chosen.map((text) => `- ${text}`),
    '',
  ]
}

/**
 * The injected message. See the module header for why it is shaped this way.
 *
 * Never returns a bare "继续": the five verification steps and the verdict
 * block are emitted unconditionally, and a missing/partial brief still renders
 * the full checklist (an agent resumed with less context needs it *more*).
 */
export function resumeMessage(brief) {
  const b = asRecord(brief)
  const task = asRecord(b.task)
  const feed = asRecord(b.feed)
  const plan = asRecord(b.plan)
  const assets = asRecord(b.assets)
  const exec = asRecord(b.executionLock)
  const interrupt = asRecord(b.interruptLock)

  const taskLabel = isNonEmptyString(task.title) ? `「${task.title}」` : ''
  const conversationId = isNonEmptyString(b.conversationId) ? b.conversationId : '（未知会话）'
  const checkpointId = isNonEmptyString(b.checkpointId) ? b.checkpointId : '（无 checkpoint）'
  const sinceCount = Number(feed.sinceCount ?? asFeedCount(feed)) || 0

  const out = []
  out.push('【中断恢复】此前这一轮对话被意外中断（不是用户主动停止），现在需要你接续。')
  out.push(`工作台项目：${b.projectId ?? '（未知项目）'}；会话：${conversationId}；任务：${taskLabel || '（未绑定任务）'}`)
  out.push(`最近 checkpoint：${checkpointId}${b.checkpointAt ? `（${b.checkpointAt}）` : ''}`)
  if (isNonEmptyString(b.checkpointSummary)) {
    out.push(`中断前的进度摘要：${clip(b.checkpointSummary, 800)}`)
  }
  if (Number(interrupt.consecutiveFailures) > 0) {
    out.push(
      line(
        `注意：本会话已连续 ${interrupt.consecutiveFailures} 次恢复失败`,
        interrupt.lastFailureReason ? `，最近一次原因：${clip(String(interrupt.lastFailureReason), 300)}` : '',
        interrupt.state === 'trial_resume' ? '。本次是人工批准的**试恢复**，请不要再次触发失败。' : '。',
      ),
    )
  }
  out.push('')
  out.push('**不要直接继续。** 你的上下文里没有中断那一轮的记忆，先完成下面五项跨模块核对，再开始任何写操作。')
  out.push('')

  // -- the five steps ------------------------------------------------------
  out.push('## 先做这五项核对（缺一不可）')
  out.push('')
  out.push('1. **读动态（feed）**：读取 checkpoint 之后的所有动态，确认其他 AI 与人类在这段时间做了什么。')
  out.push(
    line(
      `   checkpoint 之后共有 ${sinceCount} 条动态`,
      Array.isArray(feed.actorsSince) && feed.actorsSince.length > 0
        ? `，参与者：${feed.actorsSince.join('、')}`
        : '',
      '。',
    ),
  )
  const feedLines = Array.isArray(feed.sinceCheckpoint) ? feed.sinceCheckpoint : []
  if (feedLines.length > 0) {
    out.push(...feedLines.map(feedLine))
    if (feed.truncated) out.push(`  · （仅显示最近 ${feedLines.length} 条，请用动态读取工具取全量）`)
  } else {
    out.push('  · 没有新动态；但这不等于没人动过，仍需核对计划与资产。')
  }
  const humans = Array.isArray(feed.humanInstructions) ? feed.humanInstructions : []
  if (humans.length > 0) {
    out.push('  · **人类的指令优先于你的原计划**：')
    out.push(...humans.map((event) => `    - [${event.at ?? '?'}] ${clip(event.content ?? '', 300)}`))
  }
  out.push('')

  out.push('2. **重新核对计划条目与依赖（plan）**：确认该条目仍属于你、状态未被他人改动、上游依赖是否已完成。')
  const planItems = asRecord(plan.items)
  const planLines = Object.keys(planItems).map((id) => planLine(id, planItems[id]))
  if (planLines.length > 0) out.push(...planLines)
  const bound = isNonEmptyString(b.planItemId) || isNonEmptyString(plan.boundItemStatus)
  out.push(bullet(`本会话绑定条目状态：${plan.boundItemStatus ?? '（无绑定）'}${bound ? '' : ' —— 没有绑定则不要臆造计划条目'}`))
  const deps = Array.isArray(plan.dependencies) ? plan.dependencies : []
  if (deps.length > 0) {
    out.push(bullet(`依赖：${deps.map((dep) => `${dep.id}（${dep.status}${dep.done ? '，已完成' : '，未完成'}）`).join('；')}`))
  } else {
    out.push(bullet('依赖：无'))
  }
  const blocked = Array.isArray(plan.blockedDependencies) ? plan.blockedDependencies : []
  out.push(
    blocked.length > 0
      ? bullet(`⚠ 仍有未完成的上游依赖：${blocked.map((dep) => dep.id).join('、')} —— 先不要动这个条目，或先处理上游`)
      : bullet('上游依赖均已满足，或本条目无依赖。'),
  )
  out.push('')

  out.push('3. **重新核对资产版本（assets）**：不要用旧版本覆盖他人已经更新过的文件。')
  const changes = Array.isArray(assets.changes) ? assets.changes : []
  if (changes.length > 0) {
    out.push(...changes.map(assetLine))
    out.push(bullet('写资产前先读取最新版本；删除或覆盖高风险资产需要人工确认。'))
  } else {
    out.push(bullet('checkpoint 之后没有相关资产版本变化。'))
  }
  out.push('')

  out.push('4. **重新核对执行权（execution rights）**：没有执行权就不要写计划、不要写资产、不要接手任务。')
  out.push(bullet(`当前执行权持有者：${exec.holder ?? '（无人持有）'}`))
  if (exec.changedSinceCheckpoint) {
    out.push(bullet(`⚠ 执行权在中断后发生了转移（checkpoint 时为 ${exec.checkpointHolder ?? '无'}），请先确认自己是否仍有写权。`))
  }
  if (Array.isArray(exec.queued) && exec.queued.length > 0) {
    out.push(bullet(`排队等待执行权：${exec.queued.join('、')}`))
  }
  if (isNonEmptyString(task.workspace)) {
    out.push(bullet(`任务工作目录：${task.workspace}`))
  }
  out.push('')

  out.push('5. **重新核对本地工作区 / git / 后台任务**：中断前写下的文件、提交的改动、启动的后台进程，可能已经存在。')
  out.push(bullet('检查工作目录中是否已有你那一步的产物；已存在就不要重写。'))
  out.push(bullet('检查 git 状态与最近提交；如果有你的提交，说明那一步已经完成。'))
  out.push(bullet('检查是否有仍在运行或已中断的后台任务；先确认它们的结果，再决定是否重跑。'))
  out.push('')

  // -- the verdict ---------------------------------------------------------
  out.push(...verdictBlock(b.idempotency))

  // -- resume --------------------------------------------------------------
  out.push('## 核对完成之后')
  out.push('')
  out.push(`- 预期下一步的负责人：${b.nextExpectedActor ?? 'human'}`)
  out.push('- 用一句话说明核对结论（哪些已完成、哪些还需要做），然后再继续执行未完成的部分。')
  out.push('- 如果发现状态与 checkpoint 描述不一致，先写一条动态说明差异，不要静默改道。')
  out.push(`- ${SEP}`)
  out.push('- 一句话总结：先核对，再动手；已完成的 **do not repeat**。')
  return out.join('\n')
}

function asFeedCount(feed) {
  const list = Array.isArray(feed?.sinceCheckpoint) ? feed.sinceCheckpoint : []
  return list.length
}

/**
 * The system-prompt section (§6.8).
 *
 * This is not the resume message: it is the standing explanation of the
 * collaboration model that makes the resume message intelligible. An agent that
 * has not been told "other AIs share this project" reads a feed event as noise;
 * an agent that has been told reads it as a handover.
 */
export function sectionBody(config) {
  const cfg = asRecord(config)
  const threshold = Math.max(1, Number(cfg.interruptLock?.failureThreshold ?? 3))
  const stableMin = Math.max(1, Math.round(Number(cfg.interruptLock?.stableWindowMs ?? 600000) / 60000))
  const activeMin = Math.max(1, Math.round(Number(cfg.resume?.activeWindowMs ?? 7200000) / 60000))
  const maxAuto = Math.max(0, Number(cfg.resume?.maxAutoResumesPerWindow ?? 5))

  return [
    '## 多对话协作工作台（ai-buddy）',
    '',
    '你所在的这个会话是工作台里的一个**协作参与者**，不是孤立的助手。同一个项目里可能有多个 AI 会话和一个人类同时工作，共享四样东西：',
    '',
    '- **动态（feed）**：所有人的动作都会写进项目动态。人类发言（`human.*`）优先级最高，必须先读再动手。',
    '- **计划（plan）**：条目有负责人、状态和依赖。上游条目未完成时，先做上游。',
    '- **任务（task）**：一个任务绑定一个会话，并持有该会话的**执行权**（execution lock）。没有执行权就不能写计划、写资产、接手任务。',
    '- **资产（assets）**：带版本号，可以限定可见的 Agent。高风险资产覆盖或删除需要人工确认。',
    '',
    '### 写入规则',
    '',
    '1. 动手写之前，先确认执行权在你手上；不在就排队或请对方释放。',
    '2. 任何写操作都可能被中断，因此每次写之前在心里记下「我要做什么、目标是什么」，写之后核对它是否落盘。',
    '3. 不要重复他人已经完成的工作：先读动态与计划，再决定。',
    '',
    '### 中断恢复规则',
    '',
    `1. 会话可能因为 Host 重启、网络中断、模型错误而意外中断。恢复不是「继续」，而是「重新核对后接续」。`,
    `2. 恢复消息会给你五项核对清单（动态 / 计划 / 资产 / 执行权 / 本地工作区），**必须逐项完成**才能动手。`,
    '3. 恢复消息里带有一个幂等判定：',
    '   - `skip` → 该操作已生效，**do not repeat**；',
    '   - `verify_first` → 先核对再决定，**verify first, do not repeat**；',
    '   - `retry` → 未生效，可以重做一次；',
    '   - `request_human` → 状态被他人改变，**request human decision**，不要擅自覆盖。',
    `4. 连续 ${threshold} 次恢复失败，且最近一次是服务器明确拒绝（鉴权、配额、模型不可用、内容策略等死胡同错误），系统会**锁定**该会话并停止自动恢复；只有人工可以解除。临时的网络抖动不会触发锁定。`,
    `5. 恢复成功后，会话需要稳定运行 ${stableMin} 分钟（或完成一个实质性操作），失败计数才会清零。这是为了防止「恢复—立刻崩溃」的死循环。`,
    `6. 只有最近 ${activeMin} 分钟内有活动、且没有被你或人类主动停止的会话会被自动恢复；每次恢复都会计入配额（每小时最多 ${maxAuto} 次自动恢复）。`,
    '',
    '### 你要怎么做',
    '',
    '- 遇到恢复消息：按五项核对，用一句话汇报结论，然后只做未完成的部分。',
    '- 发现自己做不下去（权限不足、依赖未完成、状态冲突）：写一条动态说明，把决定交给人，不要硬改。',
    '- 不要声称自己完成了没有核对过的事情。核对是恢复流程的一部分，不是可选项。',
  ].join('\n')
}

/**
 * A compact one-line digest for a tool result or a feed event. Exported because
 * the tool layer needs the same phrasing the injected message uses, and two
 * different renderings of the same state is how agents end up contradicting
 * the workbench.
 */
export function verdictDigest(verdict) {
  const v = asRecord(verdict)
  const action = v.action ?? 'verify_first'
  const evidence = asRecord(v.evidence)
  const target = evidence.targetRef ?? null
  const prefix = {
    skip: 'skip — 已完成，不要重复',
    verify_first: 'verify_first — 先核对再决定',
    retry: 'retry — 未生效，可重做',
    request_human: 'request_human — 需要人工裁决',
  }[action] ?? action
  const parts = [prefix]
  if (target !== null && target !== undefined) parts.push(`目标 ${target}`)
  if (asStringArray([v.detail]).length > 0) parts.push(clip(String(v.detail), 200))
  return parts.join('；')
}
