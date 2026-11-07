# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 阶段六 — 与官方子智能体体系的适配

**Fixed — `interrupt_agent` reported "not found" for a Chinese member name.**

The Host's own `interrupt_agent` — registered by `@deepseek-ai/dsh-tool-subagent-control`, and in other profiles by the experimental agent-team plugin — only accepts targets its *own* subsystem returned: a session id from `list_agents`, or a teammate target from `spawn_teammate`. ai-buddy members are named in the roster (`小算`), and neither registry knows them, so the model's natural call died with `not found`.

The two systems were invisible to each other, and nothing told the model where the boundary was.

- **Added** `interrupt_member` — interrupts a team member's current turn **by roster name**. The turn stops at its next step boundary with the pending inbox preserved; the member stays online. Leader-only, like the other authority-bearing team tools. Unknown names fail with the actual roster listed, so the caller can recover without a second round trip.
- **Added** `teamRuntime.interrupt(projectId, memberName, reason)` — resolves the name through the roster and drives the same Host machinery `dispose` uses, but stops the *work* rather than releasing the seat.
- **Clarified** the descriptions of `send_message_to_member`, `interrupt_member` and `list_team`: they now say explicitly that they act on the ai-buddy roster (names from `list_team`) and that the Host's `send_message` / `interrupt_agent` / `list_agents` belong to the *other* system — the subagents you spawned inside your own conversation.
- **Updated** the leader and member bootstrap prompts with a 「两套协作体系，不要混用」 section: roster members use the `*_member` / `*_team` tools; your own spawned subagents use `list_agents` / `send_message` / `interrupt_agent`. The decision rule: a target with a role and reporting line is a team member; a target you spawned this conversation is a subagent.

The tool is deliberately **not** named `interrupt_agent` — a second tool of that name would collide at registration, and the model could not have told which one to call. The boundary is drawn by vocabulary, on both sides.

**Added** 4 assertions in `test/identity.mjs` pinning the tool's existence, its leader-only rule, the Chinese-name resolution, and the unknown-name error listing the roster.

### 阶段五 — 实测修复（团队 7-bug 报告）

A real team ran real work on this plugin and filed seven bugs. All seven were
reproduced in code and fixed; the ones that made the team unable to work are
one causal chain.

**Fixed — every agent resolved to the actor name `agent-session-`.**
BUG-1, the root of the chain. `actorFor`'s fallback sliced the session id to
8 characters, and a session id that starts with `session-` slices to exactly
`"session-"` — so the composed name was `agent-session-` for the leader and
every member alike. `plan.updateStatus` compares the actor against the
execution-lock holder, so no member could mark its own plan item in progress:
the team could not self-organise at all.

The real defect was an unwalked identity path: a team member's session is
bound to its seat through the **roster** (`team.bindSession`), not through
`task.conversationId`, so resolving by task ownership alone could never find
a member. `actorFor` now checks the roster first, then the bound task, and
falls back to the session id **verbatim** — a fallback that mangles the only
durable identity the caller has is worse than none.

**Fixed — a member that did not know its task id could not take the
execution right (BUG-2) and `link_asset_to_conversation` failed the same way
(BUG-7).** One root: task resolution only followed `task.conversationId`.
A shared `resolveTaskId` now tries an explicit id, then the bound task, then
the caller's own open task by owner name — and when nothing resolves, the
error **lists the active tasks and their owners** instead of telling the
caller to pass an id it has no way to know.

**Fixed — `create_conversation` did not grant the execution right it
promised (BUG-3).** The tool description said 「创建后你会获得该任务的执行权」;
the code never took it. An owner without the right could not even mark its
own item in progress. The tool now requests the right for the owner at
creation time and reports honestly when someone else already holds it.

**Fixed — the coordinator re-delivered an unchanged report every 30 seconds
(BUG-4).** With a stuck state — a blocked plan item nobody can fix — the
watch sent the same findings to the leader 11+ times, each one a real model
turn. `reportToLeader` now records the signature of what it delivered and
sends again only when the findings differ. A finding that persists silently
is correct: the human sees it in the workbench panels, and the leader already
has it in context.

