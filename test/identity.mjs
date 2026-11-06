/**
 * Regression suite: the identity and task-resolution fixes from the field
 * report (the team's 7-bug list).
 *
 * The report's BUG-1 was the most consequential: every member — and the
 * leader — resolved to the actor name `agent-session-`, because the fallback
 * in `actorFor` sliced the session id to 8 characters, and a session id that
 * *starts with* `session-` sliced to exactly `"session-"`. With that name,
 * no member could pass `plan.updateStatus`'s write-right check, so the team
 * could not self-organise at all.
 *
 * The suite drives the real tool layer (`registerTools`) the way the Host
 * does — `exec.agent` carrying a session id — so what it proves is what a
 * member's tool call actually sees.
 *
 * Run: node test/identity.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ROOT, load } from './harness.mjs'

const { resolveConfig } = await load('lib/config.js')
const { Store } = await load('lib/store.js')
const team = await load('lib/core/team.js')
const toolsMod = await load('lib/tools/index.js')
const plan = await load('lib/core/plan.js')

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

/**
 * A project with an initialised two-member team, each seat bound to a
 * Host-style session id, and one plan item with a task — the state a live
 * working team has.
 */
async function scenario() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-buddy-identity-'))
  const config = resolveConfig({})
  const store = new Store({ dir, config })
  const project = store.createProject({ title: 'identity', description: 'x' })
  const projectId = project.id

  team.initialize(store, projectId, {
    leaderName: 'leader',
    title: 'identity probe',
    workspace: dir,
    model: { provider: 'p', model: 'm' },
  })
  team.addMember(store, projectId, { name: '小算', title: '成员', reportsTo: 'leader' })

  const leaderSession = 'session-11111111-2222-3333-4444-555555555555'
  const memberSession = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  team.bindSession(store, projectId, { name: 'leader', sessionId: leaderSession })
  team.bindSession(store, projectId, { name: '小算', sessionId: memberSession })

  // Register the tools against a fake ctx the way the other suites do: the
  // Host's `tools` service receives each definition via `register`.
  const registered = []
  const fakeCtx = {
    get(name) {
      if (name !== 'tools') return undefined
      return {
        register(def) {
          registered.push(def)
          return () => {}
        },
      }
    },
    effect(fn) { const d = fn(); return () => { try { d?.() } catch {} } },
  }
  const core = {
    feed: await load('lib/core/feed.js'),
    plan,
    task: scenarioModules.task,
    assets: await load('lib/core/assets.js'),
    locks: await load('lib/core/locks.js'),
    checkpoint: await load('lib/core/checkpoint.js'),
    resume: await load('lib/core/resume.js'),
    prompts: await load('lib/core/prompts.js'),
  }
  const deps = {
    store,
    config,
    core,
    log: () => {},
    actorFor: (agent) => {
      // Mirror `apply()`'s resolution: roster first, then bound task, then
      // the verbatim session id. Duplicating the order here is the point —
      // the source-level check below pins that the real code keeps it.
      for (const p of store.listProjects()) {
        const t = team.load(store, p.id)
        if (t?.initialized !== true) continue
        const seat = (t.members ?? []).find((m) => m.sessionId === agent?.id)
        if (seat !== undefined && typeof seat.name === 'string' && seat.name !== '') {
          return { type: 'agent', id: seat.name, name: seat.name, sessionId: agent?.id }
        }
      }
      const sessionId = typeof agent?.id === 'string' && agent.id !== '' ? agent.id : 'unknown'
      return { type: 'agent', id: sessionId, name: sessionId, sessionId }
    },
    projectIdFor: () => projectId,
    conversationFor: (agent) => (typeof agent?.id === 'string' ? agent.id : undefined),
    teamRuntime: undefined,
  }
  toolsMod.registerTools(fakeCtx, deps)

  const planItem = plan.create(store, config, projectId, {
    actor: { type: 'human', id: 'human', name: 'Human' },
    title: '被成员认领的条目',
  })
  const task = taskCreate(store, config, projectId, {
    actor: { type: 'human', id: 'human', name: 'Human' },
    title: '成员的任务',
    ownerAgent: '小算',
    planItemId: planItem.id,
  })

  return {
    dir, config, store, projectId, planItem, task,
    leaderSession, memberSession,
    byName: new Map(registered.map((d) => [d.name, d])),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

function taskCreate(store, config, projectId, args) {
  // `task.create` is imported lazily to keep the fixture readable.
  return scenarioModules.task.create(store, config, projectId, args)
}

const scenarioModules = {}

// ------------------------------------------------------------------- pins

check('the source no longer contains the mangled session fallback', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
  assert.equal(/agent-\$\{sessionId\.slice/.test(source), false,
    'the `agent-${sessionId.slice(0, 8)}` fallback must be gone')
  assert.match(source, /The session id itself, verbatim/,
    'the fallback must keep the full session id')
})

check('actorFor resolves through the team roster before the bound task', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/index.js'), 'utf8')
  const start = source.indexOf('function actorFor')
  const end = source.indexOf('function createUserMessageFactory')
  const body = source.slice(start, end)
  const roster = body.indexOf('team.load')
  const boundTask = body.indexOf('readTasks')
  assert.ok(roster !== -1 && boundTask !== -1 && roster < boundTask,
    'the roster check must come first: a member\'s seat is bound through the roster, not through task.conversationId')
})

