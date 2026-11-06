/**
 * The team (§ team management): who exists, who reports to whom, and what each
 * member is doing right now.
 *
 * Three ideas drive the shape of this module:
 *
 * 1. **A roster is not a session list.** DSH already knows every live session;
 *    what it does not know is *why* a session exists, who answers for it, and
 *    whether its agent is working, waiting on a human, or asleep. Those are
 *    collaboration facts, so they live here, keyed by member name, and carry the
 *    session id as an attribute rather than as identity. That is what lets a
 *    member be "sleeping" while its session is disposed, and then be woken into
 *    the same seat.
 *
 * 2. **The leader is a role, not a special case sprinkled everywhere.** Any
 *    member may carry `role: 'leader'`, but exactly one may. The guard lives in
 *    `setLeader` and every mutation funnels through it, so "two leaders" is
 *    unrepresentable rather than merely discouraged.
 *
 * 3. **Status is derived where it can be, stored where it must be.** `working`
 *    vs `idle` is read from the live agent. `waiting_human` (the member asked a
 *    question and parked) and `dormant` (the member was deliberately put to
 *    sleep) cannot be observed from the outside — they are intent — so they are
 *    stored, and a stored state always wins over a live guess.
 */

import { newId, nowIso, clip, asRecord, asStringArray, isNonEmptyString } from '../util.js'

/** The states a member can be in, from the collaboration's point of view. */
export const MEMBER_STATES = Object.freeze([
  'working',       // executing a turn right now
  'waiting_human', // asked a question and parked; the human owes an answer
  'idle',          // alive and ready, nothing assigned
  'dormant',       // deliberately asleep; no session, woken on demand
  'offline',       // has no live session and was not put to sleep on purpose
])

/** Stored states that override what the live agent looks like. */
const STICKY_STATES = new Set(['waiting_human', 'dormant'])

export const ROLES = Object.freeze(['leader', 'member', 'coordinator'])

/**
 * A pool of human-readable names the leader picks from.
 *
 * The roster is read by humans — in the feed, in the org chart, in @-mentions —
 * so `budget-writer` is a poor name and `小算` is a good one. The leader chooses
 * from this pool (see `suggestMemberName`) rather than inventing a slug, which
 * keeps names short, pronounceable, and free of the punctuation that would break
 * an `@mention`.
 *
 * Deliberately Chinese-first with a Latin fallback set: the plugin's UI is
 * Chinese by default, and a mixed roster reads naturally in both.
 */
export const NAME_POOL = Object.freeze([
  '小析', '小筹', '小算', '小策', '小稽',
  '小核', '小筛', '小理', '小汇', '小撰',
  '小校', '小勘', '小铺', '小联', '小统',
  '阿析', '阿筹', '阿算', '阿策', '阿稽',
  'Aria', 'Bruno', 'Cato', 'Dana', 'Emil',
  'Faye', 'Gino', 'Hana', 'Iris', 'Jun',
])

/**
 * Pick a name for a new member.
 *
 * Rule: the leader's suggestion wins when it is usable; otherwise the first free
 * name from the pool. "Usable" means non-empty, not already taken, and short
 * enough to render in a chip — a 40-character name would break every row it
 * appears in.
 */
export function suggestMemberName(team, preferred) {
  const taken = new Set(team.members.map((m) => m.name))
  const candidate = isNonEmptyString(preferred) ? String(preferred).trim() : ''
  if (candidate !== '' && !taken.has(candidate) && candidate.length <= 16) return candidate
  for (const name of NAME_POOL) {
    if (!taken.has(name)) return name
  }
  // Pool exhausted: fall back to a numbered name rather than failing the hire.
  for (let i = 2; i < 1000; i++) {
    const name = `${team.members[0]?.name ?? 'member'}${i}`
    if (!taken.has(name)) return name
  }
  return `member${Date.now()}`
}

