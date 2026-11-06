/**
 * Interruption recovery (§7). The largest module in the plugin, and the one the
 * other four depend on without knowing it.
 *
 * Three properties are load-bearing; everything else is bookkeeping.
 *
 * ---------------------------------------------------------------------------
 * A. The idempotency guard is a table, not an if-chain (§7.3).
 *
 *    `GUARD_MATRIX` is pure data: five operation rows x four result-status
 *    columns, mapping to the four actions. Keeping it data means the design
 *    document, the tests and the runtime all read the same table, and a new
 *    operation type is one row rather than a new branch inside four call sites.
 *    `verify()` supplies the column by checking the *live store*, because the
 *    only trustworthy answer to "did my write land?" is the truth layer, not
 *    the agent's own memory of what it tried.
 *
 * ---------------------------------------------------------------------------
 * B. The interruption lock needs TWO conditions (§7.5).
 *
 *    `consecutiveFailures >= failureThreshold` alone is a trap: a flaky network
 *    produces the same count as a revoked key, and locking on a network blip
 *    converts a recoverable conversation into one that only a human can free.
 *    So the count must also be *corroborated* by the shape of the last failure:
 *    a dead-end class failure (auth/quota/model-missing/content-policy/
 *    persistent 4xx) — a server verdict that no number of retries can change.
 *    A transient blip as the Nth failure therefore does not lock. This is why
 *    `finalizeLock` re-reads the failure classification instead of trusting the
 *    outcome label alone.
 *
 * ---------------------------------------------------------------------------
 * C. Success does not reset the counter; stability does (§7.5, §10.6).
 *
 *    A resume that survives for ten seconds and dies is not a success, it is
 *    the fourth failure with a gap. Resetting on any "succeeded" outcome would
 *    hand a crash-looping conversation an unlimited retry budget, exactly the
 *    loop the lock exists to stop. `succeeded` therefore only stamps
 *    `stableSince`; `recordStable` clears the counter once the conversation has
 *    stayed alive for `config.interruptLock.stableWindowMs`, or immediately
 *    when the caller reports one substantive operation (a landed handoff, a
 *    completed plan update) — evidence that legitimately outweighs the counter.
 *
 * ---------------------------------------------------------------------------
 * D. `interrupted` means the DSH turn-end signal, and nothing else (§7.1).
 *
 *    `classifyFailure` distinguishes four classes because the retry policy and
 *    the lock policy read different columns of the same fact:
 *
 *      - `interrupted` is the Host saying "this turn ended without completing:
 *        restart, watchdog, lost stream" — the case auto-resume exists for.
 *      - `aborted` is the *user* pressing stop. It is not an interruption to
 *        recover, it is an instruction to stay stopped, so it must never be
 *        classified `interrupted`. It is classified `dead_end` because the one
 *        thing the caller must not do is retry it; `serverRejection` stays false
 *        so it can never contribute to the interruption lock.
 *      - a rate limit is `rate_limit`, not `interrupted`: the turn was refused
 *        on purpose and has a Retry-After, which is a schedule, not a failure.
 *      - a dropped socket mid-stream is `transient` ("stream-interrupt" is a
 *        transient network condition, not the Host's interrupted turn signal).
 *
 * No console output: this module is loaded inside the Host, where stdout is the
 * user's terminal and a stray log line corrupts the session transcript.
 */

import {
  newId, nowIso, clip, asRecord, asStringArray, parseSince, isNonEmptyString,
} from '../util.js'
import { resumeMessage } from './prompts.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** §7.3 rows. `last_operation.type` uses the same closed set. */
export const GUARD_MATRIX = Object.freeze({
  handoff: Object.freeze({
    confirmed: 'skip',
    unconfirmed: 'verify_first',
    failed: 'retry',
    changed_by_other: 'request_human',
  }),
  asset_write: Object.freeze({
    confirmed: 'skip',
    unconfirmed: 'verify_first',
    failed: 'retry',
    changed_by_other: 'request_human',
  }),
  plan_update: Object.freeze({
    confirmed: 'skip',
    unconfirmed: 'verify_first',
    failed: 'retry',
    changed_by_other: 'request_human',
  }),
  feed_post: Object.freeze({
    confirmed: 'skip',
    unconfirmed: 'verify_first',
    failed: 'retry',
    changed_by_other: 'request_human',
  }),
  conversation_create: Object.freeze({
    confirmed: 'skip',
    unconfirmed: 'verify_first',
    failed: 'retry',
    changed_by_other: 'request_human',
  }),
})

const OPERATION_TYPES = Object.freeze(Object.keys(GUARD_MATRIX))
const RESULT_STATUSES = Object.freeze(['confirmed', 'unconfirmed', 'failed', 'changed_by_other'])

const DEFAULT_BACKOFF_MS = Object.freeze([30000, 60000, 120000, 180000])

/**
 * Per-operation refinement of the four uniform actions. The *action* is never
 * operation-specific — that uniformity is what makes the matrix auditable — but
 * the instruction handed to the agent must be: "skip an asset write" also means
 * "read the latest version first", while "skip a feed post" means "it is
 * already there, posting again creates a duplicate".
 */
const GUARD_NOTES = Object.freeze({
  handoff: Object.freeze({
    confirmed: 'handoff 已生效：接手方已获得执行权，do not repeat the handoff',
    unconfirmed: '无法确认 handoff 是否送达：先读任务 owner / executionLock / feed，verify first',
    failed: 'handoff 未生效（目标尚未接手）：可以 retry the handoff',
    changed_by_other: '任务已被他人归档或转交：request human decision',
  }),
  asset_write: Object.freeze({
    confirmed: '写入已落盘：read latest version first，do not repeat the write',
    unconfirmed: '版本未变或无法判定：verify first, do not repeat until you have read the asset',
    failed: '写入未落盘：可以 retry the write',
    changed_by_other: '资产被他人改动或删除：request human decision，禁止覆盖',
  }),
  plan_update: Object.freeze({
    confirmed: '计划状态已更新：do not repeat the status change',
    unconfirmed: '计划状态未变：verify first, do not repeat blindly',
    failed: '计划更新未生效：可以 retry the update',
    changed_by_other: '计划条目被他人修改或删除：request human decision',
  }),
  feed_post: Object.freeze({
    confirmed: '动态已发布：跳过，避免重复发帖 (skip to avoid a duplicate post)',
    unconfirmed: '动态无法确认是否发布：先读 feed，verify first, do not repeat',
    failed: '动态未发布：可以 retry the post',
    changed_by_other: '他人已就该事项发言：request human decision',
  }),
  conversation_create: Object.freeze({
    confirmed: '会话已创建并绑定任务：do not repeat',
    unconfirmed: '任务存在但会话绑定无法确认：verify first',
    failed: '会话创建失败：可以 retry',
    changed_by_other: '任务已被他人接管：request human decision',
  }),
})

/** Fallback row for an operation type outside the closed set. */
const UNKNOWN_ROW = GUARD_MATRIX.handoff

// Failures that describe a *server verdict*: no amount of retrying changes it.
const DEAD_END_STATUSES = new Set([401, 403, 404, 402, 405, 407, 410, 451])
const DEAD_END_HINT_STATUSES = new Set([400, 412, 413, 415, 422])
const DEAD_END_CODES = [
  'authentication_error', 'auth_error', 'unauthorized', 'forbidden', 'permission_denied',
  'invalid_api_key', 'invalid_key', 'api_key_invalid', 'insufficient_quota', 'quota_exceeded',
  'billing_hard_limit', 'billing_required', 'model_not_found', 'model_missing',
  'model_not_supported', 'content_policy', 'content_filter', 'policy_violation',
  'safety_block', 'permanent', 'unsupported_parameter', 'invalid_request_error',
]
const RATE_LIMIT_CODES = ['rate_limit', 'rate_limited', 'ratelimit', 'throttle', 'throttled', 'too_many_requests']
const TRANSIENT_CODES = [
  'econnreset', 'etimedout', 'enotfound', 'eai_again', 'epipe', 'econnrefused',
  'ehostunreach', 'enetdown', 'socket_hang_up', 'socket hang up', 'timeout',
  'timed_out', 'fetch_failed', 'stream_error', 'stream_interrupted',
  'server_error', 'overloaded', 'unavailable', 'bad_gateway', 'upstream_error',
]
// The DSH turn-end record. `reason: 'aborted'` lives in the same field and is a
// user stop, which is why the value is compared exactly and never by substring.
const TURN_END_TYPES = new Set(['turn_end', 'turn_end_reason', 'turnend', 'turn-ended', 'turn_completed'])
const TURN_END_FIELDS = [
  'turnEndReason', 'finishReason', 'stopReason', 'endReason', 'turn_end_reason',
]

