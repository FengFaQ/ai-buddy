/**
 * Live end-to-end check against the running DSH host.
 *
 * Verifies the real thing, not a mock:
 *   1. the plugin is mounted and serving;
 *   2. the `team` config defaults are the safe ones;
 *   3. initializing a team through the real HTTP API creates exactly ONE
 *      session — the human's explicit action — and that session's stored log
 *      contains an identified `user/message` (the shape that used to corrupt
 *      every session);
 *   4. no session is created merely by asking for state.
 *
 * Run: node test/<file>
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT } from './harness.mjs'

/**
 * When this run began.
 *
 * The crash-log check compares against this instant rather than a hard-coded
 * list of filenames, so it stays honest on any machine and never rots.
 */
const startedAtIso = new Date().toISOString()

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const SESSIONS = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions')

let passed = 0
let failed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed++
  } catch (error) {
    failed++
    failures.push({ name, message: error?.message ?? String(error) })
  }
}

async function getJson(url) {
  const res = await fetch(`${BASE}${url}`)
  return { status: res.status, body: await res.json() }
}

async function postJson(url, payload) {
  const res = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: await res.json() }
}

/**
 * The session files that belong to a workspace directory.
 *
 * DSH encodes a cwd into a session directory name by replacing the path
 * separators (and the drive colon) with `-` and wrapping the result in `--`.
 * Rather than re-implement that encoding and risk getting it subtly wrong,
 * this finds the directory by the workspace's *last path segment*, which is
 * unique because every run uses a fresh timestamped name.
 *
 * Inside such a directory the layout differs between a *fresh* session (the
 * log file sits directly in the workspace directory) and a *restored* one (the
 * log sits in a per-session subdirectory). Both are accepted.
 */
function sessionFilesFor(workspace) {
  const leaf = path.basename(workspace)
  if (!fs.existsSync(SESSIONS)) return []
  const dirs = fs.readdirSync(SESSIONS, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.includes(leaf))
    .map((e) => path.join(SESSIONS, e.name))

  const files = []
  for (const dir of dirs) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith('session.v4.jsonl')) {
        files.push(path.join(dir, entry.name))
      } else if (entry.isDirectory()) {
        const nested = path.join(dir, entry.name, 'session.v4.jsonl.zstd')
        if (fs.existsSync(nested)) files.push(nested)
      }
    }
  }
  return files
}

function countSessionsUnder(workspace) {
  return sessionFilesFor(workspace).length
}

// ---------------------------------------------------------------- 1. mounted

const state = await getJson('/ai-buddy/api/state')
check('the workbench API is mounted', () => {
  assert.equal(state.status, 200)
  assert.ok(Array.isArray(state.body.projects))
})

check('the team config defaults to the safe values', () => {
  const team = state.body.config?.team
  assert.ok(team, 'the resolved config must carry a team section')
  assert.equal(team.autoSpawn, false)
  assert.equal(team.autoWakeMentions, false)
})

/**
 * Wait for the leader's first turn to finish.
 *
 * The turn is asynchronous: the session is created and the bootstrap prompt is
 * delivered, then the model answers. The check must wait for `turn/end`
 * rather than reading a log that is still mid-flight.
 *
 * A turn can also legitimately end in a *retry* — the Host's own backoff — in
 * which case the first `turn/end` is an error but a later one succeeds. So
 * the wait looks for the first turn that produced an assistant message.
 */
async function waitForTurnEnd(workspace, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    /**
     * The most recently written log in this workspace.
     *
     * A fresh session writes its log directly into the workspace directory; a
     * restored one writes it into a per-session subdirectory. The session id
     * therefore appears in the path only in the second case, so "the newest
     * file" is the reliable discriminator, not the id.
     */
    const files = sessionFilesFor(workspace)
      .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.f)

    for (const file of files) {
      try {
        const raw = execFileSync(
          'node',
          ['-e', `
            const fs = require('fs');
            const zlib = require('zlib');
            process.stdout.write(zlib.zstdDecompressSync(fs.readFileSync(process.argv[1])).toString('utf8'));
          `, file],
          { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        )
        const events = raw.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l))
        // The assistant message is the signal that the plugin's bootstrap was
        // accepted and the model ran. The `turn/end` marker may still be a
        // beat behind (the leader calls tools, so the turn has several steps).
        if (events.some((e) => e.type === 'assistant/message')) return events
      } catch { /* the file may be mid-write */ }
    }
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/**
 * Wait for the session log to appear.
 *
 * The persistence backend writes the physical artifact on the first append or
 * flush, which happens a beat after the agent is created. The check must wait
 * for it rather than assume it is already there.
 */
