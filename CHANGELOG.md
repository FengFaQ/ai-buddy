# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/OWNER/REPO/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/OWNER/REPO/releases/tag/v1.0.0
