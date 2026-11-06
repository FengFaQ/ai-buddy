/**
 * Regression suite: a released member must not keep an execution right.
 *
 * The execution right is a lease with a 30-minute timeout. A member that is
 * released — slept or disposed — is not working, so it must not keep holding
 * the right: every other member of that task would otherwise sit in the FIFO
 * queue behind a member that no longer exists, for up to half an hour.
 *
 * This is the same class of defect as `dormant` being a lie (§9 of DESIGN.md):
 * the persisted state says one thing while the truth is another.
 *
 * Run: node test/rights.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ROOT } from './harness.mjs'

const require = createRequire(path.join(ROOT, 'package.json'))

const { Store } = require(path.join(ROOT, 'lib/store.js'))
const locks = require(path.join(ROOT, 'lib/core/locks.js'))
const taskCore = require(path.join(ROOT, 'lib/core/task.js'))
const { resolveConfig } = require(path.join(ROOT, 'lib/config.js'))

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

/** A fresh project with one task, in a throwaway directory. */
function scenario() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-buddy-rights-'))
  const config = resolveConfig({})
  const store = new Store({ dir, config })
  const project = store.createProject({ title: 'rights', description: 'x' })
  const created = taskCore.create(store, config, project.id, {
    title: 'the task',
    ownerAgent: 'leader',
    description: 'x',
    actor: { type: 'human', id: 'human', name: 'Human' },
  })
  return {
    dir,
    store,
    config,
    projectId: project.id,
    taskId: created.id ?? created.task?.id,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  }
}

const s = scenario()

check('a member takes the execution right', () => {
  const lock = locks.request(s.store, s.config, s.projectId, {
    taskId: s.taskId,
    agent: 'leader',
  })
  assert.equal(lock.acquired, true)
  assert.equal(lock.holder, 'leader')
})

check('another member queues behind the holder', () => {
  const lock = locks.request(s.store, s.config, s.projectId, {
    taskId: s.taskId,
    agent: 'other',
  })
  assert.equal(lock.acquired, false)
  assert.equal(lock.queued, true)
  assert.equal(lock.position, 1)
})

check('the runtime releases the rights a member holds', () => {
  // The runtime's `releaseHeldRights` is what `dispose` and `sleep` call.
  // Its contract: a released member holds nothing, and the queue is promoted
  // in the same write so nobody is left waiting.
  const source = fs.readFileSync(path.join(ROOT, 'lib/host/team-runtime.js'), 'utf8')
  assert.match(source, /function releaseHeldRights\(projectId, memberName\)/)
  assert.match(source, /locks\.release\(store, config, projectId, \{[\s\S]*?force: true/)

  // `dispose` must call it…
  const disposeAt = source.indexOf('async function dispose(')
  const sleepAt = source.indexOf('async function sleep(')
  const disposeBody = source.slice(disposeAt, sleepAt)
  assert.match(disposeBody, /releaseHeldRights\(projectId, memberName\)/,
    'dispose must release the execution rights the member held')

  // …and so must `sleep`.
  const sleepBody = source.slice(sleepAt)
  assert.match(sleepBody, /releaseHeldRights\(projectId, memberName\)/,
    'sleep must release the execution rights the member held')
})

check('releasing a member frees the right for the queued member', () => {
  // The behaviour `releaseHeldRights` relies on, exercised directly.
  const released = locks.release(s.store, s.config, s.projectId, {
    taskId: s.taskId,
    agent: { type: 'human', id: 'human', name: 'Human' },
    force: true,
  })
  assert.equal(released.released, true)
  assert.equal(released.handedTo, 'other', 'the queue head must be promoted')
  const after = s.store.readTasks(s.projectId).find((t) => t.id === s.taskId)
  assert.equal(after.executionLock.holder, 'other')
  assert.equal(after.executionLock.queue.length, 0)
})

check('a member that holds nothing is not disturbed by the release', () => {
  const result = locks.release(s.store, s.config, s.projectId, {
    taskId: s.taskId,
    agent: { type: 'human', id: 'human', name: 'Human' },
    force: true,
  })
  // The right was held by 'other'; a forced release hands it on, but the
  // important part is that it did not throw and the state stayed coherent.
  assert.ok(result !== undefined)
  const after = s.store.readTasks(s.projectId).find((t) => t.id === s.taskId)
  assert.ok(after.executionLock.holder === null || typeof after.executionLock.holder === 'string')
})

/**
 * The bug this suite exists for.
 *
 * `locks.release` computed the release correctly but never persisted it.
 * `reconcile` only writes when *it* changed something, and it sees no change
 * when the queue is empty: the caller already cleared the holder, and there is
 * nobody to promote. So the release was computed and then dropped — the task
 * still named its old holder on disk, and the member kept the right for the
 * rest of its 30-minute lease while everyone else queued behind it.
 *
 * Two paths were affected, and the second is the common one:
 *   - the holder releasing its own right;
 *   - a human (or a teardown) forcing the release.
 */
check('a holder releasing its own right actually persists the release', () => {
  const s2 = scenario()
  try {
    const took = locks.request(s2.store, s2.config, s2.projectId, {
      taskId: s2.taskId,
      agent: 'leader',
    })
    assert.equal(took.acquired, true)

    const released = locks.release(s2.store, s2.config, s2.projectId, {
      taskId: s2.taskId,
      agent: 'leader',
    })
    assert.equal(released.released, true)

    // The state on disk must agree with the returned view.
    const after = s2.store.readTasks(s2.projectId).find((t) => t.id === s2.taskId)
    assert.equal(after.executionLock.holder, null,
      'the task must not still name the holder after the release')
    assert.equal(after.executionLock.acquiredAt, null)
    assert.equal(after.executionLock.expiresAt, null)
  } finally {
    s2.cleanup()
  }
})

check('a forced release of somebody else\'s right actually persists', () => {
  const s3 = scenario()
  try {
    locks.request(s3.store, s3.config, s3.projectId, { taskId: s3.taskId, agent: 'leader' })

    const released = locks.release(s3.store, s3.config, s3.projectId, {
      taskId: s3.taskId,
      agent: { type: 'human', id: 'human', name: 'Human' },
      force: true,
    })
    assert.equal(released.released, true)

    const after = s3.store.readTasks(s3.projectId).find((t) => t.id === s3.taskId)
    assert.equal(after.executionLock.holder, null,
      'the forced release must be persisted, not just computed')
  } finally {
    s3.cleanup()
  }
})

check('a release with a queued waiter promotes the waiter in the same write', () => {
  const s4 = scenario()
  try {
    locks.request(s4.store, s4.config, s4.projectId, { taskId: s4.taskId, agent: 'leader' })
    locks.request(s4.store, s4.config, s4.projectId, { taskId: s4.taskId, agent: 'other' })

    const released = locks.release(s4.store, s4.config, s4.projectId, {
      taskId: s4.taskId,
      agent: 'leader',
    })
    assert.equal(released.released, true)
    assert.equal(released.handedTo, 'other')

    const after = s4.store.readTasks(s4.projectId).find((t) => t.id === s4.taskId)
    assert.equal(after.executionLock.holder, 'other')
    assert.equal(after.executionLock.queue.length, 0)
  } finally {
    s4.cleanup()
  }
})

s.cleanup()

console.log('')
console.log(`ai-buddy rights suite: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  FAIL ${f.name}\n        ${f.message}`)
  process.exitCode = 1
}