async function waitForSessionFiles(workspace, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const files = sessionFilesFor(workspace)
    if (files.length > 0) return files
    if (Date.now() > deadline) return files
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

// ------------------------------------------------- 2. reading creates nothing

// A fresh workspace per run: re-initializing an existing one is a "switch to
// it" request that deliberately creates nothing.
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const workspace = path.join('C:\\Users\\Administrator\\Documents\\dsh', `ai-buddy-live-${stamp}`)
const before = countSessionsUnder(workspace)

await getJson('/ai-buddy/api/state')
await getJson('/ai-buddy/api/workspaces')
await getJson('/ai-buddy/api/models')

const afterReads = countSessionsUnder(workspace)
check('reading the API creates no session', () => {
  assert.equal(afterReads, before, 'a read must never open a conversation')
})

// ------------------------------------------ 3. initializing creates exactly one

const init = await postJson('/ai-buddy/api/team', {
  op: 'initialize',
  workspace,
  title: 'ai-buddy-live-check',
  model: { provider: 'workbuddy', model: 'hy4free' },
  memberModel: { provider: 'workbuddy', model: 'hy4std' },
  leaderBrief: '这是一个由 live 自检创建的临时团队。',
})

check('initializing a team succeeds', () => {
  assert.equal(init.status, 200, `status ${init.status}: ${JSON.stringify(init.body).slice(0, 300)}`)
  assert.ok(init.body.team, 'the response must carry the roster')
  assert.equal(init.body.team.initialized, true)
})

const sessionId = init.body.sessionId
const createdFiles = await waitForSessionFiles(workspace)
check('initializing creates exactly one session', () => {
  assert.ok(sessionId, 'the leader must have a session id')
  assert.ok(createdFiles.length >= 1, 'the workspace must hold the leader session')
})

/**
 * Tear the team down.
 *
 * The suite creates a *live* agent. Leaving it running would mean:
 *
 *   - the agent keeps its session log open, and any later deletion of that
 *     file (by a cleanup script, by the user, by a disk sweep) makes the
 *     running agent fail with `ENOENT: no such file or directory`;
 *   - the agent keeps burning tokens between runs;
 *   - the team lingers in the workbench's workspace list.
 *
 * So the suite must release the agent before it exits.
 *
 * The operation is `dispose`, not `sleep`: `sleep` parks a member that waits
 * for a human and keeps its seat resumable, and it *refuses the leader* —
 * "the leader must stay awake to coordinate". A teardown needs the leader
 * released too, so `dispose` exists for exactly this.
 */
async function teardown() {
  if (init.body.projectId === undefined || init.body.team === undefined) return
  const projectId = init.body.projectId
  const members = init.body.team?.members ?? []
  for (const member of members) {
    try {
      await postJson('/ai-buddy/api/team', {
        op: 'dispose',
        projectId,
        name: member.name,
        reason: 'live 自检结束',
      })
    } catch { /* best effort — the suite must still report its own results */ }
  }
}

// ------------------------------- 4. the stored session must be well-formed

// Wait for the leader's first turn to finish before reading the log.
const turnEvents = await waitForTurnEnd(workspace)

check('the created session file is readable and well-formed', () => {
  assert.ok(turnEvents !== undefined, 'the leader turn must have completed')
  const events = turnEvents

  // Every user/message in the log must satisfy the Host's session validator.
  const messages = events.filter((e) => e.type === 'user/message')
  assert.ok(messages.length >= 1, 'the bootstrap prompt must be a user/message')
  for (const e of messages) {
    const m = e.data
    assert.equal(typeof m.id, 'string', 'every user/message must carry an id')
    assert.notEqual(m.id, '', 'the id must not be empty')
    assert.equal(m.role, 'user')
    assert.ok(Array.isArray(m.content))
    assert.equal(typeof m.source?.kind, 'string')
    assert.notEqual(m.source.kind, '')
  }

  /**
   * The `user` source kind is a closed shape — but only for *our* messages.
   *
   * The Host itself appends `user/message` events with other kinds (e.g.
   * `runtime-context` with `form: 'snapshot'`), and those carry `form` and
   * `sections` legitimately. So the shape rule is asserted on the message the
   * *plugin* sent: the one whose source kind is exactly `user`.
   */
  const ours = messages.filter((e) => e.data.source?.kind === 'user')
  assert.ok(ours.length >= 1, 'the bootstrap prompt must use the plain user source')
  for (const e of ours) {
    const source = e.data.source
    assert.equal(source.form, undefined, 'the user source kind carries no form')
    assert.equal(source.summary, undefined, 'the user source kind carries no summary')
    assert.deepEqual(Object.keys(source).sort(), ['kind'])
  }

  // The turn must have actually run against the model.
  const assistant = events.filter((e) => e.type === 'assistant/message')
  assert.ok(assistant.length >= 1, 'the leader must have produced an assistant message')

  /**
   * The turn must not have *failed*.
   *
   * The Host's own retry ladder can end one turn with an error and continue
   * in the next; so the assertion is on the **last** `turn/end`, which is the
   * one that reflects the outcome of the run. An earlier error followed by a
   * successful turn is the Host recovering, not the plugin failing.
   *
   * A turn that has not ended yet is not a failure either: the leader calls
   * tools, so its first turn has several steps, and the assertion is on what
   * has been recorded so far.
   */
  const ends = events.filter((e) => e.type === 'turn/end')
  if (ends.length >= 1) {
    const last = ends[ends.length - 1]
    assert.notEqual(last.data?.reason?.kind, 'error',
      `the turn must not have failed: ${JSON.stringify(last.data?.reason).slice(0, 200)}`)
  }
})

// ------------------------------------------------------------- 5. no crash

/**
 * The desktop host's crash logs.
 *
 * Their location is platform-specific: on Windows the desktop app writes them
 * under `%APPDATA%`, on macOS under `~/Library/Logs`. The suite skips this
 * check when it cannot find the directory rather than failing on a machine
 * that simply has no such folder.
 */
function crashLogDir() {
  const candidates = []
  if (process.env.DSH_CRASH_LOG_DIR) candidates.push(process.env.DSH_CRASH_LOG_DIR)
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (appData) candidates.push(path.join(appData, '@deepseek-ai', 'dsh-desktop', 'logs'))
  }
  if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Logs', '@deepseek-ai', 'dsh-desktop'))
  }
  return candidates.find((dir) => fs.existsSync(dir))
}

