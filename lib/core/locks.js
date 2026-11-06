/**
 * Execution rights (§3): the mutex that makes "only one conversation may write
 * to this task at a time" true.
 *
 * Three properties are deliberate and must survive refactors:
 *
 * 1. **FIFO, not priority.** The queue is what keeps a starved conversation from
 *    waiting forever behind a chatty one: every waiter's position is published
 *    (`position`) and only ever improves. A priority queue would let a busy
 *    agent indefinitely postpone a resumed conversation, which is exactly the
 *    failure §7 is trying to remove.
 *
 * 2. **Expiry is swept lazily, from every entry point.** There is no long-lived
 *    timer in this module: a conversation can die without calling anything, so a
 *    timer would be the only thing noticing — and it would not survive a Host
 *    restart either. Instead every read and write path first reconciles the
 *    *one* task it is about to touch. `sweep()` is the project-wide version for
 *    the timer `index.js` runs. The cost is a `Date.parse` per call; the benefit
 *    is that a stale holder is impossible to observe, even after a crash.
 *
 * 3. **The lock lives on the task document.** `Task.executionLock` is the truth
 *    (§5.4). Keeping a second copy in memory would drift the moment the workbench
 *    edits a task, and the plan module reads the holder through the task too.
 *
 * A release always hands the right to `queue[0]` synchronously. Waiting rather
 * than polling keeps the tool call bounded: the caller learns either "you have
 * it" or "you are number N", and retries on its own schedule.
 */

import { asRecord, isNonEmptyString, nowIso } from '../util.js'

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_QUEUE_MAX_WAIT_MS = 10 * 60 * 1000
const DEFAULT_QUEUE_DEPTH = 16

// --------------------------------------------------------------- internals

function requireProject(store, projectId) {
  if (!isNonEmptyString(projectId)) {
    throw new Error('ai-buddy locks: a non-empty projectId is required')
  }
  const project = store.getProject(projectId)
  if (project === undefined) {
    throw new Error(`ai-buddy locks: unknown project "${projectId}"`)
  }
  return project
}

function agentIdOf(actor) {
  if (typeof actor === 'string') return actor
  const rec = asRecord(actor)
  if (isNonEmptyString(rec.id)) return rec.id
  return isNonEmptyString(rec.name) ? rec.name : ''
}

function isHuman(actor) {
  if (typeof actor === 'string') return actor === 'human'
  const rec = asRecord(actor)
  return rec.type === 'human' || rec.id === 'human'
}

function resolveConfig(store, config) {
  return config ?? store?.config ?? {}
}

function timeoutMsOf(store, config) {
  const value = Number(resolveConfig(store, config)?.executionLock?.timeoutMs)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS
}

function queueMaxWaitMsOf(store, config) {
  const value = Number(resolveConfig(store, config)?.executionLock?.queueMaxWaitMs)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_QUEUE_MAX_WAIT_MS
}

function maxQueueDepthOf(store, config) {
  const value = Number(resolveConfig(store, config)?.executionLock?.maxQueueDepth)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_QUEUE_DEPTH
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
            agent: isNonEmptyString(e.agent) ? e.agent : '',
            requestedAt: typeof e.requestedAt === 'string' ? e.requestedAt : nowIso(),
            timeoutAt: typeof e.timeoutAt === 'string' ? e.timeoutAt : null,
          }
        })
        .filter((entry) => entry.agent !== '')
      : [],
  }
}

function normalizeTask(raw) {
  const t = asRecord(raw)
  return {
    ...t,
    id: String(t.id ?? ''),
    status: typeof t.status === 'string' ? t.status : 'active',
    executionLock: normalizeLock(t.executionLock),
  }
}

function msOf(iso) {
  const ms = Date.parse(String(iso ?? ''))
  return Number.isFinite(ms) ? ms : 0
}

function isExpired(lock, nowMs) {
  if (lock.holder === null) return false
  if (lock.expiresAt === null) return false // an open-ended lock (human set) does not expire
  return msOf(lock.expiresAt) <= nowMs
}

function entryExpired(entry, nowMs) {
  return entry.timeoutAt !== null && msOf(entry.timeoutAt) <= nowMs
}

function findTask(store, projectId, taskId) {
  const stored = store.readTasks(projectId).find((task) => task.id === taskId)
  if (stored === undefined) {
    throw new Error(`ai-buddy locks: unknown task "${taskId}" in project "${projectId}"`)
  }
  return normalizeTask(stored)
}

