# ai-buddy — internal module contract

Every module in `lib/` implements **this** document. It is the single source of
truth for cross-module calls; if an implementation disagrees with it, the
implementation is wrong.

The plugin has three layers:

```
lib/index.js          entry: apply(ctx, config) — wires services, tools, routes
lib/tools/index.js    the 20 Agent tools; the ONLY model-facing surface
lib/web.js            the human workbench HTTP API (same-origin, no auth token)
lib/core/*.js         domain logic, no Cordis imports, plain JS objects
lib/store.js          persistence: JSON truth layer + Markdown summaries
lib/util.js           ids, clock, atomic writes, hashing, path helpers
```

`lib/core/*` and `lib/store.js` must be **importable and runnable without a
Host**: unit tests load them from Node with a temp directory. Nothing under
`lib/core/` may touch `ctx`.

---

## 1. Identifiers

`util.newId(prefix)` returns `"<prefix>_<16 lowercase hex>"`. Prefixes:

| prefix | entity |
|---|---|
| `p` | project |
| `f` | feed event |
| `pl` | plan item |
| `t` | task / conversation |
| `a` | asset |
| `cp` | checkpoint |
| `rs` | resume attempt |

Conversation ids (`conversationId`) are **Host SessionIds** — opaque strings
owned by DSH, never generated here. A task's `conversationId` may be `null`
until a session is bound.

---

## 2. `lib/util.js`

```js
export function newId(prefix)
export function nowIso()                       // new Date().toISOString()
export function sha256(bufOrString): string    // hex
export function slugify(text, fallback): string
export function readJsonFile(path, fallback)   // sync, never throws
export function writeJsonAtomic(path, value)   // sync, tmp+rename, mkdir -p
export function writeTextAtomic(path, text)
export function readTextFile(path, fallback)
export function ensureDir(path)
export function listFilesRecursive(dir): string[]
export function clampMs(ms, min, max)
export function parseSince(value)              // ISO | epoch ms | undefined -> ms
```

Atomic writes are mandatory: a crash must never leave a half-written JSON
truth layer. `writeJsonAtomic` writes `<path>.tmp`, fsyncs, renames.

---

## 3. `lib/config.js`

```js
export const DEFAULT_CONFIG  // mirrors cordis.patch.yml, see lib/config.js
export function resolveConfig(overrides, env): Config
export function dataDirOf(config, env): string
```

`resolveConfig` deep-merges `overrides` over `DEFAULT_CONFIG`, clamps numeric
ranges, and never throws. `dataDirOf` returns
`<DSH_HOME>/ai-buddy` unless `config.dataDir` is set; relative paths resolve
against `DSH_HOME` (`env.DSH_HOME` or `~/.dsh`).

---

## 4. `lib/store.js`

```js
export class Store {
  constructor({ dir, config })
  // projects
  listProjects(): Project[]
  getProject(id): Project | undefined
  createProject({ title, description, createdBy }): Project
  updateProject(id, patch): Project
  // state access — each returns a detached plain-JSON value
  snapshot(projectId): { project, feed, plan, tasks, assets }
  // mutation entry points, each (a) validates, (b) persists atomically,
  // (c) appends the feed/checkpoint events it is told to, (d) schedules the
  // Markdown refresh. They are SYNCHRONOUS.
  appendFeed(projectId, event): FeedEvent
  putPlanItem(projectId, item): PlanItem
  putTask(projectId, task): Task
  putAsset(projectId, asset): Asset
  readAssetBytes(projectId, assetId): Buffer
  writeAssetBytes(projectId, assetId, buf): void
  // checkpoints
  appendCheckpoint(projectId, checkpoint): Checkpoint
  listCheckpoints(projectId, conversationId, limit): Checkpoint[]
  latestCheckpoint(projectId, conversationId): Checkpoint | undefined
  // resume bookkeeping (separate small documents, hot-write path)
  putResumeState(projectId, conversationId, state): ResumeState
  getResumeState(projectId, conversationId): ResumeState
  // markdown
  refreshMarkdown(projectId): void       // idempotent, throttled internally
  // subscription for the web API (server-sent invalidation, not data)
  onChange(listener): () => void
}
```

`Store` serialises all writes for one project through an in-process promise
chain, so two concurrent tool calls cannot interleave a read-modify-write.

**Files on disk** (`<dataDir>/projects/<projectId>/`):

```
project.json          Project
feed.json             { version, events: FeedEvent[] }
plan.json             { version, items: PlanItem[] }
tasks.json            { version, tasks: Task[] }
assets/manifest.json  { version, assets: Asset[] }
assets/blobs/<assetId>            raw bytes
checkpoints/<conversationId>.json { version, checkpoints: Checkpoint[] }
resume/<conversationId>.json      ResumeState
md/feed.md, md/plan.md, md/assets.md, md/resume-history.md
```

