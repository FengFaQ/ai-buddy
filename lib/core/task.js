/**
 * Task = conversation binding (§2.3). A `Task` is the durable side of a Host
 * session: which conversation was doing what, who currently owns the work, and
 * what it had reached when it last stopped.
 *
 * The important boundary in this file is that **`handoff` orchestrates, it does
 * not narrate**. It validates the right, moves the execution lock, appends the
 * handoff record to the task, and returns a descriptor of the two side effects
 * somebody else must write: the checkpoint (§6.6) and the feed event (§6.1).
 * Those live in modules that need the whole project view, and `tools/index.js`
 * sequences them so exactly one checkpoint is written per handoff. If this
 * module wrote them itself, a handoff triggered from the web API and one
 * triggered from an agent tool would produce different audit trails.
 *
 * A task also owns three locks that mean different things and must not be
 * conflated:
 *   - `executionLock` (§3): who may *act* right now. Arbitrated by locks.js.
 *   - `resumeLock`  (§7.4): who is *recovering* this conversation. Owned by resume.js.
 *   - `interruptLock` (§7.5): the conversation failed to resume too often and is
 *     frozen until a human intervenes. Owned by resume.js.
 * `handoff` touches only the first.
 */

import {
  newId, nowIso, asRecord, asStringArray, isNonEmptyString, clip,
} from '../util.js'

export const TASK_STATUSES = Object.freeze([
  'active', 'paused', 'done', 'archived', 'locked_by_interrupt',
])

/** How long a handed-off execution right stays valid without a refresh. */
const DEFAULT_LOCK_TIMEOUT_MS = 30 * 60 * 1000

// --------------------------------------------------------------- internals

function requireProject(store, projectId) {
  if (!isNonEmptyString(projectId)) {
    throw new Error('ai-buddy task: a non-empty projectId is required')
  }
  const project = store.getProject(projectId)
  if (project === undefined) {
    throw new Error(`ai-buddy task: unknown project "${projectId}"`)
  }
  return project
}

function requireActor(actor) {
  // Accept a bare agent name as well as the full Actor record: the tool layer
  // knows the calling agent as a string, and forcing every tool to build the
  // record would just duplicate this normalization in five places.
  if (typeof actor === 'string' && actor.trim() !== '') {
    return { type: actor === 'human' ? 'human' : 'agent', id: actor.trim(), name: actor.trim() }
  }
  const rec = asRecord(actor)
  const id = isNonEmptyString(rec.id) ? rec.id : (isNonEmptyString(rec.name) ? rec.name : '')
  if (id === '') {
    throw new Error('ai-buddy task: an actor with a non-empty id or name is required')
  }
  return {
    type: rec.type === 'human' ? 'human' : 'agent',
    id,
    name: isNonEmptyString(rec.name) ? rec.name : id,
  }
}

function isHuman(actor) {
  return actor?.type === 'human'
}

export function emptyExecutionLock() {
  return { holder: null, acquiredAt: null, expiresAt: null, queue: [] }
}

function emptyResumeLock() {
  return { state: 'idle', holder: null, since: null, reason: '' }
}

function emptyInterruptLock() {
  return {
    state: 'unlocked',
    consecutiveFailures: 0,
    lastFailureReason: null,
    lockedAt: null,
    lockedBy: null,
    trialResumesUsed: 0,
    stableSince: null,
  }
}

function normalizeLock(raw) {
  const rec = asRecord(raw)
  return {
    holder: isNonEmptyString(rec.holder) ? rec.holder : null,
    acquiredAt: typeof rec.acquiredAt === 'string' ? rec.acquiredAt : null,
    expiresAt: typeof rec.expiresAt === 'string' ? rec.expiresAt : null,
    queue: Array.isArray(rec.queue)
      ? rec.queue
        .map((entry) => {
          const e = asRecord(entry)
          return {
            agent: isNonEmptyString(e.agent) ? e.agent : null,
            requestedAt: typeof e.requestedAt === 'string' ? e.requestedAt : null,
            timeoutAt: typeof e.timeoutAt === 'string' ? e.timeoutAt : null,
          }
        })
        .filter((entry) => entry.agent !== null)
      : [],
  }
}

