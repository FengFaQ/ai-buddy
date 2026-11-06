/**
 * Checkpoint construction (§5.6, §6.6).
 *
 * A checkpoint is the one artifact a taking-over conversation reads before it
 * decides whether to repeat work. That makes two things non-negotiable:
 *
 * 1. **It is built from the live store, never from the caller's memory.** The
 *    cross-module snapshot is read at build time, so a checkpoint cannot claim
 *    a feed position, a plan state, an asset version or an execution-lock
 *    holder that the other four modules no longer agree with (§10 invariant 1).
 *    A checkpoint that lies is worse than no checkpoint: the resumer trusts it.
 *
 * 2. **It records what the agent believed it did, plus whether that landed.**
 *    `last_operation.result_status` is the input to the idempotency guard
 *    (§7.3). Without it the resumer has to re-verify from scratch — and the
 *    cheap version of that is "just do it again", which is exactly the bug this
 *    subsystem exists to prevent.
 *
 * `build` is deliberately side-effect free so a tool can preview the document
 * (or thread it into a handoff summary) without persisting it; `write` is the
 * only function that appends. Keeping them apart is what lets a *failed*
 * operation still be checkpointed as `failed` without inventing history.
 */

import {
  newId, nowIso, clip, asRecord, asStringArray, parseSince, isNonEmptyString,
} from '../util.js'

/** The closed set from §5.6 `event_type`. */
export const CHECKPOINT_EVENT_TYPES = Object.freeze([
  'handoff', 'plan_update', 'asset_write', 'feed_post', 'status_change',
  'resume_attempt', 'resume_success', 'resume_failure',
  'lock_engaged', 'lock_released',
])

/** The closed set from §5.6 `last_operation.type` (§7.3 rows). */
export const LAST_OPERATION_TYPES = Object.freeze([
  'handoff', 'asset_write', 'plan_update', 'feed_post', 'conversation_create',
])

/** The closed set from §5.6 `last_operation.result_status`. */
export const OPERATION_RESULT_STATUSES = Object.freeze([
  'confirmed', 'unconfirmed', 'failed', 'changed_by_other',
])

/**
 * `status_change` is the generic bucket: it is what a checkpoint records when
 * the caller did not name a more specific trigger (a plain "the turn ended"
 * checkpoint). Mapping an unknown value here rather than throwing keeps a
 * checkpoint write from failing *after* the operation it was meant to guard.
 */
const DEFAULT_EVENT_TYPE = 'status_change'

/** Dependencies of a plan item form a small graph; bound it so a checkpoint
 *  stays a readable document even in a two-hundred-item project. */
const MAX_PLAN_STATES = 100
const MAX_ASSET_REFS = 200
const MAX_FEED_IDS = 50
const MAX_CONTEXT_SUMMARY = 1200

function asFeedEventArray(value) {
  return Array.isArray(value) ? value : []
}

function eventCategory(event) {
  return typeof event?.category === 'string' ? event.category : ''
}

/** The task a conversation is bound to, by explicit id first (§1: SessionId). */
function taskForConversation(tasks, conversationId, taskId) {
  if (isNonEmptyString(taskId)) {
    const direct = tasks.find((task) => task?.id === taskId)
    if (direct !== undefined) return direct
  }
  return tasks.find((task) => task?.conversationId === conversationId)
}

/**
 * Relevance filter for the feed ids a checkpoint carries: what did *this*
 * conversation need to know? Human instructions, anything touching its task or
 * plan item, lock/recovery events (they change who may act) and pinned events
 * (the ones a human must see) all qualify. Everything else is other work.
 */
function relevantFeedEvent(event, taskId, planItemId) {
  if (event === undefined || event === null) return false
  const category = eventCategory(event)
  if (taskId && event.taskId === taskId) return true
  if (planItemId && event.planItemId === planItemId) return true
  if (event.kind === 'human') return true
  if (category.startsWith('resume.') || category.startsWith('lock.')) return true
  if (category === 'execution.handoff' || category === 'task.handoff') return true
  return event.pinned === true
}

function deriveFeedEventIds(feed, previous, task, planItem) {
  const sinceMs = previous ? parseSince(previous.timestamp) : 0
  const taskId = task?.id ?? null
  const planItemId = planItem?.id ?? task?.planItemId ?? null
  const ids = []
  for (const event of feed) {
    const at = parseSince(event?.at)
    // `sinceMs === 0` means "no previous checkpoint" — everything is new.
    if (sinceMs > 0 && at > 0 && at < sinceMs) continue
    if (!relevantFeedEvent(event, taskId, planItemId)) continue
    if (isNonEmptyString(event?.id)) ids.push(event.id)
  }
  return ids.slice(Math.max(0, ids.length - MAX_FEED_IDS))
}