---

## 5. Entities

### 5.1 Project

```js
{ id, title, description, createdBy: Actor, createdAt, updatedAt,
  members: [{ id, name, kind: 'agent'|'human', joinedAt }] }
```

### 5.2 FeedEvent (§2.1)

```js
{ id, projectId, at,
  kind: 'member' | 'directed' | 'human' | 'recovery',
  category: FeedCategory,
  source: 'auto' | 'agent' | 'human',
  actor: Actor,                         // { type, id, name }
  content: string,
  taskId?, planItemId?, assetId?,
  targetRefs: string[],
  pinned: boolean,                      // lock events are pinned
  highRisk: boolean,
  meta: object }
```

`FeedCategory` (closed set, validated):

```
member:   agent.join, agent.leave, asset.upload, asset.update,
          task.create, task.handoff, task.archive,
          plan.create, plan.update, plan.status
directed: task.share, task.transfer, execution.handoff
human:    human.instruction, human.priority, human.pause, human.resume,
          human.unlock, human.reply
recovery: resume.start, resume.summary, resume.skip, resume.failure,
          lock.engaged, lock.released
```

`source` distinguishes an **automatic event** (`auto` — the system recorded a
side effect) from **AI 主动发言** (`agent` — the model called
`post_update_to_feed`) and human posts (`human`).

### 5.3 PlanItem (§2.2)

```js
{ id, projectId, title, description, assignee,          // agent name | null
  status: 'pending' | 'in_progress' | 'paused' | 'done' | 'locked_by_interrupt',
  priority: 0 | 1 | 2 | 3,                             // 3 = highest
  dependsOn: string[],                                  // PlanItem ids
  dueAt: string | null,
  taskId: string | null,                                // bound conversation task
  mode: 'pre' | 'live',                                 // 事前计划 / 事中计划
  blockedBy: string[],                                  // upstream ids still open
  createdBy: Actor, createdAt, updatedAt,
  lastNote: string }
```

`blockedBy` is **derived**, recomputed by `lib/core/plan.js#recomputeBlocking`
after any status change: an item is blocked when a `dependsOn` item is not
`done`. `locked_by_interrupt` is set only by the interruption lock (§7.5) and
cleared only by unlock.

### 5.4 Task (§2.3)

```js
{ id, projectId, title, description,
  conversationId: string | null,       // Host SessionId
  workspace: string | null,
  planItemId: string | null,
  ownerAgent: string | null,
  status: 'active' | 'paused' | 'done' | 'archived' | 'locked_by_interrupt',
  executionLock: ExecutionLock,
  resumeLock: ResumeLock,
  interruptLock: InterruptLock,
  createdAt, updatedAt,
  lastCheckpointAt: string | null,
  resumeHistory: ResumeAttempt[] }
```

### 5.5 Asset (§2.4)

```js
{ id, projectId, name, folder, bytes, sha256, version, contentType,
  ownerId: string,                     // agent name or 'human'
  allowedAgents: string[],             // empty = every project member
  highRisk: boolean,
  sourceTaskId: string | null,
  sourceLocked: boolean,               // its originating conversation is locked
  createdAt, updatedAt, deletedAt: string | null }
```

`allowedAgents` is the **agent-level access boundary** (§2.4 权限边界): a
non-empty list means only those agents (plus humans) may read or cite it.

### 5.6 Checkpoint (§6) — exact schema, no extra required fields

```js
{ checkpoint_id, timestamp, trigger_agent, conversation_id,
  event_type: 'handoff' | 'plan_update' | 'asset_write' | 'feed_post'
            | 'status_change' | 'resume_attempt' | 'resume_success'
            | 'resume_failure' | 'lock_engaged' | 'lock_released',
  plan_snapshot_ref, asset_manifest_ref, feed_event_ids: string[],
  context_summary,
  next_expected_actor: string,
  resume_context: {
    last_operation: { type: 'handoff'|'asset_write'|'plan_update'|'feed_post'
                          |'conversation_create',
                      target_ref, 
                      result_status: 'confirmed'|'unconfirmed'|'failed'|'changed_by_other',
                      verified_at },
    cross_module_snapshot: { feed_latest_event_id, plan_item_states: {},
                             asset_version_refs: {}, execution_lock_holder },
    resume_lock_state: { consecutive_failures, last_failure_reason,
                         locked, locked_at, locked_by } } }
```

### 5.7 ResumeState (runtime, per conversation)

