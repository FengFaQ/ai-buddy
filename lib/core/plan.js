/**
 * The plan board (§2.2): the project's declared work items, who owns them, and
 * what is blocked on what.
 *
 * Three design decisions in this file are load-bearing:
 *
 * 1. **`blockedBy` is derived, never authored.** It is recomputed from
 *    `dependsOn` + the current statuses after every mutation. If it were stored
 *    independently the two could disagree after a crash or an out-of-band edit,
 *    and an AI reading a stale `blockedBy` would either start work it must not
 *    start or refuse work that is unblocked. Deriving it costs one pass over a
 *    list that is small by construction.
 *
 * 2. **The write right is per-item, checked against the bound task's execution
 *    holder (§3).** A plan item is not free-floating: it is either bound to a
 *    conversation task or not. If it is bound, only the conversation that holds
 *    the execution lock of that task (or a human) may move it. This is the same
 *    lock the conversation tools use, so there is exactly one notion of "who may
 *    act now".
 *
 * 3. **Structural changes are refused, not performed.** Deleting an item or
 *    moving it to a different agent changes the meaning of the project for
 *    everybody, and an AI cannot see the consequences for conversations it is
 *    not part of. Those operations therefore return
 *    `{ needHumanConfirmation: true, reason }` and apply only when a human (or
 *    an already-confirmed human call) does them.
 *
 * Plan items are soft-deleted (`deletedAt`), because `Store` exposes
 * `putPlanItem` but no remove: the manifest keeps the tombstone so dependents
 * can still render the id they refer to, and every read path filters it out.
 */

import {
  newId, nowIso, asRecord, asStringArray, isNonEmptyString, parseTimeOrNull,
} from '../util.js'

export const PLAN_STATUSES = Object.freeze([
  'pending', 'in_progress', 'paused', 'done', 'locked_by_interrupt',
])

export const PLAN_MODES = Object.freeze(['pre', 'live'])

/** `locked_by_interrupt` is owned by the interruption lock (§7.5), not by callers. */
const INTERRUPT_STATUS = 'locked_by_interrupt'

// --------------------------------------------------------------- internals

function requireProject(store, projectId) {
  if (!isNonEmptyString(projectId)) {
    throw new Error('ai-buddy plan: a non-empty projectId is required')
  }
  const project = store.getProject(projectId)
  if (project === undefined) {
    throw new Error(`ai-buddy plan: unknown project "${projectId}"`)
  }
  return project
}

function requireActor(actor) {
  // A bare agent name is accepted as well as the full Actor record — see the
  // same note in task.js.
  if (typeof actor === 'string' && actor.trim() !== '') {
    return { type: actor === 'human' ? 'human' : 'agent', id: actor.trim(), name: actor.trim() }
  }
  const rec = asRecord(actor)
  const id = isNonEmptyString(rec.id) ? rec.id : (isNonEmptyString(rec.name) ? rec.name : '')
  if (id === '') {
    throw new Error('ai-buddy plan: an actor with a non-empty id or name is required')
  }
  const type = rec.type === 'human' ? 'human' : 'agent'
  return { type, id, name: isNonEmptyString(rec.name) ? rec.name : id }
}

function isHuman(actor) {
  return actor?.type === 'human'
}

function clampPriority(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.min(3, Math.max(0, Math.floor(n)))
}

