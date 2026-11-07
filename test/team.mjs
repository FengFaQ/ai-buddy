/**
 * Team + task-graph integration test.
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
const team = await load('lib/core/team.js')
const requests = await load('lib/core/requests.js')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
function isLosslessJson(v, p = '$') {
  if (v === undefined) return `${p} undefined`
  if (v === null) return null
  if (typeof v === 'function' || typeof v === 'symbol') return `${p} ${typeof v}`
  if (typeof v === 'number' && !Number.isFinite(v)) return `${p} not finite`
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const b = isLosslessJson(v[i], `${p}[${i}]`); if (b) return b } return null }
  if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) { if (x === undefined) return `${p}.${k} undefined`; const b = isLosslessJson(x, `${p}.${k}`); if (b) return b } return null }
  return null
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-buddy-team-'))
const config = resolveConfig({ dataDir: dir }, { DSH_HOME: dir })
const store = new Store({ dir, config })
const projectId = store.defaultProjectId()
const human = { type: 'human', id: 'human', name: 'Human' }

try {
  // ------------------------------------------------------------ lifecycle
  console.log('\n=== team lifecycle ===')
  let notInit = false
  try { team.addMember(store, projectId, { name: 'x' }) } catch { notInit = true }
  check('addMember before initialize throws', notInit)

  const t0 = team.initialize(store, projectId, { leaderName: 'leader', workspace: 'C:\\work' })
  check('initialize creates initialized team', t0.initialized === true)
  check('leader installed with role leader', t0.members.length === 1 && t0.members[0].role === 'leader')
  check('leader named leader', t0.members[0].name === 'leader')

  let dupInit = false
  try { team.initialize(store, projectId, {}) } catch { dupInit = true }
  check('re-initialize refused', dupInit)

  const t1 = team.addMember(store, projectId, { name: 'alice', title: '预算编制' })
  const alice = team.member(t1, 'alice')
  check('member defaults to reporting to leader', alice.reportsTo === 'leader')
  check('member inherits team workspace', alice.workspace === 'C:\\work')

  let dupName = false
  try { team.addMember(store, projectId, { name: 'alice' }) } catch { dupName = true }
  check('duplicate member name refused', dupName)

  let badParent = false
  try { team.addMember(store, projectId, { name: 'bob', reportsTo: 'nobody' }) } catch { badParent = true }
  check('unknown reportsTo refused', badParent)

  const t2 = team.addMember(store, projectId, { name: 'bob', reportsTo: 'alice' })
  check('nested reporting stored', team.member(t2, 'bob').reportsTo === 'alice')
  check('directReports finds bob under alice', team.directReports(t2, 'alice').length === 1)
  check('reportsTree finds downstream', team.reportsTree(t2, 'leader').length === 2)

  let removeLeader = false
  try { team.removeMember(store, projectId, { name: 'leader' }) } catch { removeLeader = true }
  check('removing the leader refused', removeLeader)

  let removeWithReports = false
  try { team.removeMember(store, projectId, { name: 'alice' }) } catch { removeWithReports = true }
  check('removing a member with reports refused', removeWithReports)

  const t3 = team.removeMember(store, projectId, { name: 'bob' })
  check('leaf member removed', team.member(t3, 'bob') === undefined)
  check('leader preserved after removal', team.leader(t3)?.name === 'leader')

  // ------------------------------------------------------------- statuses
  console.log('\n=== status accounting ===')
  team.setStatus(store, projectId, { name: 'alice', status: 'working', currentTask: '写框架' })
  let v = team.view(team.load(store, projectId), new Map())
  check('working status stored', team.member(v, 'alice').status === 'working')
  check('view counts working', v.counts.working === 1)

  // sticky state survives a live-agent report that says idle
  team.setStatus(store, projectId, { name: 'alice', status: 'waiting_human' })
  const liveMap = new Map([['sess-alice', { status: 'idle' }]])
  team.bindSession(store, projectId, { name: 'alice', sessionId: 'sess-alice' })
  team.setStatus(store, projectId, { name: 'alice', status: 'waiting_human' })
  v = team.view(team.load(store, projectId), liveMap)
  check('waiting_human beats live idle', team.member(v, 'alice').status === 'waiting_human',
    `got ${team.member(v, 'alice').status}`)

  // non-sticky state follows the live agent
  team.setStatus(store, projectId, { name: 'alice', status: 'idle' })
  v = team.view(team.load(store, projectId), new Map([['sess-alice', { status: 'running' }]]))
  check('live running derives working', team.member(v, 'alice').status === 'working')

  // -------------------------------------------------------------- reviews
  console.log('\n=== reviews ===')
  const t4 = team.review(store, projectId, {
    name: 'alice', by: 'leader', score: 85, verdict: '进度正常', advice: '把第 3 节拆细',
  })
  check('review stored with score', team.member(t4, 'alice').review.score === 85)
  check('review advice recorded', team.member(t4, 'alice').review.advice === '把第 3 节拆细')
  check('lastReviewAt set', typeof team.member(t4, 'alice').lastReviewAt === 'string')

  const t5 = team.review(store, projectId, { name: 'alice', by: 'leader', score: 999, advice: 'clamp' })
  check('score clamped to 100', team.member(t5, 'alice').review.score === 100)

  // ------------------------------------------------------------- requests
  console.log('\n=== requests ===')
  const rq = requests.create(store, config, projectId, {
    actor: human, from: 'alice', kind: 'teammate', title: '需要帮手整理数据',
    reason: '数据量太大，我一个人要三天', skill: 'Excel', urgency: 'high', leader: 'leader',
  })
  check('request created pending', rq.status === 'pending' && rq.id.startsWith('rq_'))
  check('pendingCount reflects it', requests.pendingCount(store, projectId) === 1)

  let noReason = false
  try { requests.create(store, config, projectId, { title: 'x' }) } catch { noReason = true }
  check('request without reason refused', noReason)

  const resolved = requests.resolve(store, config, projectId, {
    requestId: rq.id, status: 'approved', decidedBy: 'leader', assignee: 'bob',
  })
  check('request resolved', resolved.status === 'approved' && resolved.assignee === 'bob')

  let twice = false
  try {
    requests.resolve(store, config, projectId, { requestId: rq.id, status: 'rejected', decidedBy: 'leader' })
  } catch { twice = true }
  check('double-resolve refused', twice)

  let badStatus = false
  try { requests.resolve(store, config, projectId, { requestId: rq.id, status: 'pending' }) } catch { badStatus = true }
  check('resolve to pending refused', badStatus)

  // ------------------------------------------------------------ task graph
  console.log('\n=== task graph ===')
  const root = plan.create(store, config, projectId, {
    actor: human, title: '年度预算编制', assignee: 'leader', mode: 'pre',
  })
  const c1 = plan.create(store, config, projectId, {
    actor: human, title: '数据收集', parentId: root.id, assignee: 'alice', dependsOn: [],
  })
  const c2 = plan.create(store, config, projectId, {
    actor: human, title: '编制', parentId: root.id, assignee: 'alice',
  })
  const g1 = plan.create(store, config, projectId, {
    actor: human, title: '收集销售数据', parentId: c1.id, assignee: 'alice',
  })
  check('parentId stored on child', c1.parentId === root.id)
  check('grandchild lineage', g1.parentId === c1.id)

  let badParentId = false
  try {
    plan.create(store, config, projectId, { actor: human, title: 'x', parentId: 'pl_nope' })
  } catch { badParentId = true }
  check('unknown parentId refused', badParentId)

  plan.updateStatus(store, config, projectId, {
    actor: human, planItemId: c1.id, newStatus: 'in_progress',
  })
  const graph = plan.tree(store, projectId, { team: team.view(team.load(store, projectId), new Map()) })
  check('graph has one root', graph.roots.length === 1, `got ${graph.roots.length}`)
  check('root is the human instruction', graph.roots[0].id === root.id)
  check('root has two children', graph.roots[0].children.length === 2)
  check('child has grandchild', graph.roots[0].children.some((c) => c.children.length === 1))
  check('stats.maxDepth is 2', graph.stats.maxDepth === 2, `got ${graph.stats.maxDepth}`)
  check('stats.inProgress counts one', graph.stats.inProgress === 1)
  check('node carries agentState', typeof graph.roots[0].children[0].agentState === 'string')
  check('node carries currentTask when in progress',
    graph.index[c1.id].currentTask === '数据收集',
    JSON.stringify(graph.index[c1.id].currentTask))
  check('done/other node has no currentTask', graph.index[c2.id].currentTask === null)
  check('graph is lossless JSON', isLosslessJson(graph) === null, isLosslessJson(graph) ?? '')

  // orphan handling
  const orphanParent = plan.create(store, config, projectId, { actor: human, title: '临时父' })
  const orphanChild = plan.create(store, config, projectId, {
    actor: human, title: '孤儿', parentId: orphanParent.id,
  })
  plan.updateStatus(store, config, projectId, {
    actor: human, planItemId: orphanParent.id, delete: true,
  })
  const graph2 = plan.tree(store, projectId, {})
  const orphanNode = graph2.roots.find((r) => r.id === orphanChild.id)
  check('orphan re-rooted and flagged', orphanNode !== undefined && orphanNode.orphan === true,
    `orphanNode=${orphanNode ? JSON.stringify({ id: orphanNode.id, orphan: orphanNode.orphan }) : 'missing'}`)

  // ------------------------------------------------------ team tool shapes
  console.log('\n=== team tools ===')
  const toolsMod = await load('lib/tools/team.js')
  check('TEAM_TOOL_NAMES has 8', toolsMod.TEAM_TOOL_NAMES.length === 8,
    `got ${toolsMod.TEAM_TOOL_NAMES.length}`)
  const expected = [
    'send_message_to_member', 'await_human_reply', 'request_teammate',
    'approve_request', 'remove_member', 'review_member', 'interrupt_member',
    'list_team',
  ]
  check('all expected team tools present',
    expected.every((n) => toolsMod.TEAM_TOOL_NAMES.includes(n)))

  const fakeRuntime = {
    liveAgentMap: () => new Map(),
    send: async () => ({ delivered: false, reason: 'no_live_agent' }),
    sleep: async () => ({ dormant: true }),
    spawn: async () => ({ sessionId: 'sess-new' }),
    interrupt: async () => ({ interrupted: false, reason: 'not_running' }),
    backupConversation: async () => ({ backedUp: true, assetId: 'a_backup' }),
  }
  const defs = toolsMod.createTeamTools({
    store, config,
    core: { feed, plan, task, assets, locks, checkpoint, resume, prompts, team, requests },
    log: () => {},
    actorFor: () => ({ type: 'agent', id: 'alice', name: 'alice' }),
    projectIdFor: () => projectId,
    conversationFor: () => 'sess-alice',
    teamRuntime: fakeRuntime,
  })
  check('8 definitions built', defs.length === 8)
  check('every team tool has output.render',
    defs.every((d) => d.output && typeof d.output.render === 'function'))

  const byName = new Map(defs.map((d) => [d.name, d]))
  const exec = { agent: { id: 'sess-alice' }, signal: new AbortController().signal }

  // leader-only enforcement: caller is 'alice' (member)
  let leaderGuard = false
  let guardMsg = ''
  try {
    await byName.get('review_member').execute(
      { name: 'alice', advice: 'x' }, exec)
  } catch (error) { leaderGuard = true; guardMsg = String(error?.message ?? error) }
  check('member cannot call review_member', leaderGuard, guardMsg)

  let approveGuard = false
  try {
    await byName.get('approve_request').execute(
      { request_id: rq.id, decision: 'approve', assign_to: 'bob' }, exec)
  } catch { approveGuard = true }
  check('member cannot call approve_request', approveGuard)

  const listed = await byName.get('list_team').execute({}, exec)
  check('list_team executes', Array.isArray(listed.members) && listed.members.length >= 2)
  check('list_team is lossless JSON', isLosslessJson(listed) === null, isLosslessJson(listed) ?? '')

  const msg = await byName.get('send_message_to_member').execute(
    { content: '请把数据交给我', mention: 'leader' }, exec)
  check('send_message_to_member posts feed', typeof msg.feed_event_id === 'string')
  check('message is lossless JSON', isLosslessJson(msg) === null, isLosslessJson(msg) ?? '')

  let badMention = false
  try {
    await byName.get('send_message_to_member').execute(
      { content: 'x', mention: 'ghost' }, exec)
  } catch { badMention = true }
  check('unknown mention refused', badMention)

  const ask = await byName.get('await_human_reply').execute(
    { question: '预算口径用含税还是不含税？', sleep: false }, exec)
  check('await_human_reply registers wait', ask.waiting === true)
  check('await_human_reply lossless JSON', isLosslessJson(ask) === null)

  const req = await byName.get('request_teammate').execute(
    { title: '需要帮手', reason: '工作量太大' }, exec)
  check('request_teammate creates pending request', typeof req.request_id === 'string')
  check('request_teammate lossless JSON', isLosslessJson(req) === null, isLosslessJson(req) ?? '')

  // ----------------------------------------------------------- persistence
  console.log('\n=== persistence ===')
  const projectDir = path.join(dir, 'projects', projectId)
  const { existsSync, readFileSync } = await import('node:fs')
  check('team.json written', existsSync(path.join(projectDir, 'team.json')))
  check('requests.json written', existsSync(path.join(projectDir, 'requests.json')))
  const teamRaw = JSON.parse(readFileSync(path.join(projectDir, 'team.json'), 'utf8'))
  check('team.json valid', teamRaw.initialized === true && Array.isArray(teamRaw.members))

  store.refreshMarkdown(projectId)
  check('markdown refreshed after team changes', existsSync(path.join(projectDir, 'md', 'plan.md')))
} catch (error) {
  fail++
  failures.push(`harness threw: ${error?.message ?? error}`)
  console.log(`\nHARNESS ERROR: ${error?.stack ?? error}`)
} finally {
  try { store.dispose() } catch {}
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log(`\n================ RESULT ================`)
console.log(`PASS ${pass}   FAIL ${fail}`)
if (failures.length) { console.log('\nFAILURES:'); for (const f of failures) console.log(' - ' + f) }
process.exit(fail === 0 ? 0 : 1)