```js
{ conversationId, taskId,
  resumeLock: { state: 'idle'|'recovering'|'awaiting_human'|'paused'|'locked',
                holder, since, reason },
  interruptLock: { state: 'unlocked'|'counting'|'locked'|'trial_resume',
                   consecutiveFailures, lastFailureReason, lockedAt, lockedBy,
                   trialResumesUsed, stableSince },
  autoResumeWindow: { startedAt, count },
  lastResumeAt, lastFailureAt, lastSucceededAt }
```

### 5.8 ExecutionLock (§3)

```js
{ holder: string | null, acquiredAt: string | null,
  expiresAt: string | null,
  queue: [{ agent, requestedAt, timeoutAt }] }
```

---

## 6. `lib/core/*.js` — module APIs

All functions take `(store, config)` and plain arguments; none touch `ctx`.

### 6.1 `feed.js`

```js
export function post(store, config, projectId, { actor, content, category,
                     source, taskId, planItemId, assetId, targetRefs, pinned,
                     highRisk }) -> { event, throttled }
export function read(store, config, projectId, { sinceEventId, sinceTime,
                     categories, limit, includePinned }) -> FeedEvent[]
export function summarize(store, projectId, { limit, sinceEventId }) -> string
export function humanInstructions(store, projectId, { since }) -> FeedEvent[]
```

`post` enforces the AI rate limit (`config.feed.aiPostsPerMinute`) **only for
`source: 'agent'`**, returning `{ throttled: true }` with the event still
recorded under an internal `meta.throttled` marker but not surfaced.

### 6.2 `plan.js`

```js
export function create(store, config, projectId, { actor, title, description,
                       assignee, dependsOn, dueAt, mode, taskId, priority })
export function updateStatus(store, config, projectId, { actor, planItemId,
                            newStatus, note, executionHolder })
export function read(store, config, projectId, filter)
export function recomputeBlocking(store, projectId)
export function setLockedByInterrupt(store, projectId, planItemId, locked, reason)
```

`updateStatus` enforces the **plan-level write right** (§3): the actor must be
the current execution holder of the bound task, or a human. Structural changes
(delete / reassign across agents) return
`{ needHumanConfirmation: true, reason }` instead of applying.

### 6.3 `task.js`

```js
export function create(store, config, projectId, { actor, title, description,
                       planItemId, ownerAgent, conversationId, workspace })
export function handoff(store, config, projectId, { actor, taskId,
                        targetAgent, summary, artifacts, unfinished })
export function archive(...)
export function shareReadonly(store, config, projectId, { actor, taskId, targetAgent })
export function reference(store, config, projectId, { actor, sourceTaskId, targetTaskId })
export function read(store, config, projectId, filter)
```

### 6.4 `assets.js`

```js
export function save(store, config, projectId, { actor, name, folder,
                   bytes, contentType, sourceTaskId, allowedAgents, artifactRef })
export function update(store, config, projectId, { actor, assetId, bytes, name })
export function remove(store, config, projectId, { actor, assetId, confirmed })
export function query(store, config, projectId, { query, scope, agent })
export function linkToConversation(store, config, projectId, { actor, assetId, taskId })
export function canRead(store, projectId, asset, agent): boolean
```

A write/overwrite that touches a `highRisk` asset, and any delete, returns
`{ needHumanConfirmation: true }` unless `confirmed === true`.

### 6.5 `locks.js` — execution rights (§3)

```js
export function request(store, config, projectId, { taskId, agent })
export function release(store, config, projectId, { taskId, agent, force })
export function holder(store, projectId, taskId): string | null
export function refresh(store, config, projectId, { taskId, agent })
export function sweep(store, config, projectId): string[]   // released ids
export function canWrite(store, projectId, taskId, actor): boolean
```

FIFO queue; a release hands the lock to `queue[0]` if present; expiry is swept
on every read and by a timer in `index.js`.

### 6.6 `checkpoint.js`

```js
export function build(store, config, projectId, { conversationId, taskId,
                     eventType, triggerAgent, lastOperation, contextSummary,
                     nextExpectedActor, feedEventIds })
export function write(store, config, projectId, spec): Checkpoint
```

`build` fills `cross_module_snapshot` from the live store and
`resume_lock_state` from the resume state, so a checkpoint never lies about the
other three modules.

### 6.7 `resume.js` — §7 (largest module)