function normalizeMember(raw) {
  const m = asRecord(raw)
  return {
    name: String(m.name ?? ''),
    role: ROLES.includes(m.role) ? m.role : 'member',
    reportsTo: isNonEmptyString(m.reportsTo) ? m.reportsTo : null,
    title: isNonEmptyString(m.title) ? m.title : '',
    // A member's seat survives its session: `sessionId` is cleared when the
    // agent is put to sleep and restored when it wakes.
    sessionId: isNonEmptyString(m.sessionId) ? m.sessionId : null,
    workspace: isNonEmptyString(m.workspace) ? m.workspace : null,
    model: isNonEmptyString(m.model) ? m.model : null,
    // Full provider/model/effort triple, so a seat can be spawned without
    // re-resolving the team's default.
    modelSelection: {
      provider: isNonEmptyString(asRecord(m.modelSelection).provider) ? asRecord(m.modelSelection).provider : null,
      model: isNonEmptyString(asRecord(m.modelSelection).model) ? asRecord(m.modelSelection).model : null,
      reasoningEffort: isNonEmptyString(asRecord(m.modelSelection).reasoningEffort)
        ? asRecord(m.modelSelection).reasoningEffort
        : null,
    },
    agentPreset: isNonEmptyString(m.agentPreset) ? m.agentPreset : null,
    status: MEMBER_STATES.includes(m.status) ? m.status : 'offline',
    currentTask: isNonEmptyString(m.currentTask) ? m.currentTask : null,
    currentPlanItemId: isNonEmptyString(m.currentPlanItemId) ? m.currentPlanItemId : null,
    joinedAt: typeof m.joinedAt === 'string' ? m.joinedAt : nowIso(),
    lastActiveAt: typeof m.lastActiveAt === 'string' ? m.lastActiveAt : null,
    lastReviewAt: typeof m.lastReviewAt === 'string' ? m.lastReviewAt : null,
    // The leader's running assessment. Kept small: a score, a note, and the
    // timestamp, so a review never turns into a second feed.
    review: asRecord(m.review),
    // Aggregate counters the leader's review reads; cheap to maintain here and
    // expensive to recompute from the feed on every render.
    stats: {
      tasksCompleted: Number(asRecord(m.stats).tasksCompleted) || 0,
      tasksRejected: Number(asRecord(m.stats).tasksRejected) || 0,
      postsTotal: Number(asRecord(m.stats).postsTotal) || 0,
      blockedCount: Number(asRecord(m.stats).blockedCount) || 0,
    },
    notes: typeof m.notes === 'string' ? m.notes : '',
  }
}

function normalizeTeam(raw) {
  const t = asRecord(raw)
  return {
    projectId: String(t.projectId ?? ''),
    initialized: t.initialized === true,
    workspace: isNonEmptyString(t.workspace) ? t.workspace : null,
    leaderModel: asRecord(t.leaderModel),
    // What a newly recruited member runs on. Older rosters have no such field,
    // so it falls back to the leader's model — the historical behaviour.
    memberModel: isNonEmptyString(asRecord(t.memberModel).provider) ||
      isNonEmptyString(asRecord(t.memberModel).model)
      ? asRecord(t.memberModel)
      : asRecord(t.leaderModel),
    leaderBrief: typeof t.leaderBrief === 'string' ? t.leaderBrief : '',
    members: Array.isArray(t.members) ? t.members.map(normalizeMember) : [],
    createdAt: typeof t.createdAt === 'string' ? t.createdAt : null,
    updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : nowIso(),
  }
}

export function emptyTeam(projectId) {
  return normalizeTeam({ projectId, initialized: false, members: [] })
}

/**
 * Bound a human-written brief.
 *
 * The brief is appended to the leader's bootstrap prompt, and prompts are sent
 * on every turn of that agent's first conversation. 8 KB is generous for
 * instructions and small enough that a pasted document cannot silently inflate
 * every request.
 */
export function clampBrief(text) {
  const value = String(text ?? '')
  return value.length <= 8000 ? value : `${value.slice(0, 8000)}\n…（提示词过长，已截断）`
}

/** Normalize a workspace path for comparison: case- and separator-insensitive. */
export function workspaceKey(path) {
  if (!isNonEmptyString(path)) return ''
  return String(path).replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()
}

// ------------------------------------------------------------------ storage

