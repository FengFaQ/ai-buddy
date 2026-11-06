/**
 * The human workbench API (§7, §4).
 *
 * Design notes that matter more than the route list:
 *
 * 1. **Raw Node HTTP, not a framework.** The Host hands us
 *    `(IncomingMessage, ServerResponse)`. There is no Express, no body parser,
 *    and no router; each of those would be a dependency the profile has to
 *    resolve, and a version skew there takes the whole workbench down.
 *
 * 2. **A human mutation is a feed event.** Every POST that changes state also
 *    records what the human did, with `source: 'human'`. This is the §4
 *    requirement that an AI can read human actions — without it the feed would
 *    be one-way and the "AI 读取人类指令" half of the brief would be decorative.
 *
 * 3. **Bounded bodies.** A workbench upload goes through here, so
 *    `config.assets.maxAssetBytes` is enforced while reading, not after
 *    buffering the whole thing. A body that exceeds it is refused with 413 and
 *    the connection is drained so the socket is not left in a half-read state.
 *
 * 4. **SSE teardown is the leak risk.** One browser tab that never closes its
 *    stream would accumulate listeners forever. Every stream registers a
 *    disposer on `req.close` and clears its keepalive there.
 *
 * 5. **Errors never carry stack traces to the browser.** The client is the
 *    same-origin page, but a stray stack is still a capability hint.
 */

import { isNonEmptyString, asRecord, asStringArray, clip, nowIso } from './util.js'

const PREFIX = '/ai-buddy'
const SSE_KEEPALIVE_MS = 25_000

/** A JSON error body, with the status the caller asked for. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', Buffer.byteLength(text))
  res.end(text)
}

function sendError(res, status, message) {
  sendJson(res, status, { error: { message } })
}

/**
 * Read a request body with a hard ceiling.
 *
 * Resolves to `{ ok: true, buffer }` or `{ ok: false, status, message }`; it
 * never rejects, because an unhandled rejection inside a route handler would
 * surface as a hung request rather than an error.
 */
function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > maxBytes) {
        // Refuse early rather than buffering the rest: the client is asked to
        // stop, and we drain so the connection can be reused.
        req.resume()
        finish({ ok: false, status: 413, message: `请求体超过上限 ${maxBytes} 字节` })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish({ ok: true, buffer: Buffer.concat(chunks) }))
    req.on('error', (error) => finish({
      ok: false, status: 400, message: `读取请求体失败：${error?.message ?? error}`,
    }))
    req.on('aborted', () => finish({ ok: false, status: 400, message: '请求被中断' }))
  })
}

/** Parse a JSON body, tolerating an empty one. */
async function readJson(req, maxBytes) {
  const body = await readBody(req, maxBytes)
  if (body.ok !== true) return body
  if (body.buffer.length === 0) return { ok: true, json: {} }
  try {
    return { ok: true, json: JSON.parse(body.buffer.toString('utf8')) }
  } catch {
    return { ok: false, status: 400, message: '请求体不是合法 JSON' }
  }
}

