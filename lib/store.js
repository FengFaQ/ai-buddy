/**
 * The persistence layer: JSON truth + Markdown summaries (§6).
 *
 * Design constraints that shaped this file:
 *
 * 1. **Synchronous mutation.** Every domain module is a synchronous
 *    read-modify-write over an in-memory document. Tools are async, but they
 *    await the *input*, never the mutation, so two tools cannot interleave a
 *    read-modify-write on the same project. The Markdown refresh is the only
 *    deferred work, and it is throttled and coalesced.
 *
 * 2. **Detached reads.** `snapshot()` and every getter return structured
 *    clones. A caller that mutates a returned object cannot corrupt the truth
 *    layer, and the web API can serialise a snapshot without a lock.
 *
 * 3. **Atomic writes.** Every document goes through `writeJsonAtomic`, so a
 *    crash mid-write leaves the previous complete document in place.
 *
 * 4. **Markdown is derived, never authoritative.** If `md/` is deleted, the
 *    next refresh recreates it. Nothing reads it back.
 *
 * The store owns no timers beyond the Markdown flush, which is unref'd.
 */

import path from 'node:path'
import {
  readdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs'
import {
  ensureDir, newId, nowIso, readJsonFile, writeJsonAtomic, writeTextAtomic,
  removeFile, fileExists, asRecord,
} from './util.js'
import { renderFeedMd, renderPlanMd, renderAssetsMd, renderResumeMd } from './markdown.js'

const VERSION = 1

/** How often the Markdown summary may be rewritten per project. */
const MD_THROTTLE_MS = 1500

function emptyProjectShell(id, title) {
  return {
    id,
    title,
    description: '',
    createdBy: { type: 'human', id: 'human', name: 'Human' },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    members: [],
  }
}

export function emptyResumeState(conversationId, taskId = null) {
  return {
    conversationId,
    taskId,
    resumeLock: { state: 'idle', holder: null, since: null, reason: '' },
    interruptLock: {
      state: 'unlocked',
      consecutiveFailures: 0,
      lastFailureReason: null,
      lockedAt: null,
      lockedBy: null,
      trialResumesUsed: 0,
      stableSince: null,
    },
    autoResumeWindow: { startedAt: null, count: 0 },
    lastResumeAt: null,
    lastFailureAt: null,
    lastSucceededAt: null,
  }
}

function listDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export class Store {
  constructor({ dir, config }) {
    this.dir = dir
    this.config = config
    /** @type {Map<string, object>} projectId -> loaded project bundle */
    this.cache = new Map()
    this.listeners = new Set()
    this.mdDirty = new Set()
    ensureDir(path.join(dir, 'projects'))
    const existing = this.listProjects()
    if (existing.length === 0) this._seedDefaultProject()
    this._startMdFlush()
  }

  // ------------------------------------------------------------------ paths

  projectDir(projectId) {
    return path.join(this.dir, 'projects', projectId)
  }

  _file(projectId, name) {
    return path.join(this.projectDir(projectId), name)
  }

  _writeProjectDoc(projectId, name, value) {
    writeJsonAtomic(this._file(projectId, name), value)
  }

  // ------------------------------------------------------------------ seed

  _seedDefaultProject() {
    const project = emptyProjectShell(newId('p'), 'Default project')
    this._writeProjectDoc(project.id, 'project.json', project)
    this._writeProjectDoc(project.id, 'feed.json', { version: VERSION, events: [] })
    this._writeProjectDoc(project.id, 'plan.json', { version: VERSION, items: [] })
    this._writeProjectDoc(project.id, 'tasks.json', { version: VERSION, tasks: [] })
    this._writeProjectDoc(project.id, 'assets/manifest.json', { version: VERSION, assets: [] })
  }

  // ------------------------------------------------------------------ load

  _bundle(projectId) {
    if (typeof projectId !== 'string' || projectId === '') return undefined
    const cached = this.cache.get(projectId)
    if (cached !== undefined) return cached
    const project = readJsonFile(this._file(projectId, 'project.json'), undefined)
    if (project === undefined || project === null) return undefined
    const feed = readJsonFile(this._file(projectId, 'feed.json'), { version: VERSION, events: [] })
    const plan = readJsonFile(this._file(projectId, 'plan.json'), { version: VERSION, items: [] })
    const tasks = readJsonFile(this._file(projectId, 'tasks.json'), { version: VERSION, tasks: [] })
    const assets = readJsonFile(this._file(projectId, 'assets/manifest.json'), { version: VERSION, assets: [] })
    const bundle = {
      project,
      feed: Array.isArray(feed?.events) ? feed : { version: VERSION, events: [] },
      plan: Array.isArray(plan?.items) ? plan : { version: VERSION, items: [] },
      tasks: Array.isArray(tasks?.tasks) ? tasks : { version: VERSION, tasks: [] },
      assets: Array.isArray(assets?.assets) ? assets : { version: VERSION, assets: [] },
    }
    this.cache.set(projectId, bundle)
    return bundle
  }

  // ------------------------------------------------------------- projects

  listProjects() {
    const out = []
    for (const id of listDirs(path.join(this.dir, 'projects'))) {
      const bundle = this._bundle(id)
      if (bundle !== undefined) out.push(structuredClone(bundle.project))
    }
    return out
  }

  getProject(projectId) {
    const bundle = this._bundle(projectId)
    return bundle === undefined ? undefined : structuredClone(bundle.project)
  }

  defaultProjectId() {
    const all = this.listProjects()
    return all.length === 0 ? undefined : all[0].id
  }

  createProject({ title, description, createdBy }) {
    const project = {
      ...emptyProjectShell(newId('p'), String(title ?? '').trim() || 'Untitled project'),
      description: String(description ?? ''),
      createdBy: createdBy ?? { type: 'human', id: 'human', name: 'Human' },
    }
    this._writeProjectDoc(project.id, 'project.json', project)
    this._writeProjectDoc(project.id, 'feed.json', { version: VERSION, events: [] })
    this._writeProjectDoc(project.id, 'plan.json', { version: VERSION, items: [] })
    this._writeProjectDoc(project.id, 'tasks.json', { version: VERSION, tasks: [] })
    this._writeProjectDoc(project.id, 'assets/manifest.json', { version: VERSION, assets: [] })
    this.cache.set(project.id, {
      project,
      feed: { version: VERSION, events: [] },
      plan: { version: VERSION, items: [] },
      tasks: { version: VERSION, tasks: [] },
      assets: { version: VERSION, assets: [] },
    })
    this._notify(project.id)
    this._markMdDirty(project.id)
    return structuredClone(project)
  }

  updateProject(projectId, patch) {
    const bundle = this._bundle(projectId)
    if (bundle === undefined) return undefined
    bundle.project = { ...bundle.project, ...patch, id: projectId, updatedAt: nowIso() }
    this._writeProjectDoc(projectId, 'project.json', bundle.project)
    this._notify(projectId)
    this._markMdDirty(projectId)
    return structuredClone(bundle.project)
  }

  /** Add (or refresh) a project member. Agents and humans share the shape. */
  addMember(projectId, member) {
    const bundle = this._bundle(projectId)
    if (bundle === undefined) return undefined
    const members = Array.isArray(bundle.project.members) ? [...bundle.project.members] : []
    const index = members.findIndex((m) => m.id === member.id && m.kind === member.kind)
    const normalized = {
      id: String(member.id),
      name: String(member.name ?? member.id),
      kind: member.kind === 'agent' ? 'agent' : 'human',
      joinedAt: member.joinedAt ?? nowIso(),
    }
    if (index >= 0) members[index] = { ...members[index], ...normalized }
    else members.push(normalized)
    bundle.project = { ...bundle.project, members, updatedAt: nowIso() }
    this._writeProjectDoc(projectId, 'project.json', bundle.project)
    this._notify(projectId)
    return structuredClone(bundle.project)
  }

  removeMember(projectId, memberId, kind) {
    const bundle = this._bundle(projectId)
    if (bundle === undefined) return undefined
    const members = (bundle.project.members ?? []).filter((m) => !(m.id === memberId && m.kind === kind))
    bundle.project = { ...bundle.project, members, updatedAt: nowIso() }
    this._writeProjectDoc(projectId, 'project.json', bundle.project)
    this._notify(projectId)
    return structuredClone(bundle.project)
  }

  /** One detached read of every document of one project. */
  snapshot(projectId) {
    const bundle = this._bundle(projectId)
    if (bundle === undefined) return undefined
    return {
      project: structuredClone(bundle.project),
      feed: structuredClone(bundle.feed.events),
      plan: structuredClone(bundle.plan.items),
      tasks: structuredClone(bundle.tasks.tasks),
      assets: structuredClone(bundle.assets.assets),
    }
  }

  // ----------------------------------------------------------------- feed

  appendFeed(projectId, event) {
    const bundle = this._bundle(projectId)
    if (bundle === undefined) return undefined
    const events = bundle.feed.events
    events.push(event)
    const cap = this.config?.feed?.retention ?? 5000
    if (events.length > cap) bundle.feed.events = events.slice(events.length - cap)
    this._writeProjectDoc(projectId, 'feed.json', bundle.feed)
    this._markMdDirty(projectId)
    this._notify(projectId)
    return structuredClone(event)
  }

  readFeed(projectId) {
    const bundle = this._bundle(projectId)
    return bundle === undefined ? [] : structuredClone(bundle.feed.events)
  }

  // ----------------------------------------------------------------- plan

  putPlanItem(projectId, item) {
    const bundle = this._bundle(projectId)
    if (bundle === undefined) return undefined
    // Replace the array rather than mutating in place: a concurrent reader that
    // captured the old array keeps a consistent view.
    const items = bundle.plan.items.filter((i) => i.id !== item.id)
    items.push(item)
    bundle.plan.items = items
    this._writeProjectDoc(projectId, 'plan.json', bundle.plan)
    this._markMdDirty(projectId)
    this._notify(projectId)
    return structuredClone(item)
  }

  readPlan(projectId) {
    const bundle = this._bundle(projectId)
    return bundle === undefined ? [] : structuredClone(bundle.plan.items)
  }

  // ---------------------------------------------------------------- tasks

  putTask(projectId, task) {
    const bundle = this._bundle(projectId)
    if (bundle === undefined) return undefined
    const tasks = bundle.tasks.tasks.filter((t) => t.id !== task.id)
    tasks.push(task)
    bundle.tasks.tasks = tasks
    this._writeProjectDoc(projectId, 'tasks.json', bundle.tasks)
    this._markMdDirty(projectId)
    this._notify(projectId)
    return structuredClone(task)
  }

  readTasks(projectId) {
    const bundle = this._bundle(projectId)
    return bundle === undefined ? [] : structuredClone(bundle.tasks.tasks)
  }

  // --------------------------------------------------------------- assets

  putAsset(projectId, asset) {
    const bundle = this._bundle(projectId)
    if (bundle === undefined) return undefined
    const assets = bundle.assets.assets.filter((a) => a.id !== asset.id)
    assets.push(asset)
    bundle.assets.assets = assets
    this._writeProjectDoc(projectId, 'assets/manifest.json', bundle.assets)
    this._markMdDirty(projectId)
    this._notify(projectId)
    return structuredClone(asset)
  }

  readAssets(projectId) {
    const bundle = this._bundle(projectId)
    return bundle === undefined ? [] : structuredClone(bundle.assets.assets)
  }

  assetBlobPath(projectId, assetId) {
    return path.join(this.projectDir(projectId), 'assets', 'blobs', assetId)
  }

  readAssetBytes(projectId, assetId) {
    const file = this.assetBlobPath(projectId, assetId)
    if (!fileExists(file)) return undefined
    try {
      return readFileSync(file)
    } catch {
      return undefined
    }
  }

  writeAssetBytes(projectId, assetId, buf) {
    const file = this.assetBlobPath(projectId, assetId)
    ensureDir(path.dirname(file))
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, buf)
    renameSync(tmp, file)
  }

  deleteAssetBytes(projectId, assetId) {
    removeFile(this.assetBlobPath(projectId, assetId))
  }

  // ------------------------------------------------------------ team roster

  /**
   * The team roster lives beside the project documents, not inside
   * `project.json`: it changes far more often than project metadata, and an
   * interrupted write here must never be able to corrupt the project record
   * that everything else resolves through.
   */
  readTeam(projectId) {
    return readJsonFile(this._file(projectId, 'team.json'), undefined)
  }

  writeTeam(projectId, team) {
    writeJsonAtomic(this._file(projectId, 'team.json'), team)
    this._markMdDirty(projectId)
    this._notify(projectId)
    return team
  }

  /**
   * Find the project whose team is bound to a given directory.
   *
   * One directory = one collaboration workspace. That mapping is what lets the
   * workbench switch context by directory alone: pick a folder, and the team,
   * plan, feed and assets that belong to it come back with it. Comparison is
   * case- and separator-insensitive because Windows paths are spelled both ways
   * by different callers.
   */
  findProjectByWorkspace(path) {
    const key = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/g, '').toLowerCase()
    if (key === '') return undefined
    for (const project of this.listProjects()) {
      const team = this.readTeam(project.id)
      if (team === undefined || team === null) continue
      const teamKey = String(team.workspace ?? '')
        .replace(/\\/g, '/')
        .replace(/\/+$/g, '')
        .toLowerCase()
      if (teamKey !== '' && teamKey === key) return project.id
    }
    return undefined
  }

  /** Every workspace directory that already hosts a team. */
  listTeamWorkspaces() {
    const out = []
    for (const project of this.listProjects()) {
      const team = this.readTeam(project.id)
      if (team === undefined || team === null || team.initialized !== true) continue
      if (typeof team.workspace !== 'string' || team.workspace === '') continue
      out.push({
        projectId: project.id,
        workspace: team.workspace,
        title: project.title,
        members: Array.isArray(team.members) ? team.members.length : 0,
        leader: (team.members ?? []).find((m) => m.role === 'leader')?.name ?? null,
        updatedAt: team.updatedAt ?? null,
      })
    }
    return out
  }

  // -------------------------------------------------- collaboration requests

  readRequests(projectId) {
    const doc = readJsonFile(this._file(projectId, 'requests.json'), { version: VERSION, requests: [] })
    return Array.isArray(doc.requests) ? doc.requests : []
  }

  writeRequests(projectId, requests) {
    writeJsonAtomic(this._file(projectId, 'requests.json'), {
      version: VERSION,
      requests: Array.isArray(requests) ? requests : [],
    })
    this._markMdDirty(projectId)
    this._notify(projectId)
    return requests
  }

  // ---------------------------------------------------------- checkpoints

  _checkpointFile(projectId, conversationId) {
    return this._file(projectId, path.join('checkpoints', `${conversationId}.json`))
  }  appendCheckpoint(projectId, checkpoint) {
    const file = this._checkpointFile(projectId, checkpoint.conversation_id)
    const doc = readJsonFile(file, { version: VERSION, checkpoints: [] })
    const list = Array.isArray(doc.checkpoints) ? doc.checkpoints : []
    list.push(checkpoint)
    const cap = this.config?.checkpoints?.perConversationRetention ?? 200
    const trimmed = list.length > cap ? list.slice(list.length - cap) : list
    writeJsonAtomic(file, { version: VERSION, checkpoints: trimmed })
    this._markMdDirty(projectId)
    this._notify(projectId)
    return checkpoint
  }

  listCheckpoints(projectId, conversationId, limit = 50) {
    const doc = readJsonFile(this._checkpointFile(projectId, conversationId), { version: VERSION, checkpoints: [] })
    const list = Array.isArray(doc.checkpoints) ? doc.checkpoints : []
    return list.slice(Math.max(0, list.length - limit))
  }

  latestCheckpoint(projectId, conversationId) {
    const list = this.listCheckpoints(projectId, conversationId, 1)
    return list.length === 0 ? undefined : list[list.length - 1]
  }

  // ----------------------------------------------------------- resume state

  _resumeFile(projectId, conversationId) {
    return this._file(projectId, path.join('resume', `${conversationId}.json`))
  }

  getResumeState(projectId, conversationId) {
    const stored = readJsonFile(this._resumeFile(projectId, conversationId), undefined)
    if (stored === undefined || stored === null) return emptyResumeState(conversationId)
    // Tolerate a state written by an older build: fill anything missing.
    const base = emptyResumeState(conversationId, stored.taskId ?? null)
    return {
      ...base,
      ...stored,
      resumeLock: { ...base.resumeLock, ...asRecord(stored.resumeLock) },
      interruptLock: { ...base.interruptLock, ...asRecord(stored.interruptLock) },
      autoResumeWindow: { ...base.autoResumeWindow, ...asRecord(stored.autoResumeWindow) },
    }
  }

  putResumeState(projectId, conversationId, state) {
    writeJsonAtomic(this._resumeFile(projectId, conversationId), { ...state, conversationId })
    this._markMdDirty(projectId)
    this._notify(projectId)
    return state
  }

  listResumeStates(projectId) {
    const dir = this._file(projectId, 'resume')
    const out = []
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        out.push(this.getResumeState(projectId, name.slice(0, -'.json'.length)))
      }
    } catch {
      /* no resume directory yet */
    }
    return out
  }

  // ------------------------------------------------------------- markdown

  _markMdDirty(projectId) {
    this.mdDirty.add(projectId)
  }

  /**
   * Coalesced Markdown refresh.
   *
   * The JSON write already happened; this only decides when to re-render the
   * human-readable projection. A burst of ten tool calls produces one render,
   * which is what keeps a busy project from rewriting four files per event.
   */
  _startMdFlush() {
    const timer = setInterval(() => {
      if (this.mdDirty.size === 0) return
      const ids = [...this.mdDirty]
      this.mdDirty.clear()
      for (const id of ids) {
        try {
          this.refreshMarkdown(id)
        } catch {
          /* a Markdown refresh failure never affects the truth layer */
        }
      }
    }, MD_THROTTLE_MS)
    if (typeof timer.unref === 'function') timer.unref()
    this.mdTimer = timer
  }

  refreshMarkdown(projectId) {
    const bundle = this._bundle(projectId)
    if (bundle === undefined) return
    const mdDir = this._file(projectId, 'md')
    ensureDir(mdDir)
    writeTextAtomic(path.join(mdDir, 'feed.md'), renderFeedMd(bundle))
    writeTextAtomic(path.join(mdDir, 'plan.md'), renderPlanMd(bundle))
    writeTextAtomic(path.join(mdDir, 'assets.md'), renderAssetsMd(bundle))
    const resumeStates = this.listResumeStates(projectId)
    writeTextAtomic(path.join(mdDir, 'resume-history.md'), renderResumeMd(bundle, resumeStates))
  }

  // ---------------------------------------------------------- subscription

  onChange(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  _notify(projectId) {
    for (const listener of this.listeners) {
      try {
        listener(projectId)
      } catch {
        /* a bad listener must not break a mutation */
      }
    }
  }

  dispose() {
    if (this.mdTimer !== undefined) clearInterval(this.mdTimer)
    this.mdTimer = undefined
    this.listeners.clear()
    this.cache.clear()
  }
}

/** Every conversation id that has any task binding or persisted recovery state. */
export function conversationIdsWithState(store, projectId) {
  const ids = new Set()
  for (const state of store.listResumeStates(projectId)) {
    if (state?.conversationId) ids.add(state.conversationId)
  }
  for (const task of store.readTasks(projectId)) {
    if (task?.conversationId) ids.add(task.conversationId)
  }
  return [...ids]
}

export { VERSION as STORE_VERSION }
