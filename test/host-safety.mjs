/**
 * Regression suite: AI Buddy must never be able to kill the DSH Host.
 *
 * Two Host crashes in this environment shared one root cause — a message that
 * the Host could not key:
 *
 *   1. `message "undefined" is already pending`
 *      (`dsh-agent-loop`, `ReactLoopInbox.mutate`) — two pending messages shared
 *      an id. The throw happens *inside* the agent loop, so nothing in the
 *      plugin can contain it: Node escalates the uncaught exception and the
 *      whole Host process exits.
 *
 *   2. `session event at seq N lacks an identified message`
 *      (`dsh-session`, `assertMessageEventShape`) — a stored `user/message`
 *      without an id. The live append path does *not* check this, so the
 *      session file is written happily and only explodes on the next load.
 *
 * This suite pins the defences against both, and against the *amplifier* that
 * turned a contained rejection into a process exit: a floating promise. Node's
 * default `--unhandled-rejections=throw` turns an unhandled rejection into an
 * uncaught exception, so an un-awaited `injectResume()` was enough to end the
 * Host even though the surrounding `try/catch` looked correct.
 *
 * Run: node test/<file>
 */

import assert from 'node:assert/strict'

import { ROOT, load } from './harness.mjs'
import fs from 'node:fs'

const { createUserMessage, deliver, MessageLedger, isDeliverableMessage } =
  load('lib/core/messages.js')

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

// --------------------------------------------------------------- the contract

/**
 * A faithful miniature of the Host's durable inbox.
 *
 * Mirrors `dsh-agent-loop`'s `ReactLoopInbox`: two pending lists, a union
 * across both, and a duplicate id in that union is a hard error. The Host
 * raises this error from inside the agent loop, where a plugin cannot catch
 * it — so a plugin that cannot guarantee unique ids can end the process.
 */
class HostInbox {
  constructor() {
    this.nextTurn = []
    this.nextStep = []
  }

  splice(target, message) {
    const list = target === 'next-turn' ? this.nextTurn : this.nextStep
    const other = target === 'next-turn' ? this.nextStep : this.nextTurn
    const union = [...list, message, ...other]
    const ids = new Set()
    for (const m of union) {
      if (ids.has(m.id)) throw new Error(`message "${m.id}" is already pending`)
      ids.add(m.id)
    }
    list.push(message)
  }

  followup(m) { this.splice('next-turn', m) }
  steer(m) { this.splice('next-step', m) }
  inject(m) { this.splice('next-step', m) }
}

/** A stand-in for the Host's session validator. */
function assertMessageEventShape(message, subject) {
  if (typeof message !== 'object' || message === null) throw new Error(`${subject} lacks an identified message`)
  if (typeof message.id !== 'string' || message.id === '') throw new Error(`${subject} lacks an identified message`)
  if (message.role !== 'user') throw new Error(`${subject} message must have role "user"`)
  if (message.source === null || typeof message.source !== 'object') throw new Error(`${subject} message has invalid source`)
  if (typeof message.source.kind !== 'string' || message.source.kind === '') {
    throw new Error(`${subject} message has invalid source`)
  }
  if (!Array.isArray(message.content)) throw new Error(`${subject} message has invalid content`)
}

/** The Host's session-format rules for the `user` source kind. */
function assertUserSourceShape(source) {
  const allowed = new Set(['kind', 'rpcId', 'clientTimeZone', 'principal'])
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new Error(`${key} is not a member of the "user" source kind`)
  }
  if (source.kind !== 'user') throw new Error('expected a "user" source')
}

// --------------------------------------------------------- 1. message shape

check('createUserMessage produces an identified message', () => {
  const m = createUserMessage('hello', 'test')
  assert.equal(typeof m.id, 'string')
  assert.notEqual(m.id, '')
  assert.equal(m.role, 'user')
  assert.deepEqual(m.content, [{ type: 'text', text: 'hello' }])
})

check('createUserMessage ids are unique across calls', () => {
  const ids = new Set()
  for (let i = 0; i < 500; i++) ids.add(createUserMessage(`m${i}`, 'test').id)
  assert.equal(ids.size, 500)
})