**Fixed — `read_feed` truncated every event to 160 characters (BUG-5).** A
leader's adjudication arrived as its first line, and members had to ask for a
resend. The feed is the team's only shared channel; clipping it there clips
the collaboration. The tool now returns full content (bounded at 4000
characters against one pathological post) and the render indents it under
each header instead of gluing it to one line.

**Fixed — `@mentions` rendered with a doubled prefix (BUG-6).**
`send_message_to_member` unconditionally prefixed `@name`, but agents
routinely write the mention into their own content — producing
`@系统守护 @系统守护 …`. The prefix is now added only when the content does
not already carry it.

**Added** `test/identity.mjs` — 10 assertions driving the real tool layer
with Host-style session ids, pinning the identity resolution order, the
task-resolution fallbacks, the actionable error, the suppression signature,
and the untruncated feed.

### 阶段四 — 宿主进程安全（Host process safety）

Two crashes of the DSH host process were traced to this plugin and fixed. The
full analysis, with the evidence from the host's own sources, is in
[`DESIGN.md` §13](DESIGN.md).

**Fixed — a message without an `id` could end the host process.**
The host keys its durable inbox by `message.id`. A message without one made
the host throw `message "undefined" is already pending` from *inside* the
agent loop — past any handler a plugin could install — and Node escalated it
to an uncaught exception. A second, quieter failure wrote an unidentified
`user/message` into the session log, which the host's session validator
rejects on the next load (`session event at seq N lacks an identified
message`), leaving the whole session unreadable.

- **Added** `lib/core/messages.js` — the single place that creates a message
  or hands one to the host. Every message carries a UUID v4 identity, the
  exact shape the host's session validator requires, and the `user` source
  kind in its closed form (`{ kind: 'user' }`).
- **Added** `MessageLedger` — a per-conversation record of delivered
  identities, so a repeated id is impossible by construction rather than
  merely improbable.
- **Added** `deliver()` — delivery that never throws. A host refusal becomes
  `delivered: false`, not an exception.
- **Changed** the transport: an idle member is followed up (a turn is
  opened), a busy member is *steered* (the turn in progress is cut into)
  instead of being given a competing second turn. This follows the rule
  `dsh-connect-workbuddy` already uses.

**Fixed — an un-awaited `injectResume()` turned any failure into a host
exit.**
The surrounding `try/catch` could only see a *synchronous* throw; the
rejection of the un-awaited promise became an unhandled rejection, which
Node escalates to an uncaught exception. The call site now awaits, and the
recovery sweep is `async` with its timer callback closing the rejection.

**Fixed — enabling the plugin opened nine AI conversations.**
Reconciling roster seats after activation is right in principle, but it must
not happen by default: a session is a real, billable conversation.

- **Added** `team.autoSpawn` (default `false`) — rebuild sessions for seats
  that lost their live agent.
- **Added** `team.autoWakeMentions` (default `false`) — let the leader's
  watch re-deliver a human `@mention` to a member that was not running.
- **Changed** the leader's watch reports to a leader that already has a live
  agent, so a background pass can never open a conversation.

**Fixed — a team whose working directory did not exist never produced a
reply.** The session was created and the bootstrap prompt delivered, but the
first turn died with `working-directory: directory does not exist`. The
directory is now created before the workspace is registered.

**Fixed — releasing the execution right never actually released it.**
`locks.release()` computed the release but did not persist it: `reconcile()`
only writes when *it* changed something, and it sees no change when the queue
is empty — the caller already cleared the holder and there is nobody to
promote. So the release was computed and then silently dropped, and the task
still named its old holder on disk.

Both paths were affected, and one of them is the ordinary one: a member
releasing its own right when it finished. In practice the feature had never
worked — a member kept the right for the rest of its 30-minute lease while
everybody else queued behind a member that was no longer there.

The earlier test suite did not notice because it took a lock, released it, and
then went on assuming it still held it — the release was a no-op, which is
what let the later steps pass. The test was passing *because of* the bug.

