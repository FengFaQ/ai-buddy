/**
 * Assets (§2.4): the bytes a conversation produces and the boundary that decides
 * who else may read them.
 *
 * Two things here are policy, not plumbing:
 *
 * 1. **The metadata is the truth; the blob is a sidecar.** The manifest entry is
 *    what `query`/`canRead` filter on, so the access boundary is enforced even
 *    when the blob is missing (a half-restored backup must not become a leak).
 *
 * 2. **`allowedAgents` is a read boundary, not a write boundary.** A non-empty
 *    list means only those agents (plus humans) can read or cite the asset. The
 *    owner can always update and delete its own asset — it must not need to
 *    grant itself read access to do so.
 *
 * High-risk is *derived from the name* on every write (`config.assets.highRiskGlobs`)
 * rather than stored as a caller-supplied flag: the classifier exists so a model
 * cannot talk itself out of the gate, and re-deriving means a config change takes
 * effect on the next write instead of leaving stale flags in the manifest.
 *
 * Overwriting a high-risk asset and deleting anything are the two irreversible
 * actions a conversation can take on shared knowledge, so both return
 * `{ needHumanConfirmation: true }` until a human passes `confirmed: true`.
 * Overwriting a *normal* asset is allowed: otherwise a conversation could never
 * revise its own draft without a human in the loop.
 */

import {
  newId, nowIso, sha256, asRecord, asStringArray, isNonEmptyString,
  matchesAnyGlob,
} from '../util.js'

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

// --------------------------------------------------------------- internals

function requireProject(store, projectId) {
  if (!isNonEmptyString(projectId)) {
    throw new Error('ai-buddy assets: a non-empty projectId is required')
  }
  const project = store.getProject(projectId)
  if (project === undefined) {
    throw new Error(`ai-buddy assets: unknown project "${projectId}"`)
  }
  return project
}

function requireActor(actor) {
  if (typeof actor === 'string' && actor.trim() !== '') {
    const id = actor.trim()
    return { type: id === 'human' ? 'human' : 'agent', id, name: id }
  }
  const rec = asRecord(actor)
  const id = isNonEmptyString(rec.id) ? rec.id : (isNonEmptyString(rec.name) ? rec.name : '')
  if (id === '') {
    throw new Error('ai-buddy assets: an actor with a non-empty id or name is required')
  }
  const type = rec.type === 'human' || rec.id === 'human' ? 'human' : 'agent'
  return { type, id, name: isNonEmptyString(rec.name) ? rec.name : id }
}

function isHumanActor(actor) {
  if (typeof actor === 'string') return actor === 'human'
  const rec = asRecord(actor)
  return rec.type === 'human' || rec.id === 'human'
}

function agentIdOf(agent) {
  if (typeof agent === 'string') return agent
  const rec = asRecord(agent)
  if (isNonEmptyString(rec.id)) return rec.id
  return isNonEmptyString(rec.name) ? rec.name : ''
}

/** `bytes` may be a Buffer, a Uint8Array or a string (UTF-8) from a tool call. */
function toBuffer(bytes) {
  if (bytes === undefined || bytes === null) return Buffer.alloc(0)
  if (Buffer.isBuffer(bytes)) return bytes
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (typeof bytes === 'string') return Buffer.from(bytes, 'utf8')
  throw new Error('ai-buddy assets: bytes must be a Buffer, Uint8Array or string')
}

/**
 * The path the globs are matched against: `<folder>/<name>`.
 *
 * The shipped patterns are path-shaped (`**​/预算*`), so a bare `name` would
 * never match them. The bare name is tried as well so a project can configure a
 * flat pattern like `*.final.*` and get the expected result.
 */
function globCandidates(name, folder) {
  const normalizedFolder = `/${String(folder ?? '').replace(/^\/+|\/+$/g, '')}`
  const base = normalizedFolder === '/' ? '' : normalizedFolder
  return [`${base}/${name}`, name]
}

