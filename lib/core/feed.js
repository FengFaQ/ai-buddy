/**
 * The collaboration feed (§2.1): the append-only event stream that every
 * conversation and the human workbench read to find out what happened while
 * they were not looking.
 *
 * Why this module is the integration bus: a tool call is private to one
 * conversation, so in a multi-conversation project the only shared scratchpad is
 * data on disk — the feed is that scratchpad. The resume subsystem (§7) reads it
 * instead of guessing, and a checkpoint pins the ids of the events it saw, which
 * is what lets a resumed conversation notice that someone else moved the plan.
 *
 * Two invariants worth knowing before changing this file:
 *
 * 1. `kind` is derived from `category`, never supplied by the caller. The
 *    category set is closed (`CATEGORY_KINDS`), so a `member` event can never be
 *    filed under `recovery` and the "what did I miss" queries stay honest. An
 *    unknown category is a caller bug, not user input: it throws rather than
 *    being persisted as garbage every later reader would have to tolerate.
 *
 * 2. An agent's burst is throttled, not dropped. A throttled event is still
 *    written with `meta.throttled` so the audit trail is complete, but every
 *    read path hides it. The point is that a model must not be able to drown the
 *    feed in noise, and must not be able to post and then quote itself back as
 *    if a peer had said it.
 *
 * Nothing here emits feed events on behalf of other modules: `post` is the only
 * writer, and the caller (tools/index.js, web.js) decides when to call it. That
 * keeps one `store.appendFeed` call per user-visible action.
 */

import {
  newId, nowIso, asRecord, asStringArray, clip, isNonEmptyString, parseSince,
} from '../util.js'

/** category -> kind. Closed set; see CONTRACT §5.2. */
export const CATEGORY_KINDS = Object.freeze({
  'agent.join': 'member',
  'agent.leave': 'member',
  'asset.upload': 'member',
  'asset.update': 'member',
  'task.create': 'member',
  'task.handoff': 'member',
  'task.archive': 'member',
  'plan.create': 'member',
  'plan.update': 'member',
  'plan.status': 'member',

  'task.share': 'directed',
  'task.transfer': 'directed',
  'execution.handoff': 'directed',

  // Team collaboration (§ team management). A team message is `directed` when
  // it names a member and `member` otherwise; the caller picks the category, so
  // these two carry the addressing. They are their own categories rather than
  // reusing `task.*` because "someone spoke to the team" is a different fact
  // from "a task changed", and the feed panel renders them differently.
  'team.message': 'directed',
  'team.human_request': 'human',
  'team.request': 'directed',
  'team.approve': 'member',
  'team.reject': 'member',
  'team.remove': 'member',
  'team.review': 'member',
  'team.join': 'member',

  'human.instruction': 'human',
  'human.priority': 'human',
  'human.pause': 'human',
  'human.resume': 'human',
  'human.unlock': 'human',
  'human.reply': 'human',

  'resume.start': 'recovery',
  'resume.summary': 'recovery',
  'resume.skip': 'recovery',
  'resume.failure': 'recovery',
  'lock.engaged': 'recovery',
  'lock.released': 'recovery',
})

/** Every legal category, in the order they are declared above. */
export const FEED_CATEGORIES = Object.freeze(Object.keys(CATEGORY_KINDS))

/**
 * Lock events are the ones a human must not miss: they say "an AI stopped and it
 * needs you". They are pinned by category, not by a caller-supplied flag, so no
 * code path can file a lock event unpinned.
 */
export const LOCK_CATEGORIES = Object.freeze(['lock.engaged', 'lock.released'])

const SOURCES = new Set(['auto', 'agent', 'human'])

const RATE_WINDOW_MS = 60_000

/**
 * Accepted agent-post timestamps per project for the sliding minute.
 *
 * Module-level is correct here: a Store is one per process (§4), and the limit
 * is a property of the project's conversation, not of any single call. Only
 * *accepted* posts are recorded — a throttled attempt must not extend its own
 * ban, otherwise one noisy minute silences the agent for as long as it keeps
 * retrying.
 */
const agentPostWindows = new Map()

/** Test hook: forget the sliding windows. Not used by production code. */
export function resetRateLimits(projectId) {
  if (projectId === undefined) agentPostWindows.clear()
  else agentPostWindows.delete(projectId)
}

/** `kind` for a category, or `undefined` for an unknown one. */
export function kindOfCategory(category) {
  return CATEGORY_KINDS[category]
}

// --------------------------------------------------------------- internals