function normalizeItem(item) {
  return {
    id: String(item.id),
    projectId: String(item.projectId),
    title: String(item.title ?? ''),
    description: String(item.description ?? ''),
    assignee: isNonEmptyString(item.assignee) ? item.assignee : null,
    status: PLAN_STATUSES.includes(item.status) ? item.status : 'pending',
    priority: clampPriority(item.priority),
    dependsOn: asStringArray(item.dependsOn),
    dueAt: parseTimeOrNull(item.dueAt) === null ? null : String(item.dueAt),
    taskId: isNonEmptyString(item.taskId) ? item.taskId : null,
    mode: item.mode === 'live' ? 'live' : 'pre',
    blockedBy: asStringArray(item.blockedBy),
    createdBy: asRecord(item.createdBy),
    createdAt: typeof item.createdAt === 'string' ? item.createdAt : nowIso(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
    lastNote: typeof item.lastNote === 'string' ? item.lastNote : '',
    // Tombstone for a human-confirmed delete; see the header note.
    deletedAt: typeof item.deletedAt === 'string' ? item.deletedAt : null,
    // Where the item was before the interruption lock froze it, so unlocking can
    // put it back instead of guessing. Only ever written by
    // `setLockedByInterrupt`.
    interruptLock: isNonEmptyString(asRecord(item.interruptLock).lockedAt)
      ? asRecord(item.interruptLock)
      : null,
    // Lineage, NOT dependency. `dependsOn` is a DAG of "cannot start until";
    // `parentId` is the tree of "was spawned by". The task graph (§ new task
    // graph tab) draws the second one, because a mind map answers "how did this
    // work break down", not "what must finish first". Mixing the two would make
    // a shared prerequisite look like a duplicated child.
    parentId: isNonEmptyString(item.parentId) ? item.parentId : null,
  }
}

/** Live (non-tombstoned) items only. */
function liveItems(store, projectId) {
  return store.readPlan(projectId).map(normalizeItem).filter((item) => item.deletedAt === null)
}

/**
 * Ids that participate in a `dependsOn` cycle.
 *
 * A cycle is not merely a cosmetic problem: it makes "all dependencies done"
 * unsatisfiable, so every item in it would be blocked forever and the board
 * would silently freeze. Creating one is refused; detecting it here keeps the
 * check in a single place.
 */
export function detectCycles(items) {
  const byId = new Map(items.map((item) => [item.id, item]))
  const state = new Map() // id -> 1 visiting, 2 done
  const cyclic = new Set()

  const visit = (id, path) => {
    const status = state.get(id)
    if (status === 2) return
    if (status === 1) {
      // Everything from the first occurrence of `id` on the current path closes
      // the loop; those are the items that can never become unblocked.
      const at = path.indexOf(id)
      for (const member of at >= 0 ? path.slice(at) : [id]) cyclic.add(member)
      return
    }
    const item = byId.get(id)
    if (item === undefined) return
    state.set(id, 1)
    path.push(id)
    for (const dep of item.dependsOn) visit(dep, path)
    path.pop()
    state.set(id, 2)
  }

  for (const item of items) visit(item.id, [])
  return [...cyclic]
}

function blockedIdsOf(item, byId) {
  const out = []
  for (const depId of item.dependsOn) {
    const dep = byId.get(depId)
    // A dependency that no longer exists (or was deleted) cannot block: holding
    // an item hostage to a tombstone would freeze the board permanently.
    if (dep === undefined || dep.deletedAt !== null) continue
    if (dep.status !== 'done') out.push(depId)
  }
  return out
}

/** Persist `blockedBy` for every item, writing only the ones that changed. */
function applyBlocking(store, projectId, items) {
  const byId = new Map(items.map((item) => [item.id, item]))
  let changed = 0
  const out = []
  for (const item of items) {
    const blockedBy = blockedIdsOf(item, byId)
    const same = blockedBy.length === item.blockedBy.length
      && blockedBy.every((id, i) => item.blockedBy[i] === id)
    const next = same ? item : { ...item, blockedBy, updatedAt: nowIso() }
    if (!same) {
      changed++
      store.putPlanItem(projectId, next)
    }
    out.push(next)
  }
  return { items: out, changed }
}

/** The bound task: explicit `taskId` on the item, else the task naming the item. */
function boundTask(store, projectId, item) {
  const tasks = store.readTasks(projectId)
  if (isNonEmptyString(item.taskId)) {
    const direct = tasks.find((task) => task.id === item.taskId)
    if (direct !== undefined) return direct
  }
  return tasks.find((task) => task.planItemId === item.id)
}

/** The agent currently allowed to act on a task, per its execution lock. */
function executionHolderOf(task, explicitHolder) {
  if (isNonEmptyString(explicitHolder)) return explicitHolder
  const lock = asRecord(task?.executionLock)
  return isNonEmptyString(lock.holder) ? lock.holder : null
}

// ------------------------------------------------------------------- writes

export function create(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)
  const actor = requireActor(opts.actor)

  const title = isNonEmptyString(opts.title) ? opts.title.trim() : ''
  if (title === '') {
    throw new Error('ai-buddy plan: a plan item needs a non-empty title')
  }

  const mode = opts.mode === 'live' ? 'live' : 'pre'
  if (opts.mode !== undefined && !PLAN_MODES.includes(opts.mode)) {
    throw new Error(
      `ai-buddy plan: unknown mode "${String(opts.mode)}". Valid modes: ${PLAN_MODES.join(', ')}`,
    )
  }

  const existing = liveItems(store, projectId)
  const known = new Set(existing.map((item) => item.id))
  const dependsOn = asStringArray(opts.dependsOn)
  for (const depId of dependsOn) {
    if (!known.has(depId)) {
      throw new Error(
        `ai-buddy plan: dependsOn references unknown plan item "${depId}" in project "${projectId}"`,
      )
    }
  }

  const taskId = isNonEmptyString(opts.taskId) ? opts.taskId : null
  if (taskId !== null && !store.readTasks(projectId).some((task) => task.id === taskId)) {
    throw new Error(`ai-buddy plan: unknown task "${taskId}" in project "${projectId}"`)
  }

  // Lineage: the item this one was decomposed from. Validated against live
  // items so a graph read never has to defend against a dangling parent — a
  // missing node would silently re-root the branch and make the map lie about
  // where the work came from.
  const parentId = isNonEmptyString(opts.parentId) ? opts.parentId : null
  if (parentId !== null && !known.has(parentId)) {
    throw new Error(
      `ai-buddy plan: parentId references unknown plan item "${parentId}" in project "${projectId}"`,
    )
  }

  const at = nowIso()
  const item = normalizeItem({
    id: newId('pl'),
    projectId,
    title,
    description: typeof opts.description === 'string' ? opts.description : '',
    assignee: isNonEmptyString(opts.assignee) ? opts.assignee : null,
    status: 'pending',
    priority: opts.priority,
    dependsOn,
    dueAt: opts.dueAt ?? null,
    taskId,
    mode,
    parentId,
    blockedBy: [],
    createdBy: actor,
    createdAt: at,
    updatedAt: at,
    lastNote: '',
  })

  // Adding a node whose edges all point outward cannot itself close a loop, but
  // a caller may pre-populate `dependsOn` (import, retry) with something that
  // does — and silently freezing the board is worse than refusing the create.
  const cycle = detectCycles([...existing, item])
  if (cycle.length > 0) {
    throw new Error(
      `ai-buddy plan: refusing to create "${title}" — it would close a dependency cycle ` +
        `through ${cycle.join(', ')}`,
    )
  }

  item.blockedBy = blockedIdsOf(item, new Map([...existing, item].map((i) => [i.id, i])))
  const stored = store.putPlanItem(projectId, item) ?? item
  return normalizeItem(stored)
}