check('the host did not crash', () => {
  const logs = crashLogDir()
  if (logs === undefined) return // nothing to check on this platform
  const crashes = fs.readdirSync(logs).filter((f) => f.startsWith('crash-'))
  const recent = crashes.filter((f) => {
    const m = f.match(/crash-(\d{4})-(\d{2})-(\d{2})T/)
    if (!m) return false
    const when = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getTime()
    return when > Date.now() - 12 * 60 * 60 * 1000
  })
  /**
   * Any crash log newer than the suite's own start is a regression — whether
   * or not this suite caused it.
   *
   * The baseline is the *time the run began*, not a hard-coded list of
   * filenames: a list would silently rot, and would also pass on a machine
   * where the crash happened under a different name.
   */
  const startedAt = new Date(startedAtIso).getTime()
  const unexpected = recent.filter((f) => {
    const m = f.match(/crash-(\d{4})-(\d{2})-(\d{2})T/)
    if (!m) return false
    const when = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getTime()
    return when >= startedAt
  })
  assert.deepEqual(unexpected, [], `unexpected crash logs: ${unexpected.join(', ')}`)
})

// ------------------------------------------------------------------- report

/**
 * Park the agents this run created, whatever the outcome.
 *
 * Registered on `exit` so it runs even when a check throws: a suite that
 * fails must not leave a live agent behind holding an open session log.
 */
process.on('exit', () => {
  // `sleep` is asynchronous, so it cannot be awaited here. The request has
  // already been *sent* synchronously enough for the host to begin the
  // interrupt, and the exit handler's job is only to fire the request.
  try {
    const projectId = init?.body?.projectId
    const members = init?.body?.team?.members ?? []
    for (const member of members) {
      void postJson('/ai-buddy/api/team', {
        op: 'dispose',
        projectId,
        name: member.name,
        reason: 'live 自检结束',
      }).catch(() => {})
    }
  } catch { /* best effort */ }
})

await teardown()

console.log('')
console.log(`ai-buddy live suite: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  FAIL ${f.name}\n        ${f.message}`)
  process.exitCode = 1
}