export function computeHighRisk(config, name, folder) {
  const globs = config?.assets?.highRiskGlobs
  if (!Array.isArray(globs) || globs.length === 0) return false
  return globCandidates(name, folder).some((candidate) => matchesAnyGlob(candidate, globs))
}

function normalizeAsset(raw) {
  const a = asRecord(raw)
  return {
    id: String(a.id ?? ''),
    projectId: String(a.projectId ?? ''),
    name: String(a.name ?? ''),
    folder: typeof a.folder === 'string' ? a.folder : '',
    bytes: Number.isFinite(Number(a.bytes)) ? Number(a.bytes) : 0,
    sha256: typeof a.sha256 === 'string' ? a.sha256 : '',
    version: Number.isFinite(Number(a.version)) && Number(a.version) > 0
      ? Math.floor(Number(a.version))
      : 1,
    contentType: typeof a.contentType === 'string' ? a.contentType : 'application/octet-stream',
    ownerId: typeof a.ownerId === 'string' ? a.ownerId : 'human',
    allowedAgents: asStringArray(a.allowedAgents),
    highRisk: a.highRisk === true,
    sourceTaskId: isNonEmptyString(a.sourceTaskId) ? a.sourceTaskId : null,
    sourceLocked: a.sourceLocked === true,
    createdAt: typeof a.createdAt === 'string' ? a.createdAt : nowIso(),
    updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : nowIso(),
    deletedAt: typeof a.deletedAt === 'string' ? a.deletedAt : null,
    // A carried reference from the caller (a plan item, a task artifact id, a
    // URL) — kept opaque on purpose: this module never interprets it.
    artifactRef: a.artifactRef ?? null,
    // Overwritten versions, newest last; `version` alone cannot tell a resumed
    // conversation which bytes it last read.
    history: Array.isArray(a.history) ? a.history : [],
  }
}

/**
 * Live assets only.
 *
 * A deleted asset is a tombstone in the manifest so that the references other
 * modules already hold do not dangle; every read path starts here.
 */
function liveAssets(store, projectId) {
  return store.readAssets(projectId).map(normalizeAsset).filter((asset) => asset.deletedAt === null)
}

function readAsset(store, projectId, assetId) {
  const stored = store.readAssets(projectId).map(normalizeAsset).find((a) => a.id === assetId)
  if (stored === undefined) {
    throw new Error(`ai-buddy assets: unknown asset "${assetId}" in project "${projectId}"`)
  }
  return stored
}

function saveAsset(store, projectId, asset) {
  const saved = store.putAsset(projectId, asset)
  return normalizeAsset(saved ?? asset)
}

function maxBytes(config) {
  const value = Number(config?.assets?.maxAssetBytes)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_BYTES
}

/** An asset from a locked or archived conversation is flagged, never silently trusted. */
function lockedTaskIds(store, projectId) {
  const ids = new Set()
  for (const task of store.readTasks(projectId)) {
    if (task?.status === 'locked_by_interrupt' || task?.status === 'archived') {
      if (typeof task.id === 'string') ids.add(task.id)
    }
  }
  return ids
}

// ---------------------------------------------------------------- permissions

/**
 * The single read predicate (§2.4 权限边界), used by `query` and by the tools
 * that hand asset content to a model.
 *
 * Humans always read. An empty `allowedAgents` means the whole project. A
 * non-empty list admits exactly its members plus the asset's owner — the owner
 * wrote those bytes and cannot be locked out of its own work by its own list.
 */
export function canRead(store, projectId, asset, agent) {
  requireProject(store, projectId)
  const entry = normalizeAsset(asset)
  if (isHumanActor(agent)) return true
  const agentId = agentIdOf(agent)
  if (agentId === '') return false
  if (entry.ownerId === agentId) return true
  if (entry.allowedAgents.length === 0) return true
  return entry.allowedAgents.includes(agentId)
}