```js
// 7.1 running-turn retry
export function classifyFailure(failure): 'dead_end' | 'rate_limit'
                                       | 'transient' | 'interrupted'
export function nextBackoff(config, attempt, providerRetryAfterMs): number

// 7.2 restart resume
export function planResume(store, config, ctx): ResumeCandidate[]
export function brief(store, config, projectId, conversationId): ResumeBrief
export async function injectResume(agent, brief): Promise<void>

// 7.3 idempotency
export function guard(store, config, projectId, conversationId, operationType,
                      targetRef): GuardVerdict
export function verify(store, config, projectId, { operationType, targetRef })

// 7.4 mutual exclusion
export function acquireResumeLock(store, projectId, conversationId, holder)
export function releaseResumeLock(store, projectId, conversationId, holder)

// 7.5 unexpected-interruption lock
export function recordResumeAttempt(store, config, projectId, conversationId,
                                    { attemptId, outcome, failure })
export function recordStable(store, config, projectId, conversationId)
export function engageLock(store, config, projectId, conversationId, reason)
export function releaseLock(store, config, projectId, conversationId,
                            by, { resetCounter, trial })
export function lockStatus(store, projectId, conversationId)
```

**GuardVerdict** (§7.3 matrix):

```js
{ action: 'skip' | 'retry' | 'verify_first' | 'request_human',
  reason, detail, evidence }
```

The verdict matrix is a **pure function** of
`(operationType, resultStatus)`; it lives in `resume.js` as
`GUARD_MATRIX` and is exported for tests and for the design document.

### 6.8 `prompts.js`

```js
export function resumeMessage(brief): string   // the injected 继续 message
export function sectionBody(config): string    // system prompt section
```

The resume message **must** carry the cross-module verification requirements,
never a bare "continue". This is the §7.2 contract, enforced by tests on the
rendered string.

---

## 7. `lib/web.js` — the workbench API

Registered on `ctx.webServer` under prefix `/ai-buddy`. Everything is
same-origin; there is no separate auth token (the Host's own connection gate
already admits the page).

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/ai-buddy/` | — | the workbench HTML shell |
| GET | `/ai-buddy/api/state` | `?project=` | `{ projects, project, feed, plan, tasks, assets, resume, config }` |
| POST | `/ai-buddy/api/feed` | `{ projectId, content, category?, taskId? }` | `{ event }` |
| POST | `/ai-buddy/api/plan` | `{ projectId, op: 'create'\|'status'\|'priority'\|'assign'\|'delete', ... }` | `{ item \| items }` |
| POST | `/ai-buddy/api/task` | `{ projectId, op: 'create'\|'unlock'\|'archive'\|'release' }` | `{ task }` |
| POST | `/ai-buddy/api/asset` | multipart or `{ projectId, op, ... }` | `{ asset \| assets }` |
| POST | `/ai-buddy/api/config` | partial config | `{ config }` |
| GET | `/ai-buddy/api/events` | `?project=` | SSE invalidation stream |

Every human mutation writes a feed event (the §4 requirement that human actions
are visible to the AIs) **and** the response echoes the resulting state slice.

---

## 8. `lib/tools/index.js`

```js
export function registerTools(ctx, deps): () => void
```

`deps` is supplied by `index.js`:

```js
{ store, config, projectIdFor(agent), actorFor(agent), services: { agents,
  agentLoop, tools, workingDirectory }, log }
```

`projectIdFor(agent)` resolves the project a conversation belongs to (from its
task binding) and falls back to the single default project. Every tool is a
`ctx.tools.register({ name, description, parameters, output, execute })`
definition. Tools return **bounded** results (ids + a short summary) and point
at a follow-up read tool for full detail, per the agent-experience guidance.

The complete tool list is fixed; see `lib/tools/index.js` header.

---

## 9. `client.js`

A `window.__ModuleLoader__.load` module that registers:
- `sidebar.panellist` entry `ai-buddy` (icon + label thunk);
- `main` keyed entry `ai-buddy` — the five-panel workbench.

It talks to the host through the `/ai-buddy/api/*` routes above. It must:
- use only `--dsw-alias-*` theme tokens;
- route every visible string through `ctx.locale` under ns `ai-buddy`;
- register all listeners/timers inside `ctx.effect`;
- never touch `document.body` or another plugin's DOM.

---

## 10. Invariants enforced by tests (`test/`)

1. A checkpoint's `resume_context.cross_module_snapshot` matches the live store
   at build time.
2. `resumeMessage()` always contains the five cross-module verification items
   and never contains a bare "继续" instruction without them.
3. The guard matrix returns `skip` for `confirmed`, `verify_first` for
   `unconfirmed`, `retry` for `failed`, `request_human` for
   `changed_by_other`.
4. Three consecutive `rejected` outcomes with a server rejection on the last one
   engage the interruption lock; two do not.
5. Once locked, `acquireResumeLock` refuses and `planResume` omits the
   conversation.
6. A stable window, or a human unlock, resets `consecutiveFailures` to 0.
7. Two concurrent `requestExecutionLock` calls leave exactly one holder and one
   queue entry.
8. An agent cannot read an asset outside its `allowedAgents`.