function teamFile(store, projectId) {
  return { dir: store.projectDir(projectId), projectId }
}

export function load(store, projectId) {
  const storeModule = store
  const raw = storeModule.readTeam === undefined
    ? undefined
    : storeModule.readTeam(projectId)
  return raw === undefined ? emptyTeam(projectId) : normalizeTeam(raw)
}

export function save(store, projectId, team) {
  const next = normalizeTeam({ ...team, projectId, updatedAt: nowIso() })
  store.writeTeam(projectId, next)
  return next
}

// ------------------------------------------------------------------- queries

export function leader(team) {
  return team.members.find((m) => m.role === 'leader')
}

export function member(team, name) {
  return team.members.find((m) => m.name === name)
}

/** Everyone who answers to `name`, directly. */
export function directReports(team, name) {
  return team.members.filter((m) => m.reportsTo === name)
}

/** Everyone below `name` in the reporting chain, breadth-first. */
export function reportsTree(team, name) {
  const out = []
  const queue = [name]
  const seen = new Set([name])
  while (queue.length > 0) {
    const current = queue.shift()
    for (const candidate of team.members) {
      if (candidate.reportsTo !== current || seen.has(candidate.name)) continue
      seen.add(candidate.name)
      out.push(candidate)
      queue.push(candidate.name)
    }
  }
  return out
}

/**
 * The live view the workbench and the task graph render.
 *
 * `liveAgents` is a `Map<sessionId, {status}>` supplied by the caller — this
 * module must stay importable without the Host (same rule as all of `lib/core`),
 * so it never imports an agent service.
 */
export function view(team, liveAgents = new Map()) {
  const members = team.members.map((m) => {
    const live = m.sessionId === null ? undefined : liveAgents.get(m.sessionId)
    let status
    if (STICKY_STATES.has(m.status)) {
      // Stored intent wins: a member parked for a human is not "idle" just
      // because its agent happens to be between turns.
      status = m.status
    } else if (live !== undefined) {
      status = live.status === 'running' ? 'working' : 'idle'
    } else if (m.sessionId === null) {
      // A seat with no session has never run (or was never spawned). Falling
      // back to its stored status is the honest answer: a member that was just
      // hired shows as `idle` rather than pretending to be `offline`, and a
      // member that was marked working but whose session has not been created
      // yet keeps that intent instead of being silently downgraded.
      status = m.status === 'offline' ? 'idle' : m.status
    } else {
      // It has a session id but no live agent: the session exists and the agent
      // is not running, which is exactly what `offline` means.
      status = 'offline'
    }
    return { ...m, status, live: live !== undefined }
  })

  const byReportsTo = new Map()
  for (const m of members) {
    const key = m.reportsTo ?? '__root__'
    const list = byReportsTo.get(key) ?? []
    list.push(m)
    byReportsTo.set(key, list)
  }

  return {
    ...team,
    members,
    leader: members.find((m) => m.role === 'leader') ?? null,
    byReportsTo: Object.fromEntries(byReportsTo),
    counts: {
      total: members.length,
      working: members.filter((m) => m.status === 'working').length,
      waitingHuman: members.filter((m) => m.status === 'waiting_human').length,
      dormant: members.filter((m) => m.status === 'dormant').length,
      idle: members.filter((m) => m.status === 'idle').length,
    },
  }
}

// ------------------------------------------------------------------ mutation

/**
 * Install the first leader. Refuses when one already exists: replacing a leader
 * is `setLeader`, which is a deliberate act with its own audit trail.
 */