/** Fill every field so no reader has to defend against an older document. */
export function normalizeTask(raw) {
  const t = asRecord(raw)
  return {
    id: String(t.id ?? ''),
    projectId: String(t.projectId ?? ''),
    title: String(t.title ?? ''),
    description: String(t.description ?? ''),
    conversationId: isNonEmptyString(t.conversationId) ? t.conversationId : null,
    workspace: isNonEmptyString(t.workspace) ? t.workspace : null,
    planItemId: isNonEmptyString(t.planItemId) ? t.planItemId : null,
    ownerAgent: isNonEmptyString(t.ownerAgent) ? t.ownerAgent : null,
    status: TASK_STATUSES.includes(t.status) ? t.status : 'active',
    executionLock: normalizeLock(t.executionLock),
    resumeLock: { ...emptyResumeLock(), ...asRecord(t.resumeLock) },
    interruptLock: { ...emptyInterruptLock(), ...asRecord(t.interruptLock) },
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : nowIso(),
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : nowIso(),
    lastCheckpointAt: typeof t.lastCheckpointAt === 'string' ? t.lastCheckpointAt : null,
    resumeHistory: Array.isArray(t.resumeHistory) ? t.resumeHistory : [],
    // Handoff audit trail, appended by `handoff` below.
    handoffs: Array.isArray(t.handoffs) ? t.handoffs : [],
    // Agents granted read/cite access without execution rights (`shareReadonly`).
    sharedWith: asStringArray(t.sharedWith),
    // Task-to-task references (`reference`), both directions for cheap reads.
    references: Array.isArray(t.references) ? t.references : [],
    referencedBy: Array.isArray(t.referencedBy) ? t.referencedBy : [],
    archivedAt: typeof t.archivedAt === 'string' ? t.archivedAt : null,
    createdBy: asRecord(t.createdBy),
  }
}

function readTask(store, projectId, taskId) {
  const stored = store.readTasks(projectId).find((task) => task.id === taskId)
  if (stored === undefined) {
    throw new Error(`ai-buddy task: unknown task "${taskId}" in project "${projectId}"`)
  }
  return normalizeTask(stored)
}

function saveTask(store, projectId, task) {
  const saved = store.putTask(projectId, task)
  return normalizeTask(saved ?? task)
}

function lockTimeoutMs(store, config) {
  const value = Number(config?.executionLock?.timeoutMs ?? store?.config?.executionLock?.timeoutMs)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_LOCK_TIMEOUT_MS
}

/** Whether `agent` may act on `task` right now (human always may). */
function holdsExecutionRight(task, agentId, human) {
  if (human) return true
  const holder = task.executionLock.holder
  return holder !== null && holder === agentId
}

// ------------------------------------------------------------------- writes

export function create(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)
  const actor = requireActor(opts.actor)

  const title = isNonEmptyString(opts.title) ? opts.title.trim() : ''
  if (title === '') {
    throw new Error('ai-buddy task: a task needs a non-empty title')
  }

  const planItemId = isNonEmptyString(opts.planItemId) ? opts.planItemId : null
  if (planItemId !== null && !store.readPlan(projectId).some((item) => item.id === planItemId)) {
    throw new Error(`ai-buddy task: unknown plan item "${planItemId}" in project "${projectId}"`)
  }

  const ownerAgent = isNonEmptyString(opts.ownerAgent) ? opts.ownerAgent : null
  const conversationId = isNonEmptyString(opts.conversationId) ? opts.conversationId : null

  // A conversation may be bound to exactly one live task: two tasks pointing at
  // the same session would let two different execution rights apply to one
  // agent turn, and a resume would not know which task it was resuming.
  if (conversationId !== null) {
    const clash = store.readTasks(projectId)
      .map(normalizeTask)
      .find((task) => task.conversationId === conversationId && task.status !== 'archived')
    if (clash !== undefined) {
      throw new Error(
        `ai-buddy task: conversation "${conversationId}" is already bound to task `
          + `"${clash.id}" (${clash.title}); archive it before binding a new task`,
      )
    }
  }

  const at = nowIso()
  const expires = new Date(Date.now() + lockTimeoutMs(store, config)).toISOString()
  const task = normalizeTask({
    id: newId('t'),
    projectId,
    title,
    description: typeof opts.description === 'string' ? opts.description : '',
    conversationId,
    workspace: isNonEmptyString(opts.workspace) ? opts.workspace : null,
    planItemId,
    ownerAgent,
    status: 'active',
    // Creating a task for an owner hands that owner the execution right: the
    // agent that just opened the conversation is the one who will act in it, and
    // making it win a queue against itself would be a pointless round trip.
    executionLock: ownerAgent === null
      ? emptyExecutionLock()
      : { holder: ownerAgent, acquiredAt: at, expiresAt: expires, queue: [] },
    resumeLock: emptyResumeLock(),
    interruptLock: emptyInterruptLock(),
    createdAt: at,
    updatedAt: at,
    lastCheckpointAt: null,
    resumeHistory: [],
    createdBy: actor,
  })

  const saved = saveTask(store, projectId, { ...task, createdBy: actor })

  // Registering the owner as a project member is what makes it addressable by
  // the other modules (assignee matching, asset visibility, directed events).
  if (ownerAgent !== null) {
    try {
      store.addMember(projectId, { id: ownerAgent, name: ownerAgent, kind: 'agent' })
    } catch {
      /* membership is a convenience, never a precondition for a task */
    }
  }
  return saved
}