function assertCanWrite(entry, actor) {
  if (isHumanActor(actor)) return
  if (entry.ownerId !== actor.id) {
    throw new Error(
      `ai-buddy assets: only the owner ("${entry.ownerId}") or a human may change `
        + `asset "${entry.name}"`,
    )
  }
}

// ------------------------------------------------------------------- writes

/**
 * Store new bytes as a new asset (or a new version when `replaceAssetId` names a
 * live one — the tool surface uses `update` for that, this parameter exists for
 * the import path).
 *
 * @returns {{ asset: object, feed: object }}
 */
export function save(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)
  const actor = requireActor(opts.actor)

  const name = isNonEmptyString(opts.name) ? opts.name.trim() : ''
  if (name === '') {
    throw new Error('ai-buddy assets: an asset needs a non-empty name')
  }
  const folder = typeof opts.folder === 'string' ? opts.folder.trim() : ''
  const buf = toBuffer(opts.bytes)
  const limit = maxBytes(config)
  if (buf.length > limit) {
    throw new Error(
      `ai-buddy assets: "${name}" is ${buf.length} bytes, over the configured `
        + `config.assets.maxAssetBytes limit (${limit})`,
    )
  }

  const allowedAgents = asStringArray(opts.allowedAgents)
  const sourceTaskId = isNonEmptyString(opts.sourceTaskId) ? opts.sourceTaskId : null
  const sourceLocked = sourceTaskId !== null && lockedTaskIds(store, projectId).has(sourceTaskId)

  const at = nowIso()
  const asset = normalizeAsset({
    id: newId('a'),
    projectId,
    name,
    folder,
    bytes: buf.length,
    sha256: sha256(buf),
    version: 1,
    contentType: typeof opts.contentType === 'string' && opts.contentType !== ''
      ? opts.contentType
      : 'application/octet-stream',
    ownerId: actor.id,
    allowedAgents,
    highRisk: computeHighRisk(config, name, folder),
    sourceTaskId,
    sourceLocked,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    artifactRef: opts.artifactRef ?? null,
    history: [],
  })

  // Bytes first: a manifest entry pointing at no blob would make every later
  // read fail in a way that looks like corruption rather than a partial write.
  store.writeAssetBytes(projectId, asset.id, buf)
  const saved = saveAsset(store, projectId, asset)

  return {
    asset: saved,
    feed: {
      category: 'asset.upload',
      source: 'auto',
      actor,
      content: `上传资产「${saved.name}」v${saved.version}（${saved.bytes} 字节）`
        + (saved.highRisk ? '［高风险］' : ''),
      assetId: saved.id,
      taskId: saved.sourceTaskId,
      targetRefs: [saved.id, ...saved.allowedAgents],
      highRisk: saved.highRisk,
    },
  }
}

/**
 * Overwrite an asset's bytes (and optionally rename it), bumping `version`.
 *
 * @returns {{ asset, feed }} or `{ needHumanConfirmation: true, reason, asset }`
 */