/**
 * Move an item's status (and, for a human, its structural fields).
 *
 * @returns the updated item, or `{ needHumanConfirmation: true, reason }`
 *          when the change is structural and the actor is not human.
 */
export function updateStatus(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)
  const actor = requireActor(opts.actor)

  const planItemId = isNonEmptyString(opts.planItemId) ? opts.planItemId : ''
  if (planItemId === '') {
    throw new Error('ai-buddy plan: updateStatus needs a planItemId')
  }
  const stored = store.readPlan(projectId).find((item) => item.id === planItemId)
  if (stored === undefined) {
    throw new Error(`ai-buddy plan: unknown plan item "${planItemId}" in project "${projectId}"`)
  }
  const item = normalizeItem(stored)
  if (item.deletedAt !== null) {
    throw new Error(`ai-buddy plan: plan item "${planItemId}" was deleted`)
  }

  // --- write right (§3) ---------------------------------------------------
  // The rule is "human, or the execution holder of the bound task". One
  // documented extension: an item bound to *no* task cannot have a competing
  // execution right, so its `assignee` may move it. Without that, an agent
  // could create a 事前计划 item and then never touch it — the plan would be
  // write-only for AIs, which defeats the point of the board.
  const task = boundTask(store, projectId, item)
  const holder = executionHolderOf(task, opts.executionHolder)
  if (!isHuman(actor)) {
    if (holder === null) {
      if (task === undefined && item.assignee === actor.id) {
        // sole responsible agent of an unbound item — allowed, see above
      } else {
        throw new Error(
          `ai-buddy plan: "${item.title}" is bound to a task with no execution holder `
            + `(${task ? task.id : 'none'}), so only a human may change it. `
            + 'Claim the conversation\'s execution lock first (§3).',
        )
      }
    } else if (actor.id !== holder) {
      throw new Error(
        `ai-buddy plan: only the execution-lock holder "${holder}" (or a human) may change `
          + `"${item.title}"; "${actor.id}" does not hold it`,
      )
    }
  }

  // --- structural changes need a human ------------------------------------
  const wantsDelete = opts.delete === true || opts.newStatus === 'deleted'
  const nextAssignee = opts.assignee === undefined
    ? item.assignee
    : (isNonEmptyString(opts.assignee) ? opts.assignee : null)
  const reassigns = nextAssignee !== item.assignee && nextAssignee !== null
  if (!isHuman(actor) && (wantsDelete || reassigns)) {
    return {
      needHumanConfirmation: true,
      reason: wantsDelete
        ? `Deleting plan item "${item.title}" changes the shared board for every conversation; `
          + 'it needs a human confirmation'
        : `Moving "${item.title}" from "${item.assignee ?? 'unassigned'}" to "${nextAssignee}" `
          + 'is a reassignment across agents; it needs a human confirmation',
    }
  }

  // --- the interruption lock owns its own status (§5.3) -------------------
  // Only `setLockedByInterrupt` may move an item in or out of the frozen state.
  // Everything else is refused here rather than silently re-frozen, so a caller
  // cannot mistake "status unchanged" for "status applied".
  if (item.status === INTERRUPT_STATUS && opts.newStatus !== undefined
    && opts.newStatus !== INTERRUPT_STATUS) {
    return {
      needHumanConfirmation: true,
      reason: `"${item.title}" is frozen by the interruption lock; a human must unlock it `
        + '(setLockedByInterrupt with locked=false) before its status can change',
    }
  }

  let nextStatus = item.status
  if (opts.newStatus !== undefined && !wantsDelete) {
    if (opts.newStatus === INTERRUPT_STATUS) {
      throw new Error(
        'ai-buddy plan: locked_by_interrupt is set only by the interruption lock; '
          + 'use setLockedByInterrupt(store, projectId, planItemId, true, reason)',
      )
    }
    if (!PLAN_STATUSES.includes(opts.newStatus)) {
      throw new Error(
        `ai-buddy plan: unknown status "${String(opts.newStatus)}". `
          + `Valid statuses: ${PLAN_STATUSES.join(', ')}`,
      )
    }
    nextStatus = opts.newStatus
  }

  const at = nowIso()
  const patch = {
    ...item,
    status: nextStatus,
    assignee: nextAssignee,
    priority: opts.priority === undefined ? item.priority : clampPriority(opts.priority),
    dueAt: opts.dueAt === undefined ? item.dueAt : (opts.dueAt ?? null),
    lastNote: typeof opts.note === 'string' && opts.note.trim() !== ''
      ? opts.note.trim()
      : item.lastNote,
    updatedAt: at,
  }
  if (wantsDelete) patch.deletedAt = at

  const storedNext = store.putPlanItem(projectId, patch) ?? patch
  // Status is exactly what `blockedBy` depends on, so this is unconditional.
  recomputeBlocking(store, projectId)
  const fresh = store.readPlan(projectId).find((entry) => entry.id === planItemId)
  return normalizeItem(fresh ?? storedNext)
}