export function initialize(store, projectId, args = {}) {
  const opts = asRecord(args)
  const existing = load(store, projectId)
  if (existing.initialized === true) {
    throw new Error(
      `ai-buddy team: project "${projectId}" already has a team; ` +
        'call setLeader to change the leader instead of re-initializing',
    )
  }
  const name = isNonEmptyString(opts.leaderName) ? opts.leaderName.trim() : 'leader'
  const at = nowIso()
  const modelSelection = {
    provider: isNonEmptyString(asRecord(opts.model).provider) ? asRecord(opts.model).provider : null,
    model: isNonEmptyString(asRecord(opts.model).model) ? asRecord(opts.model).model : null,
    reasoningEffort: isNonEmptyString(asRecord(opts.model).reasoningEffort)
      ? asRecord(opts.model).reasoningEffort
      : null,
  }
  // The model new members get. Defaults to the leader's, because one team
  // running on one model is the sane default; the human may override it in the
  // setup page when a task needs a different one.
  const memberModelSelection = {
    provider: isNonEmptyString(asRecord(opts.memberModel).provider)
      ? asRecord(opts.memberModel).provider
      : modelSelection.provider,
    model: isNonEmptyString(asRecord(opts.memberModel).model)
      ? asRecord(opts.memberModel).model
      : modelSelection.model,
    reasoningEffort: isNonEmptyString(asRecord(opts.memberModel).reasoningEffort)
      ? asRecord(opts.memberModel).reasoningEffort
      : modelSelection.reasoningEffort,
  }
  const team = normalizeTeam({
    projectId,
    initialized: true,
    workspace: isNonEmptyString(opts.workspace) ? opts.workspace : null,
    // The human decides what the leader runs on, and separately what new
    // members run on. Members copy this at `addMember` time, which is why the
    // whole triple is stored rather than just the model id.
    leaderModel: modelSelection,
    memberModel: memberModelSelection,
    // Free text the human wrote to steer the leader. Appended to the leader's
    // bootstrap prompt rather than replacing it: the built-in brief explains the
    // collaboration mechanics, and the human's text layers intent on top.
    leaderBrief: typeof opts.leaderBrief === 'string' ? clampBrief(opts.leaderBrief) : '',
    members: [
      normalizeMember({
        name,
        role: 'leader',
        reportsTo: null,
        title: isNonEmptyString(opts.title) ? opts.title : '团队领导者',
        workspace: isNonEmptyString(opts.workspace) ? opts.workspace : null,
        model: modelSelection.model,
        modelSelection,
        status: 'idle',
        joinedAt: at,
        notes: '负责引入新 AI、与人类对接、审查其他成员效率。不直接参与任务执行。',
      }),
    ],
    createdAt: at,
  })
  return save(store, projectId, team)
}

/**
 * Add a member under an explicit parent.
 *
 * `reportsTo` defaults to the leader — a member that reports to nobody would be
 * unreachable by the review pass and invisible in the org chart, which is
 * exactly the orphan state this model exists to prevent.
 */
export function addMember(store, projectId, args = {}) {
  const opts = asRecord(args)
  const team = load(store, projectId)
  if (team.initialized !== true) {
    throw new Error('ai-buddy team: the team has not been initialized; initialize it first')
  }
  const name = isNonEmptyString(opts.name) ? opts.name.trim() : ''
  if (name === '') throw new Error('ai-buddy team: a member needs a non-empty name')
  if (team.members.some((m) => m.name === name)) {
    throw new Error(`ai-buddy team: a member named "${name}" already exists`)
  }
  const leaderName = leader(team)?.name ?? null
  const reportsTo = isNonEmptyString(opts.reportsTo) ? opts.reportsTo : leaderName
  if (reportsTo !== null && !team.members.some((m) => m.name === reportsTo)) {
    throw new Error(`ai-buddy team: reportsTo "${reportsTo}" is not a team member`)
  }
  const next = normalizeMember({
    name,
    // A coordinator is a special member created by the runtime, not by a hire.
    role: opts.role === 'coordinator' ? 'coordinator' : 'member',
    reportsTo,
    title: isNonEmptyString(opts.title) ? opts.title : '',
    sessionId: isNonEmptyString(opts.sessionId) ? opts.sessionId : null,
    workspace: isNonEmptyString(opts.workspace) ? opts.workspace : team.workspace,
    // Members inherit the team's member model — chosen separately from the
    // leader's in the setup page, and defaulting to it. A caller may still
    // override per member.
    model: isNonEmptyString(opts.model) ? opts.model : (team.memberModel?.model ?? team.leaderModel?.model ?? null),
    modelSelection: asRecord(opts.modelSelection).provider !== undefined
      ? {
          provider: isNonEmptyString(opts.modelSelection.provider) ? opts.modelSelection.provider : null,
          model: isNonEmptyString(opts.modelSelection.model) ? opts.modelSelection.model : null,
          reasoningEffort: isNonEmptyString(opts.modelSelection.reasoningEffort)
            ? opts.modelSelection.reasoningEffort
            : null,
        }
      : {
          provider: isNonEmptyString(team.memberModel?.provider)
            ? team.memberModel.provider
            : (isNonEmptyString(team.leaderModel?.provider) ? team.leaderModel.provider : null),
          model: isNonEmptyString(team.memberModel?.model)
            ? team.memberModel.model
            : (isNonEmptyString(team.leaderModel?.model) ? team.leaderModel.model : null),
          reasoningEffort: isNonEmptyString(team.memberModel?.reasoningEffort)
            ? team.memberModel.reasoningEffort
            : (isNonEmptyString(team.leaderModel?.reasoningEffort) ? team.leaderModel.reasoningEffort : null),
        },
    agentPreset: isNonEmptyString(opts.agentPreset) ? opts.agentPreset : null,
    status: 'idle',
    joinedAt: nowIso(),
    notes: typeof opts.notes === 'string' ? opts.notes : '',
  })
  team.members = [...team.members, next]
  return save(store, projectId, team)
}