function saveTask(store, projectId, task) {
  return normalizeTask(store.putTask(projectId, task) ?? task)
}

/**
 * Reconcile one task's lock with the clock.
 *
 * Returns the (possibly rewritten) task plus what happened, so the project-wide
 * `sweep` and the per-task callers share one code path and one write.
 */
function reconcile(store, projectId, task, { config, promote = true } = {}) {
  const nowMs = Date.now()
  const events = []
  let lock = { ...task.executionLock, queue: [...task.executionLock.queue] }
  let changed = false

  if (isExpired(lock, nowMs)) {
    events.push({ type: 'holder_expired', agent: lock.holder, taskId: task.id })
    lock = { ...lock, holder: null, acquiredAt: null, expiresAt: null }
    changed = true
  }

  // Timed-out waiters are dropped even while the lock is held: their tool call
  // has already returned "queued", and a queue that only grows is a leak.
  const survivors = lock.queue.filter((entry) => !entryExpired(entry, nowMs))
  if (survivors.length !== lock.queue.length) {
    for (const entry of lock.queue) {
      if (entryExpired(entry, nowMs)) events.push({ type: 'queue_timeout', agent: entry.agent, taskId: task.id })
    }
    lock = { ...lock, queue: survivors }
    changed = true
  }

  if (promote && lock.holder === null && lock.queue.length > 0) {
    const next = lock.queue[0]
    const acquiredAt = nowIso()
    const expiresAt = new Date(Date.now() + timeoutMsOf(store, config)).toISOString()
    events.push({ type: 'handed_to', agent: next.agent, taskId: task.id })
    lock = {
      holder: next.agent,
      acquiredAt,
      expiresAt,
      queue: lock.queue.slice(1),
    }
    changed = true
  }

  const nextTask = changed ? { ...task, executionLock: lock, updatedAt: nowIso() } : task
  if (changed) saveTask(store, projectId, nextTask)
  return { task: nextTask, events, changed }
}

/** Shape returned to callers: never the whole task, only what a tool needs. */
function lockView(task, extra = {}) {
  const lock = task.executionLock
  return {
    taskId: task.id,
    holder: lock.holder,
    acquiredAt: lock.acquiredAt,
    expiresAt: lock.expiresAt,
    queueLength: lock.queue.length,
    queue: lock.queue.map((entry, index) => ({
      agent: entry.agent,
      position: index + 1,
      requestedAt: entry.requestedAt,
      timeoutAt: entry.timeoutAt,
    })),
    ...extra,
  }
}

// ------------------------------------------------------------------- writes

/**
 * Ask for the execution right of a task.
 *
 * @returns `{ acquired, alreadyHeld?, queued?, position?, queueFull?,
 *             rejected?, holder, expiresAt, queueLength }`
 *
 * Idempotent per agent: asking twice returns "queued, position N" instead of
 * taking two queue slots, which is what keeps a retrying conversation from
 * filling the queue with itself.
 */