/**
 * Set or clear the interruption freeze on one item (§7.5).
 *
 * Kept separate from `updateStatus` because it is the *system*'s write, not an
 * actor's: it happens without an execution lock when the conversation has
 * failed to resume repeatedly, and it must be reversible back to whatever the
 * item was doing before — never to a guessed `pending`.
 */
export function setLockedByInterrupt(store, projectId, planItemId, locked, reason) {
  requireProject(store, projectId)
  if (!isNonEmptyString(planItemId)) {
    throw new Error('ai-buddy plan: setLockedByInterrupt needs a planItemId')
  }
  const stored = store.readPlan(projectId).find((item) => item.id === planItemId)
  if (stored === undefined) {
    throw new Error(`ai-buddy plan: unknown plan item "${planItemId}" in project "${projectId}"`)
  }
  const item = normalizeItem(stored)
  const note = typeof reason === 'string' ? reason.trim() : ''
  const at = nowIso()

  if (locked === true) {
    if (item.status === INTERRUPT_STATUS) return normalizeItem(stored) // idempotent
    const next = {
      ...item,
      status: INTERRUPT_STATUS,
      lastNote: note === '' ? '因意外中断锁定，等待人工裁决' : note,
      updatedAt: at,
      interruptLock: {
        lockedAt: at,
        reason: note,
        previousStatus: item.status,
      },
    }
    const saved = store.putPlanItem(projectId, next) ?? next
    recomputeBlocking(store, projectId)
    return normalizeItem(saved)
  }

  // Unlock: restore the pre-lock status. Without a recorded previous status the
  // honest answer is `pending` — the item had not been confirmed done.
  const previous = asRecord(item.interruptLock).previousStatus
  const restored = PLAN_STATUSES.includes(previous) && previous !== INTERRUPT_STATUS
    ? previous
    : 'pending'
  const next = {
    ...item,
    status: restored,
    lastNote: note === '' ? item.lastNote : note,
    updatedAt: at,
    interruptLock: null,
  }
  const saved = store.putPlanItem(projectId, next) ?? next
  recomputeBlocking(store, projectId)
  return normalizeItem(saved)
}