/**
 * The plan neighbourhood whose state a resumer must know: the bound item, its
 * transitive upstream `dependsOn` items (what must be done before continuing)
 * and everything downstream that lists one of those as a dependency (what will
 * be affected if this conversation changes its status). Computing the
 * transitive closure costs nothing at these sizes and answers the only two
 * questions the resumer actually has.
 */
function planNeighbourhoodIds(items, boundItemId) {
  if (!isNonEmptyString(boundItemId)) return []
  const byId = new Map(items.map((item) => [item.id, item]))
  if (!byId.has(boundItemId)) return [boundItemId]
  const keep = new Set([boundItemId])
  let changed = true
  while (changed) {
    changed = false
    for (const item of items) {
      const deps = asStringArray(item?.dependsOn)
      if (keep.has(item.id)) {
        for (const dep of deps) {
          if (byId.has(dep) && !keep.has(dep)) {
            keep.add(dep)
            changed = true
          }
        }
      } else if (deps.some((dep) => keep.has(dep))) {
        keep.add(item.id)
        changed = true
      }
    }
  }
  return [...keep].filter((id) => byId.has(id)).slice(0, MAX_PLAN_STATES)
}

function planItemStates(plan, task, boundItem) {
  const ids = new Set(planNeighbourhoodIds(plan, boundItem?.id ?? task?.planItemId))
  // Items bound to the same task always belong in the snapshot, even when the
  // dependency graph does not connect them.
  if (task?.planItemId) ids.add(task.planItemId)
  const states = {}
  for (const item of plan) {
    if (!ids.has(item?.id)) continue
    states[item.id] = item.status
  }
  return states
}

/**
 * Version refs for the assets this conversation could overwrite. Two sources:
 * assets minted by its task (`sourceTaskId`) and assets cited by its recent
 * feed events. Deleted assets are excluded — a resumer must not plan around a
 * blob that is gone; the guard turns that into `changed_by_other` instead.
 */
function assetVersionRefs(assets, feed, taskId) {
  const cited = new Set()
  for (const event of feed) {
    if (taskId && event?.taskId !== taskId) continue
    if (isNonEmptyString(event?.assetId)) cited.add(event.assetId)
  }
  const refs = {}
  let count = 0
  for (const asset of assets) {
    if (count >= MAX_ASSET_REFS) break
    if (asset === null || asset === undefined) continue
    if (asset.deletedAt !== null && asset.deletedAt !== undefined) continue
    const relevant = (taskId && asset.sourceTaskId === taskId) || cited.has(asset.id)
    if (!relevant) continue
    refs[asset.id] = asset.version
    count++
  }
  return refs
}

function latestFeedEventId(feed) {
  for (let i = feed.length - 1; i >= 0; i--) {
    const id = feed[i]?.id
    if (isNonEmptyString(id)) return id
  }
  return null
}

function normalizeLastOperation(value) {
  const raw = asRecord(value)
  const type = LAST_OPERATION_TYPES.includes(raw.type) ? raw.type : null
  const status = OPERATION_RESULT_STATUSES.includes(raw.result_status ?? raw.resultStatus)
    ? (raw.result_status ?? raw.resultStatus)
    : 'unconfirmed'
  const targetRef = raw.target_ref ?? raw.targetRef ?? null
  return {
    type,
    target_ref: targetRef === undefined ? null : targetRef,
    result_status: status,
    // A verification timestamp is only truthful when the caller supplies one.
    // Defaulting it to `now` would claim the live store agreed at build time.
    verified_at: raw.verified_at ?? raw.verifiedAt ?? null,
  }
}

function defaultSummary(task, planItem, lastOperation) {
  const parts = []
  if (task !== undefined) parts.push(`任务「${task.title ?? task.id}」(${task.id})`)
  else parts.push('对话未绑定任务')
  if (planItem !== undefined) parts.push(`计划条目「${planItem.title ?? planItem.id}」状态 ${planItem.status}`)
  if (lastOperation.type !== null) {
    parts.push(`上次操作 ${lastOperation.type} → ${lastOperation.result_status}`)
  }
  return parts.join('；')
}

/**
 * Build (without persisting) the §5.6 checkpoint document.
 *
 * @param {object} store  a live `Store`
 * @param {object} config effective config (retention/clip knobs)
 * @param {string} projectId
 * @param {object} spec   { conversationId, taskId, eventType, triggerAgent,
 *                          lastOperation, contextSummary, nextExpectedActor,
 *                          feedEventIds }
 */