export function request(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)

  const taskId = isNonEmptyString(opts.taskId) ? opts.taskId : ''
  if (taskId === '') throw new Error('ai-buddy locks: request needs a taskId')
  const agent = agentIdOf(opts.agent)
  if (agent === '') throw new Error('ai-buddy locks: request needs a non-empty agent')

  let task = findTask(store, projectId, taskId)
  if (task.status === 'archived') {
    throw new Error(
      `ai-buddy locks: task "${taskId}" is archived; its execution right cannot be requested`,
    )
  }
  if (task.status === 'locked_by_interrupt' && !isHuman(opts.agent)) {
    return lockView(task, {
      acquired: false,
      rejected: true,
      reason: 'the conversation is frozen by the interruption lock; a human must unlock it '
        + '(§7.5) before execution rights can be requested',
    })
  }

  // Expiry first: taking over an abandoned lock must not require waiting for it.
  task = reconcile(store, projectId, task, { config }).task

  if (task.executionLock.holder === agent) {
    // Re-requesting while holding is a renewal, not a second acquisition.
    const refreshed = reconcile(store, projectId, {
      ...task,
      executionLock: {
        ...task.executionLock,
        expiresAt: new Date(Date.now() + timeoutMsOf(store, config)).toISOString(),
      },
    }, { config, promote: false }).task
    return lockView(refreshed, { acquired: true, alreadyHeld: true })
  }

  if (task.executionLock.holder === null) {
    const at = nowIso()
    const next = {
      ...task,
      executionLock: {
        ...task.executionLock,
        holder: agent,
        acquiredAt: at,
        expiresAt: new Date(Date.now() + timeoutMsOf(store, config)).toISOString(),
        queue: task.executionLock.queue.filter((entry) => entry.agent !== agent),
      },
      updatedAt: at,
    }
    return lockView(saveTask(store, projectId, next), { acquired: true })
  }

  const existingIndex = task.executionLock.queue.findIndex((entry) => entry.agent === agent)
  if (existingIndex >= 0) {
    return lockView(task, {
      acquired: false,
      queued: true,
      alreadyQueued: true,
      position: existingIndex + 1,
    })
  }

  const depth = maxQueueDepthOf(store, config)
  if (task.executionLock.queue.length >= depth) {
    return lockView(task, {
      acquired: false,
      queued: false,
      queueFull: true,
      reason: `the execution queue of "${task.title}" is full (${depth}); wait for a release `
        + 'instead of queueing',
    })
  }

  const at = nowIso()
  const next = {
    ...task,
    executionLock: {
      ...task.executionLock,
      queue: [
        ...task.executionLock.queue,
        {
          agent,
          requestedAt: at,
          timeoutAt: new Date(Date.now() + queueMaxWaitMsOf(store, config)).toISOString(),
        },
      ],
    },
    updatedAt: at,
  }
  const saved = saveTask(store, projectId, next)
  return lockView(saved, {
    acquired: false,
    queued: true,
    position: saved.executionLock.queue.length,
  })
}

/**
 * Give up the right (or leave the queue).
 *
 * `force` exists for a human acting on a stuck conversation, and for the resume
 * path when the holder's turn is known to be gone. An agent can never force
 * another agent's release.
 *
 * @returns `{ released, leftQueue?, handedTo, taskId, holder, queueLength }`
 */
export function release(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)

  const taskId = isNonEmptyString(opts.taskId) ? opts.taskId : ''
  if (taskId === '') throw new Error('ai-buddy locks: release needs a taskId')
  const agent = agentIdOf(opts.agent)
  if (agent === '') throw new Error('ai-buddy locks: release needs a non-empty agent')
  const force = opts.force === true || isHuman(opts.agent)

  let task = findTask(store, projectId, taskId)
  task = reconcile(store, projectId, task, { config, promote: false }).task

  const queuedIndex = task.executionLock.queue.findIndex((entry) => entry.agent === agent)
  if (task.executionLock.holder !== agent) {
    if (queuedIndex >= 0) {
      const queue = task.executionLock.queue.filter((entry) => entry.agent !== agent)
      const saved = saveTask(store, projectId, {
        ...task,
        executionLock: { ...task.executionLock, queue },
        updatedAt: nowIso(),
      })
      return lockView(saved, { released: false, leftQueue: true, handedTo: null })
    }
    if (!force) {
      throw new Error(
        `ai-buddy locks: "${agent}" does not hold the execution right of task "${taskId}" `
          + `(holder: ${task.executionLock.holder ?? 'none'}); only the holder or a human `
          + '(force) may release it',
      )
    }
    // Forced release of a lock somebody else holds: sweep expired waiters, then
    // hand the right on.
    //
    // The write must happen HERE, not in `reconcile`. `reconcile` only saves
    // when *it* changed something, and it sees no change here: the holder was
    // already cleared by the caller, and an empty queue means there is nobody
    // to promote. So the release would be computed and then silently dropped —
    // the task would still name its old holder on disk.
    //
    // That is exactly what a released member must not do: keep the execution
    // right for the rest of its lease (30 minutes) while every other member
    // of the task waits behind a member that no longer exists.
    const releasedLock = { ...task.executionLock, holder: null, acquiredAt: null, expiresAt: null }
    const swept = reconcile(store, projectId, {
      ...task,
      executionLock: releasedLock,
    }, { config, promote: true })
    // `reconcile` may have promoted the head of the queue; take its lock.
    const saved = swept.changed
      ? swept.task
      : saveTask(store, projectId, {
        ...task,
        executionLock: releasedLock,
        updatedAt: nowIso(),
      })
    return lockView(saved, {
      released: true,
      forced: true,
      handedTo: saved.executionLock.holder,
    })
  }

  const handedTo = task.executionLock.queue.length > 0 ? task.executionLock.queue[0].agent : null
  const releasedLock = { ...task.executionLock, holder: null, acquiredAt: null, expiresAt: null }
  const next = {
    ...task,
    executionLock: releasedLock,
    updatedAt: nowIso(),
  }
  // `promote: true` is what makes FIFO real: the head of the queue takes the
  // right inside the same write, so there is no window with a free lock.
  //
  // The write must happen HERE, not in `reconcile`. `reconcile` only saves when
  // *it* changed something, and it sees no change when the queue is empty:
  // the holder was already cleared by the caller and there is nobody to
  // promote. So the release would be computed and then silently dropped — the
  // task would still name its old holder on disk, and the released member
  // would keep the right for the rest of its lease.
  const reconciled = reconcile(store, projectId, next, { config, promote: true })
  const saved = reconciled.changed
    ? reconciled.task
    : saveTask(store, projectId, next)
  return lockView(saved, {
    released: true,
    handedTo: saved.executionLock.holder ?? handedTo,
  })
}