// -------------------------------------------------------------------- reads

/**
 * The board, filtered. Live items only; `includeDeleted` is for the web API's
 * history view.
 */
export function read(store, config, projectId, filter = {}) {
  const opts = asRecord(filter)
  requireProject(store, projectId)

  let items = store.readPlan(projectId).map(normalizeItem)
  if (opts.includeDeleted !== true) items = items.filter((item) => item.deletedAt === null)

  if (isNonEmptyString(opts.status)) {
    const wanted = opts.status === 'open'
      // "open" is the board view every agent wants: not done, not deleted.
      ? (item) => item.status !== 'done'
      : (item) => item.status === opts.status
    items = items.filter(wanted)
  }
  if (isNonEmptyString(opts.assignee)) {
    items = items.filter((item) => item.assignee === opts.assignee)
  }
  if (isNonEmptyString(opts.taskId)) {
    items = items.filter((item) => item.taskId === opts.taskId)
  }
  if (isNonEmptyString(opts.mode)) {
    items = items.filter((item) => item.mode === opts.mode)
  }
  if (opts.blocked === true) items = items.filter((item) => item.blockedBy.length > 0)
  if (opts.blocked === false) items = items.filter((item) => item.blockedBy.length === 0)

  const limit = Number(opts.limit)
  if (Number.isFinite(limit) && limit > 0) items = items.slice(0, Math.floor(limit))
  return items
}

/**
 * Recompute `blockedBy` for every item, oldest dependency first (§5.3).
 *
 * Called after any status change and by the resume path, which must not trust a
 * snapshot taken before the interruption. Returns the whole item list so the
 * caller can echo the board without a second read.
 */