check('createUserMessage rejects empty text', () => {
  assert.throws(() => createUserMessage('', 'test'), /non-empty string/)
  assert.throws(() => createUserMessage(undefined, 'test'), /non-empty string/)
})

check('a created message satisfies the Host session validator', () => {
  const m = createUserMessage('hello', 'test')
  assertMessageEventShape(m, 'session event at seq 0')
})

check('a created message satisfies the Host session-format source rules', () => {
  const m = createUserMessage('hello', 'test')
  assertUserSourceShape(m.source)
})

check('the source carries no illegal form/summary pair', () => {
  // An earlier revision wrote { kind: 'user', form: 'notice', summary }.
  // It survived the live validator but is off-contract: `form`/`summary`
  // belong to the `plugin` source kind, not to `user`.
  const m = createUserMessage('hello', 'some-label')
  assert.equal(m.source.form, undefined)
  assert.equal(m.source.summary, undefined)
  assert.equal(m.source.kind, 'user')
})

check('isDeliverableMessage rejects the shapes that killed the Host', () => {
  assert.equal(isDeliverableMessage({ id: '', role: 'user', content: [{}], source: { kind: 'user' } }), false)
  assert.equal(isDeliverableMessage({ role: 'user', content: [{}], source: { kind: 'user' } }), false)
  assert.equal(isDeliverableMessage({ id: 'x', role: 'user', content: {}, source: { kind: 'user' } }), false)
  assert.equal(isDeliverableMessage({ id: 'x', role: 'user', content: [{}], source: {} }), false)
  assert.equal(isDeliverableMessage({ id: 'x', role: 'user', content: [{}], source: { kind: 'user' } }), true)
})

// --------------------------------------------------------- 2. the ledger

check('the ledger remembers ids per conversation', () => {
  const ledger = new MessageLedger()
  assert.equal(ledger.remember('c1', 'm1'), true)
  assert.equal(ledger.has('c1', 'm1'), true)
  assert.equal(ledger.has('c2', 'm1'), false)
  assert.equal(ledger.remember('c1', 'm1'), false)
})

check('the ledger forgets a conversation on demand', () => {
  const ledger = new MessageLedger()
  ledger.remember('c1', 'm1')
  ledger.forget('c1')
  assert.equal(ledger.has('c1', 'm1'), false)
})

check('the ledger is bounded', () => {
  const ledger = new MessageLedger(16)
  for (let i = 0; i < 200; i++) ledger.remember('c1', `m${i}`)
  // The oldest ids are evicted, but the ledger must not grow without limit.
  assert.ok(ledger.ids.get('c1').size <= 16)
})

// --------------------------------------------- 3. delivery cannot kill the Host

await checkAsync('delivery into a healthy agent succeeds', async () => {
  const inbox = new HostInbox()
  const agent = { status: 'idle', followup: (m) => inbox.followup(m) }
  const result = await deliver(agent, createUserMessage('hi', 'test'))
  assert.equal(result.delivered, true)
  assert.equal(result.transport, 'followup')
  assert.equal(inbox.nextTurn.length, 1)
})

await checkAsync('an idle agent is followed up (a turn is opened)', async () => {
  const inbox = new HostInbox()
  const agent = { status: 'idle', followup: (m) => inbox.followup(m), steer: (m) => inbox.steer(m) }
  const result = await deliver(agent, createUserMessage('hi', 'test'))
  assert.equal(result.transport, 'followup')
  assert.equal(inbox.nextTurn.length, 1)
  assert.equal(inbox.nextStep.length, 0)
})

await checkAsync('a busy agent is steered (no competing turn)', async () => {
  const inbox = new HostInbox()
  const agent = { status: 'running', followup: (m) => inbox.followup(m), steer: (m) => inbox.steer(m) }
  const result = await deliver(agent, createUserMessage('hi', 'test'))
  assert.equal(result.transport, 'steer')
  assert.equal(inbox.nextTurn.length, 0)
  assert.equal(inbox.nextStep.length, 1)
})