export function update(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)
  const actor = requireActor(opts.actor)

  const assetId = isNonEmptyString(opts.assetId) ? opts.assetId : ''
  if (assetId === '') throw new Error('ai-buddy assets: update needs an assetId')
  const entry = readAsset(store, projectId, assetId)
  if (entry.deletedAt !== null) {
    throw new Error(`ai-buddy assets: asset "${assetId}" was deleted`)
  }
  assertCanWrite(entry, actor)

  const name = isNonEmptyString(opts.name) ? opts.name.trim() : entry.name
  const folder = typeof opts.folder === 'string' ? opts.folder.trim() : entry.folder
  // Re-derive rather than trusting the stored flag: a rename into a high-risk
  // path must escalate, and a rename out of one must not stay gated forever.
  const highRisk = computeHighRisk(config, name, folder)

  if ((entry.highRisk || highRisk) && opts.confirmed !== true) {
    return {
      needHumanConfirmation: true,
      reason: `"${name}" is a high-risk asset (${(config?.assets?.highRiskGlobs ?? []).join(', ')}); `
        + 'overwriting it needs a human confirmation. Re-call with confirmed: true after the '
        + 'human approves.',
      asset: entry,
    }
  }

  const buf = opts.bytes === undefined ? store.readAssetBytes(projectId, assetId) : toBuffer(opts.bytes)
  if (buf === undefined) {
    throw new Error(
      `ai-buddy assets: the stored bytes of "${entry.name}" are missing; re-save it instead `
        + 'of updating it',
    )
  }
  const limit = maxBytes(config)
  if (buf.length > limit) {
    throw new Error(
      `ai-buddy assets: "${name}" is ${buf.length} bytes, over the configured `
        + `config.assets.maxAssetBytes limit (${limit})`,
    )
  }

  const at = nowIso()
  const history = [
    ...entry.history,
    {
      version: entry.version,
      sha256: entry.sha256,
      bytes: entry.bytes,
      replacedAt: at,
      by: actor.id,
    },
  ].slice(-20)

  const next = {
    ...entry,
    name,
    folder,
    sha256: sha256(buf),
    bytes: buf.length,
    version: entry.version + 1,
    highRisk,
    contentType: typeof opts.contentType === 'string' && opts.contentType !== ''
      ? opts.contentType
      : entry.contentType,
    allowedAgents: opts.allowedAgents === undefined
      ? entry.allowedAgents
      : asStringArray(opts.allowedAgents),
    updatedAt: at,
    history,
  }

  store.writeAssetBytes(projectId, assetId, buf)
  const saved = saveAsset(store, projectId, next)

  return {
    asset: saved,
    feed: {
      category: 'asset.update',
      source: 'auto',
      actor,
      content: `更新资产「${saved.name}」至 v${saved.version}（${saved.bytes} 字节）`
        + (saved.highRisk ? '［高风险］' : ''),
      assetId: saved.id,
      taskId: saved.sourceTaskId,
      targetRefs: [saved.id],
      highRisk: saved.highRisk,
    },
  }
}

/**
 * Soft-delete an asset. Any delete needs a human (§2.4): the other conversations
 * cannot tell a wrong deletion from a lost file.
 *
 * @returns {{ asset, feed, needHumanConfirmation? }}
 */
export function remove(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)
  const actor = requireActor(opts.actor)

  const assetId = isNonEmptyString(opts.assetId) ? opts.assetId : ''
  if (assetId === '') throw new Error('ai-buddy assets: remove needs an assetId')
  const entry = readAsset(store, projectId, assetId)
  if (entry.deletedAt !== null) {
    return { asset: entry, feed: null, alreadyDeleted: true, needHumanConfirmation: false }
  }
  assertCanWrite(entry, actor)

  if (opts.confirmed !== true) {
    return {
      needHumanConfirmation: true,
      reason: `Deleting "${entry.name}" removes bytes other conversations may cite; `
        + 'it needs a human confirmation. Re-call with confirmed: true after the human approves.',
      asset: entry,
    }
  }

  const at = nowIso()
  // The blob goes away, the manifest entry stays: the id keeps resolving to a
  // tombstone, so a plan item or checkpoint that cites it still renders.
  store.deleteAssetBytes(projectId, assetId)
  const saved = saveAsset(store, projectId, {
    ...entry,
    bytes: 0,
    deletedAt: at,
    updatedAt: at,
  })

  return {
    asset: saved,
    feed: {
      category: 'asset.update',
      source: 'auto',
      actor,
      content: `删除资产「${entry.name}」`,
      assetId: entry.id,
      taskId: entry.sourceTaskId,
      targetRefs: [entry.id],
      highRisk: entry.highRisk,
    },
    needHumanConfirmation: false,
  }
}

/**
 * Point an asset at the conversation that produced or is consuming it.
 *
 * `sourceLocked` is recomputed here because it is a *derived* warning shown in
 * the workbench: an asset whose originating conversation is frozen must look
 * frozen too, or a human will trust bytes nobody can revise.
 */