export function recomputeBlocking(store, projectId) {
  requireProject(store, projectId)
  const items = liveItems(store, projectId)
  const cycles = detectCycles(items)
  const { items: next } = applyBlocking(store, projectId, items)
  if (cycles.length > 0) {
    // Not thrown: a cycle already in the file must not brick every read. The
    // board reports it instead, and `create` refuses to add more.
    return next.map((item) => ({
      ...item,
      cycle: cycles.includes(item.id),
    }))
  }
  return next.map((item) => ({ ...item, cycle: false }))
}

// ------------------------------------------------------------- task graph

/**
 * Build the lineage forest the task-graph view renders.
 *
 * The graph answers "how did this work break down, and who is on which branch
 * right now" — not "what must finish first" (that is `dependsOn`, drawn as
 * cross-links). So it walks `parentId`, and every root is either a human
 * instruction (an item with no parent that a human created) or an orphan whose
 * parent was deleted.
 *
 * Returns `{ roots, index }` where each node carries the resolved runtime state
 * the view needs, so the client never has to join three collections itself:
 *
 *   status / assignee          from the plan item
 *   agentState                 live AI state (working/waiting/dormant/offline)
 *   currentTask                what that agent is doing right now, if anything
 *   depth / children / orphan  tree geometry
 *
 * @param {object} store
 * @param {string} projectId
 * @param {{ team?: { members?: object[] } }} [runtime] live team roster, if any
 */
export function tree(store, projectId, runtime = {}) {
  requireProject(store, projectId)
  const items = liveItems(store, projectId)
  const tasks = store.readTasks(projectId)
  const members = Array.isArray(runtime?.team?.members) ? runtime.team.members : []

  const memberByName = new Map()
  for (const member of members) {
    if (isNonEmptyString(member?.name)) memberByName.set(member.name, member)
  }
  const taskById = new Map()
  for (const candidate of tasks) {
    if (isNonEmptyString(candidate?.id)) taskById.set(candidate.id, candidate)
  }

  const byId = new Map(items.map((item) => [item.id, item]))
  const childrenOf = new Map()
  const roots = []

  for (const item of items) {
    // A parent that no longer exists re-roots the branch and is flagged, rather
    // than dropping the node: a silently missing branch is worse than one
    // marked "its parent was deleted".
    const parent = item.parentId === null ? undefined : byId.get(item.parentId)
    const orphan = item.parentId !== null && parent === undefined
    if (parent === undefined) roots.push({ item, orphan })
    else {
      const list = childrenOf.get(parent.id) ?? []
      list.push(item)
      childrenOf.set(parent.id, list)
    }
  }

  const index = {}
  let maxDepth = 0

  const build = (item, depth, orphan) => {
    maxDepth = Math.max(maxDepth, depth)
    const member = item.assignee === null ? undefined : memberByName.get(item.assignee)
    const boundTask = item.taskId === null ? undefined : taskById.get(item.taskId)
    // Only an item that is actually in flight has a "current task"; a done item
    // showing one would claim the agent is still on it.
    const inFlight = item.status === 'in_progress'
    const node = {
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      assignee: item.assignee,
      mode: item.mode,
      blockedBy: item.blockedBy,
      dependsOn: item.dependsOn,
      dueAt: item.dueAt,
      taskId: item.taskId,
      depth,
      orphan: orphan === true,
      children: [],
      agentState: member?.status ?? (item.assignee === null ? 'unassigned' : 'offline'),
      agentRole: member?.role ?? null,
      currentTask: inFlight ? item.title : null,
      executionHolder: boundTask?.executionLock?.holder ?? null,
      locked: item.status === 'locked_by_interrupt',
    }
    index[item.id] = node
    for (const child of childrenOf.get(item.id) ?? []) {
      node.children.push(build(child, depth + 1, false))
    }
    return node
  }

  const builtRoots = roots.map(({ item, orphan }) => build(item, 0, orphan))

  return {
    roots: builtRoots,
    index,
    stats: {
      total: items.length,
      roots: builtRoots.length,
      maxDepth,
      inProgress: items.filter((i) => i.status === 'in_progress').length,
      blocked: items.filter((i) => i.status === 'locked_by_interrupt').length,
    },
  }
}