await checkAsync('a Host rejection becomes a failed delivery, not a throw', async () => {
  // This is the exact Host fault that ended the process twice.
  const agent = {
    status: 'idle',
    followup() { throw new Error('message "undefined" is already pending') },
  }
  const result = await deliver(agent, createUserMessage('hi', 'test'))
  assert.equal(result.delivered, false)
  assert.equal(result.reason, 'delivery_failed')
  assert.match(result.error, /already pending/)
})

await checkAsync('an invalid message is refused before it reaches the Host', async () => {
  let called = false
  const agent = { status: 'idle', followup: () => { called = true } }
  const result = await deliver(agent, { role: 'user', content: [{}], source: { kind: 'user' } })
  assert.equal(result.delivered, false)
  assert.equal(result.reason, 'invalid_message')
  assert.equal(called, false)
})

await checkAsync('a missing agent is reported, not thrown', async () => {
  const result = await deliver(undefined, createUserMessage('hi', 'test'))
  assert.equal(result.delivered, false)
  assert.equal(result.reason, 'no_agent')
})

await checkAsync('an agent with no transport is reported, not thrown', async () => {
  const result = await deliver({ status: 'idle' }, createUserMessage('hi', 'test'))
  assert.equal(result.delivered, false)
  assert.equal(result.reason, 'no_transport')
})

// -------------------------------------- 4. the Host must never see a duplicate

await checkAsync('repeated deliveries never produce a duplicate pending id', async () => {
  const inbox = new HostInbox()
  const agent = { status: 'idle', followup: (m) => inbox.followup(m) }
  const ledger = new MessageLedger()

  // Simulate a retry storm: the same logical message attempted many times.
  // Each attempt must mint a *fresh* id, or the Host throws.
  for (let i = 0; i < 50; i++) {
    let message = createUserMessage('retry', 'test')
    if (ledger.has('c1', message.id)) message = createUserMessage('retry', 'test')
    ledger.remember('c1', message.id)
    const result = await deliver(agent, message)
    assert.equal(result.delivered, true)
  }
  assert.equal(inbox.nextTurn.length, 50)
})

await checkAsync('two agents may carry the same id without colliding', async () => {
  // The Host's inbox is per-session, so a per-conversation ledger is the right
  // scope: the same id in two different conversations is not a duplicate.
  const a = new HostInbox()
  const b = new HostInbox()
  const ledger = new MessageLedger()
  const message = createUserMessage('shared', 'test')
  ledger.remember('c1', message.id)
  ledger.remember('c2', message.id)
  assert.equal(ledger.has('c1', message.id), true)
  assert.equal(ledger.has('c2', message.id), true)
  a.followup(message)
  b.followup(message)
  assert.equal(a.nextTurn.length, 1)
  assert.equal(b.nextTurn.length, 1)
})

// --------------------------------- 5. the floating promise that killed the Host

await checkAsync('injectResume rejects when the message has no id', async () => {
  const { injectResume } = load('lib/core/resume.js')
  const agent = { status: 'idle', followup: () => {} }
  await assert.rejects(
    () => injectResume(agent, { projectId: 'p', conversationId: 'c' }, {
      createUserMessage: () => ({ role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } }),
      deliver: () => ({ delivered: true }),
    }),
    /non-empty `id`/,
  )
})

await checkAsync('injectResume surfaces a refused delivery as a rejection', async () => {
  const { injectResume } = load('lib/core/resume.js')
  const agent = { status: 'idle', followup: () => {} }
  await assert.rejects(
    () => injectResume(agent, { projectId: 'p', conversationId: 'c' }, {
      createUserMessage: () => createUserMessage('x', 'test'),
      deliver: () => ({ delivered: false, reason: 'delivery_failed', error: 'already pending' }),
    }),
    /refused the resume message/,
  )
})

await checkAsync('injectResume requires a delivery transport', async () => {
  const { injectResume } = load('lib/core/resume.js')
  const agent = { status: 'idle', followup: () => {} }
  await assert.rejects(
    () => injectResume(agent, { projectId: 'p', conversationId: 'c' }, {
      createUserMessage: () => createUserMessage('x', 'test'),
    }),
    /deps\.deliver/,
  )
})