const MAX_BRIEF_FEED_EVENTS = 50
const MAX_HISTORY = 50
const MAX_REASON_LEN = 500

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sourceRecord(value) {
  if (value !== null && typeof value === 'object') return value
  if (typeof value === 'string' && value !== '') return { message: value }
  return {}
}

/** Every diagnostic string a failure might carry, joined for pattern matching. */
function failureText(failure) {
  const src = sourceRecord(failure)
  const nested = sourceRecord(src.error)
  const response = sourceRecord(src.response)
  const parts = [
    failure instanceof Error ? `${failure.name} ${failure.message}` : '',
    src.code, src.name, src.message, src.reason, src.type, src.kind, src.event,
    src.detail, src.statusText, src.errorCode, src.error_type,
    nested.code, nested.message, nested.type,
    response.statusText,
  ]
  return parts
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .join(' ')
    .toLowerCase()
}

function statusCodeOf(failure) {
  const src = sourceRecord(failure)
  const response = sourceRecord(src.response)
  const candidates = [src.status, src.statusCode, src.status_code, response.status]
  for (const candidate of candidates) {
    const n = Number(candidate)
    if (Number.isFinite(n) && n >= 100 && n < 600) return n
  }
  return 0
}

function codeOf(failure) {
  const src = sourceRecord(failure)
  const nested = sourceRecord(src.error)
  const candidates = [src.code, src.errorCode, src.error_type, nested.code, src.type]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate.toLowerCase()
    const n = Number(candidate)
    if (Number.isFinite(n) && n >= 400 && n < 600) return String(n)
  }
  return ''
}

/** Retry-After in ms, from the many shapes providers use. */
function retryAfterOf(failure) {
  const src = sourceRecord(failure)
  const nested = sourceRecord(src.error)
  const headers = asRecord(src.headers ?? nested.headers)
  const direct = [
    src.providerRetryAfterMs, src.retryAfterMs, nested.providerRetryAfterMs, nested.retryAfterMs,
  ]
  for (const candidate of direct) {
    const n = Number(candidate)
    if (Number.isFinite(n) && n > 0) return Math.floor(n)
  }
  const seconds = [src.retryAfter, nested.retryAfter, headers['retry-after'], headers['Retry-After']]
  for (const candidate of seconds) {
    const n = Number(candidate)
    if (Number.isFinite(n) && n > 0) return Math.floor(n * 1000)
  }
  return 0
}

/** The DSH turn-end reason, or '' when the failure does not describe one. */
function turnEndReasonOf(failure) {
  if (failure === null || typeof failure !== 'object') return ''
  for (const field of TURN_END_FIELDS) {
    const value = failure[field]
    if (typeof value === 'string' && value !== '') return value.toLowerCase()
  }
  const type = String(failure.type ?? failure.kind ?? failure.event ?? '').toLowerCase()
  const hasStatus = statusCodeOf(failure) !== 0
  // A bare `reason` is only a turn-end reason when the record is not carrying a
  // transport/HTTP diagnostic. `{ reason: 'ECONNRESET' }` is a socket error;
  // `{ type: 'turn_end', reason: 'interrupted' }` is the Host signal.
  if (typeof failure.reason === 'string' && failure.reason !== '') {
    if (TURN_END_TYPES.has(type) || !hasStatus) return failure.reason.toLowerCase()
  }
  return ''
}

function matchesAny(text, needles) {
  return needles.some((needle) => text.includes(needle))
}

/**
 * One pass over a failure, producing both the classification and the two facts
 * the lock policy needs but the class alone cannot express: whether this was a
 * *server* rejection, and whether it was a deliberate stop.
 */
function inspectFailure(failure) {
  const text = failureText(failure)
  const status = statusCodeOf(failure)
  const code = codeOf(failure)
  const providerRetryAfterMs = retryAfterOf(failure)
  const reason = turnEndReasonOf(failure)

  const deliberate = reason === 'aborted' || reason === 'cancelled' || reason === 'canceled'
    || reason === 'user_stop' || reason === 'stopped_by_user'
  const interruptedReason = reason === 'interrupted' || reason === 'turn_interrupted'
  const explicitInterrupt = failure !== null && typeof failure === 'object'
    && (failure.interrupted === true || failure.signal === 'interrupted' || code === 'interrupted')

  const rateLimited = status === 429
    || matchesAny(code, RATE_LIMIT_CODES)
    || matchesAny(text, RATE_LIMIT_CODES)
  const deadEnd = status === 0
    ? matchesAny(code, DEAD_END_CODES) || matchesAny(text, DEAD_END_CODES)
    : DEAD_END_STATUSES.has(status)
      || (DEAD_END_HINT_STATUSES.has(status) && (matchesAny(code, DEAD_END_CODES) || matchesAny(text, DEAD_END_CODES)))

  let classification
  if (deliberate) {
    // A user stop. Classified dead_end so the running-turn retry never re-runs
    // it, but `serverRejection` stays false so it can never latch the lock.
    classification = 'dead_end'
  } else if (interruptedReason || explicitInterrupt) {
    classification = 'interrupted'
  } else if (rateLimited && (status === 429 || providerRetryAfterMs > 0)) {
    // A quota-flavoured code with a Retry-After is a schedule, not a dead end.
    classification = 'rate_limit'
  } else if (deadEnd) {
    classification = 'dead_end'
  } else {
    classification = 'transient'
  }

  const serverRejection = classification === 'dead_end' && !deliberate
  return {
    classification,
    serverRejection,
    deliberate,
    providerRetryAfterMs,
    status,
    code,
    text,
  }
}

/** A short, human-readable reason string for the lock record and the feed. */
function reasonText(failure) {
  if (failure === null || failure === undefined) return null
  if (typeof failure === 'string') return clip(failure, MAX_REASON_LEN)
  const src = sourceRecord(failure)
  const parts = [src.code, src.status ?? src.statusCode, src.message ?? src.reason ?? src.detail]
    .filter((part) => part !== undefined && part !== null && part !== '')
  const text = parts.length > 0 ? parts.join(' ') : String(failure)
  return clip(text, MAX_REASON_LEN)
}

function normalizeOperationType(value) {
  return OPERATION_TYPES.includes(value) ? value : null
}

function normalizeResultStatus(value) {
  return RESULT_STATUSES.includes(value) ? value : null
}

function asIso(value) {
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString()
  }
  return null
}