- **Fixed** both release paths in `lib/core/locks.js` to write the release
  themselves instead of relying on `reconcile` to persist it.
- **Added** `teamRuntime.releaseHeldRights()` — a released member must not
  keep blocking its team, so `dispose` and `sleep` release the rights the
  member held, promoting the next in the FIFO queue in the same write.
- **Added** `POST /ai-buddy/api/task` with `op: 'take'`. The workbench could
  always *release* an execution right but never take one, so a human watching
  a task nobody had claimed had no way to act on it.
- **Added** `test/rights.mjs`. The fix was verified by reverting it and
  confirming the suite fails: a regression test that passes against the
  broken code is worse than no test.

**Fixed — a team could not be taken down.** `sleep` parks a member that waits
for a human and keeps its seat resumable, and it refuses the leader — "the
leader must stay awake to coordinate". That refusal is right for a human's
decision, but it left no teardown path at all: `remove_member` only edits the
roster without releasing the agent, and `sleep` cannot reach the leader. A
finished team — or a test run — kept its agent alive, holding an open session
log; deleting that log later made the running agent fail with `ENOENT`.

- **Added** `teamRuntime.dispose(projectId, memberName, reason)` — releases
  any member's agent, the leader included, and only reports `dormant` after
  the agent is confirmed gone.
- **Added** `POST /ai-buddy/api/team` with `op: 'dispose'`.
- The end-to-end suite now releases the agent it creates, so it no longer
  leaves a background process holding a session log.

### Tests

254 assertions across eight suites. `npm test` runs the 247 offline ones;
`npm run test:live` adds 7 end-to-end assertions against a running host that
drive a real model turn. The suites live in `test/` and resolve the plugin
root from their own location, so they work in any checkout.

### 阶段三 — 团队与任务图

- **Added** the leader as a *role*: it introduces members, interfaces with
  humans, reviews member efficiency, and decides whether a task goes to an
  existing member or a new one — without executing tasks itself.
- **Added** the coordinator seat (`调度`): a sub-agent that watches the plan,
  the discussion and the task list, reports problems promptly, and takes over
  waiting-type commands.
- **Added** the task graph: plan items carry a `parentId` lineage, distinct
  from `dependsOn`, rendered as a mind map beside the board.
- **Added** the setup page (OOBE): workspace, leader model, member model, and
  the human's own brief — appended *after* the leader's built-in brief, not
  replacing it.
- **Fixed** `dormant` was a lie: it claimed a member was asleep while its
  agent kept running. The seat is now only marked `dormant` after the agent
  is confirmed gone.

### 阶段二 — 团队子系统

- **Added** seven team tools (`send_message_to_member`,
  `await_human_reply`, `request_teammate`, `approve_request`, `remove_member`,
  `review_member`, `list_team`).
- **Added** human-readable member names and inline `@mention` autocomplete.
- **Fixed** a tool returning `null` made DSH reject its registration, so the
  tools silently vanished from the model's tool list.

### 阶段一 — 四大模块

- **Added** the four modules — 动态 (feed), 计划 (plan), 任务 (task),
  资产 (assets) — over a shared execution-rights model.
- **Added** the three locks: conversation execution right, plan write right,
  asset write right, plus the separate resume lock and the
  unexpected-interruption lock.
- **Added** the recovery subsystem: checkpoints, the idempotency guard
  matrix, the resume brief, and the unexpected-interruption lock with its
  trial-resume and human-unlock paths.
- **Added** 20 agent-facing tools.

### Notes for future work

- The plugin cannot import `@deepseek-ai/dsh-llm`'s `createUserMessage`:
  the host packages live inside the application bundle and a profile plugin
  cannot resolve them, and no host service exposes a message factory. The
  message shape is therefore replicated — precisely, and deliberately.
- `lib/core/` must stay importable without the host. That is why the message
  layer lives there rather than in `lib/host/`.

[Unreleased]: https://github.com/FengFaQ/ai-buddy/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/FengFaQ/ai-buddy/releases/tag/v1.0.0