/**
 * The amplifier.
 *
 * A `try/catch` around an **un-awaited** async call does not catch a
 * rejection. Node's default `--unhandled-rejections=throw` turns the
 * unhandled rejection into an uncaught exception, and the Host process exits.
 *
 * This test reproduces the shape and asserts that the *awaited* form contains
 * the failure. It is the regression test for the exact line that took DSH
 * down (`resume.injectResume(...)` without `await`).
 */
await checkAsync('an un-awaited injectResume escapes the try/catch as an unhandled rejection', async () => {
  const { injectResume } = load('lib/core/resume.js')
  const agent = { status: 'idle', followup: () => {} }

  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    let caughtByTryCatch = false
    try {
      // Deliberately NOT awaited — this is the defect being guarded against.
      void injectResume(agent, { projectId: 'p', conversationId: 'c' }, {
        createUserMessage: () => createUserMessage('x', 'test'),
        deliver: () => ({ delivered: false, reason: 'delivery_failed' }),
      })
    } catch {
      caughtByTryCatch = true
    }
    // The synchronous try/catch did NOT see the rejection...
    assert.equal(caughtByTryCatch, false)

    // ...and Node reports it as an unhandled rejection, which is exactly the
    // condition that ends the Host process.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(rejections.length, 1)
    assert.match(String(rejections[0]?.message ?? ''), /refused the resume message/)
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

await checkAsync('the awaited injectResume contains the same failure', async () => {
  const { injectResume } = load('lib/core/resume.js')
  const agent = { status: 'idle', followup: () => {} }

  const rejections = []
  const onRejection = (reason) => rejections.push(reason)
  process.on('unhandledRejection', onRejection)
  try {
    let caughtWhenAwaited = false
    try {
      await injectResume(agent, { projectId: 'p', conversationId: 'c' }, {
        createUserMessage: () => createUserMessage('x', 'test'),
        deliver: () => ({ delivered: false, reason: 'delivery_failed' }),
      })
    } catch {
      caughtWhenAwaited = true
    }
    assert.equal(caughtWhenAwaited, true)

    // Give the microtask queue a chance to report an unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(rejections, [])
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

// ------------------------------------------------------------- 6. the ledger
// in the real runtime path

check('the team runtime mints every message through the shared factory', () => {
  const source = fs.readFileSync(`${ROOT}/lib/host/team-runtime.js`, 'utf8')
  // No hand-rolled message literal may remain in the runtime: every message
  // must come from the shared, validated factory.
  assert.equal(/role:\s*'user'/.test(source), false,
    'team-runtime.js still builds a user message by hand')
  assert.match(source, /createUserMessage\(/)
})

check('the resume factory mints every message through the shared factory', () => {
  const source = fs.readFileSync(`${ROOT}/lib/index.js`, 'utf8')
  assert.equal(/role:\s*'user'/.test(source), false,
    'index.js still builds a user message by hand')
  assert.match(source, /createUserMessage\(/)
})

check('the resume pass awaits its injection', () => {
  const source = fs.readFileSync(`${ROOT}/lib/index.js`, 'utf8')
  assert.match(source, /await resume\.injectResume\(/,
    'resume.injectResume must be awaited, or its rejection becomes unhandled')
})

check('no runtime call site calls agent.followup directly', () => {
  for (const file of ['lib/host/team-runtime.js', 'lib/index.js', 'lib/host/watch.js']) {
    const source = fs.readFileSync(`${ROOT}/${file}`, 'utf8')
    // Strip comments so a prose mention of `agent.followup()` in a doc comment
    // does not read as a call site.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    assert.equal(/\.followup\s*\(/.test(code), false,
      `${file} calls agent.followup directly; it must go through lib/core/messages.js`)
  }
})

// ------------------------------------------------------------------- report

console.log('')
console.log(`ai-buddy host-safety suite: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  FAIL ${f.name}\n        ${f.message}`)
  process.exitCode = 1
}