function resolveNow(value) {
  if (typeof value === 'function') {
    try {
      return resolveNow(value())
    } catch {
      return Date.now()
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

// ---------------------------------------------------------------------------
// 7.1 — running-turn failure classification and retry ladder
// ---------------------------------------------------------------------------

/**
 * Classify a failed turn. See the header (D) for why `aborted` is not
 * `interrupted` and why a stream error is `transient`.
 *
 * @returns {'dead_end'|'rate_limit'|'transient'|'interrupted'}
 */
export function classifyFailure(failure) {
  return inspectFailure(failure).classification
}

/**
 * Delay before retry number `attempt` (1-based). Holds at the last rung instead
 * of growing without bound: an agent that keeps failing should be *paced*, and
 * the wall ceiling that actually stops it is `maxRetryWallMs`, not the ladder.
 */
export function nextBackoff(config, attempt, providerRetryAfterMs) {
  const ladder = Array.isArray(config?.resume?.backoffMs) && config.resume.backoffMs.length > 0
    ? config.resume.backoffMs
    : DEFAULT_BACKOFF_MS
  const index = Math.min(Math.max(1, Math.floor(Number(attempt) || 1)) - 1, ladder.length - 1)
  let delay = Math.max(0, Math.floor(Number(ladder[index]) || 0))
  const retryAfter = Math.floor(Number(providerRetryAfterMs) || 0)
  if (config?.resume?.honorRetryAfter !== false && retryAfter > delay) delay = retryAfter
  const ceiling = Number(config?.resume?.maxRetryWallMs)
  if (Number.isFinite(ceiling) && ceiling > 0) delay = Math.min(delay, Math.floor(ceiling))
  return delay
}

// ---------------------------------------------------------------------------
// Resume state access
// ---------------------------------------------------------------------------

function taskForConversation(store, projectId, conversationId) {
  const tasks = store.readTasks(projectId)
  return tasks.find((task) => task?.conversationId === conversationId)
}

function loadState(store, projectId, conversationId) {
  const state = store.getResumeState(projectId, conversationId)
  if (!state.taskId) {
    const task = taskForConversation(store, projectId, conversationId)
    if (task !== undefined) state.taskId = task.id
  }
  return state
}

function saveState(store, projectId, state) {
  return store.putResumeState(projectId, state.conversationId, state)
}

/**
 * Flip the bound plan item to `locked_by_interrupt` and back (§5.3).
 *
 * `plan.js` owns `setLockedByInterrupt`, but importing it here would couple the
 * recovery module to a sibling that is loaded (and unit-tested) on its own. The
 * write is a single status field, so doing it through the store is cheaper than
 * the coupling — and it is wrapped, because failing to lock the plan item must
 * never prevent the *lock itself* from being recorded. Losing a cosmetic status
 * is survivable; losing the lock is how a crash loop runs forever.
 */
function applyPlanLock(store, projectId, conversationId, locked, reason, config) {
  try {
    const state = loadState(store, projectId, conversationId)
    const task = state.taskId ? store.readTasks(projectId).find((t) => t.id === state.taskId) : undefined
    const items = store.readPlan(projectId)
    const targets = items.filter((item) => (
      (task?.planItemId && item.id === task.planItemId) || (task && item.taskId === task.id)
    ))
    for (const item of targets) {
      const next = { ...item }
      if (locked) {
        if (next.status !== 'locked_by_interrupt') {
          next.planStatusBeforeLock = next.status
        }
        next.status = 'locked_by_interrupt'
        next.lastNote = reason ?? '自动恢复连续失败，已锁定等待人工裁决。'
      } else if (next.status === 'locked_by_interrupt') {
        next.status = next.planStatusBeforeLock ?? 'in_progress'
        delete next.planStatusBeforeLock
        next.lastNote = reason ?? '人工解除中断锁，恢复执行。'
      } else {
        continue
      }
      next.updatedAt = nowIso()
      store.putPlanItem(projectId, next)
    }
    void config
  } catch {
    /* the lock record is the safety mechanism; a plan write is a projection */
  }
}

/** Append to `Task.resumeHistory` (§5.4), bounded. */
function appendResumeHistory(store, projectId, conversationId, attempt) {
  try {
    const task = taskForConversation(store, projectId, conversationId)
    if (task === undefined) return
    const history = Array.isArray(task.resumeHistory) ? [...task.resumeHistory] : []
    history.push(attempt)
    store.putTask(projectId, {
      ...task,
      resumeHistory: history.slice(Math.max(0, history.length - MAX_HISTORY)),
      updatedAt: nowIso(),
    })
  } catch {
    /* history is a projection of the resume state, never its source */
  }
}

// ---------------------------------------------------------------------------
// 7.2 — restart resume planning
// ---------------------------------------------------------------------------

function conversationsOf(store, projectId) {
  const ids = new Set()
  try {
    for (const state of store.listResumeStates(projectId)) {
      if (isNonEmptyString(state?.conversationId)) ids.add(state.conversationId)
    }
  } catch {
    /* a project that has never resumed has no resume directory */
  }
  for (const task of store.readTasks(projectId)) {
    if (isNonEmptyString(task?.conversationId)) ids.add(task.conversationId)
  }
  return [...ids]
}

function activityFromDeps(deps, conversationId) {
  if (typeof deps?.sessionLastActivityAt !== 'function') return 0
  try {
    return parseSince(deps.sessionLastActivityAt(conversationId))
  } catch {
    return 0
  }
}

/**
 * Which conversations should an automatic resume pass consider, and why.
 *
 * Boundaries, in order, because each one is cheaper than the next:
 *   silent window after restart -> mutex -> interruption lock -> user stop ->
 *   running turn -> active window -> sliding-window cap.
 *
 * Read-only by design: the planner must be safe to call from the workbench. The
 * auto-resume budget is charged when the injection actually happens
 * (`injectResume` with `deps.auto`), not when someone looks at the plan.
 */
export function planResume(store, config, deps = {}) {
  const resumeCfg = config?.resume ?? {}
  const lockCfg = config?.interruptLock ?? {}
  const now = resolveNow(deps.now)
  const restartAt = parseSince(deps.restartAt)
  const silentWindowMs = Number(resumeCfg.silentWindowMs ?? 15000)
  const activeWindowMs = Number(resumeCfg.activeWindowMs ?? 2 * 60 * 60 * 1000)
  const windowMs = Number(resumeCfg.windowMs ?? 60 * 60 * 1000)
  const maxAuto = Number(resumeCfg.maxAutoResumesPerWindow ?? 5)

  // A resume pass that fires while the user is still typing their first
  // post-restart message races them for the conversation. Stay quiet.
  if (restartAt > 0 && now - restartAt < silentWindowMs) return []

  let projectIds = []
  if (Array.isArray(deps.projectIds) && deps.projectIds.length > 0) projectIds = deps.projectIds
  else if (isNonEmptyString(deps.projectId)) projectIds = [deps.projectId]
  else projectIds = store.listProjects().map((project) => project.id)

  const onlyConversations = Array.isArray(deps.conversationIds) && deps.conversationIds.length > 0
    ? new Set(deps.conversationIds)
    : null

  const candidates = []
  for (const projectId of projectIds) {
    for (const conversationId of conversationsOf(store, projectId)) {
      if (onlyConversations !== null && !onlyConversations.has(conversationId)) continue

      const state = loadState(store, projectId, conversationId)
      const interrupt = asRecord(state.interruptLock)
      const resumeLock = asRecord(state.resumeLock)

      // §7.5: a locked conversation is out of the automatic pass entirely; only
      // a human unlock (releaseLock) can put it back.
      if (interrupt.state === 'locked') continue
      // §7.4: someone is already recovering this conversation.
      if (resumeLock.state === 'recovering') continue
      // A human pause / an awaiting-human decision outranks the auto pass.
      if (resumeLock.state === 'paused' || resumeLock.state === 'awaiting_human') continue

      if (typeof deps.wasUserAborted === 'function') {
        let aborted = false
        try {
          aborted = deps.wasUserAborted(conversationId) === true
        } catch {
          aborted = false
        }
        if (aborted) continue
      }

      let running = false
      if (typeof deps.isRunning === 'function') {
        try {
          running = deps.isRunning(conversationId) === true
        } catch {
          running = false
        }
      }
      if (running) continue

      const task = taskForConversation(store, projectId, conversationId)
      const checkpoint = store.latestCheckpoint(projectId, conversationId)

      let lastActivityAt = activityFromDeps(deps, conversationId)
      if (lastActivityAt <= 0) {
        lastActivityAt = parseSince(checkpoint?.timestamp)
          || parseSince(task?.updatedAt)
          || parseSince(state.lastResumeAt)
          || parseSince(state.lastFailureAt)
      }
      const activityKnown = lastActivityAt > 0
      if (activityKnown && now - lastActivityAt > activeWindowMs) continue
      // Nothing at all to go on: no checkpoint, no task, no history. There is
      // nothing to resume, so do not invent a candidacy.
      if (!activityKnown && checkpoint === undefined && task === undefined) continue

      const window = asRecord(state.autoResumeWindow)
      const windowStartedAt = parseSince(window.startedAt)
      const windowExpired = windowStartedAt <= 0 || (now - windowStartedAt) > windowMs
      const windowCount = windowExpired ? 0 : Math.max(0, Number(window.count) || 0)
      if (maxAuto <= 0 || windowCount >= maxAuto) continue

      const failures = Math.max(0, Number(interrupt.consecutiveFailures) || 0)
      const isTrial = interrupt.state === 'trial_resume'
      const trigger = isTrial
        ? 'trial'
        : (interrupt.state === 'counting' || failures > 0 ? 'retry' : 'restart')

      candidates.push({
        projectId,
        conversationId,
        taskId: task?.id ?? state.taskId ?? null,
        taskTitle: task?.title ?? null,
        planItemId: task?.planItemId ?? null,
        trigger,
        reason: isTrial ? 'trial_resume' : (failures > 0 ? 'interrupted_with_failures' : 'interrupted_turn'),
        attempt: failures + 1,
        consecutiveFailures: failures,
        interruptState: interrupt.state ?? 'unlocked',
        resumeLockState: resumeLock.state ?? 'idle',
        lastFailureReason: interrupt.lastFailureReason ?? null,
        lockedAt: interrupt.lockedAt ?? null,
        lastActivityAt: activityKnown ? new Date(lastActivityAt).toISOString() : null,
        activityKnown,
        checkpointId: checkpoint?.checkpoint_id ?? null,
        checkpointAt: checkpoint?.timestamp ?? null,
        nextExpectedActor: checkpoint?.next_expected_actor ?? null,
        windowCount,
        windowLimit: maxAuto,
        retryDelayMs: nextBackoff(config, failures + 1),
        stableWindowMs: Number(lockCfg.stableWindowMs ?? 0),
      })
    }
  }

  // A human-authorised trial first, then the most recent interruption. Most
  // recent first is deliberate: an older conversation has usually been dealt
  // with by whoever was around, while the newest one is the freshest context.
  candidates.sort((a, b) => {
    const trialA = a.trigger === 'trial' ? 0 : 1
    const trialB = b.trigger === 'trial' ? 0 : 1
    if (trialA !== trialB) return trialA - trialB
    const atA = parseSince(a.checkpointAt)
    const atB = parseSince(b.checkpointAt)
    if (atA !== atB) return atB - atA
    return a.consecutiveFailures - b.consecutiveFailures
  })

  const limit = Number(deps.limit)
  return Number.isFinite(limit) && limit > 0 ? candidates.slice(0, Math.floor(limit)) : candidates
}

// ---------------------------------------------------------------------------
// 7.3 — idempotency: verify against the truth layer, then consult the matrix
// ---------------------------------------------------------------------------

function targetIdOf(operationType, targetRef) {
  if (isNonEmptyString(targetRef)) return targetRef
  if (targetRef !== null && typeof targetRef === 'object') {
    const keys = ['id', 'assetId', 'taskId', 'planItemId', 'eventId', 'conversationId', 'ref']
    for (const key of keys) {
      if (isNonEmptyString(targetRef[key])) return targetRef[key]
    }
  }
  void operationType
  return null
}

function checkpointOf(store, projectId, conversationId) {
  if (!isNonEmptyString(conversationId)) return undefined
  try {
    return store.latestCheckpoint(projectId, conversationId)
  } catch {
    return undefined
  }
}

function snapshotOf(checkpoint) {
  return asRecord(checkpoint?.resume_context?.cross_module_snapshot)
}

function verifyFeedPost(events, targetId, checkpoint) {
  const byId = targetId ? events.find((event) => event?.id === targetId) : undefined
  if (byId !== undefined) {
    return {
      status: 'confirmed',
      evidence: { operationType: 'feed_post', targetRef: targetId, eventId: byId.id, at: byId.at, actor: byId.actor?.name ?? null },
    }
  }
  // A dedupe/correlation key on the event is the other legitimate proof: the
  // post landed under a different id than the caller expected.
  if (targetId) {
    const correlated = events.find((event) => (
      event?.meta && (event.meta.clientRef === targetId || event.meta.operationRef === targetId)
    ))
    if (correlated !== undefined) {
      return {
        status: 'confirmed',
        evidence: { operationType: 'feed_post', targetRef: targetId, eventId: correlated.id, via: 'meta.clientRef' },
      }
    }
  }
  const since = checkpoint ? parseSince(checkpoint.timestamp) : 0
  const others = since > 0
    ? events.filter((event) => parseSince(event?.at) >= since && event?.actor?.type === 'agent')
    : []
  return {
    status: 'failed',
    evidence: {
      operationType: 'feed_post',
      targetRef: targetId,
      found: false,
      othersSinceCheckpoint: others.map((event) => event.id).slice(0, 10),
    },
  }
}

function verifyAssetWrite(assets, targetId, checkpoint) {
  const asset = targetId ? assets.find((candidate) => candidate?.id === targetId) : undefined
  const recordedRefs = asRecord(snapshotOf(checkpoint).asset_version_refs)
  const recorded = targetId !== null && Object.prototype.hasOwnProperty.call(recordedRefs, targetId)
    ? Number(recordedRefs[targetId])
    : undefined
  if (asset === undefined) {
    // Present at checkpoint time, gone now: someone deleted it. Retrying would
    // resurrect a blob another actor removed on purpose.
    const existedBefore = recorded !== undefined || (checkpoint !== undefined && targetId !== null && targetId === checkpoint?.resume_context?.last_operation?.target_ref)
    return {
      status: existedBefore ? 'changed_by_other' : 'failed',
      evidence: { operationType: 'asset_write', targetRef: targetId, found: false, existedBefore },
    }
  }
  if (asset.deletedAt !== null && asset.deletedAt !== undefined) {
    return {
      status: 'changed_by_other',
      evidence: { operationType: 'asset_write', targetRef: targetId, deletedAt: asset.deletedAt, version: asset.version },
    }
  }
  const currentVersion = Number(asset.version) || 0
  if (recorded === undefined) {
    const since = checkpoint ? parseSince(checkpoint.timestamp) : 0
    const touched = since > 0 ? parseSince(asset.updatedAt) >= since : false
    return {
      status: touched ? 'confirmed' : 'unconfirmed',
      evidence: { operationType: 'asset_write', targetRef: targetId, version: currentVersion, baseline: 'none', touchedSinceCheckpoint: touched },
    }
  }
  if (currentVersion === recorded) {
    // Nothing moved: the write did not land.
    return {
      status: 'unconfirmed',
      evidence: { operationType: 'asset_write', targetRef: targetId, version: currentVersion, checkpointVersion: recorded, moved: false },
    }
  }
  if (currentVersion === recorded + 1) {
    return {
      status: 'confirmed',
      evidence: { operationType: 'asset_write', targetRef: targetId, version: currentVersion, checkpointVersion: recorded, moved: true },
    }
  }
  return {
    status: 'changed_by_other',
    evidence: {
      operationType: 'asset_write', targetRef: targetId, version: currentVersion,
      checkpointVersion: recorded, rewritesSinceCheckpoint: currentVersion - recorded,
    },
  }
}

function verifyHandoff(tasks, events, targetId, checkpoint) {
  const task = targetId
    ? tasks.find((candidate) => candidate?.id === targetId || candidate?.conversationId === targetId)
    : undefined
  if (task === undefined) {
    return { status: 'failed', evidence: { operationType: 'handoff', targetRef: targetId, found: false } }
  }
  if (task.status === 'archived') {
    return { status: 'changed_by_other', evidence: { operationType: 'handoff', targetRef: task.id, taskStatus: task.status } }
  }
  const since = checkpoint ? parseSince(checkpoint.timestamp) : 0
  const handoffEvents = events.filter((event) => (
    event?.taskId === task.id
    && ['task.handoff', 'execution.handoff', 'task.transfer'].includes(event.category)
    && (since === 0 || parseSince(event.at) >= since)
  ))
  if (handoffEvents.length > 0) {
    return {
      status: 'confirmed',
      evidence: {
        operationType: 'handoff', targetRef: task.id, taskStatus: task.status,
        ownerAgent: task.ownerAgent, executionLockHolder: asRecord(task.executionLock).holder ?? null,
        eventIds: handoffEvents.map((event) => event.id).slice(0, 5),
      },
    }
  }
  return {
    status: 'unconfirmed',
    evidence: {
      operationType: 'handoff', targetRef: task.id, taskStatus: task.status,
      ownerAgent: task.ownerAgent, handoffEventsSinceCheckpoint: 0,
    },
  }
}

function verifyPlanUpdate(items, targetId, checkpoint) {
  const item = targetId ? items.find((candidate) => candidate?.id === targetId) : undefined
  const recordedStates = asRecord(snapshotOf(checkpoint).plan_item_states)
  const recorded = targetId !== null && Object.prototype.hasOwnProperty.call(recordedStates, targetId)
    ? recordedStates[targetId]
    : undefined
  if (item === undefined) {
    return {
      status: 'changed_by_other',
      evidence: { operationType: 'plan_update', targetRef: targetId, found: false, checkpointStatus: recorded ?? null },
    }
  }
  const since = checkpoint ? parseSince(checkpoint.timestamp) : 0
  const touched = since > 0 ? parseSince(item.updatedAt) >= since : false
  if (recorded !== undefined && item.status !== recorded) {
    return {
      status: 'confirmed',
      evidence: { operationType: 'plan_update', targetRef: item.id, status: item.status, checkpointStatus: recorded, touched },
    }
  }
  if (touched && (recorded === undefined || item.status !== recorded)) {
    return {
      status: 'confirmed',
      evidence: { operationType: 'plan_update', targetRef: item.id, status: item.status, checkpointStatus: recorded ?? null, touched },
    }
  }
  return {
    status: 'unconfirmed',
    evidence: {
      operationType: 'plan_update', targetRef: item.id, status: item.status,
      checkpointStatus: recorded ?? null, touched, blockedBy: asStringArray(item.blockedBy),
    },
  }
}

function verifyConversationCreate(tasks, targetId) {
  const task = targetId
    ? tasks.find((candidate) => candidate?.id === targetId || candidate?.conversationId === targetId)
    : undefined
  if (task === undefined) {
    return { status: 'failed', evidence: { operationType: 'conversation_create', targetRef: targetId, found: false } }
  }
  if (isNonEmptyString(task.conversationId)) {
    return {
      status: 'confirmed',
      evidence: { operationType: 'conversation_create', targetRef: task.id, conversationId: task.conversationId },
    }
  }
  if (task.status === 'archived') {
    return { status: 'changed_by_other', evidence: { operationType: 'conversation_create', targetRef: task.id, taskStatus: task.status } }
  }
  // The task exists but no session is bound: the create call did not finish.
  return { status: 'failed', evidence: { operationType: 'conversation_create', targetRef: task.id, conversationId: null } }
}

/**
 * Check the live store for the effect of `last_operation`.
 *
 * The status is deliberately conservative: `confirmed` requires positive
 * evidence, because `confirmed` -> `skip` and a wrong skip silently drops work.
 * `unconfirmed` is the safe default — it costs one read, not one lost write.
 */
export function verify(store, config, projectId, input = {}) {
  const operationType = normalizeOperationType(input.operationType)
  const targetRef = input.targetRef ?? null
  const targetId = targetIdOf(operationType, targetRef)
  const conversationId = isNonEmptyString(input.conversationId) ? input.conversationId : null
  const snapshot = store.snapshot(projectId)

  if (snapshot === undefined) {
    return { status: 'unconfirmed', evidence: { reason: 'unknown_project', projectId, operationType } }
  }
  if (operationType === null) {
    return {
      status: 'unconfirmed',
      evidence: { reason: 'unknown_operation_type', operationType: input.operationType ?? null, targetRef },
    }
  }

  const checkpoint = checkpointOf(store, projectId, conversationId)
  const events = Array.isArray(snapshot.feed) ? snapshot.feed : []
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : []
  const items = Array.isArray(snapshot.plan) ? snapshot.plan : []
  const assets = Array.isArray(snapshot.assets) ? snapshot.assets : []

  let result
  switch (operationType) {
    case 'feed_post':
      result = verifyFeedPost(events, targetId, checkpoint)
      break
    case 'asset_write':
      result = verifyAssetWrite(assets, targetId, checkpoint)
      break
    case 'handoff':
      result = verifyHandoff(tasks, events, targetId, checkpoint)
      break
    case 'plan_update':
      result = verifyPlanUpdate(items, targetId, checkpoint)
      break
    case 'conversation_create':
      result = verifyConversationCreate(tasks, targetId)
      break
    default:
      result = { status: 'unconfirmed', evidence: { reason: 'unhandled_operation', operationType } }
  }

  void config
  return {
    status: result.status,
    evidence: {
      ...result.evidence,
      projectId,
      conversationId,
      checkpointId: checkpoint?.checkpoint_id ?? null,
      checkpointAt: checkpoint?.timestamp ?? null,
    },
  }
}

/**
 * The verdict the resuming agent must obey before repeating anything (§7.3).
 * The action is a pure lookup in `GUARD_MATRIX`; the prose is per operation.
 */
export function guard(store, config, projectId, conversationId, operationType, targetRef) {
  const checkpoint = checkpointOf(store, projectId, conversationId)
  const lastOperation = asRecord(checkpoint?.resume_context?.last_operation)
  const type = normalizeOperationType(operationType) ?? normalizeOperationType(lastOperation.type)
  const ref = targetRef ?? lastOperation.target_ref ?? null

  if (type === null) {
    // Nothing attempted yet: the only safe instruction is to look before acting.
    return {
      action: 'verify_first',
      reason: 'no_recorded_operation',
      detail: '没有可核对的上次操作记录：先读动态/计划/资产/执行权，verify first before acting',
      evidence: {
        operationType: null,
        targetRef: ref,
        resultStatus: 'unconfirmed',
        recordedStatus: normalizeResultStatus(lastOperation.result_status),
        checkpointId: checkpoint?.checkpoint_id ?? null,
      },
    }
  }

  const verification = verify(store, config, projectId, {
    operationType: type,
    targetRef: ref,
    conversationId,
  })
  const status = normalizeResultStatus(verification.status) ?? 'unconfirmed'
  const row = GUARD_MATRIX[type] ?? UNKNOWN_ROW
  const action = row[status] ?? 'verify_first'
  const note = GUARD_NOTES[type]?.[status] ?? `${type}: ${action}`

  return {
    action,
    reason: `${type}_${status}`,
    detail: note,
    evidence: {
      ...verification.evidence,
      operationType: type,
      targetRef: ref,
      resultStatus: status,
      recordedStatus: normalizeResultStatus(lastOperation.result_status),
      recordedVerifiedAt: lastOperation.verified_at ?? null,
      matrixAction: action,
    },
  }
}

// ---------------------------------------------------------------------------
// 7.4 — mutual exclusion: one recovery flow per conversation
// ---------------------------------------------------------------------------

/**
 * Take the recovery flow for one conversation.
 *
 * Refuses while the interruption lock is engaged: the whole point of the lock
 * is that no automatic flow may touch this conversation until a human acts.
 * A second acquire while a recovery is already running returns the *existing*
 * holder rather than overwriting it — a lost holder field would leave a
 * recovery in flight that can never be released.
 */
export function acquireResumeLock(store, projectId, conversationId, holder) {
  const state = loadState(store, projectId, conversationId)
  const interrupt = asRecord(state.interruptLock)
  const lock = asRecord(state.resumeLock)
  const who = isNonEmptyString(holder) ? holder : 'auto'

  if (interrupt.state === 'locked') {
    return {
      acquired: false,
      reason: 'locked_by_interrupt',
      holder: lock.holder ?? null,
      since: lock.since ?? null,
      state,
      lockedAt: interrupt.lockedAt ?? null,
      lockedBy: interrupt.lockedBy ?? null,
    }
  }
  if (lock.state === 'recovering') {
    if (lock.holder === who) {
      return { acquired: true, reason: 'already_held', holder: lock.holder, since: lock.since, state }
    }
    return {
      acquired: false,
      reason: 'recovery_in_progress',
      holder: lock.holder ?? null,
      since: lock.since ?? null,
      state,
    }
  }
  if (lock.state === 'paused') {
    return { acquired: false, reason: 'paused_by_human', holder: lock.holder ?? null, since: lock.since ?? null, state }
  }
  if (lock.state === 'awaiting_human') {
    return { acquired: false, reason: 'awaiting_human', holder: lock.holder ?? null, since: lock.since ?? null, state }
  }

  const at = nowIso()
  const next = {
    ...state,
    resumeLock: { state: 'recovering', holder: who, since: at, reason: 'resume_started' },
    lastResumeAt: at,
  }
  saveState(store, projectId, next)
  return { acquired: true, reason: 'acquired', holder: who, since: at, state: next }
}

/** Release the flow. Only the holder may release it. */
export function releaseResumeLock(store, projectId, conversationId, holder) {
  const state = loadState(store, projectId, conversationId)
  const lock = asRecord(state.resumeLock)
  if (lock.state !== 'recovering') {
    return { released: false, reason: 'not_recovering', holder: lock.holder ?? null, state }
  }
  if (isNonEmptyString(holder) && lock.holder !== holder) {
    return { released: false, reason: 'not_holder', holder: lock.holder ?? null, state }
  }
  const next = {
    ...state,
    resumeLock: { state: 'idle', holder: null, since: nowIso(), reason: 'resume_released' },
  }
  saveState(store, projectId, next)
  return { released: true, reason: 'released', holder: lock.holder ?? null, state: next }
}

// ---------------------------------------------------------------------------
// 7.5 — unexpected-interruption lock
// ---------------------------------------------------------------------------

/**
 * Engage the lock. Idempotent: engaging twice keeps the first `lockedAt`, so
 * the human reviewing the project sees when the lock *started*, not when it was
 * last re-asserted.
 */
export function engageLock(store, config, projectId, conversationId, reason) {
  const state = loadState(store, projectId, conversationId)
  const interrupt = asRecord(state.interruptLock)
  const at = nowIso()
  const alreadyLocked = interrupt.state === 'locked' || interrupt.state === 'trial_resume'

  const next = {
    ...state,
    interruptLock: {
      ...interrupt,
      state: 'locked',
      lastFailureReason: reason !== undefined && reason !== null
        ? clip(String(reason), MAX_REASON_LEN)
        : interrupt.lastFailureReason ?? null,
      lockedAt: alreadyLocked ? (interrupt.lockedAt ?? at) : at,
      lockedBy: alreadyLocked ? (interrupt.lockedBy ?? 'system') : (interrupt.lockedBy ?? 'system'),
      // A lock breaks stability by definition.
      stableSince: null,
    },
    resumeLock: {
      state: 'awaiting_human',
      holder: null,
      since: at,
      reason: `locked: ${clip(String(reason ?? 'interruption'), 200)}`,
    },
    lastFailureAt: state.lastFailureAt ?? at,
  }
  saveState(store, projectId, next)
  applyPlanLock(store, projectId, conversationId, true, reason, config)
  return next
}

/**
 * Release the lock. `{ resetCounter }` defaults to true for a full unlock (a
 * human asserting "it is fine now" also resets the evidence) and false for a
 * trial, because a trial is a *test* of the human's hypothesis and must keep
 * the failure history that explains why a lock exists at all.
 *
 * `{ trial: true }` puts the conversation in `trial_resume` instead of
 * `unlocked`: one supervised attempt. If it fails, `recordResumeAttempt` sends
 * it straight back to `locked` with `awaiting_human` — no automatic retry, and
 * `trialResumesUsed` makes the budget visible to the human.
 */
export function releaseLock(store, config, projectId, conversationId, by, opts = {}) {
  const state = loadState(store, projectId, conversationId)
  const interrupt = asRecord(state.interruptLock)
  const trial = opts.trial === true
  const maxTrial = Number(config?.interruptLock?.maxTrialResumes ?? 1)
  const at = nowIso()
  const actor = isNonEmptyString(by) ? by : 'human'

  if (!trial && interrupt.state !== 'locked' && interrupt.state !== 'trial_resume') {
    return { released: false, reason: 'not_locked', state }
  }
  if (trial && Math.max(0, Number(interrupt.trialResumesUsed) || 0) >= maxTrial) {
    return { released: false, reason: 'trial_exhausted', trialResumesUsed: Number(interrupt.trialResumesUsed) || 0, state }
  }

  const resetCounter = opts.resetCounter === undefined ? !trial : opts.resetCounter === true
  const nextInterrupt = {
    ...interrupt,
    state: trial ? 'trial_resume' : 'unlocked',
    consecutiveFailures: resetCounter ? 0 : Math.max(0, Number(interrupt.consecutiveFailures) || 0),
    lastFailureReason: resetCounter ? null : (interrupt.lastFailureReason ?? null),
    lockedAt: trial ? at : null,
    lockedBy: trial ? `trial:${actor}` : null,
    trialResumesUsed: trial ? Math.max(0, Number(interrupt.trialResumesUsed) || 0) + 1 : Math.max(0, Number(interrupt.trialResumesUsed) || 0),
    stableSince: null,
  }

  const next = {
    ...state,
    interruptLock: nextInterrupt,
    // Hand the conversation back to the planner only once the lock is gone; a
    // trial is resumable immediately (that is what the human just asked for).
    resumeLock: { state: 'idle', holder: null, since: at, reason: trial ? 'trial_unlock' : 'unlocked_by_human' },
  }
  saveState(store, projectId, next)
  applyPlanLock(store, projectId, conversationId, false, `由 ${actor} 解除${trial ? '（试恢复）' : ''}`, config)
  return {
    released: true,
    reason: trial ? 'trial_resume' : 'unlocked',
    trial,
    by: actor,
    consecutiveFailures: nextInterrupt.consecutiveFailures,
    trialResumesUsed: nextInterrupt.trialResumesUsed,
    state: next,
  }
}

/** Read-only projection of the lock, for tools and the workbench. */
export function lockStatus(store, projectId, conversationId) {
  const state = loadState(store, projectId, conversationId)
  const interrupt = asRecord(state.interruptLock)
  const lockState = interrupt.state ?? 'unlocked'
  return {
    conversationId,
    taskId: state.taskId ?? null,
    state: lockState,
    locked: lockState === 'locked',
    trial: lockState === 'trial_resume',
    consecutiveFailures: Math.max(0, Number(interrupt.consecutiveFailures) || 0),
    lastFailureReason: interrupt.lastFailureReason ?? null,
    lockedAt: interrupt.lockedAt ?? null,
    lockedBy: interrupt.lockedBy ?? null,
    trialResumesUsed: Math.max(0, Number(interrupt.trialResumesUsed) || 0),
    stableSince: interrupt.stableSince ?? null,
    resumeLock: asRecord(state.resumeLock),
    autoResumable: lockState !== 'locked',
    lastResumeAt: state.lastResumeAt ?? null,
    lastSucceededAt: state.lastSucceededAt ?? null,
    lastFailureAt: state.lastFailureAt ?? null,
  }
}

/**
 * Record one resume attempt and re-evaluate the lock (§7.5).
 *
 * `outcome`:
 *   - `rejected`          the server refused the attempt (a verdict about us)
 *   - `interrupted_again` the turn was cut off again (a fact about the turn)
 *   - `succeeded`         the turn completed; NOT a counter reset (see header C)
 *
 * The lock engages only when BOTH hold:
 *   1. `consecutiveFailures >= config.interruptLock.failureThreshold`, and
 *   2. the failure just recorded is a server rejection (`dead_end`, and not a
 *      user abort) — a transient blip is evidence of bad luck, not of a
 *      condition that will still be there after the next hundred retries.
 */
export function recordResumeAttempt(store, config, projectId, conversationId, input = {}) {
  const state = loadState(store, projectId, conversationId)
  const interrupt = asRecord(state.interruptLock)
  const threshold = Math.max(1, Number(config?.interruptLock?.failureThreshold ?? 3))
  const at = nowIso()
  const attemptId = isNonEmptyString(input.attemptId) ? input.attemptId : newId('rs')

  const outcome = ['rejected', 'interrupted_again', 'succeeded'].includes(input.outcome)
    ? input.outcome
    // An unrecognised outcome is treated as a failure: under-counting failures
    // is how a crash loop stays invisible.
    : 'interrupted_again'
  const facts = inspectFailure(input.failure)
  const failed = outcome !== 'succeeded'
  const wasTrial = interrupt.state === 'trial_resume'
  const alreadyLocked = interrupt.state === 'locked'

  let consecutiveFailures = Math.max(0, Number(interrupt.consecutiveFailures) || 0)
  if (failed) consecutiveFailures += 1

  const attempt = {
    id: attemptId,
    at,
    trigger: wasTrial ? 'trial' : 'auto',
    outcome,
    failure: failed ? reasonText(input.failure) : null,
    classification: failed ? facts.classification : null,
    serverRejection: failed ? facts.serverRejection : false,
    count: consecutiveFailures,
  }
  appendResumeHistory(store, projectId, conversationId, attempt)

  if (!failed) {
    // Success only *starts the stability clock*. `stableSince` is deliberately
    // not accompanied by a counter reset — a resume that lives ten seconds and
    // dies is the fourth failure, not a fresh start.
    const next = {
      ...state,
      interruptLock: {
        ...interrupt,
        // A successful trial is a successful supervised attempt: the lock is
        // satisfied and the conversation returns to normal service.
        state: wasTrial || alreadyLocked ? 'unlocked' : (consecutiveFailures > 0 ? 'counting' : 'unlocked'),
        consecutiveFailures,
        stableSince: at,
        lockedAt: wasTrial ? null : (interrupt.lockedAt ?? null),
        lockedBy: wasTrial ? null : (interrupt.lockedBy ?? null),
      },
      resumeLock: { state: 'idle', holder: null, since: at, reason: 'resume_attempt_succeeded' },
      lastSucceededAt: at,
      lastResumeAt: state.lastResumeAt ?? at,
    }
    saveState(store, projectId, next)
    if (wasTrial || alreadyLocked) applyPlanLock(store, projectId, conversationId, false, '恢复成功，解除中断锁', config)
    return { ...next, lockEngaged: false, outcome, threshold, classification: null }
  }

  // ---- failure path -------------------------------------------------------
  const shouldLock = alreadyLocked
    || wasTrial
    || (consecutiveFailures >= threshold && facts.serverRejection)

  const nextInterrupt = {
    ...interrupt,
    // Engaging writes 'locked' below; this is the pre-lock state.
    state: shouldLock ? 'locked' : 'counting',
    consecutiveFailures,
    lastFailureReason: reasonText(input.failure) ?? interrupt.lastFailureReason ?? null,
    // Stability is broken by a failure: a stale `stableSince` would let the next
    // `recordStable` call zero the counter right after a rejection.
    stableSince: null,
  }

  if (shouldLock) {
    nextInterrupt.lockedAt = wasTrial ? at : (interrupt.lockedAt ?? at)
    nextInterrupt.lockedBy = wasTrial ? 'system:trial_failed' : (interrupt.lockedBy ?? 'system')
    // A failed trial must not be auto-retried: the human gets the decision back.
    nextInterrupt.trialResumesUsed = Math.max(0, Number(interrupt.trialResumesUsed) || 0)
  }

  const next = {
    ...state,
    interruptLock: nextInterrupt,
    resumeLock: shouldLock
      ? { state: 'awaiting_human', holder: null, since: at, reason: 'interruption_lock_engaged' }
      : { state: 'idle', holder: null, since: at, reason: 'resume_attempt_failed' },
    lastFailureAt: at,
    lastResumeAt: state.lastResumeAt ?? at,
  }
  saveState(store, projectId, next)
  if (shouldLock && !alreadyLocked) {
    applyPlanLock(store, projectId, conversationId, true, nextInterrupt.lastFailureReason, config)
  }

  return {
    ...next,
    lockEngaged: shouldLock,
    outcome,
    threshold,
    classification: facts.classification,
    serverRejection: facts.serverRejection,
    maxTrialResumes: Number(config?.interruptLock?.maxTrialResumes ?? 1),
  }
}

/**
 * Reset the failure counter once the conversation has demonstrated stability.
 *
 * Two ways to prove it, and both are needed:
 *   - time: `now - stableSince >= stableWindowMs` (the conversation kept running
 *     after a resume and did not die again);
 *   - substance: `{ substantive: true }`, one real operation landed. A landed
 *     handoff is stronger evidence than ten quiet minutes, so the caller may
 *     assert it directly.
 *
 * The lock state itself is NOT released here: a locked conversation is not
 * running, so it cannot be stable, and the only way out of `locked` is an
 * explicit `releaseLock` (human decision) — auto-releasing on a counter would
 * reintroduce the retry loop the lock exists to stop.
 */
export function recordStable(store, config, projectId, conversationId, opts = {}) {
  const state = loadState(store, projectId, conversationId)
  const interrupt = asRecord(state.interruptLock)
  const windowMs = Math.max(0, Number(config?.interruptLock?.stableWindowMs ?? 10 * 60 * 1000))
  const now = resolveNow(opts.now)
  const stableSince = parseSince(interrupt.stableSince)
  const elapsedMs = stableSince > 0 ? now - stableSince : 0
  const substantive = opts.substantive === true
  const timedOut = stableSince > 0 && elapsedMs >= windowMs

  if (!substantive && !timedOut) {
    return {
      ...state,
      reset: false,
      reason: 'not_stable_yet',
      elapsedMs,
      remainingMs: stableSince > 0 ? Math.max(0, windowMs - elapsedMs) : windowMs,
      substantive,
    }
  }

  const next = {
    ...state,
    interruptLock: {
      ...interrupt,
      consecutiveFailures: 0,
      lastFailureReason: null,
      stableSince: null,
      state: interrupt.state === 'counting' || interrupt.state === 'trial_resume'
        ? 'unlocked'
        : (interrupt.state ?? 'unlocked'),
    },
  }
  saveState(store, projectId, next)
  return {
    ...next,
    reset: true,
    reason: substantive ? 'substantive_operation' : 'stable_window_elapsed',
    elapsedMs,
    remainingMs: 0,
    substantive,
  }
}

// ---------------------------------------------------------------------------
// 7.2 — the resume brief and its injection
// ---------------------------------------------------------------------------

/**
 * The cross-module verification payload (§7.2).
 *
 * A resume without this is a guess. The brief exists so the taking-over
 * conversation can answer "what changed while I was gone?" *before* it acts:
 * what other agents posted, what the plan looks like now, which assets moved,
 * who holds execution rights, and whether its own last operation already
 * landed. The idempotency verdict is the headline — it is the difference
 * between a resume and a duplicate.
 */
export function brief(store, config, projectId, conversationId) {
  const state = loadState(store, projectId, conversationId)
  const task = taskForConversation(store, projectId, conversationId)
  const checkpoint = checkpointOf(store, projectId, conversationId)
  const snapshot = store.snapshot(projectId) ?? { feed: [], plan: [], tasks: [], assets: [] }
  const events = Array.isArray(snapshot.feed) ? snapshot.feed : []
  const items = Array.isArray(snapshot.plan) ? snapshot.plan : []
  const assets = Array.isArray(snapshot.assets) ? snapshot.assets : []
  const crossSnapshot = snapshotOf(checkpoint)
  const boundItemId = task?.planItemId ?? null
  const boundItem = boundItemId ? items.find((item) => item.id === boundItemId) : undefined

  // -- feed since the checkpoint -------------------------------------------
  const lastFeedId = crossSnapshot.feed_latest_event_id
    ?? (Array.isArray(checkpoint?.feed_event_ids) ? checkpoint.feed_event_ids[checkpoint.feed_event_ids.length - 1] : null)
  const lastIndex = isNonEmptyString(lastFeedId) ? events.findIndex((event) => event?.id === lastFeedId) : -1
  const sinceEvents = lastIndex >= 0
    ? events.slice(lastIndex + 1)
    : (checkpoint !== undefined
      ? events.filter((event) => parseSince(event?.at) > parseSince(checkpoint.timestamp))
      : events.slice(Math.max(0, events.length - 20)))
  const feedSince = sinceEvents.slice(Math.max(0, sinceEvents.length - MAX_BRIEF_FEED_EVENTS)).map((event) => ({
    id: event.id,
    at: event.at,
    kind: event.kind,
    category: event.category,
    source: event.source,
    actor: event.actor?.name ?? event.actor?.id ?? 'unknown',
    taskId: event.taskId ?? null,
    planItemId: event.planItemId ?? null,
    assetId: event.assetId ?? null,
    pinned: event.pinned === true,
    content: clip(event.content ?? '', 400),
  }))
  const actorsSince = [...new Set(feedSince.map((event) => event.actor))]

  // -- plan ----------------------------------------------------------------
  const recordedStates = asRecord(crossSnapshot.plan_item_states)
  const relevantIds = new Set(Object.keys(recordedStates))
  if (boundItemId) relevantIds.add(boundItemId)
  if (boundItem) {
    for (const dep of asStringArray(boundItem.dependsOn)) relevantIds.add(dep)
  }
  const planItems = {}
  for (const item of items) {
    if (!relevantIds.has(item.id)) continue
    planItems[item.id] = {
      id: item.id,
      title: item.title,
      status: item.status,
      assignee: item.assignee ?? null,
      priority: item.priority ?? 0,
      dependsOn: asStringArray(item.dependsOn),
      blockedBy: asStringArray(item.blockedBy),
      taskId: item.taskId ?? null,
      lastNote: item.lastNote ?? '',
      checkpointStatus: recordedStates[item.id] ?? null,
      changedSinceCheckpoint: recordedStates[item.id] !== undefined && recordedStates[item.id] !== item.status,
    }
  }
  const dependencies = (boundItem ? asStringArray(boundItem.dependsOn) : []).map((id) => {
    const dep = items.find((item) => item.id === id)
    return {
      id,
      title: dep?.title ?? id,
      status: dep?.status ?? 'missing',
      done: dep?.status === 'done',
      blocked: dep !== undefined && dep.status !== 'done',
    }
  })

  // -- assets --------------------------------------------------------------
  const assetRefs = asRecord(crossSnapshot.asset_version_refs)
  const assetChanges = []
  for (const asset of assets) {
    const had = Object.prototype.hasOwnProperty.call(assetRefs, asset.id)
    const from = had ? Number(assetRefs[asset.id]) : null
    const to = asset.deletedAt ? null : (Number(asset.version) || 0)
    if (!had) {
      if (asset.deletedAt) continue
      // Not in the checkpoint but bound to this task: it appeared while away.
      if (task && asset.sourceTaskId === task.id) {
        assetChanges.push({ assetId: asset.id, name: asset.name, from: null, to, deleted: false, kind: 'added' })
      }
      continue
    }
    if (asset.deletedAt) {
      assetChanges.push({ assetId: asset.id, name: asset.name, from, to: null, deleted: true, kind: 'deleted' })
      continue
    }
    if (from !== to) {
      assetChanges.push({ assetId: asset.id, name: asset.name, from, to, deleted: false, kind: 'updated' })
    }
  }

  // -- execution rights ----------------------------------------------------
  const executionLock = asRecord(task?.executionLock)
  const currentExecutionLock = {
    holder: executionLock.holder ?? null,
    acquiredAt: executionLock.acquiredAt ?? null,
    expiresAt: executionLock.expiresAt ?? null,
    queued: Array.isArray(executionLock.queue) ? executionLock.queue.map((entry) => entry?.agent ?? null).filter(Boolean) : [],
    checkpointHolder: crossSnapshot.execution_lock_holder ?? null,
    changedSinceCheckpoint: (executionLock.holder ?? null) !== (crossSnapshot.execution_lock_holder ?? null),
  }

  // -- idempotency ---------------------------------------------------------
  const lastOperation = asRecord(checkpoint?.resume_context?.last_operation)
  const idempotency = guard(
    store, config, projectId, conversationId,
    normalizeOperationType(lastOperation.type), lastOperation.target_ref ?? null,
  )

  return {
    projectId,
    conversationId,
    taskId: task?.id ?? state.taskId ?? null,
    task: task === undefined ? null : {
      id: task.id,
      title: task.title,
      status: task.status,
      ownerAgent: task.ownerAgent ?? null,
      workspace: task.workspace ?? null,
      planItemId: task.planItemId ?? null,
      lastCheckpointAt: task.lastCheckpointAt ?? null,
    },
    planItemId: boundItemId,
    planItem: boundItem === undefined ? null : {
      id: boundItem.id,
      title: boundItem.title,
      status: boundItem.status,
      assignee: boundItem.assignee ?? null,
      priority: boundItem.priority ?? 0,
    },
    checkpoint: checkpoint ?? null,
    checkpointId: checkpoint?.checkpoint_id ?? null,
    checkpointAt: checkpoint?.timestamp ?? null,
    checkpointSummary: checkpoint?.context_summary ?? '',
    nextExpectedActor: checkpoint?.next_expected_actor ?? task?.ownerAgent ?? 'human',
    lastOperation,
    feed: {
      latestEventId: crossSnapshot.feed_latest_event_id ?? (events.length > 0 ? events[events.length - 1].id : null),
      sinceCheckpoint: feedSince,
      sinceCount: sinceEvents.length,
      truncated: sinceEvents.length > feedSince.length,
      actorsSince,
      humanInstructions: feedSince.filter((event) => event.kind === 'human' || event.category === 'human.instruction'),
    },
    plan: {
      items: planItems,
      dependencies,
      blockedDependencies: dependencies.filter((dep) => dep.blocked),
      boundItemStatus: boundItem?.status ?? null,
    },
    assets: {
      versionRefs: assetRefs,
      changes: assetChanges,
      changedCount: assetChanges.length,
    },
    executionLock: currentExecutionLock,
    idempotency,
    interruptLock: {
      state: state.interruptLock?.state ?? 'unlocked',
      consecutiveFailures: Math.max(0, Number(state.interruptLock?.consecutiveFailures) || 0),
      lastFailureReason: state.interruptLock?.lastFailureReason ?? null,
      lockedAt: state.interruptLock?.lockedAt ?? null,
      lockedBy: state.interruptLock?.lockedBy ?? null,
      trialResumesUsed: Math.max(0, Number(state.interruptLock?.trialResumesUsed) || 0),
    },
    resumeLock: asRecord(state.resumeLock),
    generatedAt: nowIso(),
  }
}

/**
 * Inject the resume message into a conversation.
 *
 * `deps.createUserMessage(text)` resolves the Host's message shape *at call
 * time*: `lib/core/` must stay importable without the Host (§intro), so the
 * factory is supplied by the tool layer rather than imported here.
 *
 * `deps.deliver(agent, message)` performs the actual hand-off. It is injected
 * for the same reason, and because the *transport* is a Host concern:
 * `followup` opens a turn, `steer` cuts into a turn in progress, and choosing
 * between them is the runtime's job, not the recovery subsystem's.
 *
 * `deps.auto !== false` charges the sliding-window budget, because this is the
 * moment an automatic resume actually costs the user something.
 */
export async function injectResume(agent, resumeBrief, deps = {}) {
  if (agent === null || typeof agent !== 'object') {
    throw new TypeError('injectResume: a live agent is required')
  }
  if (typeof deps.createUserMessage !== 'function') {
    throw new TypeError('injectResume: deps.createUserMessage(text) is required')
  }
  if (typeof deps.deliver !== 'function') {
    throw new TypeError('injectResume: deps.deliver(agent, message) is required')
  }
  const text = resumeMessage(resumeBrief)
  const message = await deps.createUserMessage(text)

  /**
   * Refuse to hand the Host a message it cannot key.
   *
   * `followup()` keys its pending inbox by `message.id`. Passing a message
   * without one throws `message "undefined" is already pending` from inside the
   * agent loop — and nothing on this side can catch a fault raised there, so the
   * entire Host process exits. A resume is a convenience; taking DSH down for it
   * is not a trade this subsystem may make.
   *
   * So the shape is validated here, before the call: a factory that forgets `id`
   * becomes a normal rejected attempt instead of a process crash.
   */
  if (message === null || typeof message !== 'object' || message.id === undefined || message.id === null || message.id === '') {
    throw new TypeError(
      'injectResume: deps.createUserMessage(text) must return a message with a non-empty `id` ' +
        '(the Host keys its pending inbox by it; a missing id crashes the process)',
    )
  }

  /**
   * The hand-off is guarded, so a Host-side rejection (a message the Host
   * cannot key, a session being torn down) becomes a normal failed attempt —
   * never an unhandled rejection, which Node turns into an uncaught exception
   * and, with it, the end of the Host process.
   */
  const outcome = await deps.deliver(agent, message)
  if (outcome !== undefined && outcome !== null && outcome.delivered === false) {
    const reason = outcome.reason ?? 'delivery_failed'
    const detail = outcome.error ? `: ${outcome.error}` : ''
    throw new Error(`injectResume: the Host refused the resume message (${reason}${detail})`)
  }
  const result = outcome?.result ?? outcome

  // Charge the auto-resume budget only after the injection actually happened:
  // counting a failed send would let the cap silently swallow recoveries.
  const store = deps.store
  const projectId = deps.projectId ?? resumeBrief?.projectId
  const conversationId = deps.conversationId ?? resumeBrief?.conversationId
  if (store !== undefined && deps.auto !== false && isNonEmptyString(projectId) && isNonEmptyString(conversationId)) {
    try {
      const state = loadState(store, projectId, conversationId)
      const window = asRecord(state.autoResumeWindow)
      const now = Date.now()
      const windowMs = Number(store.config?.resume?.windowMs ?? 60 * 60 * 1000)
      const startedAt = parseSince(window.startedAt)
      const expired = startedAt <= 0 || (now - startedAt) > windowMs
      const next = {
        ...state,
        autoResumeWindow: {
          startedAt: expired ? new Date(now).toISOString() : window.startedAt,
          count: (expired ? 0 : Math.max(0, Number(window.count) || 0)) + 1,
        },
        lastResumeAt: new Date(now).toISOString(),
      }
      saveState(store, projectId, next)
    } catch {
      /* bookkeeping must never fail an injection that already happened */
    }
  }
  return result
}