/**
 * Remove a member's seat.
 *
 * The caller is responsible for archiving the conversation first (see
 * `lib/host/team-runtime.js`, which backs the transcript up to the asset
 * library before this runs). This function only refuses operations that would
 * corrupt the roster: removing the leader, or removing a member who still has
 * direct reports (which would orphan them).
 */
export function removeMember(store, projectId, args = {}) {
  const opts = asRecord(args)
  const team = load(store, projectId)
  const name = isNonEmptyString(opts.name) ? opts.name.trim() : ''
  const target = team.members.find((m) => m.name === name)
  if (target === undefined) throw new Error(`ai-buddy team: no member named "${name}"`)
  if (target.role === 'leader') {
    throw new Error(
      'ai-buddy team: the leader cannot be removed; install a different leader first',
    )
  }
  const reports = directReports(team, name)
  if (reports.length > 0) {
    throw new Error(
      `ai-buddy team: "${name}" still has ${reports.length} direct report(s) ` +
        `(${reports.map((r) => r.name).join(', ')}); reassign them first`,
    )
  }
  team.members = team.members.filter((m) => m.name !== name)
  return save(store, projectId, team)
}

/** Hand the leader role to another member, atomically demoting the old one. */
export function setLeader(store, projectId, args = {}) {
  const opts = asRecord(args)
  const team = load(store, projectId)
  const name = isNonEmptyString(opts.name) ? opts.name.trim() : ''
  const target = team.members.find((m) => m.name === name)
  if (target === undefined) throw new Error(`ai-buddy team: no member named "${name}"`)
  team.members = team.members.map((m) => (
    m.name === name
      ? { ...m, role: 'leader', reportsTo: null }
      : { ...m, role: 'member', reportsTo: m.reportsTo === name ? null : m.reportsTo }
  ))
  return save(store, projectId, team)
}

/**
 * Record a state the runtime observed (or a decision it made).
 *
 * `sticky` is deliberate: only `waiting_human` and `dormant` survive a live
 * agent report, because they describe intent rather than activity. Passing any
 * other state here is a plain write.
 */
export function setStatus(store, projectId, args = {}) {
  const opts = asRecord(args)
  const team = load(store, projectId)
  const name = isNonEmptyString(opts.name) ? opts.name : ''
  const target = team.members.find((m) => m.name === name)
  if (target === undefined) throw new Error(`ai-buddy team: no member named "${name}"`)
  const status = MEMBER_STATES.includes(opts.status) ? opts.status : target.status
  const updated = {
    ...target,
    status,
    currentTask: opts.currentTask === undefined ? target.currentTask : (opts.currentTask ?? null),
    currentPlanItemId: opts.currentPlanItemId === undefined
      ? target.currentPlanItemId
      : (opts.currentPlanItemId ?? null),
    sessionId: opts.sessionId === undefined ? target.sessionId : (opts.sessionId ?? null),
    lastActiveAt: nowIso(),
  }
  team.members = team.members.map((m) => (m.name === name ? updated : m))
  return save(store, projectId, team)
}