export function linkToConversation(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)
  const actor = requireActor(opts.actor)

  const assetId = isNonEmptyString(opts.assetId) ? opts.assetId : ''
  if (assetId === '') throw new Error('ai-buddy assets: linkToConversation needs an assetId')
  const taskId = isNonEmptyString(opts.taskId) ? opts.taskId : ''
  if (taskId === '') throw new Error('ai-buddy assets: linkToConversation needs a taskId')

  const entry = readAsset(store, projectId, assetId)
  if (entry.deletedAt !== null) {
    throw new Error(`ai-buddy assets: asset "${assetId}" was deleted`)
  }
  const task = store.readTasks(projectId).find((t) => t.id === taskId)
  if (task === undefined) {
    throw new Error(`ai-buddy assets: unknown task "${taskId}" in project "${projectId}"`)
  }
  // Linking is a visibility statement, so it is held to the read boundary: an
  // agent cannot attach an asset to a conversation it could not cite.
  if (!canRead(store, projectId, entry, actor)) {
    throw new Error(
      `ai-buddy assets: "${actor.id}" may not cite "${entry.name}" — it is outside the `
        + `asset's allowedAgents (${entry.allowedAgents.join(', ')})`,
    )
  }

  const locked = task.status === 'locked_by_interrupt' || task.status === 'archived'
  const saved = saveAsset(store, projectId, {
    ...entry,
    sourceTaskId: taskId,
    sourceLocked: locked,
    updatedAt: nowIso(),
  })

  return {
    asset: saved,
    feed: {
      category: 'asset.update',
      source: 'auto',
      actor,
      content: `资产「${saved.name}」关联到任务「${String(task.title ?? taskId)}」`,
      assetId: saved.id,
      taskId,
      targetRefs: [saved.id, taskId],
      highRisk: saved.highRisk,
    },
  }
}

// -------------------------------------------------------------------- reads

/**
 * Query the manifest, filtered by the caller's read boundary.
 *
 * `scope` is one of:
 *   - `readable` (default): only assets `agent` may cite;
 *   - `all`: the whole live manifest — for the human workbench, which must see
 *     the assets it is deciding about;
 *   - `mine`: assets this agent owns;
 *   - `shared`: assets restricted *to* this agent (an explicit grant list).
 */
export function query(store, config, projectId, args = {}) {
  const opts = asRecord(args)
  requireProject(store, projectId)

  const text = isNonEmptyString(opts.query) ? opts.query.trim().toLowerCase() : ''
  const scope = isNonEmptyString(opts.scope) ? opts.scope : 'readable'
  const agent = opts.agent
  const agentId = agentIdOf(agent)

  let assets = liveAssets(store, projectId)

  if (isNonEmptyString(opts.folder)) {
    assets = assets.filter((asset) => asset.folder === opts.folder)
  }
  if (isNonEmptyString(opts.taskId)) {
    assets = assets.filter((asset) => asset.sourceTaskId === opts.taskId)
  }
  if (opts.highRisk === true) assets = assets.filter((asset) => asset.highRisk)
  if (text !== '') {
    assets = assets.filter((asset) => (
      asset.name.toLowerCase().includes(text)
      || asset.folder.toLowerCase().includes(text)
      || String(asset.artifactRef ?? '').toLowerCase().includes(text)
    ))
  }

  switch (scope) {
    case 'all':
      break
    case 'mine':
      assets = assets.filter((asset) => asset.ownerId === agentId)
      break
    case 'shared':
      assets = assets.filter((asset) => asset.allowedAgents.length > 0
        && asset.allowedAgents.includes(agentId))
      break
    case 'readable':
      assets = assets.filter((asset) => canRead(store, projectId, asset, agent))
      break
    default:
      throw new Error(
        `ai-buddy assets: unknown scope "${scope}". Valid scopes: all, readable, mine, shared`,
      )
  }

  const limit = Number(opts.limit)
  if (Number.isFinite(limit) && limit > 0) assets = assets.slice(0, Math.floor(limit))
  return assets
}