/**
 * Transfer the execution right of a task to another agent.
 *
 * Returns the facts the caller turns into audit records:
 *
 * ```js
 * {
 *   task, handoffId, from, to, at,
 *   previousHolder, executionLock,
 *   feed:   { category: 'execution.handoff', source: 'auto', content, taskId, targetRefs },
 *   checkpoint: { eventType: 'handoff', triggerAgent, lastOperation, contextSummary,
 *                 nextExpectedActor, taskId, conversationId },
 *   needCheckpoint: true
 * }
 * ```
 *
 * `checkpoint.lastOperation.result_status` is `'unconfirmed'` on purpose: the
 * receiving agent has not answered yet, and marking it `confirmed` would let a
 * resumed conversation skip work the target never did (§7.3).
 */
export function handoff(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)
  const actor = requireActor(opts.actor)

  const taskId = isNonEmptyString(opts.taskId) ? opts.taskId : ''
  if (taskId === '') throw new Error('ai-buddy task: handoff needs a taskId')
  const targetAgent = isNonEmptyString(opts.targetAgent) ? opts.targetAgent.trim() : ''
  if (targetAgent === '') {
    throw new Error('ai-buddy task: handoff needs a non-empty targetAgent')
  }

  const task = readTask(store, projectId, taskId)
  if (task.status === 'archived') {
    throw new Error(`ai-buddy task: cannot hand off archived task "${taskId}"`)
  }
  if (task.status === 'locked_by_interrupt') {
    throw new Error(
      `ai-buddy task: task "${taskId}" is frozen by the interruption lock; `
        + 'a human must unlock the conversation before it can be handed off',
    )
  }
  if (!holdsExecutionRight(task, actor.id, isHuman(actor))) {
    throw new Error(
      `ai-buddy task: "${actor.id}" does not hold the execution right of task "${task.title}" `
        + `(current holder: ${task.executionLock.holder ?? 'none'}); take the lock or ask the `
        + 'holder to hand off',
    )
  }
  if (task.executionLock.holder !== null && targetAgent === task.executionLock.holder) {
    // Handing to the current holder is a no-op that would still write a
    // checkpoint and confuse the next resume into thinking work moved.
    throw new Error(
      `ai-buddy task: "${targetAgent}" already holds the execution right of task "${taskId}"`,
    )
  }

  const at = nowIso()
  const previousHolder = task.executionLock.holder
  const handoffId = newId('f')
  const summary = typeof opts.summary === 'string' ? opts.summary.trim() : ''
  const artifacts = asStringArray(opts.artifacts)
  const unfinished = asStringArray(opts.unfinished)

  const expires = new Date(Date.now() + lockTimeoutMs(store, config)).toISOString()
  const next = {
    ...task,
    // Ownership follows the handoff: `ownerAgent` is who is answerable for the
    // task now, and leaving the old owner in place would make every "my tasks"
    // read lie after the first handoff.
    ownerAgent: targetAgent,
    status: task.status === 'paused' ? 'active' : task.status,
    executionLock: {
      holder: targetAgent,
      acquiredAt: at,
      expiresAt: expires,
      // Drop the receiver's own pending request: it just got what it queued for.
      queue: task.executionLock.queue.filter((entry) => entry.agent !== targetAgent),
    },
    handoffs: [
      ...task.handoffs,
      {
        id: handoffId,
        at,
        from: previousHolder ?? actor.id,
        to: targetAgent,
        by: actor,
        summary,
        artifacts,
        unfinished,
      },
    ],
    updatedAt: at,
  }
  const saved = saveTask(store, projectId, next)

  try {
    store.addMember(projectId, { id: targetAgent, name: targetAgent, kind: 'agent' })
  } catch {
    /* see create() */
  }

  const contextSummary = clip(
    summary !== '' ? summary : `执行权由 ${previousHolder ?? actor.id} 移交给 ${targetAgent}`,
    1200,
  )

  return {
    task: saved,
    handoffId,
    from: previousHolder ?? actor.id,
    to: targetAgent,
    at,
    previousHolder,
    executionLock: saved.executionLock,
    feed: {
      category: 'execution.handoff',
      source: 'auto',
      actor,
      content: `执行权移交给 ${targetAgent}：${contextSummary}`,
      taskId: saved.id,
      planItemId: saved.planItemId,
      targetRefs: [targetAgent, ...artifacts],
      highRisk: false,
    },
    checkpoint: {
      taskId: saved.id,
      conversationId: saved.conversationId,
      triggerAgent: actor.id,
      eventType: 'handoff',
      contextSummary,
      nextExpectedActor: targetAgent,
      lastOperation: {
        type: 'handoff',
        target_ref: targetAgent,
        result_status: 'unconfirmed',
        verified_at: at,
      },
    },
    needCheckpoint: true,
  }
}