function requireProject(store, projectId) {
  if (!isNonEmptyString(projectId)) {
    throw new Error('ai-buddy feed: a non-empty projectId is required')
  }
  const project = store.getProject(projectId)
  if (project === undefined) {
    throw new Error(`ai-buddy feed: unknown project "${projectId}"`)
  }
  return project
}

function normalizeActor(actor, source) {
  // A bare agent name is accepted as well as the Actor record; the tool layer
  // knows the caller as a string and building the record there would just
  // duplicate this normalization.
  if (typeof actor === 'string' && actor.trim() !== '') {
    const id = actor.trim()
    return { type: id === 'human' ? 'human' : (source === 'human' ? 'human' : 'agent'), id, name: id }
  }
  const rec = asRecord(actor)
  const type = rec.type === 'human' || rec.type === 'agent' || rec.type === 'system'
    ? rec.type
    : (source === 'human' ? 'human' : 'system')
  const id = isNonEmptyString(rec.id) ? rec.id : (type === 'human' ? 'human' : 'system')
  const name = isNonEmptyString(rec.name) ? rec.name : id
  return { type, id, name }
}

/** Fill the optional fields so no reader has to defend against a sparse event. */
function normalizeEvent(event) {
  return {
    id: String(event.id),
    projectId: String(event.projectId),
    at: typeof event.at === 'string' ? event.at : nowIso(),
    kind: CATEGORY_KINDS[event.category] ?? 'member',
    category: event.category,
    source: SOURCES.has(event.source) ? event.source : 'auto',
    actor: normalizeActor(event.actor, event.source),
    content: typeof event.content === 'string' ? event.content : '',
    taskId: event.taskId ?? null,
    planItemId: event.planItemId ?? null,
    assetId: event.assetId ?? null,
    targetRefs: asStringArray(event.targetRefs),
    pinned: event.pinned === true,
    highRisk: event.highRisk === true,
    meta: asRecord(event.meta),
  }
}

/** The event stream minus the throttled ones — see invariant 2 above. */
function visibleEvents(events) {
  return events
    .filter((event) => asRecord(event.meta).throttled !== true)
    .map(normalizeEvent)
}

