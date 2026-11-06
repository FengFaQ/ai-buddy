/**
 * Collaboration requests: the adjudication queue between a member who needs
 * help and the leader who decides.
 *
 * Why this is its own record rather than a plan item: a request is a *claim
 * awaiting judgement*, and it has a lifecycle no other entity has — pending,
 * approved, rejected, expired. Making it a plan item would mean a member could
 * unilaterally create work by submitting a request, which is exactly the
 * authority the leader is supposed to hold.
 *
 * The queue is deliberately small and append-only in practice: a request is
 * created once and resolved once. Re-opening a resolved request is refused, so
 * "approve twice" cannot happen even under a retry.
 */

import { newId, nowIso, asRecord, asStringArray, isNonEmptyString, clip } from '../util.js'

export const REQUEST_STATUSES = Object.freeze(['pending', 'approved', 'rejected', 'expired'])

export const REQUEST_KINDS = Object.freeze(['teammate', 'task'])

function normalizeRequest(raw) {
  const r = asRecord(raw)
  return {
    id: String(r.id ?? ''),
    projectId: String(r.projectId ?? ''),
    kind: REQUEST_KINDS.includes(r.kind) ? r.kind : 'teammate',
    from: isNonEmptyString(r.from) ? r.from : null,
    leader: isNonEmptyString(r.leader) ? r.leader : null,
    title: String(r.title ?? ''),
    reason: String(r.reason ?? ''),
    skill: isNonEmptyString(r.skill) ? r.skill : null,
    urgency: ['low', 'normal', 'high'].includes(r.urgency) ? r.urgency : 'normal',
    planItemId: isNonEmptyString(r.planItemId) ? r.planItemId : null,
    status: REQUEST_STATUSES.includes(r.status) ? r.status : 'pending',
    decidedBy: isNonEmptyString(r.decidedBy) ? r.decidedBy : null,
    decidedAt: isNonEmptyString(r.decidedAt) ? r.decidedAt : null,
    assignee: isNonEmptyString(r.assignee) ? r.assignee : null,
    reasonOnDecide: typeof r.reasonOnDecide === 'string' ? r.reasonOnDecide : '',
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : nowIso(),
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : nowIso(),
  }
}

export function create(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  const title = isNonEmptyString(opts.title) ? opts.title.trim() : ''
  if (title === '') throw new Error('ai-buddy requests: a request needs a non-empty title')
  const reason = isNonEmptyString(opts.reason) ? opts.reason.trim() : ''
  if (reason === '') {
    throw new Error('ai-buddy requests: a request needs a reason; the leader cannot judge a bare ask')
  }

  const request = normalizeRequest({
    id: newId('rq'),
    projectId,
    kind: opts.kind,
    from: opts.from,
    leader: opts.leader,
    title,
    reason,
    skill: opts.skill,
    urgency: opts.urgency,
    planItemId: opts.planItemId,
    status: 'pending',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })

  const list = store.readRequests(projectId)
  list.push(request)
  store.writeRequests(projectId, list)
  return request
}

export function get(store, projectId, requestId) {
  return store.readRequests(projectId).map(normalizeRequest).find((r) => r.id === requestId)
}

export function list(store, projectId, filter = {}) {
  const opts = asRecord(filter)
  let items = store.readRequests(projectId).map(normalizeRequest)
  if (isNonEmptyString(opts.status)) items = items.filter((r) => r.status === opts.status)
  if (isNonEmptyString(opts.from)) items = items.filter((r) => r.from === opts.from)
  const limit = Number(opts.limit)
  if (Number.isFinite(limit) && limit > 0) items = items.slice(Math.max(0, items.length - limit))
  return items
}

/** Resolve one request exactly once. */
export function resolve(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  const requestId = isNonEmptyString(opts.requestId) ? opts.requestId : ''
  if (requestId === '') throw new Error('ai-buddy requests: resolve needs a requestId')
  const status = REQUEST_STATUSES.includes(opts.status) ? opts.status : ''
  if (status === '' || status === 'pending') {
    throw new Error(`ai-buddy requests: resolve needs a terminal status, got "${String(opts.status)}"`)
  }

  const list_ = store.readRequests(projectId).map(normalizeRequest)
  const index = list_.findIndex((r) => r.id === requestId)
  if (index < 0) throw new Error(`ai-buddy requests: unknown request "${requestId}"`)
  const current = list_[index]
  if (current.status !== 'pending') {
    throw new Error(
      `ai-buddy requests: "${requestId}" is already ${current.status}; ` +
        'a resolved request cannot be decided again',
    )
  }

  const at = nowIso()
  list_[index] = {
    ...current,
    status,
    decidedBy: isNonEmptyString(opts.decidedBy) ? opts.decidedBy : null,
    decidedAt: at,
    assignee: isNonEmptyString(opts.assignee) ? opts.assignee : null,
    reasonOnDecide: typeof opts.reason === 'string' ? clip(opts.reason, 1200) : '',
    updatedAt: at,
  }
  store.writeRequests(projectId, list_)
  return list_[index]
}

/** How many requests are waiting on the leader right now. */
export function pendingCount(store, projectId) {
  return store.readRequests(projectId).filter((r) => asRecord(r).status === 'pending').length
}

export { normalizeRequest }