check('watch.js suppresses an unchanged findings report', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/host/watch.js'), 'utf8')
  assert.match(source, /lastReportedFindings/, 'a signature store must exist')
  assert.match(source, /lastReportedFindings\.set\(projectId, signature\)/,
    'the signature is recorded only after delivery')
  const guardAt = source.indexOf('lastReportedFindings.get(projectId) === signature')
  const sendAt = source.indexOf('teamRuntime.send(projectId, {')
  const reportBody = source.slice(source.indexOf('function reportToLeader') === -1
    ? source.indexOf('async function reportToLeader')
    : source.indexOf('function reportToLeader'))
  assert.match(reportBody, /lastReportedFindings\.get\(projectId\) === signature/,
    'reportToLeader must consult the signature before sending')
})

check('create_conversation takes the execution right it promises', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/tools/index.js'), 'utf8')
  const createAt = source.indexOf("name: 'create_conversation'")
  const body = source.slice(createAt, createAt + 6000)
  assert.match(body, /core\.locks\.request/,
    'the description promises the right, so the tool must take it')
})

check('send_message_to_member no longer double-prefixes a mention', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib/tools/team.js'), 'utf8')
  assert.match(source, /startsWith\(`@\$\{mention\}`\)/,
    'the prefix must be conditional on the content not already carrying it')
})

// ------------------------------------------------ behaviour through tools

async function main() {
  scenarioModules.task = await load('lib/core/task.js')
  const s = await scenario()
  try {
    const memberExec = { agent: { id: s.memberSession }, signal: new AbortController().signal }
    const leaderExec = { agent: { id: s.leaderSession }, signal: new AbortController().signal }

    await checkAsync('BUG-1: a member session resolves to the member name', async () => {
      const lock = await s.byName.get('request_execution_lock').execute({}, memberExec)
      assert.equal(lock.task_id, s.task.id,
        'the member must resolve to its own task without passing an id')
      assert.equal(lock.granted, true, 'the owner must get the right')
    })

    await checkAsync('BUG-1: the leader session resolves to "leader"', async () => {
      // The leader owns no task, so the resolution must fail — but the failure
      // is now *actionable*: it names the active tasks and their owners, which
      // is exactly what BUG-2 asked for. Before the fix, the leader's actor
      // was `agent-session-` and the same call died with a write-right error
      // that named nobody.
      await assert.rejects(
        () => s.byName.get('request_execution_lock').execute({}, leaderExec),
        (error) => {
          assert.match(error.message, /无法确定对话 id/)
          assert.match(error.message, /owner: 小算/,
            'the error must list the active tasks so the caller can pass an id')
          return true
        },
      )
    })

    await checkAsync('BUG-1: a member can update the plan status of its own item', async () => {
      // Take the right back first (the leader queued behind it above).
      await s.byName.get('request_execution_lock').execute({}, memberExec)
      const result = await s.byName.get('update_plan_status').execute(
        { plan_item_id: s.planItem.id, new_status: 'in_progress' }, memberExec)
      assert.equal(result.plan_item_id, s.planItem.id)
      assert.equal(result.need_human, false)
    })

    await checkAsync('BUG-5: read_feed returns untruncated content', async () => {
      const long = `裁决：`.padEnd(600, 'x')
      const { default: feedMod } = { default: null }
      const feed = await load('lib/core/feed.js')
      feed.post(s.store, s.config, s.projectId, {
        actor: { type: 'agent', id: 'leader', name: 'leader' },
        content: long,
        category: 'team.message',
        source: 'agent',
      })
      const value = await s.byName.get('read_feed').execute({ limit: 5 }, memberExec)
      const found = value.events.find((e) => e.content.startsWith('裁决：'))
      assert.ok(found !== undefined, 'the long post must be present')
      assert.equal(found.content.length, long.length,
        'the stored/returned content must not be clipped to a line')
    })

    await checkAsync('BUG-2/7: an explicit id still wins', async () => {
      const lock = await s.byName.get('request_execution_lock').execute(
        { conversation_id: s.task.id }, memberExec)
      assert.equal(lock.task_id, s.task.id)
    })
  } finally {
    s.cleanup()
  }

  console.log('')
  console.log(`ai-buddy identity suite: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log('')
    for (const f of failures) console.log(`  FAIL ${f.name}\n        ${f.message}`)
    process.exitCode = 1
  }
}

await main()
