/**
 * Lossless-JSON regression test.
 *
 * The Host rejects a tool value that is not lossless JSON. `undefined` in an
 * object property is the trap: `JSON.stringify` silently drops it, so a tool
 * "looks fine" in a unit test and fails on the wire with
 * "value is not lossless JSON" — after the side effect already happened.
 *
 * This exercises every tool through the same `jsonSafe` wrapper the plugin
 * registers, so a future `?? undefined` cannot reintroduce the bug.
 */

import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'

import { ROOT, load } from './harness.mjs'
const { resolveConfig } = await load('lib/config.js')
const { Store } = await load('lib/store.js')
const feed = await load('lib/core/feed.js')
const plan = await load('lib/core/plan.js')
const task = await load('lib/core/task.js')
const assets = await load('lib/core/assets.js')
const locks = await load('lib/core/locks.js')
const checkpoint = await load('lib/core/checkpoint.js')
const resume = await load('lib/core/resume.js')
const prompts = await load('lib/core/prompts.js')
const toolsMod = await load('lib/tools/index.js')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** Mirrors the Host's lossless-JSON check: no undefined anywhere. */
function isLosslessJson(value, pathSeen = '$') {
  if (value === undefined) return `${pathSeen} is undefined`
  if (value === null) return null
  if (typeof value === 'function' || typeof value === 'symbol') return `${pathSeen} is ${typeof value}`
  if (typeof value === 'number' && !Number.isFinite(value)) return `${pathSeen} is not finite`
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const bad = isLosslessJson(value[i], `${pathSeen}[${i}]`)
      if (bad !== null) return bad
    }
    return null
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) return `${pathSeen}.${k} is undefined`
      const bad = isLosslessJson(v, `${pathSeen}.${k}`)
      if (bad !== null) return bad
    }
    return null
  }
  return null
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-buddy-json-'))
const config = resolveConfig({ dataDir: dir }, { DSH_HOME: dir })
const store = new Store({ dir, config })
const projectId = store.defaultProjectId()

// Capture what registerTools would actually send to the Host.
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

toolsMod.registerTools(fakeCtx, {
  store, config,
  core: { feed, plan, task, assets, locks, checkpoint, resume, prompts },
  log: () => {},
  actorFor: () => ({ type: 'agent', id: 'agent-1', name: 'agent-1' }),
  projectIdFor: () => projectId,
  conversationFor: () => 'conv-json',
})

check('registered 20 tools', registered.length === 20, `got ${registered.length}`)

const byName = new Map(registered.map((d) => [d.name, d]))
const exec = { agent: { id: 'conv-json' }, signal: new AbortController().signal }

// Seed a project so the tools have real data to read back.
const actor = { type: 'agent', id: 'agent-1', name: 'agent-1' }
const planItem = plan.create(store, config, projectId, { actor: actor.name, title: '种子条目' })
  ?? plan.create(store, config, projectId, { actor: { type: 'agent', id: actor.name, name: actor.name }, title: '种子条目' })
const seedTask = task.create(store, config, projectId, {
  actor: { type: 'agent', id: actor.name, name: actor.name },
  title: '种子任务', ownerAgent: 'agent-1', planItemId: planItem.id,
})
const seedAsset = assets.save(store, config, projectId, {
  actor: { type: 'agent', id: actor.name, name: actor.name },
  name: '种子资产.md', bytes: Buffer.from('# x'),
})
// A second task so `reference_conversation` has two distinct endpoints, and so
// `link_asset_to_conversation` has a target the executor conversation owns.
const peerTask = task.create(store, config, projectId, {
  actor: { type: 'agent', id: actor.name, name: actor.name },
  title: '对端任务', ownerAgent: 'peer-agent',
})
// A third task, used only to exercise `release_execution_lock`.
//
// The release must be exercised on its own task: the other steps below need
// `seedTask` to still hold the execution right, and a release that actually
// releases (which it now does) would take that right away. Releasing on a
// shared task would have hidden the difference between a release that works
// and one that is silently dropped.
const releaseTask = task.create(store, config, projectId, {
  actor: { type: 'agent', id: actor.name, name: actor.name },
  title: '释放用任务', ownerAgent: 'agent-1',
})
// The release only has something to release if the right was taken first.
locks.request(store, config, projectId, { taskId: releaseTask.id, agent: 'agent-1' })
feed.post(store, config, projectId, {
  actor: { type: 'human', id: 'human', name: 'Human' },
  content: '人类指令', category: 'human.instruction', source: 'human',
})
checkpoint.write(store, config, projectId, {
  conversationId: 'conv-json', taskId: seedTask.id, eventType: 'status_change',
  triggerAgent: 'agent-1', contextSummary: 'seed',
  lastOperation: { type: 'plan_update', target_ref: planItem.id, result_status: 'confirmed' },
})

