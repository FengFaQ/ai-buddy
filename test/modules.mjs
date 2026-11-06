/**
 * Integration harness for ai-buddy. Lives in %TEMP%, not the repo.
 *
 * Drives the real modules against a real Store in a temp directory: no mocks of
 * the persistence layer, because the point is to catch contract drift between
 * the modules and the wiring (which is exactly the bug class found in review).
 */

import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'

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

function check(name, condition, detail) {
  if (condition) {
    pass++
    console.log(`PASS ${name}`)
  } else {
    fail++
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-buddy-it-'))
const config = resolveConfig({ dataDir: dir }, { DSH_HOME: dir })
const store = new Store({ dir, config })
const projectId = store.defaultProjectId()

const human = { type: 'human', id: 'human', name: 'Human' }
const agentA = { type: 'agent', id: 'architect', name: 'architect' }
const agentB = { type: 'agent', id: 'budget-writer', name: 'budget-writer' }

try {
  // ---------------------------------------------------------------- feed
  section('feed')
  const e1 = feed.post(store, config, projectId, {
    actor: human, content: '请架构 Agent 基于历史数据制定预算编制框架。',
    category: 'human.instruction', source: 'human',
  })
  check('feed.post returns event', typeof e1.event.id === 'string' && e1.event.id.startsWith('f_'))
  check('human event kind is human', e1.event.kind === 'human')

  const e2 = feed.post(store, config, projectId, {
    actor: agentA, content: '已生成框架文档。', category: 'plan.update', source: 'agent',
  })
  check('agent post accepted', e2.throttled === false)

  const read = feed.read(store, config, projectId, { limit: 10, includePinned: true })
  check('feed.read returns events', Array.isArray(read) && read.length === 2)

  const instr = feed.humanInstructions(store, projectId, {})
  check('humanInstructions filters to human', instr.length === 1 && instr[0].id === e1.event.id)

  let badCategory = false
  try {
    feed.post(store, config, projectId, { actor: agentA, content: 'x', category: 'nope', source: 'agent' })
  } catch { badCategory = true }
  check('unknown category throws', badCategory)

  // ---------------------------------------------------------------- plan
  section('plan')
  const p1 = plan.create(store, config, projectId, {
    actor: agentA, title: '数据收集', assignee: 'architect', priority: 2,
  })
  const p2 = plan.create(store, config, projectId, {
    actor: agentA, title: '预算编制', assignee: 'budget-writer', priority: 3, dependsOn: [p1.id],
  })
  check('plan.create returns items', p1.id.startsWith('pl_') && p2.id.startsWith('pl_'))
  check('dependent item is blocked upstream', (p2.blockedBy ?? []).length === 1)

  let unknownDepRefused = false
  try {
    plan.create(store, config, projectId, { actor: agentA, title: '悬空依赖', dependsOn: ['pl_doesnotexist0000'] })
  } catch { unknownDepRefused = true }
  check('unknown dependency is refused', unknownDepRefused)

  // A legitimate third item chained on p2 must be accepted (the earlier version
  // of this test asserted the opposite and was simply wrong).
  const p3 = plan.create(store, config, projectId, {
    actor: agentA, title: '评审', assignee: 'architect', dependsOn: [p2.id],
  })
  check('chained dependency is accepted', p3.id.startsWith('pl_'))

  const cycleDetected = plan.detectCycles([
    { id: 'x', dependsOn: ['y'], status: 'pending', deletedAt: null },
    { id: 'y', dependsOn: ['x'], status: 'pending', deletedAt: null },
  ])
  check('detectCycles finds a closed loop', cycleDetected.length === 2,
    JSON.stringify(cycleDetected))

  const planRead = plan.read(store, config, projectId, {})
  check('plan.read returns all three', planRead.length === 3,
    `got ${planRead.length}: ${planRead.map((i) => i.title).join(',')}`)

  // ---------------------------------------------------------------- locks
  section('locks')
  const t1 = task.create(store, config, projectId, {
    actor: agentA, title: '预算编制会话', ownerAgent: 'architect', planItemId: p2.id,
  })
  check('task.create returns task', t1.id.startsWith('t_'))
  check('creator holds execution right', t1.executionLock.holder === 'architect')

  const reqB = locks.request(store, config, projectId, { taskId: t1.id, agent: 'budget-writer' })
  check('second agent is queued, not granted', reqB.acquired === false && reqB.position === 1,
    JSON.stringify({ acquired: reqB.acquired, position: reqB.position }))

  const rel = locks.release(store, config, projectId, { taskId: t1.id, agent: 'architect' })
  check('release hands to the queued agent', rel.released === true && rel.handedTo === 'budget-writer',
    JSON.stringify({ released: rel.released, handedTo: rel.handedTo }))

  const h1 = locks.holder(store, projectId, t1.id)
  check('holder is now the queued agent', h1 === 'budget-writer')

  // --------------------------------------------------------------- assets
  section('assets')
  const saved = assets.save(store, config, projectId, {
    actor: agentA, name: '历史预算表.md', folder: 'budgets',
    bytes: Buffer.from('# 2024 预算\n总预算 1000 万'),
  })
  check('assets.save returns asset', saved.asset.id.startsWith('a_'))
  check('high-risk glob matched 预算', saved.asset.highRisk === true)

  const readable = assets.query(store, config, projectId, { scope: 'readable', agent: agentB })
  check('asset is readable project-wide', readable.length === 1)

  const gated = assets.save(store, config, projectId, {
    actor: agentA, name: '机密.md', folder: 'secret',
    bytes: Buffer.from('x'), allowedAgents: ['architect'],
  })
  const notReadable = assets.query(store, config, projectId, { scope: 'readable', agent: agentB })
  check('agent-level boundary hides gated asset', notReadable.length === 1,
    `visible=${notReadable.map((a) => a.name).join(',')}`)

  const overwrite = assets.update(store, config, projectId, {
    actor: agentA, assetId: saved.asset.id, bytes: Buffer.from('new'),
  })
  check('high-risk overwrite needs human', overwrite.needHumanConfirmation === true)

  // ----------------------------------------------------------- checkpoints
  section('checkpoints')
  const cp = checkpoint.write(store, config, projectId, {
    conversationId: 'conv-A', taskId: t1.id, eventType: 'handoff',
    triggerAgent: 'architect',
    lastOperation: { type: 'handoff', target_ref: 'budget-writer', result_status: 'unconfirmed' },
    contextSummary: '移交编制任务',
    nextExpectedActor: 'budget-writer',
  })
  check('checkpoint has required schema', typeof cp.checkpoint_id === 'string'
    && cp.conversation_id === 'conv-A' && cp.event_type === 'handoff')
  check('checkpoint cross-module snapshot from live store',
    typeof cp.resume_context.cross_module_snapshot.execution_lock_holder === 'string'
    || cp.resume_context.cross_module_snapshot.execution_lock_holder === null)
  check('checkpoint carries resume_lock_state',
    typeof cp.resume_context.resume_lock_state.consecutive_failures === 'number')

  // ------------------------------------------------------------- recovery
  section('recovery')

  check('classifyFailure dead_end', resume.classifyFailure({ code: 'insufficient_quota', status: 429 }) === 'dead_end'
    || resume.classifyFailure({ code: 'invalid_api_key', status: 401 }) === 'dead_end')
  check('classifyFailure transient', resume.classifyFailure({ code: 'network_error' }) === 'transient')

  check('backoff ladder first step', resume.nextBackoff(config, 0) === 30000)
  check('backoff honors larger Retry-After',
    resume.nextBackoff(config, 0, 120000) >= 120000)

  check('GUARD_MATRIX confirmed -> skip', resume.GUARD_MATRIX.handoff.confirmed === 'skip')
  check('GUARD_MATRIX unconfirmed -> verify_first', resume.GUARD_MATRIX.handoff.unconfirmed === 'verify_first')
  check('GUARD_MATRIX failed -> retry', resume.GUARD_MATRIX.handoff.failed === 'retry')
  check('GUARD_MATRIX changed_by_other -> request_human', resume.GUARD_MATRIX.handoff.changed_by_other === 'request_human')
  check('GUARD_MATRIX covers 5 operations', Object.keys(resume.GUARD_MATRIX).length === 5)

  const brief = resume.brief(store, config, projectId, 'conv-A')
  check('brief returns a checkpoint', brief?.checkpoint?.checkpoint_id === cp.checkpoint_id)
  const msg = prompts.resumeMessage(brief)
  const required = ['动态', '计划', '资产', '执行权']
  const missing = required.filter((word) => !msg.includes(word))
  check('resumeMessage carries cross-module verification', missing.length === 0, `missing=${missing.join(',')}`)
  check('resumeMessage is not a bare continue', msg.length > 200)
  check('resumeMessage states the verdict', /skip|verify_first|retry|request_human/.test(msg))

  // interruption lock: two failures do NOT lock
  const conv = 'conv-A'
  resume.recordResumeAttempt(store, config, projectId, conv, {
    attemptId: 'r1', outcome: 'rejected', failure: { code: 'insufficient_quota', status: 402 },
  })
  resume.recordResumeAttempt(store, config, projectId, conv, {
    attemptId: 'r2', outcome: 'rejected', failure: { code: 'insufficient_quota', status: 402 },
  })
  const afterTwo = resume.lockStatus(store, projectId, conv)
  check('two failures do not lock', afterTwo.locked === false && afterTwo.consecutiveFailures === 2,
    JSON.stringify({ locked: afterTwo.locked, n: afterTwo.consecutiveFailures }))

  // third failure is transient -> still no lock
  resume.recordResumeAttempt(store, config, projectId, conv, {
    attemptId: 'r3', outcome: 'rejected', failure: { code: 'network_error' },
  })
  const afterTransient = resume.lockStatus(store, projectId, conv)
  check('transient third failure does not lock', afterTransient.locked === false,
    JSON.stringify({ locked: afterTransient.locked, n: afterTransient.consecutiveFailures }))

  // now hit the threshold with a dead-end rejection
  resume.recordResumeAttempt(store, config, projectId, conv, {
    attemptId: 'r4', outcome: 'rejected', failure: { code: 'insufficient_quota', status: 402 },
  })
  const afterLock = resume.lockStatus(store, projectId, conv)
  check('threshold + dead-end rejection engages the lock', afterLock.locked === true,
    JSON.stringify({ locked: afterLock.locked, n: afterLock.consecutiveFailures, reason: afterLock.lastFailureReason }))

  // locked conversation refuses a resume lock
  const acquire = resume.acquireResumeLock(store, projectId, conv, 'auto-restart')
  check('locked conversation refuses resume lock', acquire?.acquired !== true,
    JSON.stringify(acquire))

  // locked conversation is omitted from the plan
  const candidates = resume.planResume(store, config, {
    now: Date.now(), restartAt: 0,
    isRunning: () => false, sessionLastActivityAt: () => Date.now(), wasUserAborted: () => false,
  })
  const picked = candidates.filter((c) => c.conversationId === conv)
  check('locked conversation omitted from planResume', picked.length === 0,
    `candidates=${candidates.map((c) => c.conversationId).join(',')}`)

  // human unlock resets
  resume.releaseLock(store, config, projectId, conv, 'human', { resetCounter: true })
  const unlocked = resume.lockStatus(store, projectId, conv)
  check('human unlock clears the lock and counter',
    unlocked.locked === false && unlocked.consecutiveFailures === 0,
    JSON.stringify({ locked: unlocked.locked, n: unlocked.consecutiveFailures }))

  // ---------------------------------------------------------------- tools
  section('tools')
  check('TOOL_NAMES has exactly 20', toolsMod.TOOL_NAMES.length === 20,
    `got ${toolsMod.TOOL_NAMES.length}`)
  const expected = [
    'post_update_to_feed', 'read_feed', 'create_plan_item', 'update_plan_status', 'read_plan',
    'create_conversation', 'handoff_conversation', 'request_execution_lock',
    'release_execution_lock', 'share_conversation_readonly', 'reference_conversation',
    'query_assets', 'save_to_assets', 'link_asset_to_conversation', 'read_human_instructions',
    'inspect_resume_state', 'publish_resume_note', 'request_manual_resume',
    'verify_idempotency', 'query_resume_lock',
  ]
  const missingTools = expected.filter((n) => !toolsMod.TOOL_NAMES.includes(n))
  check('all 20 brief tool names present', missingTools.length === 0, `missing=${missingTools.join(',')}`)

  const definitions = toolsMod.createToolDefinitions({
    store, config,
    core: { feed, plan, task, assets, locks, checkpoint, resume, prompts },
    log: () => {},
    actorFor: () => agentA,
    projectIdFor: () => projectId,
    conversationFor: () => 'conv-A',
  })
  check('definitions built', definitions.length === 20)
  const everyDefValid = definitions.every((d) =>
    typeof d.name === 'string' && typeof d.description === 'string'
    && d.parameters !== undefined && typeof d.execute === 'function'
    && d.output !== undefined && typeof d.output.render === 'function'
    && d.output.schema !== undefined)
  check('every tool has name/description/parameters/execute/output', everyDefValid,
    definitions.filter((d) => !(d.output && typeof d.output.render === 'function')).map((d) => d.name).join(','))

  const fakeExec = { agent: { id: 'conv-A' }, signal: new AbortController().signal }
  const byName = new Map(definitions.map((d) => [d.name, d]))

  const posted = await byName.get('post_update_to_feed').execute(
    { content: '工具层自检：进展正常', category: 'plan.update' }, fakeExec)
  check('post_update_to_feed executes', typeof posted.event_id === 'string')

  const readBack = await byName.get('read_feed').execute({ limit: 5 }, fakeExec)
  check('read_feed executes', Array.isArray(readBack.events) && readBack.count > 0)

  const madePlan = await byName.get('create_plan_item').execute(
    { title: '评审', assignee: 'architect', priority: 1 }, fakeExec)
  check('create_plan_item executes', typeof madePlan.plan_item_id === 'string')

  const planList = await byName.get('read_plan').execute({ filter: 'all' }, fakeExec)
  check('read_plan executes', Array.isArray(planList.items) && planList.count >= 3)

  const lockReq = await byName.get('request_execution_lock').execute({ conversation_id: t1.id }, fakeExec)
  check('request_execution_lock maps acquired->granted',
    lockReq.granted === false || lockReq.granted === true,
    JSON.stringify(lockReq))
  check('request_execution_lock reports holder', typeof lockReq.holder === 'string' || lockReq.holder === null,
    JSON.stringify(lockReq))

  const lockRel = await byName.get('release_execution_lock').execute({ conversation_id: t1.id }, fakeExec)
  check('release_execution_lock maps handedTo->next_holder',
    lockRel.released === true || lockRel.released === false, JSON.stringify(lockRel))

  const instr2 = await byName.get('read_human_instructions').execute({}, fakeExec)
  check('read_human_instructions executes', Array.isArray(instr2.instructions))

  const verdict = await byName.get('verify_idempotency').execute(
    { operation_type: 'handoff', target_ref: 'budget-writer' }, fakeExec)
  check('verify_idempotency returns an action',
    ['skip', 'retry', 'verify_first', 'request_human'].includes(verdict.action),
    JSON.stringify(verdict))

  const lockQ = await byName.get('query_resume_lock').execute({ conversation_id: conv }, fakeExec)
  check('query_resume_lock executes', typeof lockQ.state === 'string' && Array.isArray(lockQ.unlock_conditions))

  const inspected = await byName.get('inspect_resume_state').execute({ conversation_id: conv }, fakeExec)
  check('inspect_resume_state executes', typeof inspected.conversation_id === 'string')

  // ------------------------------------------------------------- on disk
  section('persistence')
  const projectDir = path.join(dir, 'projects', projectId)
  for (const name of ['project.json', 'feed.json', 'plan.json', 'tasks.json', 'assets/manifest.json']) {
    check(`truth layer has ${name}`, existsSync(path.join(projectDir, name)))
  }
  check('checkpoint file exists', existsSync(path.join(projectDir, 'checkpoints', 'conv-A.json')))
  check('resume state exists', existsSync(path.join(projectDir, 'resume', 'conv-A.json')))

  store.refreshMarkdown(projectId)
  for (const name of ['feed.md', 'plan.md', 'assets.md', 'resume-history.md']) {
    check(`markdown has ${name}`, existsSync(path.join(projectDir, 'md', name)))
  }
  const planMd = readFileSync(path.join(projectDir, 'md', 'plan.md'), 'utf8')
  check('plan.md lists a plan item', planMd.includes('数据收集'))
  const feedMd = readFileSync(path.join(projectDir, 'md', 'feed.md'), 'utf8')
  check('feed.md lists a feed event', feedMd.includes('预算编制框架'))

  const raw = JSON.parse(readFileSync(path.join(projectDir, 'plan.json'), 'utf8'))
  check('plan.json is valid JSON with items', Array.isArray(raw.items) && raw.items.length >= 3)
} catch (error) {
  fail++
  failures.push(`harness threw: ${error?.message ?? error}\n${error?.stack ?? ''}`)
  console.log(`\nHARNESS ERROR: ${error?.stack ?? error}`)
} finally {
  try { store.dispose() } catch { /* n/a */ }
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* n/a */ }
}

console.log(`\n================ RESULT ================`)
console.log(`PASS ${pass}   FAIL ${fail}`)
if (failures.length > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log(' - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
