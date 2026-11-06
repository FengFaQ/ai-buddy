/**
 * Regression suite: enabling AI Buddy must not create AI conversations.
 *
 * The human's requirement (turn 9): keep ai-buddy enabled, but **without
 * auto-creating AI conversations**. A session is a real, billable conversation
 * with a real model; a plugin that opens nine of them the moment it is enabled
 * spends the user's quota without being asked.
 *
 * This suite pins the gate. It also pins the *other* side of it: the explicit
 * human actions (initializing the team, adding a member, creating a task) must
 * still work — a gate that silently disabled the whole feature would satisfy
 * this suite and still be wrong.
 *
 * Run: node test/<file>
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

import { ROOT, load } from './harness.mjs'

const { resolveConfig, DEFAULT_CONFIG } = load('lib/config.js')
const { watchPass } = load('lib/host/watch.js')

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

async function checkAsync(name, fn) {
  try {
    await fn()
    passed++
  } catch (error) {
    failed++
    failures.push({ name, message: error?.message ?? String(error) })
  }
}

// ---------------------------------------------------------- the config gate

check('autoSpawn is off by default', () => {
  assert.equal(DEFAULT_CONFIG.team.autoSpawn, false)
  assert.equal(resolveConfig({}).team.autoSpawn, false)
  assert.equal(resolveConfig({ team: {} }).team.autoSpawn, false)
  assert.equal(resolveConfig({ team: { autoSpawn: 'yes' } }).team.autoSpawn, false)
})

check('autoWakeMentions is off by default', () => {
  assert.equal(DEFAULT_CONFIG.team.autoWakeMentions, false)
  assert.equal(resolveConfig({}).team.autoWakeMentions, false)
})

check('autoSpawn can be turned on explicitly', () => {
  assert.equal(resolveConfig({ team: { autoSpawn: true } }).team.autoSpawn, true)
})

check('the resolved config always carries a team section', () => {
  const config = resolveConfig({})
  assert.equal(typeof config.team, 'object')
  assert.equal(typeof config.team.autoSpawn, 'boolean')
  assert.equal(typeof config.team.autoWakeMentions, 'boolean')
})

// ------------------------------------------------- the reconcile gate in code

check('the activation reconcile is gated on team.autoSpawn', () => {
  const source = fs.readFileSync(`${ROOT}/lib/index.js`, 'utf8')
  assert.match(source, /config\.team\?\.autoSpawn !== true/,
    'reconcileTeamSeats must refuse to spawn when team.autoSpawn is off')
})

// ------------------------------------------------------- the watch gate

/** A store stub with one initialized project and a team whose leader is idle. */
function makeDeps(overrides = {}) {
  const calls = { spawned: [], woken: [], sent: [], ensured: 0 }
  const teamState = {
    initialized: true,
    leader: 'leader',
    members: [
      { name: 'leader', role: 'leader', status: 'idle', sessionId: null },
      { name: '调度', role: 'coordinator', status: 'idle', sessionId: null },
      { name: '成员甲', role: 'member', status: 'offline', sessionId: null },
    ],
  }
  const deps = {
    calls,
    config: resolveConfig({}),
    log: () => {},
    store: {
      listProjects: () => [{ id: 'p1' }],
      readTasks: () => [],
    },
    teamCore: {
      load: () => teamState,
      leader: () => ({ name: 'leader', role: 'leader', status: 'idle', sessionId: null }),
      member: () => undefined,
      suggestMemberName: () => '调度',
      addMember: () => teamState,
    },
    planCore: { read: () => [] },
    requestsCore: { list: () => [] },
    feed: { post: () => {} },
    teamRuntime: {
      findAgent: () => undefined,
      spawn: async (projectId, name) => { calls.spawned.push(name); return { sessionId: 'session-new' } },
      wake: async (projectId, name) => { calls.woken.push(name); return { sessionId: 'session-new' } },
      send: async (projectId, args) => { calls.sent.push(args.to); return { delivered: true } },
    },
    ...overrides,
  }
  return deps
}

await checkAsync('the watch creates nothing when autoSpawn and autoWake are off', async () => {
  const deps = makeDeps()
  await watchPass({}, deps)
  assert.deepEqual(deps.calls.spawned, [], 'the watch must not spawn a coordinator')
  assert.deepEqual(deps.calls.woken, [], 'the watch must not wake a member')
  assert.deepEqual(deps.calls.sent, [], 'the watch must not deliver a report')
})

await checkAsync('the watch starts the coordinator when autoSpawn is on', async () => {
  const deps = makeDeps({ config: resolveConfig({ team: { autoSpawn: true } }) })
  await watchPass({}, deps)
  // The coordinator seat may already exist (it is created once and reused), in
  // which case the watch *wakes* it — and waking a seat with no session spawns
  // one. Either way a conversation is started, which is what the opt-in means.
  const started = deps.calls.spawned.length + deps.calls.woken.length
  assert.ok(started >= 1, 'the coordinator conversation should be started')
})