const calls = [
  ['post_update_to_feed', { content: 'JSON 自检', category: 'plan.update' }],
  ['read_feed', { limit: 5 }],
  ['create_plan_item', { title: 'JSON 自检条目' }],
  ['update_plan_status', { plan_item_id: planItem.id, new_status: 'in_progress' }],
  ['read_plan', { filter: 'all' }],
  ['create_conversation', { title: 'JSON 自检会话' }],
  ['request_execution_lock', { conversation_id: seedTask.id }],
  ['release_execution_lock', { conversation_id: releaseTask.id }],
  ['share_conversation_readonly', { conversation_id: seedTask.id, target_agent: 'peer' }],
  ['reference_conversation', { source_conversation_id: seedTask.id, target_conversation_id: peerTask.id }],
  ['query_assets', { query: '种子', scope: 'project' }],
  ['link_asset_to_conversation', { asset_id: seedAsset.asset.id, conversation_id: seedTask.id }],
  ['read_human_instructions', {}],
  ['inspect_resume_state', { conversation_id: 'conv-json' }],
  ['verify_idempotency', { operation_type: 'plan_update', target_ref: planItem.id }],
  ['query_resume_lock', { conversation_id: 'conv-json' }],
  ['request_manual_resume', { conversation_id: 'conv-json', reason: 'JSON 自检' }],
  ['publish_resume_note', { conversation_id: 'conv-json', summary: 'JSON 自检恢复摘要' }],
]

for (const [name, args] of calls) {
  const definition = byName.get(name)
  if (definition === undefined) { check(`${name} exists`, false); continue }
  try {
    const value = await definition.execute(args, exec)
    const bad = isLosslessJson(value)
    check(`${name} returns lossless JSON`, bad === null, bad ?? '')
    // The render callback must not throw on the sanitized value either.
    if (bad === null) {
      const blocks = definition.output.render(args, value)
      check(`${name} renders one text block`, Array.isArray(blocks) && blocks.length > 0)
    }
  } catch (error) {
    check(`${name} executes`, false, String(error?.message ?? error))
  }
}

// handoff last: it mutates ownership for the rest.
try {
  const definition = byName.get('handoff_conversation')
  const value = await definition.execute(
    { task_id: seedTask.id, target_agent: 'peer-agent', summary: '移交给 peer' }, exec)
  const bad = isLosslessJson(value)
  check('handoff_conversation returns lossless JSON', bad === null, bad ?? '')
} catch (error) {
  check('handoff_conversation executes', false, String(error?.message ?? error))
}

try {
  const definition = byName.get('save_to_assets')
  const value = await definition.execute({ name: 'JSON自检产物.md', content: '# 产物' }, exec)
  const bad = isLosslessJson(value)
  check('save_to_assets returns lossless JSON', bad === null, bad ?? '')
} catch (error) {
  check('save_to_assets executes', false, String(error?.message ?? error))
}

try { store.dispose() } catch {}
try { rmSync(dir, { recursive: true, force: true }) } catch {}

console.log(`\n================ RESULT ================`)
console.log(`PASS ${pass}   FAIL ${fail}`)
if (failures.length) { console.log('\nFAILURES:'); for (const f of failures) console.log(' - ' + f) }
process.exit(fail === 0 ? 0 : 1)