/**
 * Archive a task: it stops being resumable and stops holding an execution right,
 * but its checkpoints and history stay readable for the audit trail.
 */
export function archive(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)
  const actor = requireActor(opts.actor)

  const taskId = isNonEmptyString(opts.taskId) ? opts.taskId : ''
  if (taskId === '') throw new Error('ai-buddy task: archive needs a taskId')
  const task = readTask(store, projectId, taskId)
  if (task.status === 'archived') return task

  // Archiving a live conversation is a structural act: it decides that nobody
  // may resume that session any more. Only the current holder or a human can
  // make that call, same rule as the plan board. An unheld task is fair game —
  // it is already nobody's work in progress.
  const holderId = task.executionLock.holder
  if (!isHuman(actor) && holderId !== null && actor.id !== holderId) {
    throw new Error(
      `ai-buddy task: only the execution holder (${holderId}) or a human `
        + `may archive "${task.title}"`,
    )
  }

  const at = nowIso()
  const saved = saveTask(store, projectId, {
    ...task,
    status: 'archived',
    archivedAt: at,
    executionLock: emptyExecutionLock(),
    updatedAt: at,
  })

  return saved
}

/**
 * Grant read/cite access to an agent without giving it the execution right.
 *
 * This is the lightweight collaboration path: an agent that needs to *know* what
 * another conversation produced can be given the task and its artifacts, and
 * still cannot write. The execution right is untouched by design.
 */
export function shareReadonly(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)
  const actor = requireActor(opts.actor)

  const taskId = isNonEmptyString(opts.taskId) ? opts.taskId : ''
  if (taskId === '') throw new Error('ai-buddy task: shareReadonly needs a taskId')
  const targetAgent = isNonEmptyString(opts.targetAgent) ? opts.targetAgent.trim() : ''
  if (targetAgent === '') {
    throw new Error('ai-buddy task: shareReadonly needs a non-empty targetAgent')
  }

  const task = readTask(store, projectId, taskId)
  if (!holdsExecutionRight(task, actor.id, isHuman(actor)) && !isHuman(actor)) {
    throw new Error(
      `ai-buddy task: only the execution holder (${task.executionLock.holder ?? 'none'}) `
        + `or a human may share "${task.title}"`,
    )
  }

  const at = nowIso()
  const already = task.sharedWith.includes(targetAgent)
  const saved = saveTask(store, projectId, {
    ...task,
    sharedWith: already ? task.sharedWith : [...task.sharedWith, targetAgent],
    updatedAt: at,
  })

  return {
    task: saved,
    targetAgent,
    alreadyShared: already,
    feed: {
      category: 'task.share',
      source: 'auto',
      actor,
      content: `任务「${saved.title}」以只读方式共享给 ${targetAgent}`,
      taskId: saved.id,
      planItemId: saved.planItemId,
      targetRefs: [targetAgent],
      highRisk: false,
    },
  }
}