/** The workbench shell. Inline everything: no external asset to 404. */
function renderShell() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>AI Buddy 协作工作台</title>
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; height:100%;
    background: var(--dsw-alias-bg-base, #fff);
    color: var(--dsw-alias-label-primary, #111);
    font: 14px/1.55 ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  #root { height:100%; }
  .ab-loading { padding:32px; color: var(--dsw-alias-label-secondary, #666); }
</style>
</head>
<body>
<div id="root"><div class="ab-loading">正在载入工作台…</div></div>
<script type="module">
// The shell is intentionally thin: the real UI is the React panel registered by
// client.js inside the Harness page. This route exists so the workbench is also
// reachable as a plain page (deep-link, bookmark, or a diagnostic when the
// panel slot is not registered), and it degrades to a readable state dump
// rather than a blank screen.
const root = document.getElementById('root')
async function boot() {
  try {
    const res = await fetch('${PREFIX}/api/state', { cache: 'no-store' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const state = await res.json()
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
    const tasks = (state.tasks || [])
    const plan = (state.plan || [])
    const feed = (state.feed || []).slice(-20).reverse()
    root.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.style.cssText = 'padding:24px;max-width:1100px;margin:0 auto'
    wrap.innerHTML = '<h1 style="font-size:18px;margin:0 0 4px">' + esc(state.project?.title || 'AI Buddy') + '</h1>'
      + '<p style="color:var(--dsw-alias-label-secondary,#666);margin:0 0 20px">完整工作台在 Harness 侧栏的 AI Buddy 面板中；此处为只读概览。</p>'
      + '<h2 style="font-size:14px;margin:18px 0 8px">计划（' + plan.length + '）</h2>'
      + '<div>' + (plan.map((i) => '<div style="padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#eee)"><code>' + esc(i.id) + '</code> [' + esc(i.status) + '] ' + esc(i.title) + ' — ' + esc(i.assignee || '待指派') + '</div>').join('') || '<em>暂无</em>') + '</div>'
      + '<h2 style="font-size:14px;margin:18px 0 8px">任务（' + tasks.length + '）</h2>'
      + '<div>' + (tasks.map((t) => '<div style="padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#eee)"><code>' + esc(t.id) + '</code> [' + esc(t.status) + '] ' + esc(t.title) + ' — ' + esc(t.ownerAgent || '未指派') + (t.status === 'locked_by_interrupt' ? ' <strong>（因中断锁定）</strong>' : '') + '</div>').join('') || '<em>暂无</em>') + '</div>'
      + '<h2 style="font-size:14px;margin:18px 0 8px">动态（最近 ' + feed.length + '）</h2>'
      + '<div>' + (feed.map((e) => '<div style="padding:4px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#eee)"><code>' + esc(e.at) + '</code> ' + esc(e.actor?.name || '?') + ' · ' + esc(e.category) + ' — ' + esc(e.content) + '</div>').join('') || '<em>暂无</em>') + '</div>'
    root.appendChild(wrap)
  } catch (error) {
    root.textContent = '工作台载入失败：' + (error && error.message ? error.message : error)
  }
}
boot()
</script>
</body>
</html>`
}

/**
 * Register every workbench route.
 *
 * @returns a disposer that removes all of them; safe to call twice.
 */
export function registerWeb(ctx, deps) {
  const { store, log } = deps
  const getConfig = typeof deps.getConfig === 'function' ? deps.getConfig : () => deps.config
  const core = deps.core ?? {}
  const teamRuntime = deps.teamRuntime
  const disposers = []

  /** Register one route, degrading instead of unmounting on a collision. */
  function route(kind, path, handler) {
    try {
      const disposer = ctx.webServer.register({
        kind,
        path,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            log?.(`ai-buddy web: ${path} failed: ${error?.message ?? error}`)
            if (!res.headersSent) sendError(res, 500, '内部错误')
            else try { res.end() } catch { /* already gone */ }
          }
        },
      })
      disposers.push(disposer)
      return true
    } catch (error) {
      log?.(`ai-buddy web: could not register ${path}: ${error?.message ?? error}`)
      return false
    }
  }

  function maxBodyBytes() {
    const limit = Number(getConfig()?.assets?.maxAssetBytes)
    return Number.isFinite(limit) && limit > 0 ? limit + 64 * 1024 : 32 * 1024 * 1024
  }

  /** The project the request addresses; falls back to the only one. */
  /**
   * The project a request addresses.
   *
   * There is deliberately **no fallback to "the first project"**. That fallback
   * is what made projects look like they shared data: a request without an
   * explicit `project` landed on whichever project happened to sort first, so
   * switching workspace in the UI could silently keep reading the old one.
   *
   * Returning `undefined` forces every caller to handle "no project selected"
   * as its own state, which is the honest answer.
   */
  function resolveProject(url) {
    const requested = url.searchParams.get('project')
    if (isNonEmptyString(requested)) return requested
    const body = url.searchParams.get('bodyProject')
    if (isNonEmptyString(body)) return body
    return undefined
  }

  /** The human actor every workbench mutation is attributed to. */
  function humanActor() {
    return { type: 'human', id: 'human', name: 'Human' }
  }

  /**
   * Create a project that belongs to one workspace.
   *
   * Every team gets its own project document set: sharing one project across two
   * workspaces would mean two teams writing into one plan, one feed and one
   * asset manifest — the exact cross-contamination the workspace switch exists
   * to prevent. The title is the directory's final segment so the project list
   * reads like the folders the human actually picked.
   */
  function createProjectForWorkspace(workspace) {
    const segments = String(workspace).replace(/\\/g, '/').split('/').filter(Boolean)
    const title = segments.length > 0 ? segments[segments.length - 1] : '协作项目'
    return store.createProject({
      title,
      description: `工作区：${workspace}`,
      createdBy: humanActor(),
    }).id
  }

  /** Post a human feed event, tolerating a module that is not loaded. */
  function postHumanFeed(projectId, body) {
    if (core.feed?.post === undefined) return undefined
    try {
      return core.feed.post(store, getConfig(), projectId, {
        actor: humanActor(),
        source: 'human',
        ...body,
      })
    } catch (error) {
      log?.(`ai-buddy web: human feed post failed: ${error?.message ?? error}`)
      return undefined
    }
  }

  // ------------------------------------------------------------- the shell

  route('exact', `${PREFIX}/`, (_req, res) => {
    const html = renderShell()
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Length', Buffer.byteLength(html))
    res.end(html)
  })

  // -------------------------------------------------------------- the state

  route('exact', `${PREFIX}/api/state`, (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const projectId = resolveProject(url)
    if (!isNonEmptyString(projectId)) {
      return sendJson(res, 200, {
        projects: [], project: null, feed: [], plan: [], tasks: [], assets: [],
        resume: [], config: getConfig(),
      })
    }
    const snapshot = store.snapshot(projectId)
    if (snapshot === undefined) return sendError(res, 404, `项目 ${projectId} 不存在`)

    // ---- team ----
    // The roster is joined with live agent state here, once, so neither the task
    // graph nor the team panel has to know how to ask the Host what is running.
    let teamView = null
    let taskGraph = null
    try {
      const liveAgents = teamRuntime !== undefined && typeof teamRuntime.liveAgentMap === 'function'
        ? teamRuntime.liveAgentMap()
        : new Map()
      const rawTeam = core.team.load(store, projectId)
      teamView = core.team.view(rawTeam, liveAgents)
      taskGraph = core.plan.tree(store, projectId, { team: teamView })
    } catch (error) {
      log?.(`ai-buddy web: team/graph read failed: ${error?.message ?? error}`)
    }

    let requests = []
    try {
      requests = core.requests.list(store, projectId, { limit: 100 })
    } catch (error) {
      log?.(`ai-buddy web: requests read failed: ${error?.message ?? error}`)
    }

    // Recovery state is joined here rather than stored on the task: the resume
    // document is the recovery subsystem's, and copying its fields into the
    // task would create two places that can disagree.
    const resumeStates = store.listResumeStates(projectId)
    const byConversation = new Map(resumeStates.map((s) => [s.conversationId, s]))
    const tasks = snapshot.tasks.map((task) => {
      const state = task.conversationId ? byConversation.get(task.conversationId) : undefined
      return {
        ...task,
        resumeState: state ?? null,
        checkpointCount: task.conversationId
          ? store.listCheckpoints(projectId, task.conversationId, 1000).length
          : 0,
        latestCheckpoint: task.conversationId
          ? store.latestCheckpoint(projectId, task.conversationId) ?? null
          : null,
      }
    })

    return sendJson(res, 200, {
      projects: store.listProjects(),
      project: snapshot.project,
      feed: snapshot.feed,
      plan: snapshot.plan,
      tasks,
      assets: snapshot.assets,
      resume: resumeStates,
      team: teamView,
      taskGraph,
      requests,
      config: getConfig(),
    })
  })

  // ------------------------------------------------------- human feed posts

  route('exact', `${PREFIX}/api/feed`, async (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, '只接受 POST')
    const parsed = await readJson(req, maxBodyBytes())
    if (parsed.ok !== true) return sendError(res, parsed.status, parsed.message)
    const body = asRecord(parsed.json)
    const projectId = isNonEmptyString(body.projectId) ? body.projectId : resolveProject(new URL(req.url, 'http://localhost'))
    if (!isNonEmptyString(projectId)) return sendError(res, 400, '缺少 projectId 且无法推断项目')
    if (store.getProject(projectId) === undefined) return sendError(res, 404, `项目 ${projectId} 不存在`)
    const content = isNonEmptyString(body.content) ? body.content.trim() : ''
    if (content === '') return sendError(res, 400, 'content 不能为空')

    const category = isNonEmptyString(body.category) ? body.category : 'human.instruction'
    const mention = isNonEmptyString(body.mention) ? body.mention.trim() : undefined

    const posted = postHumanFeed(projectId, {
      content,
      category,
      taskId: isNonEmptyString(body.taskId) ? body.taskId : undefined,
      planItemId: isNonEmptyString(body.planItemId) ? body.planItemId : undefined,
      assetId: isNonEmptyString(body.assetId) ? body.assetId : undefined,
      // The mention has to survive into the stored event, otherwise the member
      // reading the feed later cannot tell it was addressed.
      targetRefs: mention === undefined ? [] : [mention],
      meta: mention === undefined ? {} : { mention },
    })
    if (posted === undefined) return sendError(res, 500, '动态写入失败（feed 模块不可用）')

    /**
     * Deliver the mention.
     *
     * Writing an `@name` into the feed is only half the job — the other half is
     * making that member actually act. Without this, mentioning an idle member
     * was a no-op: the event appeared in the timeline and nothing else happened,
     * because a member's agent does not poll the feed on its own.
     *
     * A failure here must not fail the post: the message is already durably
     * recorded, and the human's intent is not lost just because the target could
     * not be reached this second.
     */
    let delivery = null
    if (mention !== undefined && teamRuntime !== undefined) {
      try {
        const result = await teamRuntime.send(projectId, {
          to: mention,
          content,
          from: 'human',
        })
        delivery = {
          delivered: result?.delivered === true,
          transport: result?.transport ?? '',
          reason: result?.reason ?? '',
          hint: result?.hint ?? '',
        }
      } catch (error) {
        log?.(`ai-buddy web: mention delivery failed: ${error?.message ?? error}`)
        delivery = { delivered: false, transport: '', reason: 'error', hint: String(error?.message ?? error) }
      }
    }

    return sendJson(res, 200, { event: posted.event, delivery })
  })

  // -------------------------------------------------------------- plan ops

  route('exact', `${PREFIX}/api/plan`, async (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, '只接受 POST')
    const parsed = await readJson(req, maxBodyBytes())
    if (parsed.ok !== true) return sendError(res, parsed.status, parsed.message)
    const body = asRecord(parsed.json)
    const projectId = isNonEmptyString(body.projectId) ? body.projectId : resolveProject(new URL(req.url, 'http://localhost'))
    if (!isNonEmptyString(projectId)) return sendError(res, 400, '缺少 projectId')
    if (store.getProject(projectId) === undefined) return sendError(res, 404, `项目 ${projectId} 不存在`)
    if (core.plan === undefined) return sendError(res, 503, 'plan 模块不可用')

    const op = isNonEmptyString(body.op) ? body.op : ''
    const config = getConfig()
    const actor = humanActor()

    try {
      if (op === 'create') {
        const item = core.plan.create(store, config, projectId, {
          actor,
          title: body.title,
          description: body.description,
          assignee: body.assignee,
          dependsOn: asStringArray(body.dependsOn),
          priority: body.priority,
          dueAt: body.dueAt,
          mode: body.mode === 'pre' ? 'pre' : 'live',
          // Lineage is what the task graph draws, so the human-facing create
          // path must be able to set it — otherwise every node a human adds
          // re-roots the tree and the mind map never forms.
          parentId: body.parentId,
          taskId: body.taskId,
        })
        postHumanFeed(projectId, {
          content: `人类新增计划条目「${item.title}」`,
          category: 'plan.create',
          planItemId: item.id,
        })
        return sendJson(res, 200, { item })
      }
      if (op === 'status') {
        const result = core.plan.updateStatus(store, config, projectId, {
          actor,
          planItemId: body.planItemId,
          newStatus: body.newStatus,
          note: body.note,
          delete: body.delete === true,
        })
        if (result?.needHumanConfirmation === true) {
          // A human is already the confirmer, so the gate opens here; the field
          // is echoed so a future non-human caller sees the same contract.
          return sendJson(res, 200, { needHumanConfirmation: false, reason: result.reason, item: result })
        }
        postHumanFeed(projectId, {
          content: `人类把计划条目 ${body.planItemId} 状态改为 ${body.newStatus ?? '（已删除）'}`,
          category: 'plan.status',
          planItemId: body.planItemId,
        })
        return sendJson(res, 200, { item: result })
      }
      if (op === 'priority' || op === 'assign' || op === 'note') {
        const result = core.plan.updateStatus(store, config, projectId, {
          actor,
          planItemId: body.planItemId,
          priority: body.priority,
          assignee: body.assignee,
          note: body.note,
          newStatus: body.newStatus,
        })
        postHumanFeed(projectId, {
          content: `人类调整计划条目 ${body.planItemId}（${op}）`,
          category: 'plan.update',
          planItemId: body.planItemId,
        })
        return sendJson(res, 200, { item: result })
      }
      if (op === 'delete') {
        const result = core.plan.updateStatus(store, config, projectId, {
          actor, planItemId: body.planItemId, delete: true,
        })
        postHumanFeed(projectId, {
          content: `人类删除了计划条目 ${body.planItemId}`,
          category: 'plan.update',
          planItemId: body.planItemId,
        })
        return sendJson(res, 200, { item: result })
      }
      return sendError(res, 400, `未知的 op "${op}"`)
    } catch (error) {
      return sendError(res, 400, String(error?.message ?? error))
    }
  })

  // -------------------------------------------------------------- task ops

  route('exact', `${PREFIX}/api/task`, async (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, '只接受 POST')
    const parsed = await readJson(req, maxBodyBytes())
    if (parsed.ok !== true) return sendError(res, parsed.status, parsed.message)
    const body = asRecord(parsed.json)
    const projectId = isNonEmptyString(body.projectId) ? body.projectId : resolveProject(new URL(req.url, 'http://localhost'))
    if (!isNonEmptyString(projectId)) return sendError(res, 400, '缺少 projectId')
    if (store.getProject(projectId) === undefined) return sendError(res, 404, `项目 ${projectId} 不存在`)

    // A create is the default: the panel posts `{ title, ownerAgent }` without
    // an `op` because "make a task" is what the form means. Requiring the caller
    // to spell out `op: 'create'` made a perfectly ordinary submission fail with
    // `未知的 op ""` — the reported "cannot publish a task".
    const op = isNonEmptyString(body.op) ? body.op : 'create'
    const config = getConfig()
    const actor = humanActor()

    try {
      if (op === 'create') {
        if (core.task === undefined) return sendError(res, 503, 'task 模块不可用')
        const ownerAgent = isNonEmptyString(body.ownerAgent) ? body.ownerAgent : undefined

        /**
         * A task is "one conversation, one workspace, one execution lock".
         * Creating the task without a conversation left it unbound, so the
         * conversation it represents lived outside any project — which is the
         * other half of "I still see conversations from the previous project".
         *
         * When an owner is named, spawn that member's session first and bind it,
         * so the task owns a real conversation from the start.
         */
        let conversationId = isNonEmptyString(body.conversationId) ? body.conversationId : undefined
        let spawnError = ''
        if (conversationId === undefined && ownerAgent !== undefined && teamRuntime !== undefined) {
          try {
            const teamState = core.team.load(store, projectId)
            const seat = (teamState.members ?? []).find((m) => m.name === ownerAgent)
            if (seat !== undefined) {
              if (seat.sessionId !== null && seat.sessionId !== undefined) {
                conversationId = seat.sessionId
              } else {
                const spawned = await teamRuntime.spawn(projectId, ownerAgent)
                conversationId = spawned.sessionId
              }
            }
          } catch (error) {
            spawnError = String(error?.message ?? error)
            log?.(`ai-buddy web: could not bind a conversation to task: ${spawnError}`)
          }
        }

        const task = core.task.create(store, config, projectId, {
          actor,
          title: body.title,
          description: body.description,
          planItemId: body.planItemId,
          ownerAgent,
          conversationId,
          workspace: isNonEmptyString(body.workspace) ? body.workspace : undefined,
        })
        postHumanFeed(projectId, {
          content: `人类创建任务「${task.title}」${task.ownerAgent ? `，指派给 ${task.ownerAgent}` : ''}`,
          category: 'task.create',
          taskId: task.id,
        })
        return sendJson(res, 200, {
          task,
          // Surfaced so the panel can say "the task exists but its session could
          // not be created" instead of pretending everything worked.
          spawnError: spawnError === '' ? null : spawnError,
        })
      }

      if (op === 'unlock') {
        if (core.resume === undefined) return sendError(res, 503, 'resume 模块不可用')
        const taskId = isNonEmptyString(body.taskId) ? body.taskId : ''
        const task = store.readTasks(projectId).find((t) => t.id === taskId)
        if (task === undefined) return sendError(res, 404, `任务 ${taskId} 不存在`)
        if (!isNonEmptyString(task.conversationId)) return sendError(res, 400, '该任务未绑定对话，无法解锁')

        // The human unlock is the ONLY path that clears a locked conversation
        // without a successful trial resume, so it is also the one that decides
        // whether the failure counter resets. `resetCounter` defaults to true:
        // a human who says "I fixed it" is asserting the condition is gone.
        const result = core.resume.releaseLock(
          store, config, projectId, task.conversationId,
          'human',
          { resetCounter: body.resetCounter !== false, trial: body.trial === true },
        )
        if (core.task !== undefined && core.task.read !== undefined) {
          try {
            const fresh = store.readTasks(projectId).find((t) => t.id === taskId)
            if (fresh !== undefined && fresh.status === 'locked_by_interrupt') {
              store.putTask(projectId, { ...fresh, status: 'active', updatedAt: nowIso() })
            }
          } catch (error) {
            log?.(`ai-buddy web: task status refresh failed: ${error?.message ?? error}`)
          }
        }
        postHumanFeed(projectId, {
          content: `人类解除了对话 ${task.conversationId} 的意外中断锁${body.resetCounter !== false ? '，并重置失败计数' : ''}`,
          category: 'human.unlock',
          taskId,
        })
        return sendJson(res, 200, { taskId, lock: result })
      }

      if (op === 'archive') {
        if (core.task === undefined) return sendError(res, 503, 'task 模块不可用')
        const result = core.task.archive(store, config, projectId, { actor, taskId: body.taskId })
        postHumanFeed(projectId, {
          content: `人类归档了任务 ${body.taskId}`,
          category: 'task.archive',
          taskId: body.taskId,
        })
        return sendJson(res, 200, { task: result?.task ?? result })
      }

      if (op === 'take') {
        if (core.locks === undefined) return sendError(res, 503, 'locks 模块不可用')
        /**
         * Ask for a task's execution right.
         *
         * The workbench could always *release* a right but never take one, so
         * the human could not hand a task to a member from the panel — the only
         * way to move the right was for an agent to call
         * `request_execution_lock`. A human watching a task sit idle because
         * nobody took the right had no way to act on it.
         *
         * The holder is the named agent, or the human when none is named.
         */
        const agent = isNonEmptyString(body.agent) ? body.agent : 'human'
        const result = core.locks.request(store, config, projectId, {
          taskId: body.taskId,
          agent,
        })
        postHumanFeed(projectId, {
          content: `人类把任务 ${body.taskId} 的执行权交给了 ${agent}。`,
          category: 'task.transfer',
          taskId: body.taskId,
        })
        return sendJson(res, 200, { result })
      }

      if (op === 'release') {
        if (core.locks === undefined) return sendError(res, 503, 'locks 模块不可用')
        const result = core.locks.release(store, config, projectId, {
          taskId: body.taskId, agent: body.agent ?? 'human',
        })
        postHumanFeed(projectId, {
          content: `人类强制释放了任务 ${body.taskId} 的执行权`,
          category: 'task.transfer',
          taskId: body.taskId,
        })
        return sendJson(res, 200, { result })
      }

      if (op === 'handoff') {
        if (core.task === undefined) return sendError(res, 503, 'task 模块不可用')
        const result = core.task.handoff(store, config, projectId, {
          actor,
          taskId: body.taskId,
          targetAgent: body.targetAgent,
          summary: body.summary,
          artifacts: asStringArray(body.artifacts),
          unfinished: asStringArray(body.unfinished),
        })
        if (result?.feed) {
          try {
            core.feed?.post(store, config, projectId, { ...result.feed, actor })
          } catch (error) {
            log?.(`ai-buddy web: handoff feed failed: ${error?.message ?? error}`)
          }
        }
        return sendJson(res, 200, { result })
      }

      return sendError(res, 400, `未知的 op "${op}"`)
    } catch (error) {
      return sendError(res, 400, String(error?.message ?? error))
    }
  })

  // ------------------------------------------------------------- asset ops

  route('exact', `${PREFIX}/api/asset`, async (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, '只接受 POST')
    const url = new URL(req.url, 'http://localhost')
    const projectParam = url.searchParams.get('project')

    // Metadata travels in the query string when the body is raw bytes, because
    // a multipart parser would be the one dependency this file refuses to take.
    const op = url.searchParams.get('op') ?? ''
    const config = getConfig()
    const actor = humanActor()
    const maxBytes = maxBodyBytes()

    if (op === 'upload' || op === 'update') {
      const body = await readBody(req, maxBytes)
      if (body.ok !== true) return sendError(res, body.status, body.message)
      const projectId = isNonEmptyString(projectParam) ? projectParam : resolveProject(url)
      if (!isNonEmptyString(projectId)) return sendError(res, 400, '缺少 project 参数')
      if (store.getProject(projectId) === undefined) return sendError(res, 404, `项目 ${projectId} 不存在`)
      if (core.assets === undefined) return sendError(res, 503, 'assets 模块不可用')
      const name = url.searchParams.get('name')
      if (!isNonEmptyString(name)) return sendError(res, 400, '缺少 name 参数')
      if (body.buffer.length === 0) return sendError(res, 400, '上传内容为空')

      try {
        const result = core.assets.save(store, config, projectId, {
          actor,
          name,
          folder: url.searchParams.get('folder') ?? '',
          bytes: body.buffer,
          contentType: url.searchParams.get('contentType') ?? 'application/octet-stream',
          sourceTaskId: url.searchParams.get('taskId') ?? undefined,
        })
        if (result?.feed) {
          try {
            core.feed?.post(store, config, projectId, { ...result.feed, actor })
          } catch (error) {
            log?.(`ai-buddy web: asset feed failed: ${error?.message ?? error}`)
          }
        }
        postHumanFeed(projectId, {
          content: `人类上传了资产「${result.asset.name}」`,
          category: 'asset.upload',
          assetId: result.asset.id,
        })
        return sendJson(res, 200, { asset: result.asset })
      } catch (error) {
        return sendError(res, 400, String(error?.message ?? error))
      }
    }

    const parsed = await readJson(req, maxBytes)
    if (parsed.ok !== true) return sendError(res, parsed.status, parsed.message)
    const body = asRecord(parsed.json)
    const projectId = isNonEmptyString(body.projectId) ? body.projectId : resolveProject(url)
    if (!isNonEmptyString(projectId)) return sendError(res, 400, '缺少 projectId')
    if (store.getProject(projectId) === undefined) return sendError(res, 404, `项目 ${projectId} 不存在`)
    if (core.assets === undefined) return sendError(res, 503, 'assets 模块不可用')

    try {
      if (op === 'delete') {
        const result = core.assets.remove(store, config, projectId, {
          actor, assetId: body.assetId, confirmed: true,
        })
        postHumanFeed(projectId, {
          content: `人类删除了资产 ${body.assetId}`,
          category: 'asset.update',
          assetId: body.assetId,
        })
        return sendJson(res, 200, { asset: result?.asset })
      }
      if (op === 'link') {
        const result = core.assets.linkToConversation(store, config, projectId, {
          actor, assetId: body.assetId, taskId: body.taskId,
        })
        postHumanFeed(projectId, {
          content: `人类把资产 ${body.assetId} 引用到任务 ${body.taskId}`,
          category: 'asset.update',
          assetId: body.assetId,
          taskId: body.taskId,
        })
        return sendJson(res, 200, { asset: result?.asset })
      }
      if (op === 'list') {
        const assets = core.assets.query(store, config, projectId, {
          query: body.query, scope: 'all', folder: body.folder, limit: body.limit,
        })
        return sendJson(res, 200, { assets })
      }
      return sendError(res, 400, `未知的 op "${op}"`)
    } catch (error) {
      return sendError(res, 400, String(error?.message ?? error))
    }
  })

  // ------------------------------------------------------- workspace picker

  /**
   * The workspaces that already host a team, plus a directory listing for the
   * picker.
   *
   * Switching collaboration context is switching **directory**: one folder owns
   * one team, one plan, one feed. So the panel opens on a picker rather than on
   * whichever project happened to load first — otherwise a human with two teams
   * would silently edit the wrong one.
   */
  route('exact', `${PREFIX}/api/workspaces`, async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const browse = url.searchParams.get('browse')

    let teams = []
    try {
      teams = store.listTeamWorkspaces()
    } catch (error) {
      log?.(`ai-buddy web: team workspace list failed: ${error?.message ?? error}`)
    }

    // Optional directory browsing for the picker: the Host owns path semantics,
    // so this delegates to the directory-picker controller when it exists and
    // degrades to "a team list only" when it does not.
    let directories
    if (isNonEmptyString(browse)) {
      directories = []
      try {
        const controller = ctx.get('directoryPickerController')
        if (controller !== undefined && typeof controller.list === 'function') {
          const listing = await controller.list(browse, new AbortController().signal)
          directories = (listing?.entries ?? []).map((entry) => ({
            name: entry.name ?? '',
            path: entry.path ?? '',
            isDirectory: entry.kind === 'directory' || entry.isDirectory === true,
          }))
        }
      } catch (error) {
        log?.(`ai-buddy web: directory browse failed: ${error?.message ?? error}`)
      }
    }

    return sendJson(res, 200, {
      teams,
      ...(directories === undefined ? {} : { directories, browsing: browse }),
      current: (() => {
        try {
          const requested = url.searchParams.get('project')
          if (isNonEmptyString(requested)) return requested
          const projectId = store.defaultProjectId()
          return projectId ?? null
        } catch {
          return null
        }
      })(),
    })
  })

  // -------------------------------------------------------------- team ops

  /**
   * The models a human may pick when initializing the team.
   *
   * Read from `llm` — the same registry the Host's own model picker uses — so
   * the list can never drift from what the deployment actually offers. The
   * current default is returned alongside it so the panel can preselect it.
   *
   * `listProviders()` is synchronous and returns `{id, name}`; `listModels(id)`
   * is **async** and adapter-backed, so the two cannot be walked in one loop
   * without awaiting. Both halves degrade to empty rather than failing: a Host
   * that exposes no model list still lets the human pick from the remaining
   * providers, and a total failure leaves the panel usable.
   */
  route('exact', `${PREFIX}/api/models`, async (req, res) => {
    const result = { models: [], default: null }
    try {
      const llm = ctx.get('llm')
      const agentDefaultModel = ctx.get('agentDefaultModel')

      if (agentDefaultModel !== undefined && typeof agentDefaultModel.currentSelection === 'function') {
        const current = agentDefaultModel.currentSelection()
        if (current !== null && current !== undefined) {
          result.default = {
            provider: current.provider ?? '',
            model: current.model ?? '',
            reasoningEffort: current.reasoningEffort ?? '',
          }
        }
      }

      if (llm !== undefined && typeof llm.listProviders === 'function') {
        const providers = llm.listProviders()
        for (const provider of Array.isArray(providers) ? providers : []) {
          const providerId = provider?.id ?? provider?.name ?? ''
          if (!isNonEmptyString(providerId)) continue
          let models = []
          if (typeof llm.listModels === 'function') {
            try {
              models = (await llm.listModels(providerId)) ?? []
            } catch (error) {
              // A provider whose adapter cannot enumerate models still gets one
              // entry, so the human can still choose it by name.
              log?.(`ai-buddy web: listModels(${providerId}) failed: ${error?.message ?? error}`)
              models = []
            }
          }
          for (const model of models) {
            const modelId = model?.id ?? model?.name ?? ''
            if (!isNonEmptyString(modelId)) continue
            result.models.push({
              provider: providerId,
              providerName: provider?.name ?? providerId,
              model: modelId,
              name: isNonEmptyString(model.name) ? model.name : modelId,
              description: isNonEmptyString(model.description) ? model.description : null,
            })
          }
        }
      }
    } catch (error) {
      log?.(`ai-buddy web: model catalogue read failed: ${error?.message ?? error}`)
    }
    return sendJson(res, 200, result)
  })

  route('exact', `${PREFIX}/api/team`, async (req, res) => {
    if (req.method !== 'POST') return sendError(res, 405, '只接受 POST')
    const parsed = await readJson(req, maxBodyBytes())
    if (parsed.ok !== true) return sendError(res, parsed.status, parsed.message)
    const body = asRecord(parsed.json)
    const requestedProjectId = isNonEmptyString(body.projectId)
      ? body.projectId
      : resolveProject(new URL(req.url, 'http://localhost'))

    // `initialize` is the one op that may legitimately arrive without a project:
    // it is the OOBE page talking, and on a fresh workspace no project exists
    // yet. That op creates the project itself; every other op needs one.
    const op = isNonEmptyString(body.op) ? body.op : ''
    if (op !== 'initialize' && !isNonEmptyString(requestedProjectId)) {
      return sendError(res, 400, '缺少 projectId')
    }
    const projectId = requestedProjectId
    if (isNonEmptyString(projectId) && store.getProject(projectId) === undefined) {
      return sendError(res, 404, `项目 ${projectId} 不存在`)
    }
    if (core.team === undefined) return sendError(res, 503, 'team 模块不可用')
    const config = getConfig()

    try {
      if (op === 'initialize') {
        // Human-only, by construction: this route is the workbench's, and the
        // brief requires that a human decides when the team starts costing
        // tokens. No agent tool calls this path.
        const workspace = isNonEmptyString(body.workspace) ? body.workspace : undefined
        if (workspace === undefined) {
          return sendError(res, 400, '必须选择工作区：所有 AI 会话都会建在这个目录下。')
        }
        const model = asRecord(body.model)
        if (!isNonEmptyString(model.provider) || !isNonEmptyString(model.model)) {
          return sendError(res, 400, '必须选择 leader 的模型：团队所有成员都会继承它。')
        }

        // One directory owns one team. If this directory already hosts a team,
        // this call is a "switch to it" request rather than a second init —
        // re-initializing would either fail or silently fork a duplicate
        // collaboration space on the same folder.
        const existingProjectId = store.findProjectByWorkspace(workspace)
        if (existingProjectId !== undefined) {
          const existing = core.team.load(store, existingProjectId)
          return sendJson(res, 200, {
            projectId: existingProjectId,
            team: core.team.view(existing, teamRuntime?.liveAgentMap?.() ?? new Map()),
            sessionId: '',
            spawnError: '',
            reused: true,
          })
        }

        // A workspace with no team yet: reuse the requested project if it is
        // still empty, otherwise create a fresh one so the two teams never share
        // a plan, a feed, or an asset manifest.
        const targetProjectId = isNonEmptyString(body.projectId) && body.reuseProject === true
          ? body.projectId
          : createProjectForWorkspace(workspace)

        const team = core.team.initialize(store, targetProjectId, {
          leaderName: isNonEmptyString(body.leaderName) ? body.leaderName : 'leader',
          title: isNonEmptyString(body.title) ? body.title : undefined,
          workspace,
          model,
          // Optional: what newly recruited members run on. Defaults to the
          // leader's model when omitted.
          memberModel: asRecord(body.memberModel),
          // Optional: the human's own instructions, appended to the leader's
          // built-in brief rather than replacing it.
          leaderBrief: typeof body.leaderBrief === 'string' ? body.leaderBrief : '',
        })
        let sessionId
        let spawnError
        if (teamRuntime !== undefined && typeof teamRuntime.spawn === 'function') {
          try {
            const spawned = await teamRuntime.spawn(targetProjectId, team.members[0].name)
            sessionId = spawned.sessionId
          } catch (error) {
            spawnError = String(error?.message ?? error)
            log?.(`ai-buddy web: leader spawn failed: ${spawnError}`)
          }
        }
        postHumanFeed(targetProjectId, {
          content:
            `团队已初始化，领导者为 ${team.members[0].name}，模型 ${model.provider}/${model.model}，` +
            `工作区 ${workspace}。`,
          category: 'team.join',
        })
        return sendJson(res, 200, {
          projectId: targetProjectId,
          team: core.team.view(core.team.load(store, targetProjectId), new Map()),
          sessionId,
          spawnError,
          reused: false,
        })
      }

      if (op === 'add') {
        const team = core.team.addMember(store, projectId, {
          name: body.name,
          title: body.title,
          reportsTo: body.reportsTo,
          workspace: body.workspace,
        })
        let sessionId
        let spawnError
        if (teamRuntime !== undefined && typeof teamRuntime.spawn === 'function') {
          try {
            const spawned = await teamRuntime.spawn(projectId, body.name)
            sessionId = spawned.sessionId
          } catch (error) {
            spawnError = String(error?.message ?? error)
          }
        }
        postHumanFeed(projectId, {
          content: `人类引入了新成员 ${body.name}${body.title ? `（${body.title}）` : ''}。`,
          category: 'team.join',
        })
        return sendJson(res, 200, { team, sessionId, spawnError })
      }

      if (op === 'remove') {
        let backup
        if (teamRuntime !== undefined && typeof teamRuntime.backupConversation === 'function') {
          backup = await teamRuntime.backupConversation(projectId, body.name)
        }
        const team = core.team.removeMember(store, projectId, { name: body.name })
        postHumanFeed(projectId, {
          content:
            `人类移除了成员 ${body.name}。` +
            (backup?.backedUp ? `对话已备份为资产 \`${backup.assetId}\`。` : ''),
          category: 'team.remove',
          assetId: backup?.assetId ?? undefined,
        })
        return sendJson(res, 200, { team, backup })
      }

      if (op === 'sleep') {
        const result = await teamRuntime.sleep(projectId, body.name, body.reason ?? '')
        postHumanFeed(projectId, { content: `人类让 ${body.name} 进入休眠。`, category: 'team.review' })
        return sendJson(res, 200, { result })
      }

      /**
       * Release a member's agent for good.
       *
       * `sleep` parks a member that is waiting on a human and keeps its seat
       * resumable; it refuses the leader, because the leader must stay awake to
       * coordinate. `dispose` is the teardown path: it releases the agent for
       * any role, including the leader, and the seat no longer points at a
       * live session.
       *
       * It exists because without it there is no way to take a team down: a
       * finished team — or a test run — would keep its agent alive, holding an
       * open session log and burning tokens.
       */
      if (op === 'dispose') {
        const result = await teamRuntime.dispose(projectId, body.name, body.reason ?? '')
        postHumanFeed(projectId, {
          content: `人类释放了 ${body.name} 的会话${body.reason ? `（${body.reason}）` : ''}。`,
          category: 'team.review',
        })
        return sendJson(res, 200, { result })
      }

      if (op === 'wake') {
        const result = await teamRuntime.wake(projectId, body.name)
        postHumanFeed(projectId, { content: `人类唤醒了 ${body.name}。`, category: 'team.review' })
        return sendJson(res, 200, { result })
      }

      if (op === 'review') {
        const team = core.team.review(store, projectId, {
          name: body.name,
          by: 'human',
          score: body.score,
          verdict: body.verdict,
          advice: body.advice,
        })
        return sendJson(res, 200, { team })
      }

      if (op === 'setLeader') {
        const team = core.team.setLeader(store, projectId, { name: body.name })
        postHumanFeed(projectId, { content: `${body.name} 被指定为新的团队领导者。`, category: 'team.join' })
        return sendJson(res, 200, { team })
      }

      if (op === 'decide') {
        // The human may also adjudicate a pending request; the leader's tool is
        // not the only path, because a stuck leader must not block the team.
        const request = core.requests.resolve(store, config, projectId, {
          requestId: body.requestId,
          status: body.decision === 'reject' ? 'rejected' : 'approved',
          decidedBy: 'human',
          assignee: body.assignee,
          reason: body.reason ?? '',
        })
        postHumanFeed(projectId, {
          content: `人类裁决了协作请求「${request.title}」：${body.decision === 'reject' ? '打回' : '批准'}`,
          category: body.decision === 'reject' ? 'team.reject' : 'team.approve',
        })
        return sendJson(res, 200, { request })
      }

      return sendError(res, 400, `未知的 op "${op}"`)
    } catch (error) {
      return sendError(res, 400, String(error?.message ?? error))
    }
  })

  // ------------------------------------------------------------- config ops

  route('exact', `${PREFIX}/api/config`, async (req, res) => {
    if (req.method === 'GET') return sendJson(res, 200, { config: getConfig() })
    if (req.method !== 'POST') return sendError(res, 405, '只接受 GET 或 POST')
    const parsed = await readJson(req, maxBodyBytes())
    if (parsed.ok !== true) return sendError(res, parsed.status, parsed.message)
    const patch = asRecord(parsed.json)
    const live = getConfig()

    // Shallow-merge per section. The live object is mutated in place so the
    // tools, which captured it at apply time, see the change without a reload.
    for (const [key, value] of Object.entries(patch)) {
      if (key === '_env') continue
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof live[key] === 'object' && live[key] !== null) {
        Object.assign(live[key], value)
      } else if (key in live) {
        live[key] = value
      }
    }
    return sendJson(res, 200, { config: live })
  })

  // ------------------------------------------------------- SSE invalidation

  route('exact', `${PREFIX}/api/events`, (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const projectFilter = url.searchParams.get('project')

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    res.write(': ai-buddy connected\n\n')

    let closed = false
    let pending = null

    // Coalesce bursts: ten tool calls in one second must not produce ten full
    // state refetches in the page.
    const notify = (projectId) => {
      if (closed) return
      if (isNonEmptyString(projectFilter) && projectId !== projectFilter) return
      if (pending !== null) return
      pending = setTimeout(() => {
        pending = null
        if (closed) return
        try {
          res.write(`event: invalidate\ndata: ${JSON.stringify({ projectId, at: nowIso() })}\n\n`)
        } catch {
          cleanup()
        }
      }, 250)
    }

    const unsubscribe = store.onChange(notify)
    const keepalive = setInterval(() => {
      if (closed) return
      try {
        res.write(': keepalive\n\n')
      } catch {
        cleanup()
      }
    }, SSE_KEEPALIVE_MS)
    if (typeof keepalive.unref === 'function') keepalive.unref()

    function cleanup() {
      if (closed) return
      closed = true
      clearInterval(keepalive)
      if (pending !== null) clearTimeout(pending)
      try {
        unsubscribe()
      } catch {
        /* already gone */
      }
      try {
        res.end()
      } catch {
        /* already gone */
      }
    }

    req.on('close', cleanup)
    req.on('aborted', cleanup)
    res.on('close', cleanup)
  })

  const disposeAll = () => {
    for (const disposer of disposers.splice(0)) {
      try {
        disposer()
      } catch {
        /* already removed */
      }
    }
  }
  return disposeAll
}