function stamp(iso) {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return String(iso ?? '—')
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

function actorLabel(actor) {
  const name = actor?.name ?? actor?.id ?? 'unknown'
  return actor?.type === 'human' ? `${name}(人)` : name
}

/**
 * Charge one agent post against the sliding minute.
 * Returns true when the post is allowed.
 */
function chargeAgentQuota(projectId, postsPerMinute) {
  const limit = Number(postsPerMinute)
  // A non-positive limit means "do not throttle": an operator who wants the AIs
  // silent can say so on the feed policy, but a `0` that silently blackholes
  // every AI post is a worse default than no limit at all.
  if (!Number.isFinite(limit) || limit <= 0) return true
  const now = Date.now()
  const window = (agentPostWindows.get(projectId) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (window.length >= limit) {
    agentPostWindows.set(projectId, window)
    return false
  }
  window.push(now)
  agentPostWindows.set(projectId, window)
  return true
}

// ------------------------------------------------------------------- writes

/**
 * Record one feed event.
 *
 * @returns {{ event: object, throttled: boolean }}
 */
export function post(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)

  const category = isNonEmptyString(opts.category) ? opts.category : ''
  const kind = CATEGORY_KINDS[category]
  if (kind === undefined) {
    throw new Error(
      `ai-buddy feed: unknown category "${category}". ` +
        `Valid categories: ${FEED_CATEGORIES.join(', ')}`,
    )
  }

  const content = typeof opts.content === 'string' ? opts.content.trim() : ''
  if (content === '') {
    throw new Error('ai-buddy feed: a feed event needs a non-empty content string')
  }

  const rawSource = opts.source
  if (rawSource !== undefined && !SOURCES.has(rawSource)) {
    throw new Error(
      `ai-buddy feed: unknown source "${String(rawSource)}". Valid sources: auto, agent, human`,
    )
  }
  const source = rawSource ?? 'auto'

  if (source === 'agent') {
    const raw = typeof opts.actor === 'string' ? opts.actor.trim() : ''
    const rec = asRecord(opts.actor)
    if (raw === '' && !isNonEmptyString(rec.id) && !isNonEmptyString(rec.name)) {
      throw new Error('ai-buddy feed: an agent post must name the agent that made it (actor)')
    }
  }

  const isLockEvent = LOCK_CATEGORIES.includes(category)
  const throttled = source === 'agent'
    && !chargeAgentQuota(projectId, config?.feed?.aiPostsPerMinute)

  const event = normalizeEvent({
    id: newId('f'),
    projectId,
    at: nowIso(),
    kind,
    category,
    source,
    actor: opts.actor,
    content,
    taskId: opts.taskId ?? null,
    planItemId: opts.planItemId ?? null,
    assetId: opts.assetId ?? null,
    targetRefs: opts.targetRefs,
    // A lock event is always pinned and always high risk: it is the one class of
    // event whose entire purpose is to stop an AI and wait for a human.
    pinned: isLockEvent ? true : opts.pinned === true,
    highRisk: isLockEvent ? true : opts.highRisk === true,
    meta: {
      ...asRecord(opts.meta),
      ...(throttled ? { throttled: true } : {}),
    },
  })

  const stored = store.appendFeed(projectId, event)
  return { event: stored ?? event, throttled }
}

// -------------------------------------------------------------------- reads

/**
 * Read a window of the feed, oldest first.
 *
 * `sinceEventId` is exclusive. When that id is no longer retained, the whole
 * retained window is returned: an empty answer would be indistinguishable from
 * "nothing happened", which is exactly the wrong conclusion for a resuming
 * conversation.
 */
export function read(store, config, projectId, options = {}) {
  const opts = asRecord(options)
  requireProject(store, projectId)

  let events = visibleEvents(store.readFeed(projectId))

  if (isNonEmptyString(opts.sinceEventId)) {
    const index = events.findIndex((event) => event.id === opts.sinceEventId)
    if (index >= 0) events = events.slice(index + 1)
  }

  const sinceMs = parseSince(opts.sinceTime)
  if (sinceMs > 0) events = events.filter((event) => Date.parse(event.at) >= sinceMs)

  const categories = asStringArray(opts.categories)
  if (categories.length > 0) {
    events = events.filter(
      (event) => categories.includes(event.category) || categories.includes(event.kind),
    )
  }

  const limit = Number(opts.limit)
  let windowed = events
  if (Number.isFinite(limit) && limit > 0) {
    windowed = events.slice(Math.max(0, events.length - Math.floor(limit)))
  }

  // `includePinned` restores the "must not miss" events that the limit pushed
  // out of the window. Pinned events are cross-cutting (a lock engaged an hour
  // ago is still the reason nobody is working), so they belong in every view.
  if (opts.includePinned === true && windowed.length !== events.length) {
    const kept = new Set(windowed.map((event) => event.id))
    const pinned = events.filter((event) => event.pinned && !kept.has(event.id))
    windowed = [...pinned, ...windowed]
  }

  return windowed
}

/**
 * A Markdown digest for an agent's context: ids it can cite, one line each.
 *
 * Deliberately terse — the model pays for every token, and the ids are the part
 * it cannot reconstruct.
 */
export function summarize(store, projectId, options = {}) {
  const opts = asRecord(options)
  const project = requireProject(store, projectId)
  const limit = Number.isFinite(Number(opts.limit)) ? Math.max(1, Math.floor(Number(opts.limit))) : 50
  const events = read(store, store.config, projectId, {
    limit,
    sinceEventId: opts.sinceEventId,
    categories: opts.categories,
    includePinned: true,
  })

  const lines = [`# 协作动态 — ${project.title}（${events.length} 条）`, '']
  if (events.length === 0) {
    lines.push('_暂无动态。_')
    return lines.join('\n')
  }
  for (const event of events) {
    const tags = [event.kind, event.category, `source:${event.source}`]
    if (event.taskId) tags.push(`task:${event.taskId}`)
    if (event.planItemId) tags.push(`plan:${event.planItemId}`)
    if (event.assetId) tags.push(`asset:${event.assetId}`)
    const pin = event.pinned ? ' **[需人工关注]**' : ''
    lines.push(
      `- \`${event.id}\` ${stamp(event.at)} ${actorLabel(event.actor)} ` +
        `(${tags.join(' · ')})${pin} — ${clip(event.content, 300)}`,
    )
  }
  return lines.join('\n')
}

/**
 * What the human actually asked for, oldest first.
 *
 * Only the `human.*` directive categories count. A human who uploads an asset
 * also produces a feed event, but that is an incidental member event, not an
 * instruction a resuming AI should re-read as an order.
 */
export function humanInstructions(store, projectId, options = {}) {
  const opts = asRecord(options)
  requireProject(store, projectId)
  const sinceMs = parseSince(opts.since)
  return visibleEvents(store.readFeed(projectId)).filter((event) => {
    if (kindOfCategory(event.category) !== 'human') return false
    if (sinceMs > 0 && Date.parse(event.at) < sinceMs) return false
    return true
  })
}
