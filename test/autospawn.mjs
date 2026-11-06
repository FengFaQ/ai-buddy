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

// ------------------------------------------------------------------- report

console.log('')
console.log(`ai-buddy auto-spawn suite: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  FAIL ${f.name}\n        ${f.message}`)
  process.exitCode = 1
}