/**
 * Record that one task's work builds on another's.
 *
 * Written on both sides: the source gets `references`, the target gets
 * `referencedBy`, so either direction is one read away. The reference is what
 * lets a checkpoint (and a resuming agent) know which other conversation's
 * output is safe to trust.
 */
export function reference(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)
  const actor = requireActor(opts.actor)

  const sourceTaskId = isNonEmptyString(opts.sourceTaskId) ? opts.sourceTaskId : ''
  const targetTaskId = isNonEmptyString(opts.targetTaskId) ? opts.targetTaskId : ''
  if (sourceTaskId === '' || targetTaskId === '') {
    throw new Error('ai-buddy task: reference needs both sourceTaskId and targetTaskId')
  }
  if (sourceTaskId === targetTaskId) {
    throw new Error('ai-buddy task: a task cannot reference itself')
  }

  const source = readTask(store, projectId, sourceTaskId)
  const target = readTask(store, projectId, targetTaskId)
  const at = nowIso()
  const entry = { taskId: '', at, by: actor, note: typeof opts.note === 'string' ? opts.note : '' }

  const savedSource = saveTask(store, projectId, {
    ...source,
    references: source.references.some((r) => asRecord(r).taskId === targetTaskId)
      ? source.references
      : [...source.references, { ...entry, taskId: targetTaskId }],
    updatedAt: at,
  })
  const savedTarget = saveTask(store, projectId, {
    ...target,
    referencedBy: target.referencedBy.some((r) => asRecord(r).taskId === sourceTaskId)
      ? target.referencedBy
      : [...target.referencedBy, { ...entry, taskId: sourceTaskId }],
    updatedAt: at,
  })

  return {
    sourceTask: savedSource,
    targetTask: savedTarget,
    // directed: this is a statement aimed at the other conversation, not a
    // general member event.
    feed: {
      category: 'task.transfer',
      source: 'auto',
      actor,
      content: `任务「${savedSource.title}」引用了「${savedTarget.title}」的产出`,
      taskId: savedSource.id,
      planItemId: savedSource.planItemId,
      targetRefs: [savedTarget.id],
      highRisk: false,
    },
  }
}

// -------------------------------------------------------------------- reads

/**
 * Read tasks, filtered. Archived tasks are excluded unless asked for, because
 * every "what is happening" surface should see the live set by default.
 */
export function read(store, config, projectId, filter = {}) {
  const opts = asRecord(filter)
  requireProject(store, projectId)

  let tasks = store.readTasks(projectId).map(normalizeTask)
  if (opts.includeArchived !== true) tasks = tasks.filter((task) => task.status !== 'archived')

  if (isNonEmptyString(opts.id)) tasks = tasks.filter((task) => task.id === opts.id)
  if (isNonEmptyString(opts.status)) tasks = tasks.filter((task) => task.status === opts.status)
  if (isNonEmptyString(opts.ownerAgent)) {
    tasks = tasks.filter((task) => task.ownerAgent === opts.ownerAgent)
  }
  if (isNonEmptyString(opts.planItemId)) {
    tasks = tasks.filter((task) => task.planItemId === opts.planItemId)
  }
  if (isNonEmptyString(opts.conversationId)) {
    tasks = tasks.filter((task) => task.conversationId === opts.conversationId)
  }
  if (isNonEmptyString(opts.id) && tasks.length === 0) {
    throw new Error(`ai-buddy task: unknown task "${opts.id}" in project "${projectId}"`)
  }

  const limit = Number(opts.limit)
  if (Number.isFinite(limit) && limit > 0) tasks = tasks.slice(0, Math.floor(limit))
  return tasks
}