export function build(store, config, projectId, spec = {}) {
  const conversationId = typeof spec.conversationId === 'string' ? spec.conversationId.trim() : ''
  if (conversationId === '') {
    throw new TypeError('checkpoint.build: conversationId is required')
  }
  const snapshot = store.snapshot(projectId)
  if (snapshot === undefined) {
    throw new Error(`checkpoint.build: unknown project ${projectId}`)
  }

  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : []
  const plan = Array.isArray(snapshot.plan) ? snapshot.plan : []
  const assets = Array.isArray(snapshot.assets) ? snapshot.assets : []
  const feed = asFeedEventArray(snapshot.feed)

  const task = taskForConversation(tasks, conversationId, spec.taskId)
  const boundItem = task?.planItemId
    ? plan.find((item) => item?.id === task.planItemId)
    : undefined
  const previous = store.latestCheckpoint(projectId, conversationId)
  const lastOperation = normalizeLastOperation(spec.lastOperation)

  const requestedIds = asStringArray(spec.feedEventIds)
  const feedEventIds = requestedIds.length > 0
    ? requestedIds.slice(Math.max(0, requestedIds.length - MAX_FEED_IDS))
    : deriveFeedEventIds(feed, previous, task, boundItem)

  const resumeState = store.getResumeState(projectId, conversationId) ?? {}
  const interrupt = asRecord(resumeState.interruptLock)
  const executionLock = asRecord(task?.executionLock)

  const eventType = CHECKPOINT_EVENT_TYPES.includes(spec.eventType)
    ? spec.eventType
    : DEFAULT_EVENT_TYPE

  const triggerAgent = isNonEmptyString(spec.triggerAgent)
    ? spec.triggerAgent
    : (task?.ownerAgent ?? 'unknown')

  const nextExpectedActor = isNonEmptyString(spec.nextExpectedActor)
    ? spec.nextExpectedActor
    : (task?.ownerAgent ?? boundItem?.assignee ?? 'human')

  const summary = isNonEmptyString(spec.contextSummary)
    ? spec.contextSummary
    : defaultSummary(task, boundItem, lastOperation)

  return {
    checkpoint_id: newId('cp'),
    timestamp: nowIso(),
    trigger_agent: triggerAgent,
    conversation_id: conversationId,
    event_type: eventType,
    // Refs point at the truth layer, not at a copy: the resumer re-reads them.
    plan_snapshot_ref: boundItem ? `plan.json#${boundItem.id}` : 'plan.json',
    asset_manifest_ref: 'assets/manifest.json',
    feed_event_ids: feedEventIds,
    context_summary: clip(summary, MAX_CONTEXT_SUMMARY),
    next_expected_actor: nextExpectedActor,
    resume_context: {
      last_operation: lastOperation,
      cross_module_snapshot: {
        feed_latest_event_id: latestFeedEventId(feed),
        plan_item_states: planItemStates(plan, task, boundItem),
        asset_version_refs: assetVersionRefs(assets, feed, task?.id),
        execution_lock_holder: executionLock.holder ?? null,
      },
      resume_lock_state: {
        consecutive_failures: Number(interrupt.consecutiveFailures ?? 0) || 0,
        last_failure_reason: interrupt.lastFailureReason ?? null,
        // A trial resume is still a lock: the conversation must not also be
        // picked up by another automatic pass while the trial runs.
        locked: interrupt.state === 'locked' || interrupt.state === 'trial_resume',
        locked_at: interrupt.lockedAt ?? null,
        locked_by: interrupt.lockedBy ?? null,
      },
    },
  }
}

/**
 * Build and append. Returns the persisted checkpoint.
 *
 * Side effect beyond the append: the bound task remembers when it was last
 * checkpointed (`Task.lastCheckpointAt`, §5.4), because the workbench and the
 * resume planner both ask "is this conversation's state fresh?".
 */
export function write(store, config, projectId, spec = {}) {
  const checkpoint = build(store, config, projectId, spec)
  store.appendCheckpoint(projectId, checkpoint)

  const conversationId = checkpoint.conversation_id
  const tasks = store.readTasks(projectId)
  const task = tasks.find((candidate) => candidate?.conversationId === conversationId)
  if (task !== undefined) {
    store.putTask(projectId, {
      ...task,
      lastCheckpointAt: checkpoint.timestamp,
      updatedAt: checkpoint.timestamp,
    })
  }
  return checkpoint
}