/** Extend a held lock's expiry. The holder's "still working" heartbeat. */
export function refresh(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)

  const taskId = isNonEmptyString(opts.taskId) ? opts.taskId : ''
  if (taskId === '') throw new Error('ai-buddy locks: refresh needs a taskId')
  const agent = agentIdOf(opts.agent)
  if (agent === '') throw new Error('ai-buddy locks: refresh needs a non-empty agent')

  let task = findTask(store, projectId, taskId)
  task = reconcile(store, projectId, task, { config, promote: false }).task

  if (task.executionLock.holder !== agent) {
    return lockView(task, {
      refreshed: false,
      reason: `"${agent}" no longer holds the execution right of task "${taskId}" `
        + `(holder: ${task.executionLock.holder ?? 'none'})`,
    })
  }

  const saved = saveTask(store, projectId, {
    ...task,
    executionLock: {
      ...task.executionLock,
      expiresAt: new Date(Date.now() + timeoutMsOf(store, config)).toISOString(),
    },
    updatedAt: nowIso(),
  })
  return lockView(saved, { refreshed: true })
}

// -------------------------------------------------------------------- reads

/**
 * The current holder, or `null`.
 *
 * Expired holders are swept here because this is the function every other module
 * calls to answer "who may act now" — returning a dead agent would send work to
 * a conversation that no longer exists.
 */
export function holder(store, projectId, taskId) {
  requireProject(store, projectId)
  const id = isNonEmptyString(taskId) ? taskId : ''
  if (id === '') throw new Error('ai-buddy locks: holder needs a taskId')
  const task = findTask(store, projectId, id)
  const { task: reconciled } = reconcile(store, projectId, task, { config: store?.config })
  return reconciled.executionLock.holder
}

/**
 * The single predicate the other modules use (§6.5).
 *
 * Humans always may. An agent may when it holds the lock *and* the task is not
 * frozen: an archived task is history, and an interrupted one waits for a human
 * by definition (§7.5) — letting the lock alone authorize writes there would
 * quietly defeat the lock.
 */
export function canWrite(store, projectId, taskId, actor) {
  requireProject(store, projectId)
  const id = isNonEmptyString(taskId) ? taskId : ''
  if (id === '') throw new Error('ai-buddy locks: canWrite needs a taskId')
  const agent = agentIdOf(actor)
  if (agent === '') return false

  const task = findTask(store, projectId, id)
  if (isHuman(actor)) return true

  const { task: reconciled } = reconcile(store, projectId, task, { config: store?.config })
  if (reconciled.status === 'archived') return false
  if (reconciled.status === 'locked_by_interrupt') return false
  return reconciled.executionLock.holder === agent
}

/**
 * Project-wide reconciliation for the timer in `index.js` (§6.5).
 *
 * @returns `string[]` — the ids of tasks whose lock changed: a holder expired,
 *   a waiter timed out, or the queue head was promoted. A promotion counts
 *   because it is exactly the event a resumed conversation is waiting on, and
 *   the caller uses this list to write the corresponding feed/checkpoint events.
 */
export function sweep(store, config, projectId) {
  requireProject(store, projectId)
  const affected = new Set()
  for (const stored of store.readTasks(projectId)) {
    const task = normalizeTask(stored)
    const { changed } = reconcile(store, projectId, task, { config })
    if (changed) affected.add(task.id)
  }
  return [...affected]
}