await checkAsync('the watch never reports to a leader without a live session', async () => {
  // `teamRuntime.send` wakes its target, and waking a seat that never had a
  // session spawns one. A background watch must not open conversations.
  const deps = makeDeps()
  // A plan item that is blocked produces a finding.
  deps.planCore.read = () => [{ id: 'p', status: 'pending', blockedBy: ['q'] }]
  await watchPass({}, deps)
  assert.deepEqual(deps.calls.sent, [],
    'a report must not be delivered to a leader that has no live session')
})

await checkAsync('the watch reports to a leader that is already running', async () => {
  const deps = makeDeps()
  deps.planCore.read = () => [{ id: 'p', status: 'pending', blockedBy: ['q'] }]
  deps.teamCore.leader = () => ({ name: 'leader', role: 'leader', status: 'working', sessionId: 'session-live' })
  deps.teamRuntime.findAgent = (id) => (id === 'session-live' ? { id: 'session-live', status: 'running' } : undefined)
  await watchPass({}, deps)
  assert.deepEqual(deps.calls.sent, ['leader'],
    'a live leader should receive the report')
})

// --------------------------------------- the human's explicit actions survive

check('the OOBE initialize path still spawns the leader', () => {
  // The gate must not disable the feature: initializing the team is the
  // human explicitly asking for a conversation.
  const source = fs.readFileSync(`${ROOT}/lib/web.js`, 'utf8')
  assert.match(source, /op === 'initialize'/)
  assert.match(source, /teamRuntime\.spawn\(targetProjectId/)
})

check('adding a member still spawns it', () => {
  const source = fs.readFileSync(`${ROOT}/lib/web.js`, 'utf8')
  assert.match(source, /teamRuntime\.spawn\(projectId, body\.name\)/)
})

check('creating a task still binds a conversation', () => {
  const source = fs.readFileSync(`${ROOT}/lib/web.js`, 'utf8')
  assert.match(source, /teamRuntime\.spawn\(projectId, ownerAgent\)/)
})

// ------------------------------------------------- a team can be torn down

/**
 * `sleep` parks a member that waits for a human and keeps its seat
 * resumable — and it refuses the leader ("the leader must stay awake to
 * coordinate"). That refusal is right for a human's decision, but it left no
 * way to take a team down: a finished team, or a test run, kept its agent
 * alive, holding an open session log and burning tokens.
 *
 * A live agent whose log is later deleted fails with `ENOENT: no such file
 * or directory` — which reads like a plugin bug and is not one. So the
 * teardown path has to exist, and it has to work for every role.
 */
check('the runtime can release any member, including the leader', () => {
  const source = fs.readFileSync(`${ROOT}/lib/host/team-runtime.js`, 'utf8')
  assert.match(source, /async function dispose\(projectId, memberName, reason/)
  // `dispose` must not carry the leader's restriction that `sleep` has.
  const disposeBody = source.slice(source.indexOf('async function dispose('))
  const sleepAt = disposeBody.indexOf('async function sleep(')
  const body = sleepAt === -1 ? disposeBody : disposeBody.slice(0, sleepAt)
  assert.equal(body.includes('must stay awake'), false,
    'dispose must be able to release the leader; that is the whole point of it')
  assert.match(body, /handle\.dispose\(\)/,
    'dispose must actually release the agent, not just mark the seat')
})

check('the dispose operation is exposed on the workbench API', () => {
  const source = fs.readFileSync(`${ROOT}/lib/web.js`, 'utf8')
  assert.match(source, /op === 'dispose'/)
  assert.match(source, /teamRuntime\.dispose\(projectId, body\.name/)
})

check('dispose reports dormancy only after the agent is confirmed gone', () => {
  const source = fs.readFileSync(`${ROOT}/lib/host/team-runtime.js`, 'utf8')
  const disposeBody = source.slice(source.indexOf('async function dispose('))
  const sleepAt = disposeBody.indexOf('async function sleep(')
  const body = sleepAt === -1 ? disposeBody : disposeBody.slice(0, sleepAt)
  assert.match(body, /findAgent\(sessionId\)/,
    'dispose must re-check the agent after disposing it')
  assert.match(body, /dormant \? 'dormant' : 'offline'/,
    "the seat must only claim 'dormant' when the agent is really gone")
})

// ------------------------------------------------------------------- report

console.log('')
console.log(`ai-buddy auto-spawn suite: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  FAIL ${f.name}\n        ${f.message}`)
  process.exitCode = 1
}