/** Attach a live session to a seat (creation or wake). */
export function bindSession(store, projectId, args = {}) {
  const opts = asRecord(args)
  const team = load(store, projectId)
  const name = isNonEmptyString(opts.name) ? opts.name : ''
  const target = team.members.find((m) => m.name === name)
  if (target === undefined) throw new Error(`ai-buddy team: no member named "${name}"`)
  const sessionId = isNonEmptyString(opts.sessionId) ? opts.sessionId : null
  team.members = team.members.map((m) => (
    m.name === name
      ? {
          ...m,
          sessionId,
          status: sessionId === null ? 'dormant' : 'idle',
          lastActiveAt: nowIso(),
          workspace: isNonEmptyString(opts.workspace) ? opts.workspace : m.workspace,
        }
      : m
  ))
  return save(store, projectId, team)
}

/**
 * Record the leader's assessment of one member.
 *
 * Deliberately append-and-replace rather than append-and-grow: a member keeps
 * one current review plus a small counter set, because the workbench shows the
 * current judgement and the feed already holds the history. Storing every
 * review in the roster would make the roster the fastest-growing file in the
 * project.
 */
export function review(store, projectId, args = {}) {
  const opts = asRecord(args)
  const team = load(store, projectId)
  const name = isNonEmptyString(opts.name) ? opts.name : ''
  const target = team.members.find((m) => m.name === name)
  if (target === undefined) throw new Error(`ai-buddy team: no member named "${name}"`)
  const at = nowIso()
  const entry = {
    at,
    by: isNonEmptyString(opts.by) ? opts.by : (leader(team)?.name ?? 'leader'),
    score: Number.isFinite(Number(opts.score)) ? Math.max(0, Math.min(100, Number(opts.score))) : null,
    verdict: isNonEmptyString(opts.verdict) ? opts.verdict : '',
    advice: typeof opts.advice === 'string' ? clip(opts.advice, 1200) : '',
  }
  team.members = team.members.map((m) => (
    m.name === name
      ? { ...m, review: entry, lastReviewAt: at, notes: entry.advice || m.notes }
      : m
  ))
  return save(store, projectId, team)
}

/** Bump the counters the review pass reads. Missing members are a no-op. */
export function bumpStat(store, projectId, args = {}) {
  const opts = asRecord(args)
  const team = load(store, projectId)
  const name = isNonEmptyString(opts.name) ? opts.name : ''
  const key = isNonEmptyString(opts.key) ? opts.key : ''
  if (!['tasksCompleted', 'tasksRejected', 'postsTotal', 'blockedCount'].includes(key)) {
    return team
  }
  const delta = Number.isFinite(Number(opts.delta)) ? Number(opts.delta) : 1
  team.members = team.members.map((m) => (
    m.name === name
      ? { ...m, stats: { ...m.stats, [key]: Math.max(0, (m.stats[key] ?? 0) + delta) } }
      : m
  ))
  return save(store, projectId, team)
}

/**
 * Which members are idle and could take work, best first.
 *
 * Ordering is the leader's decision aid, so it is stated in one place: fewer
 * current obligations first, then the member who has waited longest. A member
 * parked for a human is never offered — it cannot start.
 */
export function availableMembers(team) {
  return team.members
    .filter((m) => m.role === 'member' && (m.status === 'idle' || m.status === 'offline'))
    .sort((a, b) => {
      const loadA = (a.currentTask === null ? 0 : 1) + (a.stats.blockedCount ?? 0)
      const loadB = (b.currentTask === null ? 0 : 1) + (b.stats.blockedCount ?? 0)
      if (loadA !== loadB) return loadA - loadB
      const tA = Date.parse(a.lastActiveAt ?? a.joinedAt) || 0
      const tB = Date.parse(b.lastActiveAt ?? b.joinedAt) || 0
      return tA - tB
    })
}

export { normalizeMember, normalizeTeam }
