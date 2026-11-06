/**
 * HTTP-level test for lib/web.js: real sockets against a fake ctx.webServer.
 */

import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
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
const { registerWeb } = await load('lib/web.js')

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS ${name}`) }
  else { fail++; failures.push(name + (detail ? ` — ${detail}` : '')); console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'ai-buddy-web-'))
const config = resolveConfig({ dataDir: dir }, { DSH_HOME: dir })
const store = new Store({ dir, config })
const projectId = store.defaultProjectId()

// ---- fake ctx.webServer that captures routes and dispatches by path ----
const routes = []
const fakeCtx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  },
}

const dispose = registerWeb(fakeCtx, {
  store, config,
  core: { feed, plan, task, assets, locks, checkpoint, resume, prompts },
  projectIdFor: () => projectId,
  actorFor: () => ({ type: 'agent', id: 'agent-1', name: 'agent-1' }),
  log: (m) => console.log('   [log]', m),
  getConfig: () => config,
})

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const matches = routes.filter((r) => (
    r.kind === 'exact' ? url.pathname === r.path : url.pathname.startsWith(r.path)
  ))
  if (matches.length === 0) {
    res.statusCode = 404
    res.end('no route')
    return
  }
  matches[0].handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

async function get(pathname) {
  const res = await fetch(base + pathname)
  const text = await res.text()
  return { status: res.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

async function postJson(pathname, body) {
  const res = await fetch(base + pathname, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, text, json: (() => { try { return JSON.parse(text) } catch { return null } })() }
}

try {
  check('registered routes', routes.length >= 7, `count=${routes.length}`)

  const state = await get(`/ai-buddy/api/state?project=${projectId}`)
  check('GET state -> 200 JSON', state.status === 200 && state.json !== null)
  check('state has all slices', state.json !== null && ['projects', 'project', 'feed', 'plan', 'tasks', 'assets'].every((k) => k in state.json))

  const posted = await postJson('/ai-buddy/api/feed', {
    projectId, content: '人类指令：请基于历史数据制定框架', category: 'human.instruction',
  })
  check('POST feed -> 200', posted.status === 200, posted.text.slice(0, 200))
  check('feed event persisted', posted.json?.event?.content?.includes('历史数据'))

  const afterFeed = await get(`/ai-buddy/api/state?project=${projectId}`)
  check('feed event visible in state', (afterFeed.json?.feed ?? []).length === 1)

  const planCreate = await postJson('/ai-buddy/api/plan', {
    projectId, op: 'create', title: '数据收集', assignee: 'architect',
  })
  check('POST plan create -> 200', planCreate.status === 200, planCreate.text.slice(0, 200))
  const planItemId = planCreate.json?.item?.id
  check('plan item returned', typeof planItemId === 'string')

  const planStatus = await postJson('/ai-buddy/api/plan', {
    projectId, op: 'status', planItemId, newStatus: 'in_progress', note: '开始',
  })
  check('POST plan status -> 200', planStatus.status === 200, planStatus.text.slice(0, 200))
  check('status changed', planStatus.json?.item?.status === 'in_progress')

  const taskCreate = await postJson('/ai-buddy/api/task', {
    projectId, op: 'create', title: '预算编制会话', ownerAgent: 'budget-writer', planItemId,
  })
  check('POST task create -> 200', taskCreate.status === 200, taskCreate.text.slice(0, 200))
  check('task bound to plan item', taskCreate.json?.task?.planItemId === planItemId)

  // raw-bytes upload
  const upRes = await fetch(`${base}/ai-buddy/api/asset?op=upload&project=${projectId}&name=${encodeURIComponent('历史预算表.md')}&folder=budgets`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('# 2024 预算'),
  })
  const upJson = await upRes.json().catch(() => null)
  check('asset upload -> 200', upRes.status === 200, JSON.stringify(upJson).slice(0, 200))
  check('asset recorded', typeof upJson?.asset?.id === 'string')

  const assetList = await postJson('/ai-buddy/api/asset?op=list', { projectId })
  check('asset list -> 200', assetList.status === 200 && Array.isArray(assetList.json?.assets))

  // body cap: 413
  const tooBig = await fetch(`${base}/ai-buddy/api/feed`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, content: 'x'.repeat(40 * 1024 * 1024) }),
  }).catch((e) => ({ status: 'ERR', text: String(e) }))
  check('oversized body refused (413 or connection reset)', tooBig.status === 413 || tooBig.status === 'ERR',
    `status=${tooBig.status}`)

  const unknown = await get('/ai-buddy/api/nope')
  check('unknown route -> 404', unknown.status === 404)

  const shell = await get('/ai-buddy/')
  check('workbench shell -> 200 html', shell.status === 200 && shell.text.includes('<!doctype html'))

  // SSE
  const sse = await new Promise((resolve) => {
    const req = http.get(`${base}/ai-buddy/api/events?project=${projectId}`, (res) => {
      resolve({ status: res.statusCode, type: res.headers['content-type'] })
      res.destroy()
      req.destroy()
    })
    req.on('error', () => resolve({ status: 'ERR', type: '' }))
    setTimeout(() => { req.destroy(); resolve({ status: 'TIMEOUT', type: '' }) }, 4000)
  })
  check('SSE sets text/event-stream', String(sse.type).includes('text/event-stream'), JSON.stringify(sse))

  const cfg = await postJson('/ai-buddy/api/config', { feed: { aiPostsPerMinute: 7 } })
  check('POST config merges', cfg.status === 200 && cfg.json?.config?.feed?.aiPostsPerMinute === 7,
    JSON.stringify(cfg.json?.config?.feed))

  dispose()
  check('disposer removes all routes', routes.length === 0, `left=${routes.length}`)
} finally {
  await new Promise((r) => server.close(r))
  try { store.dispose() } catch {}
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}

console.log(`\n================ RESULT ================`)
console.log(`PASS ${pass}   FAIL ${fail}`)
if (failures.length) { console.log('\nFAILURES:'); for (const f of failures) console.log(' - ' + f) }
process.exit(fail === 0 ? 0 : 1)
