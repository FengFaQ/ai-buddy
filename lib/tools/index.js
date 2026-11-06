/**
 * The Agent-facing surface: exactly the 20 tools the brief fixes in §5.
 *
 * Three rules shape every definition here:
 *
 * 1. **Bounded results.** Every tool returns ids plus a short summary, never a
 *    whole document. An agent that needs detail calls the matching read tool
 *    with a narrower filter. This is what keeps a busy project from blowing a
 *    context window on a feed dump.
 *
 * 2. **The store is the only truth.** Tools never cache; they read the same
 *    JSON the human workbench reads, so an AI and the human always agree.
 *
 * 3. **Writes leave evidence.** A tool that changes state also writes the feed
 *    event or checkpoint the brief requires for that change, in the same
 *    synchronous step, so no crash can leave state changed but unrecorded.
 *
 * Naming is fixed by the brief and must not drift: the design document, the
 * workbench and the tests all address these exact names.
 */

import { asRecord, asStringArray, isNonEmptyString, newId, nowIso, clip } from '../util.js'

const FEED_CATEGORIES = [
  'agent.join', 'agent.leave', 'asset.upload', 'asset.update',
  'task.create', 'task.handoff', 'task.archive',
  'plan.create', 'plan.update', 'plan.status',
  'task.share', 'task.transfer', 'execution.handoff',
  'human.instruction', 'human.priority', 'human.pause', 'human.resume',
  'human.unlock', 'human.reply',
  'resume.start', 'resume.summary', 'resume.skip', 'resume.failure',
  'lock.engaged', 'lock.released',
]

const PLAN_STATUSES = ['pending', 'in_progress', 'paused', 'done', 'locked_by_interrupt']

function fail(message) {
  throw new Error(message)
}

function requireString(args, key, hint) {
  const value = asRecord(args)[key]
  if (!isNonEmptyString(value)) fail(`${key} 必填：${hint}`)
  return String(value).trim()
}

function optionalString(args, key) {
  const value = asRecord(args)[key]
  return isNonEmptyString(value) ? String(value).trim() : undefined
}

/** A text-only tool output: the model sees `render`'s blocks, the UI sees `value`. */
function textOutput(schema, render) {
  return { schema, render }
}

/**
 * Make a tool result lossless JSON.
 *
 * The Host rejects a tool value that is not lossless JSON, and `undefined` is
 * the one value that breaks it: a property whose value is `undefined` is
 * dropped by `JSON.stringify` but is not a JSON value, so the Host's
 * `structuredClone`-based check rejects the whole call with
 * "value is not lossless JSON" — after the tool already did its work.
 *
 * Every tool here is written to return "fields that may be absent" as
 * `undefined`, which is idiomatic JS and the wrong choice at this boundary.
 * Sanitizing once, in the registration wrapper, is what keeps a later tool from
 * reintroducing the bug: a new `?? undefined` cannot reach the wire.
 */
function jsonSafe(value) {
  if (value === undefined) return null
  if (value === null) return null
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function' || typeof value === 'symbol') return null
  if (typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue
      out[key] = jsonSafe(entry)
    }
    return out
  }
  return value
}

function renderSummary(lines) {
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

/**
 * Build the tool definitions.
 *
 * `deps` is supplied by `lib/index.js`; see CONTRACT.md §8. Every function here
 * closes over it, so a tool call never has to rediscover the project or the
 * actor identity.
 */
export function createToolDefinitions(deps) {
  const {
    store, config, core, log,
    actorFor, projectIdFor, conversationFor,
  } = deps

  /** Resolve the project for this call, failing with an actionable message. */
  function projectOf(agent) {
    const projectId = projectIdFor(agent)
    if (!isNonEmptyString(projectId)) {
      fail('当前会话没有绑定任何项目。请先由人类在工作台创建项目，或先调用 create_conversation 绑定本项目。')
    }
    if (store.getProject(projectId) === undefined) {
      fail(`项目 ${projectId} 不存在（可能已被删除）。请调用 read_plan 或 read_feed 确认当前可用项目。`)
    }
    return projectId
  }

  /** The actor record for a tool call: `{ type, id, name }`. */
  function actorOf(agent) {
    try {
      return actorFor(agent)
    } catch {
      return { type: 'agent', id: String(agent?.id ?? 'unknown'), name: 'agent' }
    }
  }

  /** The task bound to the calling conversation, if any. */
  function boundTask(projectId, agent) {
    const conversationId = conversationFor(agent)
    if (!isNonEmptyString(conversationId)) return undefined
    return store.readTasks(projectId).find((t) => t.conversationId === conversationId)
  }

  /**
   * Resolve which task the caller means.
   *
   * Three ways to say it, most explicit first:
   *
   *   1. an explicit `conversation_id` argument (which is really a task id);
   *   2. the task bound to the caller's conversation;
   *   3. the caller's own open task — resolved by **owner name**, because a
   *      team member's session is bound through the roster (`team.bindSession`),
   *      not through `task.conversationId`. BUG-2 in the field report was this
   *      path missing: a member that did not know its task id could not take
   *      the execution right at all, so the team could not self-organise.
   *
   * When nothing resolves, the failure lists the open tasks — an error that
   * says "pass an id" without saying which ids exist just moves the dead-end
   * one message later.
   */
  function resolveTaskId(projectId, agent, explicit) {
    if (isNonEmptyString(explicit)) return explicit
    const actor = actorOf(agent)
    const bound = boundTask(projectId, agent)
    if (bound !== undefined) return bound.id
    const owned = store
      .readTasks(projectId)
      .filter((t) => t.ownerAgent === actor.name && t.status !== 'archived')
    if (owned.length === 1) return owned[0].id
    const open = store
      .readTasks(projectId)
      .filter((t) => t.status === 'active')
      .map((t) => `\`${t.id}\`「${t.title}」(owner: ${t.ownerAgent ?? '—'})`)
    fail(
      '无法确定对话 id：该会话没有绑定任务，也没有恰好一个以你为负责人的任务。' +
        (open.length > 0
          ? `当前活跃任务：${open.join('；')}。请显式传 conversation_id。`
          : '项目中没有活跃任务。请先由人类创建任务，或调用 create_conversation。'),
    )
  }

  /**
   * Write the checkpoint the brief requires after each collaboration-critical
   * node (§7.1). Failures here are logged, never surfaced: a checkpoint is
   * evidence, and losing evidence must not undo a change the human can see.
   */
  function checkpoint(projectId, agent, spec) {
    if (core?.checkpoint?.write === undefined) return undefined
    try {
      const conversationId = spec.conversationId ?? conversationFor(agent) ?? 'unbound'
      return core.checkpoint.write(store, config, projectId, {
        conversationId,
        taskId: spec.taskId,
        eventType: spec.eventType,
        triggerAgent: actorOf(agent).name,
        lastOperation: spec.lastOperation,
        contextSummary: spec.contextSummary,
        nextExpectedActor: spec.nextExpectedActor,
        feedEventIds: spec.feedEventIds ?? [],
      })
    } catch (error) {
      log?.(`ai-buddy: checkpoint failed (${spec.eventType}): ${error?.message ?? error}`)
      return undefined
    }
  }

  // ------------------------------------------------------------- feed tools

  const postUpdateToFeed = {
    name: 'post_update_to_feed',
    description:
      '向项目动态流发布一条进展/阻塞/产物/计划变更通知。队友 Agent 和人类都会看到。' +
      '这是 AI 主动发言（区别于系统自动事件），受速率限制：超过配置的每分钟条数会被拒绝，' +
      '此时应合并信息后再发，而不是重试原样内容。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要发布的内容。写清楚做了什么、结论是什么、下一步是谁。不要贴大段文件内容，贴路径或资产 id。' },
        category: { type: 'string', enum: FEED_CATEGORIES, description: `分类。常用：plan.update（计划变更）、task.handoff（移交）、asset.upload（产物落地）、human.reply（回复人类）。默认 agent.leave 不适用，省略时按 agent 主动播报处理。` },
        task_id: { type: 'string', description: '可选：关联的任务 id。' },
        plan_item_id: { type: 'string', description: '可选：关联的计划条目 id。' },
        asset_id: { type: 'string', description: '可选：关联的资产 id。' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { event_id: { type: 'string' }, at: { type: 'string' }, summary: { type: 'string' } }, required: ['event_id', 'summary'], additionalProperties: false },
      (_args, value) => renderSummary([`已发布动态 \`${value.event_id}\`（${value.at}）`, value.summary]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const content = requireString(args, 'content', '必须写清楚发布什么')
      const category = optionalString(args, 'category') ?? 'plan.update'
      const result = core.feed.post(store, config, projectId, {
        actor,
        content,
        category,
        source: 'agent',
        taskId: optionalString(args, 'task_id'),
        planItemId: optionalString(args, 'plan_item_id'),
        assetId: optionalString(args, 'asset_id'),
      })
      if (result?.throttled === true) {
        fail(`动态发布已被告知节流（每分钟上限 ${config.feed.aiPostsPerMinute} 条）。请合并成一条更完整的信息后再发，不要重试原样内容。`)
      }
      return {
        event_id: result.event.id,
        at: result.event.at,
        summary: clip(content, 200),
      }
    },
  }

  const readFeed = {
    name: 'read_feed',
    description:
      '读取项目动态流（谁在什么时候做了什么）。恢复任务时**第一步就应该调用它**，' +
      '用来发现自你上次检查点以来其他 Agent 或人类做了什么。返回最近的若干条事件，' +
      '用 `since_checkpoint` 只看增量可显著减少 token。',
    parameters: {
      type: 'object',
      properties: {
        since_checkpoint: { type: 'string', description: '可选：检查点 id 或动态事件 id。传检查点 id 时只返回该检查点之后的事件；传事件 id 时只返回其后的事件。' },
        limit: { type: 'number', description: '返回条数，默认 20，最大 100。' },
        include_pinned: { type: 'boolean', description: '是否额外返回置顶的锁定事件，默认 true。锁定事件优先级高，建议保持开启。' },
      },
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { events: { type: 'array', items: { type: 'object' } }, count: { type: 'number' }, note: { type: 'string' } }, required: ['events', 'count'], additionalProperties: false },
      (_args, value) => renderSummary([
        `动态流返回 ${value.count} 条${value.note ? `（${value.note}）` : ''}`,
        ...value.events.map((e) => [
          `- [${e.at}] ${e.actor?.name ?? '?'} · ${e.category}`,
          // Full content, indented under its header. BUG-5 in the field
          // report: a 160-character clip cut a leader's adjudication off
          // after its first line, and the member had to ask for a resend.
          // The feed is the team's only shared channel, so what one agent
          // writes here is what another agent reads — clipping it here is
          // clipping the collaboration itself.
          ...String(e.content ?? '').split('\n').map((line) => `    ${line}`),
        ]).flat(),
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const limit = Math.min(100, Math.max(1, Number(asRecord(args).limit) || 20))
      const since = optionalString(args, 'since_checkpoint')

      // `since_checkpoint` accepts both spellings the agent might use: a real
      // feed event id, or a checkpoint id. A checkpoint is resolved to the last
      // feed event it recorded — that is the precise position it saw. Falling
      // back to its timestamp would re-read events it had already absorbed when
      // several events share that second.
      let sinceEventId = since
      let sinceTime
      if (since !== undefined && since.startsWith('cp_')) {
        const conversationId = conversationFor(exec.agent)
          ?? store.readTasks(projectId).find((t) => t.id === boundTask(projectId, exec.agent)?.id)?.conversationId
        let checkpoint
        if (isNonEmptyString(conversationId)) {
          checkpoint = store.latestCheckpoint(projectId, conversationId)
        }
        const ids = Array.isArray(checkpoint?.feed_event_ids) ? checkpoint.feed_event_ids : []
        if (ids.length > 0) {
          sinceEventId = ids[ids.length - 1]
        } else {
          // No feed ids recorded: fall back to the checkpoint's timestamp so the
          // agent still gets only what happened after it, never a full replay.
          sinceEventId = undefined
          sinceTime = checkpoint?.timestamp
        }
      }

      const events = core.feed.read(store, config, projectId, {
        sinceEventId,
        sinceTime,
        limit,
        includePinned: asRecord(args).include_pinned !== false,
      })
      return {
        events: events.map((e) => ({
          id: e.id, at: e.at, category: e.category, actor: e.actor,
          kind: e.kind,
          // Generous but bounded: the field report's BUG-5 was an adjudication
          // truncated to its first line. 4000 characters covers any real
          // message while keeping one pathological post from flooding a turn.
          content: clip(e.content, 4000), pinned: e.pinned === true,
        })),
        count: events.length,
        ...(since ? { note: `自 ${since} 之后` } : {}),
      }
    },
  }

  // ------------------------------------------------------------- plan tools

  const createPlanItem = {
    name: 'create_plan_item',
    description:
      '在项目计划看板中创建一个条目。适用于事前计划（先出方案供人类确认）和事中计划' +
      '（执行中发现需要新增工作项）。创建时应写清依赖，看板会自动推导“上游阻塞”。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '条目标题，一句话说清要交付什么。' },
        description: { type: 'string', description: '可选：验收标准、范围边界。' },
        assignee: { type: 'string', description: '可选：负责 Agent 名。省略 = 待指派。' },
        depends_on: { type: 'array', items: { type: 'string' }, description: '可选：前置计划条目 id 列表。' },
        priority: { type: 'number', description: '0-3，3 最高，默认 1。' },
        due_at: { type: 'string', description: '可选：截止时间 ISO8601。' },
        mode: { type: 'string', enum: ['pre', 'live'], description: 'pre = 事前计划（供人类确认），live = 事中计划（执行中动态更新），默认 live。' },
        task_id: { type: 'string', description: '可选：绑定到已存在的任务 id。' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { plan_item_id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' }, blocked_by: { type: 'array', items: { type: 'string' } } }, required: ['plan_item_id', 'status'], additionalProperties: false },
      (_args, value) => renderSummary([
        `已创建计划条目 \`${value.plan_item_id}\`（${value.title}），状态 ${value.status}`,
        value.blocked_by?.length ? `上游未完成，被阻塞于：${value.blocked_by.join('、')}` : '',
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const item = core.plan.create(store, config, projectId, {
        actor: actorOf(exec.agent),
        title: requireString(args, 'title', '条目必须有标题'),
        description: optionalString(args, 'description'),
        assignee: optionalString(args, 'assignee'),
        dependsOn: asStringArray(asRecord(args).depends_on),
        priority: Number(asRecord(args).priority ?? 1),
        dueAt: optionalString(args, 'due_at'),
        mode: optionalString(args, 'mode') === 'pre' ? 'pre' : 'live',
        taskId: optionalString(args, 'task_id'),
      })
      checkpoint(projectId, exec.agent, {
        taskId: item.taskId,
        eventType: 'plan_update',
        lastOperation: { type: 'plan_update', targetRef: item.id, resultStatus: 'confirmed' },
        contextSummary: `创建计划条目「${item.title}」`,
        nextExpectedActor: item.assignee ?? 'human',
        feedEventIds: item.feedEventId ? [item.feedEventId] : [],
      })
      return {
        plan_item_id: item.id,
        title: item.title,
        status: item.status,
        blocked_by: item.blockedBy ?? [],
      }
    },
  }

  const updatePlanStatus = {
    name: 'update_plan_status',
    description:
      '更新计划条目状态。写入权规则：只有该条目绑定任务的当前执行权持有者，或人类，可以改状态。' +
      '状态变更会写入动态流并立即反映到看板。被意外中断锁锁定的条目在解锁前不能改为其他状态。',
    parameters: {
      type: 'object',
      properties: {
        plan_item_id: { type: 'string', description: '计划条目 id。' },
        new_status: { type: 'string', enum: PLAN_STATUSES, description: '新状态。' },
        note: { type: 'string', description: '可选：变更说明，会记入条目并在看板展示。' },
      },
      required: ['plan_item_id', 'new_status'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { plan_item_id: { type: 'string' }, status: { type: 'string' }, need_human: { type: 'boolean' }, reason: { type: 'string' } }, required: ['plan_item_id', 'status'], additionalProperties: false },
      (_args, value) => renderSummary([
        `计划条目 \`${value.plan_item_id}\` 状态 → ${value.status}`,
        value.need_human ? `需要人类确认：${value.reason}` : '',
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const planItemId = requireString(args, 'plan_item_id', '必须指定计划条目')
      const newStatus = requireString(args, 'new_status', `必须是 ${PLAN_STATUSES.join('/')} 之一`)
      if (!PLAN_STATUSES.includes(newStatus)) fail(`new_status 只能是 ${PLAN_STATUSES.join(', ')}`)
      const result = core.plan.updateStatus(store, config, projectId, {
        actor: actorOf(exec.agent),
        planItemId,
        newStatus,
        note: optionalString(args, 'note'),
      })
      if (result?.needHumanConfirmation === true) {
        return { plan_item_id: planItemId, status: result.currentStatus ?? 'unknown', need_human: true, reason: result.reason ?? '需要人类确认' }
      }
      checkpoint(projectId, exec.agent, {
        taskId: result.taskId,
        eventType: 'status_change',
        lastOperation: { type: 'plan_update', targetRef: planItemId, resultStatus: 'confirmed' },
        contextSummary: `计划条目 ${planItemId} 状态改为 ${newStatus}`,
        nextExpectedActor: result.assignee ?? 'human',
      })
      // A completed item may unblock everything downstream; refresh the view
      // the next reader sees rather than making them recompute it.
      core.plan.recomputeBlocking(store, projectId)
      return { plan_item_id: planItemId, status: newStatus, need_human: false }
    },
  }

  const readPlan = {
    name: 'read_plan',
    description:
      '读取项目计划看板。返回条目状态、负责人、依赖与阻塞情况。执行前用它确认自己负责什么、' +
      '前置条目是否已完成；恢复时用它核对计划是否已被其他 Agent 改动。',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', enum: ['all', 'mine', 'blocked', 'locked', 'open'], description: 'all=全部（默认）；mine=我负责的；blocked=被上游阻塞的；locked=因中断锁定的；open=未完成的。' },
        limit: { type: 'number', description: '返回条数，默认 50，最大 200。' },
      },
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, count: { type: 'number' } }, required: ['items', 'count'], additionalProperties: false },
      (_args, value) => renderSummary([
        `计划返回 ${value.count} 项`,
        ...value.items.slice(0, 60).map((i) => `- \`${i.id}\` [${i.status}] ${i.title} — ${i.assignee ?? '待指派'}${i.blockedBy?.length ? `（上游阻塞：${i.blockedBy.join('、')}）` : ''}`),
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const filter = optionalString(args, 'filter') ?? 'all'
      const limit = Math.min(200, Math.max(1, Number(asRecord(args).limit) || 50))
      const actor = actorOf(exec.agent)

      // The board's own filter vocabulary is narrower than the tool's, because
      // "mine" and "locked" are questions about the caller and the board state,
      // not about a stored field. Mapping here keeps `core/plan.js` free of
      // tool-specific vocabulary.
      const query = {}
      if (filter === 'mine') query.assignee = actor.name
      else if (filter === 'blocked') query.blocked = true
      else if (filter === 'open') query.status = 'open'
      let items = core.plan.read(store, config, projectId, query)
      if (filter === 'locked') items = items.filter((i) => i.status === 'locked_by_interrupt')
      items = items.slice(0, limit)

      return {
        items: items.map((i) => ({
          id: i.id, title: i.title, status: i.status, assignee: i.assignee,
          priority: i.priority, dependsOn: i.dependsOn, blockedBy: i.blockedBy,
          taskId: i.taskId, dueAt: i.dueAt, mode: i.mode,
        })),
        count: items.length,
      }
    },
  }

  // ------------------------------------------------------------- task tools

  const createConversation = {
    name: 'create_conversation',
    description:
      '创建一个新的协作任务（对应一个新对话/工作空间）。可以绑定计划条目，并挂载资产作为上下文。' +
      '创建后你会获得该任务的执行权。子任务可用它把上下文打包传给新对话。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题。' },
        description: { type: 'string', description: '可选：任务说明与验收标准。' },
        plan_item_id: { type: 'string', description: '可选：绑定的计划条目 id。' },
        owner_agent: { type: 'string', description: '可选：负责 Agent 名，默认自己。' },
        workspace: { type: 'string', description: '可选：工作目录绝对路径。' },
        asset_ids: { type: 'array', items: { type: 'string' }, description: '可选：创建时挂载的资产 id 列表（作为 RAG 上下文）。' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { task_id: { type: 'string' }, plan_item_id: { type: 'string' }, owner_agent: { type: 'string' }, mounted_assets: { type: 'array', items: { type: 'string' } } }, required: ['task_id', 'owner_agent'], additionalProperties: false },
      (_args, value) => renderSummary([
        `已创建任务 \`${value.task_id}\`，负责 Agent：${value.owner_agent}`,
        value.plan_item_id ? `绑定计划条目 \`${value.plan_item_id}\`` : '',
        value.mounted_assets?.length ? `已挂载资产：${value.mounted_assets.join('、')}` : '',
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const assetIds = asStringArray(asRecord(args).asset_ids)

      // Idempotency (§7.3 conversation_create): if an identical open task
      // already exists under the same plan item, return it instead of minting
      // a second conversation. This is the check that prevents a resumed agent
      // from fanning out duplicate work.
      const planItemId = optionalString(args, 'plan_item_id')
      const title = requireString(args, 'title', '任务必须有标题')
      if (planItemId) {
        const existing = store.readTasks(projectId).find(
          (t) => t.planItemId === planItemId && t.title === title && t.status !== 'archived',
        )
        if (existing !== undefined) {
          return {
            task_id: existing.id,
            plan_item_id: existing.planItemId,
            owner_agent: existing.ownerAgent ?? actor.name,
            mounted_assets: [],
            note: '同计划条目下已存在同名任务，未重复创建（幂等守卫）',
          }
        }
      }

      const task = core.task.create(store, config, projectId, {
        actor,
        title,
        description: optionalString(args, 'description'),
        planItemId,
        ownerAgent: optionalString(args, 'owner_agent') ?? actor.name,
        workspace: optionalString(args, 'workspace'),
      })
      for (const assetId of assetIds) {
        try {
          core.assets.linkToConversation(store, config, projectId, { actor, assetId, taskId: task.id })
        } catch (error) {
          log?.(`ai-buddy: mount asset ${assetId} failed: ${error?.message ?? error}`)
        }
      }

      // The description promises "创建后你会获得该任务的执行权" — so the tool
      // must actually take it. An owner without the right could not even mark
      // its own plan item in progress, which is how a freshly created
      // conversation dead-locked before its first step. The right is granted
      // to the owner at creation time by `task.create` itself, so this call is
      // normally a no-op confirmation; taking it here covers the case where
      // another agent already holds it (the queue is the honest outcome).
      let lockNote = ''
      try {
        const lock = core.locks.request(store, config, projectId, {
          taskId: task.id,
          agent: task.ownerAgent ?? actor.name,
        })
        if (lock?.acquired !== true) {
          lockNote = `执行权当前归 ${lock?.holder ?? '?'} 所有，你排在第 ${lock?.position ?? '?'} 位`
        }
      } catch (error) {
        lockNote = `执行权请求失败：${error?.message ?? error}`
      }

      checkpoint(projectId, exec.agent, {
        taskId: task.id,
        eventType: 'status_change',
        lastOperation: { type: 'conversation_create', targetRef: task.id, resultStatus: 'confirmed' },
        contextSummary: `创建任务「${task.title}」`,
        nextExpectedActor: task.ownerAgent ?? actor.name,
      })
      return {
        task_id: task.id,
        plan_item_id: task.planItemId ?? undefined,
        owner_agent: task.ownerAgent ?? actor.name,
        mounted_assets: assetIds,
        ...(lockNote === '' ? {} : { note: lockNote }),
      }
    },
  }

  const handoffConversation = {
    name: 'handoff_conversation',
    description:
      '把执行权、产物、进度摘要和未完成事项移交给另一个 Agent。移交前应写好摘要——接手方看不到你的对话历史。' +
      '移交前先调用 verify_idempotency（operation_type=handoff）避免重复移交。',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 id。' },
        target_agent: { type: 'string', description: '接收执行权的 Agent 名。' },
        summary: { type: 'string', description: '进度摘要：已完成什么、当前状态、关键决定。' },
        artifacts: { type: 'array', items: { type: 'string' }, description: '可选：产物引用（资产 id 或路径）。' },
        unfinished: { type: 'array', items: { type: 'string' }, description: '可选：未完成事项，接手方要做的下一步。' },
      },
      required: ['task_id', 'target_agent', 'summary'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { task_id: { type: 'string' }, from_agent: { type: 'string' }, to_agent: { type: 'string' }, skipped: { type: 'boolean' } }, required: ['task_id', 'to_agent'], additionalProperties: false },
      (_args, value) => renderSummary([
        value.skipped
          ? `移交已存在，未重复执行：任务 \`${value.task_id}\` 的执行权已归 ${value.to_agent}`
          : `已移交任务 \`${value.task_id}\`：${value.from_agent} → ${value.to_agent}`,
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const taskId = requireString(args, 'task_id', '必须指定任务')
      const targetAgent = requireString(args, 'target_agent', '必须指定接收方 Agent')
      const summary = requireString(args, 'summary', '移交必须带摘要，接手方看不到你的对话历史')

      const task = store.readTasks(projectId).find((t) => t.id === taskId)
      if (task === undefined) fail(`任务 ${taskId} 不存在`)

      // Idempotency guard (§7.3 handoff): the target already holding the
      // execution right means this handoff already took effect — repeating it
      // would produce a duplicate feed event and a misleading checkpoint.
      if (task.ownerAgent === targetAgent && core.locks.holder(store, projectId, taskId) === targetAgent) {
        checkpoint(projectId, exec.agent, {
          taskId,
          eventType: 'resume_attempt',
          lastOperation: { type: 'handoff', targetRef: taskId, resultStatus: 'confirmed' },
          contextSummary: `移交已生效，跳过重复移交（目标 ${targetAgent} 已持有执行权）`,
          nextExpectedActor: targetAgent,
        })
        return { task_id: taskId, from_agent: actor.name, to_agent: targetAgent, skipped: true }
      }

      const result = core.task.handoff(store, config, projectId, {
        actor,
        taskId,
        targetAgent,
        summary,
        artifacts: asStringArray(asRecord(args).artifacts),
        unfinished: asStringArray(asRecord(args).unfinished),
      })

      // `core/task.js` returns the audit descriptors alongside the new task, so
      // the feed wording and the checkpoint's `result_status` live with the rule
      // that produced them instead of being re-derived here. It deliberately
      // reports the handoff as `unconfirmed`: the receiver has not answered yet,
      // and marking it confirmed would let a resumer skip work nobody did.
      let feedEventId
      if (result?.feed !== undefined && result.feed !== null) {
        try {
          const posted = core.feed.post(store, config, projectId, {
            ...result.feed,
            actor: result.feed.actor ?? actor,
          })
          feedEventId = posted?.event?.id
        } catch (error) {
          log?.(`ai-buddy: handoff feed post failed: ${error?.message ?? error}`)
        }
      }
      if (result?.checkpoint !== undefined && result.checkpoint !== null) {
        checkpoint(projectId, exec.agent, {
          ...result.checkpoint,
          conversationId: result.checkpoint.conversationId ?? conversationFor(exec.agent),
          feedEventIds: feedEventId ? [feedEventId] : [],
        })
      }
      return {
        task_id: taskId,
        from_agent: result?.from ?? actor.name,
        to_agent: targetAgent,
        skipped: false,
      }
    },
  }

  const requestExecutionLock = {
    name: 'request_execution_lock',
    description:
      '请求某个对话/任务的执行权。一个对话在任一时刻只有一个持有者。' +
      '若已被他人持有，你会进入 FIFO 队列并在其释放后自动获得。执行权有超时，' +
      '长任务需要周期性调用本工具或 release_execution_lock 前的 refresh 来续期。',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '对话/任务 id。省略则取当前会话绑定的任务。' },
      },
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { task_id: { type: 'string' }, granted: { type: 'boolean' }, holder: { type: 'string' }, queue_position: { type: 'number' }, expires_at: { type: 'string' } }, required: ['task_id', 'granted'], additionalProperties: false },
      (_args, value) => renderSummary([
        value.granted
          ? `已获得任务 \`${value.task_id}\` 的执行权，到期时间 ${value.expires_at ?? '（无）'}`
          : `执行权当前归 ${value.holder} 所有，你排在第 ${value.queue_position ?? '?'} 位`,
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const taskId = resolveTaskId(projectId, exec.agent, optionalString(args, 'conversation_id'))
      const result = core.locks.request(store, config, projectId, { taskId, agent: actor.name })
      // `core/locks.js` speaks in `acquired` / `position`; the tool contract
      // fixed by the brief speaks in `granted` / `queue_position`. The mapping
      // lives here, at the boundary, so neither vocabulary has to bend.
      return {
        task_id: taskId,
        granted: result?.acquired === true,
        holder: result?.holder ?? null,
        queue_position: result?.position,
        expires_at: result?.expiresAt ?? undefined,
      }
    },
  }

  const releaseExecutionLock = {
    name: 'release_execution_lock',
    description:
      '释放你持有的执行权，队列中下一位会立即获得。任务完成或需要交给人类时调用。' +
      '释放后你不会再能写计划状态或提交产物。',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '对话/任务 id。省略则取当前会话绑定的任务。' },
      },
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { task_id: { type: 'string' }, released: { type: 'boolean' }, next_holder: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id', 'released'], additionalProperties: false },
      (_args, value) => renderSummary([
        value.released
          ? `已释放任务 \`${value.task_id}\` 的执行权${value.next_holder ? `，移交给队列中的 ${value.next_holder}` : ''}`
          : `未释放：${value.reason ?? '当前执行权不在你手上'}`,
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const taskId = resolveTaskId(projectId, exec.agent, optionalString(args, 'conversation_id'))
      const result = core.locks.release(store, config, projectId, { taskId, agent: actor.name })
      // Same boundary mapping as `request`: `handedTo` is the module's name for
      // the agent the queue promoted.
      return {
        task_id: taskId,
        released: result?.released === true,
        next_holder: result?.handedTo ?? undefined,
        reason: result?.leftQueue === true ? '你原本在队列中，已退出队列（并不持有执行权）' : undefined,
      }
    },
  }

  const shareConversationReadonly = {
    name: 'share_conversation_readonly',
    description:
      '把一个对话的只读访问权分享给另一个 Agent。被分享方可以看到内容但不能产生新消息或产物。' +
      '适用于需要其他 Agent 复核但不移交执行权的场景，会写入“与我有关”的动态事件。',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '要分享的对话/任务 id。' },
        target_agent: { type: 'string', description: '接收只读访问的 Agent 名。' },
      },
      required: ['conversation_id', 'target_agent'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { task_id: { type: 'string' }, shared_with: { type: 'string' }, readonly: { type: 'boolean' } }, required: ['task_id', 'shared_with'], additionalProperties: false },
      (_args, value) => renderSummary([`任务 \`${value.task_id}\` 已只读分享给 ${value.shared_with}`]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const taskId = requireString(args, 'conversation_id', '必须指定对话')
      const targetAgent = requireString(args, 'target_agent', '必须指定目标 Agent')
      core.task.shareReadonly(store, config, projectId, { actor, taskId, targetAgent })
      const event = core.feed.post(store, config, projectId, {
        actor,
        content: `将任务 \`${taskId}\` 只读分享给 ${targetAgent}`,
        category: 'task.share',
        source: 'auto',
        taskId,
      })
      checkpoint(projectId, exec.agent, {
        taskId,
        eventType: 'feed_post',
        lastOperation: { type: 'feed_post', targetRef: event.id, resultStatus: 'confirmed' },
        contextSummary: `只读分享给 ${targetAgent}`,
        nextExpectedActor: targetAgent,
        feedEventIds: [event.id],
      })
      return { task_id: taskId, shared_with: targetAgent, readonly: true }
    },
  }

  const referenceConversation = {
    name: 'reference_conversation',
    description:
      '把一个对话引用进另一个对话，使前者的上下文/产物对后者可见。用于子任务汇总回父任务、' +
      '或让执行方看到设计方的讨论结论。不会转移执行权。',
    parameters: {
      type: 'object',
      properties: {
        source_conversation_id: { type: 'string', description: '被引用的源对话/任务 id。' },
        target_conversation_id: { type: 'string', description: '接收引用的目标对话/任务 id。' },
      },
      required: ['source_conversation_id', 'target_conversation_id'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { source_task_id: { type: 'string' }, target_task_id: { type: 'string' } }, required: ['source_task_id', 'target_task_id'], additionalProperties: false },
      (_args, value) => renderSummary([`已把任务 \`${value.source_task_id}\` 引用进 \`${value.target_task_id}\``]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const sourceTaskId = requireString(args, 'source_conversation_id', '必须指定源对话')
      const targetTaskId = requireString(args, 'target_conversation_id', '必须指定目标对话')
      core.task.reference(store, config, projectId, { actor, sourceTaskId, targetTaskId })
      core.feed.post(store, config, projectId, {
        actor,
        content: `引用对话：\`${sourceTaskId}\` → \`${targetTaskId}\``,
        category: 'task.share',
        source: 'auto',
        taskId: targetTaskId,
      })
      return { source_task_id: sourceTaskId, target_task_id: targetTaskId }
    },
  }

  // ------------------------------------------------------------ asset tools

  const queryAssets = {
    name: 'query_assets',
    description:
      '检索项目资产库。你只能看到授权范围内的资产——未授权的资产不会出现在结果里，' +
      '也不要点名猜测它们的内容。返回资产 id、名称、目录、版本；用资产 id 调 ' +
      'link_asset_to_conversation 挂载到对话。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（匹配名称、目录、备注）。省略 = 列出授权范围内全部。' },
        scope: { type: 'string', enum: ['project', 'mine', 'folder'], description: 'project=全项目授权范围（默认）；mine=自己上传的；folder=按 folder 过滤。' },
        folder: { type: 'string', description: 'scope=folder 时必填。' },
        limit: { type: 'number', description: '返回条数，默认 20，最大 100。' },
      },
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { assets: { type: 'array', items: { type: 'object' } }, count: { type: 'number' }, hidden_count: { type: 'number' } }, required: ['assets', 'count'], additionalProperties: false },
      (_args, value) => renderSummary([
        `资产检索返回 ${value.count} 项${value.hidden_count ? `（另有 ${value.hidden_count} 项超出你的授权范围，未显示）` : ''}`,
        ...value.assets.slice(0, 40).map((a) => `- \`${a.id}\` ${a.name}（${a.folder || '/'}，v${a.version}）`),
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const scopeArg = optionalString(args, 'scope') ?? 'project'

      // The tool's vocabulary is friendlier than the module's: `project` means
      // "everything I am allowed to cite", which is `readable` in the module.
      // `hidden_count` is computed by asking for the whole manifest and
      // subtracting, so an agent learns that a boundary applied without ever
      // seeing the gated entries themselves.
      const scope = scopeArg === 'mine' ? 'mine' : (scopeArg === 'shared' ? 'shared' : 'readable')
      const limit = Math.min(100, Math.max(1, Number(asRecord(args).limit) || 20))
      const visible = core.assets.query(store, config, projectId, {
        query: optionalString(args, 'query'),
        scope,
        folder: optionalString(args, 'folder'),
        agent: actor,
        limit,
      })
      let hiddenCount = 0
      try {
        const everything = core.assets.query(store, config, projectId, {
          query: optionalString(args, 'query'),
          scope: 'all',
          folder: optionalString(args, 'folder'),
        })
        hiddenCount = Math.max(0, everything.length - visible.length)
      } catch {
        hiddenCount = 0
      }
      return {
        assets: visible.map((a) => ({
          id: a.id, name: a.name, folder: a.folder, version: a.version,
          bytes: a.bytes, owner: a.ownerId, highRisk: a.highRisk === true,
        })),
        count: visible.length,
        hidden_count: hiddenCount,
      }
    },
  }

  const saveToAssets = {
    name: 'save_to_assets',
    description:
      '把产物保存到项目资产库，使其他 Agent 和人类可复用。可以传已存在的文件路径，或直接传文本内容。' +
      '覆盖高风险资产（命中配置的 high_risk_globs）会要求人类确认，此时工具会返回 need_human=true，' +
      '你应当把决定权交回人类而不是反复尝试。写入会记录检查点与动态。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '资产文件名（含扩展名）。' },
        folder: { type: 'string', description: '可选：资产库内目录，如 budgets/2026。' },
        source_path: { type: 'string', description: '可选：要保存的本地文件绝对路径。与 content 二选一。' },
        content: { type: 'string', description: '可选：直接写入的文本内容。与 source_path 二选一。' },
        artifact_ref: { type: 'string', description: '可选：产物引用（工具/任务产物的标识），用于溯源。' },
        allowed_agents: { type: 'array', items: { type: 'string' }, description: '可选：限定可读的 Agent 名。省略 = 全项目可见。' },
        overwrite_confirmed: { type: 'boolean', description: '覆盖高风险资产时必须由人类确认后由人类操作；Agent 不要自行置 true。' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { asset_id: { type: 'string' }, version: { type: 'number' }, name: { type: 'string' }, need_human: { type: 'boolean' }, reason: { type: 'string' } }, required: ['name'], additionalProperties: false },
      (_args, value) => renderSummary([
        value.need_human
          ? `资产写入需要人类确认：${value.reason}`
          : `已保存资产 \`${value.asset_id}\` ${value.name}（v${value.version}）`,
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const name = requireString(args, 'name', '资产必须有文件名')
      const sourcePath = optionalString(args, 'source_path')
      const content = optionalString(args, 'content')
      if (sourcePath === undefined && content === undefined) {
        fail('必须提供 source_path 或 content 之一——资产需要实际内容。')
      }

      // The module works in bytes; the tool accepts either a path or inline
      // text so an agent that just produced markdown need not touch the disk.
      let bytes
      if (sourcePath !== undefined) {
        try {
          const module = await import('node:fs')
          bytes = module.readFileSync(sourcePath)
        } catch (error) {
          fail(`无法读取 source_path（${sourcePath}）：${error?.message ?? error}`)
        }
      } else {
        bytes = Buffer.from(content, 'utf8')
      }

      const folder = optionalString(args, 'folder')
      const existing = core.assets.query(store, config, projectId, {
        query: name, scope: 'all', folder,
      }).find((a) => a.name === name && a.folder === (folder ?? ''))
      const confirmed = asRecord(args).overwrite_confirmed === true && actor.type === 'human'

      const result = existing === undefined
        ? core.assets.save(store, config, projectId, {
            actor,
            name,
            folder,
            bytes,
            artifactRef: optionalString(args, 'artifact_ref'),
            allowedAgents: asStringArray(asRecord(args).allowed_agents),
            sourceTaskId: boundTask(projectId, exec.agent)?.id,
          })
        : core.assets.update(store, config, projectId, {
            actor,
            assetId: existing.id,
            name,
            folder,
            bytes,
            confirmed,
          })

      if (result?.needHumanConfirmation === true) {
        return {
          name,
          need_human: true,
          reason: result.reason ?? '需要人类确认',
          asset_id: result.asset?.id ?? existing?.id,
        }
      }

      // The module hands back the exact feed descriptor its own rule produced
      // (upload vs update, high-risk wording), so it is posted verbatim.
      let feedEventId
      if (result?.feed !== undefined && result.feed !== null) {
        try {
          const posted = core.feed.post(store, config, projectId, {
            ...result.feed,
            actor: result.feed.actor ?? actor,
          })
          feedEventId = posted?.event?.id
        } catch (error) {
          log?.(`ai-buddy: asset feed post failed: ${error?.message ?? error}`)
        }
      }

      const saved = result.asset
      checkpoint(projectId, exec.agent, {
        taskId: boundTask(projectId, exec.agent)?.id,
        eventType: 'asset_write',
        lastOperation: {
          type: 'asset_write',
          target_ref: saved.id,
          result_status: 'confirmed',
          verified_at: nowIso(),
        },
        contextSummary: `写入资产 ${saved.name} v${saved.version}`,
        nextExpectedActor: actor.name,
        feedEventIds: feedEventId ? [feedEventId] : [],
      })
      return { asset_id: saved.id, version: saved.version, name, need_human: false }
    },
  }

  const linkAssetToConversation = {
    name: 'link_asset_to_conversation',
    description:
      '把资产挂载到当前（或指定）对话，使其进入你的可读上下文。挂载前应确认资产在你的授权范围内，' +
      '否则调用会失败——那是权限边界在起作用，不是可以绕过的错误。',
    parameters: {
      type: 'object',
      properties: {
        asset_id: { type: 'string', description: '资产 id。' },
        conversation_id: { type: 'string', description: '可选：目标对话/任务 id，默认当前绑定的任务。' },
      },
      required: ['asset_id'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { asset_id: { type: 'string' }, task_id: { type: 'string' }, name: { type: 'string' } }, required: ['asset_id'], additionalProperties: false },
      (_args, value) => renderSummary([`资产 \`${value.asset_id}\`（${value.name ?? '?'}）已挂载到任务 \`${value.task_id ?? '当前'}\``]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const assetId = requireString(args, 'asset_id', '必须指定资产')
      const taskId = resolveTaskId(projectId, exec.agent, optionalString(args, 'conversation_id'))
      const result = core.assets.linkToConversation(store, config, projectId, { actor, assetId, taskId })
      if (result?.feed !== undefined && result.feed !== null) {
        try {
          core.feed.post(store, config, projectId, { ...result.feed, actor: result.feed.actor ?? actor })
        } catch (error) {
          log?.(`ai-buddy: asset link feed failed: ${error?.message ?? error}`)
        }
      }
      return { asset_id: assetId, task_id: taskId, name: result?.asset?.name }
    },
  }

  // -------------------------------------------------- human-instruction tool

  const readHumanInstructions = {
    name: 'read_human_instructions',
    description:
      '读取人类在动态中发布的最新指令（含追问、优先级调整、暂停/转向要求）。' +
      '执行长任务时应在每个检查点后调用它；人类可能在你执行期间改变了方向。' +
      '返回结果中 category 为 human.* 的事件即人类指令。',
    parameters: {
      type: 'object',
      properties: {
        since: { type: 'string', description: '可选：ISO 时间或动态事件 id。省略 = 最近 24 小时。' },
        limit: { type: 'number', description: '返回条数，默认 10，最大 50。' },
      },
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { instructions: { type: 'array', items: { type: 'object' } }, count: { type: 'number' } }, required: ['instructions', 'count'], additionalProperties: false },
      (_args, value) => renderSummary([
        value.count === 0 ? '自该时间点以来人类没有新的指令。' : `人类指令 ${value.count} 条：`,
        ...value.instructions.map((e) => `- [${e.at}] ${e.category} — ${clip(e.content, 300)}`),
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const limit = Math.min(50, Math.max(1, Number(asRecord(args).limit) || 10))
      const all = core.feed.humanInstructions(store, projectId, {
        since: optionalString(args, 'since'),
      })
      // `limit` keeps the NEWEST instructions: an agent coming back after a long
      // pause needs the latest direction, not the oldest.
      const instructions = all.slice(Math.max(0, all.length - limit))
      return {
        instructions: instructions.map((e) => ({ id: e.id, at: e.at, category: e.category, content: clip(e.content, 600) })),
        count: instructions.length,
      }
    },
  }

  // --------------------------------------------------------- recovery tools

  const inspectResumeState = {
    name: 'inspect_resume_state',
    description:
      '在恢复一个中断的任务之前，检查它实际的跨模块状态。返回：最近检查点、自检查点以来的新动态、' +
      '计划条目当前状态与阻塞、资产版本变化、执行权归属、以及上一次操作的幂等性判定。' +
      '**恢复流程的第一步必须是它**，而不是直接继续执行。',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '可选：对话/任务 id，默认当前绑定的任务。' },
      },
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { conversation_id: { type: 'string' }, checkpoint_id: { type: 'string' }, verified: { type: 'array', items: { type: 'string' } }, changed: { type: 'array', items: { type: 'string' } }, verdict: { type: 'object' }, brief: { type: 'string' } }, required: ['conversation_id'], additionalProperties: false },
      (_args, value) => renderSummary([
        `对话 \`${value.conversation_id}\` 恢复核对`,
        value.checkpoint_id ? `最近检查点：\`${value.checkpoint_id}\`` : '尚无检查点',
        value.changed?.length ? `自检查点以来的变化：${value.changed.join('；')}` : '自检查点以来各模块无变化',
        value.verdict ? `幂等性判定：${value.verdict.action}（${value.verdict.reason}）` : '',
        '',
        value.brief,
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const conversationId = optionalString(args, 'conversation_id')
        ?? boundTask(projectId, exec.agent)?.conversationId
        ?? conversationFor(exec.agent)
      if (!isNonEmptyString(conversationId)) fail('无法确定对话 id：请显式传 conversation_id。')
      const brief = core.resume.brief(store, config, projectId, conversationId)
      const cp = brief.checkpoint
      return {
        conversation_id: conversationId,
        checkpoint_id: cp?.checkpoint_id,
        verified: brief.verifiedModules ?? ['feed', 'plan', 'asset', 'execution_lock', 'workspace'],
        changed: brief.changes ?? [],
        verdict: brief.verdict,
        brief: brief.text ?? '',
      }
    },
  }

  const publishResumeNote = {
    name: 'publish_resume_note',
    description:
      '把恢复摘要发布到动态流，让队友和人类知道发生了什么：从哪个检查点恢复、核对了哪些模块、' +
      '跳过了哪些重复操作、接下来谁推进。恢复完成后必须调用它，否则其他 Agent 无从得知。',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '可选：对话/任务 id。' },
        summary: { type: 'string', description: '恢复摘要：检查点、核对结论、跳过项、下一步与责任人。' },
      },
      required: ['summary'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { event_id: { type: 'string' }, pinned: { type: 'boolean' } }, required: ['event_id'], additionalProperties: false },
      (_args, value) => renderSummary([`恢复摘要已发布：\`${value.event_id}\``]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const conversationId = optionalString(args, 'conversation_id')
        ?? boundTask(projectId, exec.agent)?.conversationId
        ?? conversationFor(exec.agent)
      const summary = requireString(args, 'summary', '恢复摘要不能为空')
      const task = store.readTasks(projectId).find((t) => t.conversationId === conversationId)
      const event = core.feed.post(store, config, projectId, {
        actor,
        content: `恢复摘要：${summary}`,
        category: 'resume.summary',
        source: 'auto',
        taskId: task?.id,
        pinned: false,
      })
      checkpoint(projectId, exec.agent, {
        taskId: task?.id,
        conversationId,
        eventType: 'resume_success',
        lastOperation: { type: 'feed_post', targetRef: event.id, resultStatus: 'confirmed' },
        contextSummary: clip(summary, 400),
        nextExpectedActor: actor.name,
        feedEventIds: [event.id],
      })
      if (isNonEmptyString(conversationId)) {
        try {
          core.resume.recordStable(store, config, projectId, conversationId, { substantive: true })
        } catch (error) {
          log?.(`ai-buddy: recordStable failed: ${error?.message ?? error}`)
        }
      }
      return { event_id: event.id, pinned: false }
    },
  }

  const requestManualResume = {
    name: 'request_manual_resume',
    description:
      '当对话被意外中断锁锁定，或恢复被服务端持续拒绝时，向人类请求一次人工裁决。' +
      '你**不能**自行解锁；本工具只是把决定权交回人类，并附上你判断的根因与建议。' +
      '锁定状态下反复调用它不会恢复，只会刷屏。',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '可选：对话/任务 id。' },
        reason: { type: 'string', description: '为什么需要人工介入：错误摘要、疑似根因、建议的处理方式。' },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { conversation_id: { type: 'string' }, lock_state: { type: 'string' }, informed_human: { type: 'boolean' } }, required: ['conversation_id', 'informed_human'], additionalProperties: false },
      (_args, value) => renderSummary([
        `已向人类请求人工裁决（对话 \`${value.conversation_id}\`，当前锁状态 ${value.lock_state}）`,
        '在人类解除锁定之前，本对话不会进行任何自动恢复尝试。',
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const actor = actorOf(exec.agent)
      const conversationId = optionalString(args, 'conversation_id')
        ?? boundTask(projectId, exec.agent)?.conversationId
        ?? conversationFor(exec.agent)
      if (!isNonEmptyString(conversationId)) fail('无法确定对话 id：请显式传 conversation_id。')
      const reason = requireString(args, 'reason', '必须说明为什么需要人工介入')
      const status = core.resume.lockStatus(store, projectId, conversationId)

      // Move the runtime lock to awaiting_human. This does NOT unlock: the
      // remaining automatic resume paths stay blocked, which is the whole
      // point of the stop-loss lock.
      try {
        const state = store.getResumeState(projectId, conversationId)
        store.putResumeState(projectId, conversationId, {
          ...state,
          resumeLock: {
            state: status?.locked === true ? 'paused' : 'awaiting_human',
            holder: null, since: nowIso(), reason: clip(reason, 300),
          },
        })
      } catch (error) {
        log?.(`ai-buddy: request_manual_resume state update failed: ${error?.message ?? error}`)
      }
      core.feed.post(store, config, projectId, {
        actor,
        content: `请求人工裁决（对话 \`${conversationId}\`）：${clip(reason, 800)}`,
        category: 'resume.failure',
        source: 'auto',
        taskId: store.readTasks(projectId).find((t) => t.conversationId === conversationId)?.id,
        pinned: status?.locked === true,
      })
      return {
        conversation_id: conversationId,
        lock_state: status?.state ?? 'unlocked',
        informed_human: true,
      }
    },
  }

  const verifyIdempotency = {
    name: 'verify_idempotency',
    description:
      '在恢复执行任何会产生副作用的协作操作之前，核对它是否已经生效。' +
      'operation_type 决定核对方式。返回 skip / retry / verify_first / request_human 四选一：' +
      'skip = 已完成，不要再做；retry = 上次失败，重试正是恢复的目的；' +
      'verify_first = 结果未确认，先读实际状态再决定；request_human = 已被他人改动，交回人类。',
    parameters: {
      type: 'object',
      properties: {
        operation_type: { type: 'string', enum: ['handoff', 'asset_write', 'plan_update', 'feed_post', 'conversation_create'], description: '要核对的操作类型。' },
        target_ref: { type: 'string', description: '目标对象：任务 id、资产 id、计划条目 id、动态事件 id 或对话 id。' },
        conversation_id: { type: 'string', description: '可选：所在对话 id。' },
      },
      required: ['operation_type', 'target_ref'],
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { action: { type: 'string' }, status: { type: 'string' }, reason: { type: 'string' }, evidence: { type: 'string' } }, required: ['action', 'reason'], additionalProperties: false },
      (_args, value) => renderSummary([
        `幂等性判定：${value.action}`,
        `结果状态：${value.status ?? 'unknown'}`,
        `原因：${value.reason}`,
        value.evidence ? `证据：${value.evidence}` : '',
        '',
        value.action === 'skip' ? '→ 该操作已完成，**不要重复执行**。'
          : value.action === 'retry' ? '→ 上次失败，重试是正确的恢复动作。'
            : value.action === 'verify_first' ? '→ 结果未确认，**先读取实际状态再决定**，不要盲目重放。'
              : '→ 已被其他参与者改动，**把决定权交给人类**。',
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const operationType = requireString(args, 'operation_type', '必须指定操作类型')
      const targetRef = requireString(args, 'target_ref', '必须指定目标对象')
      const conversationId = optionalString(args, 'conversation_id')
        ?? boundTask(projectId, exec.agent)?.conversationId
        ?? conversationFor(exec.agent)
        ?? 'unbound'
      const verified = core.resume.verify(store, config, projectId, { operationType, targetRef })
      const verdict = core.resume.guard(
        store, config, projectId, conversationId, operationType, targetRef,
      )
      return {
        action: verdict.action,
        status: verified.status,
        reason: verdict.reason,
        evidence: verdict.detail ?? verified.evidence ?? '',
      }
    },
  }

  const queryResumeLock = {
    name: 'query_resume_lock',
    description:
      '查询某个对话的意外中断锁状态：是否锁定、连续失败次数、锁定原因、解锁条件。' +
      '在执行任何自动恢复之前先查它——锁定时所有自动恢复都必须停止，只读访问不受影响。',
    parameters: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: '可选：对话/任务 id。' },
      },
      additionalProperties: false,
    },
    output: textOutput(
      { type: 'object', properties: { conversation_id: { type: 'string' }, state: { type: 'string' }, locked: { type: 'boolean' }, consecutive_failures: { type: 'number' }, failure_threshold: { type: 'number' }, last_failure_reason: { type: 'string' }, locked_at: { type: 'string' }, locked_by: { type: 'string' }, unlock_conditions: { type: 'array', items: { type: 'string' } } }, required: ['conversation_id', 'state', 'locked'], additionalProperties: false },
      (_args, value) => renderSummary([
        `对话 \`${value.conversation_id}\` 意外中断锁：${value.state}${value.locked ? '（已锁定）' : ''}`,
        `连续失败 ${value.consecutive_failures}/${value.failure_threshold}`,
        value.last_failure_reason ? `最近失败原因：${value.last_failure_reason}` : '',
        value.locked ? '解锁条件：' : '',
        ...(value.unlock_conditions ?? []).map((c) => `- ${c}`),
      ]),
    ),
    async execute(args, exec) {
      const projectId = projectOf(exec.agent)
      const conversationId = optionalString(args, 'conversation_id')
        ?? boundTask(projectId, exec.agent)?.conversationId
        ?? conversationFor(exec.agent)
      if (!isNonEmptyString(conversationId)) fail('无法确定对话 id：请显式传 conversation_id。')
      const status = core.resume.lockStatus(store, projectId, conversationId)
      return {
        conversation_id: conversationId,
        state: status?.state ?? 'unlocked',
        locked: status?.locked === true,
        consecutive_failures: status?.consecutiveFailures ?? 0,
        failure_threshold: config.interruptLock.failureThreshold,
        last_failure_reason: status?.lastFailureReason ?? undefined,
        locked_at: status?.lockedAt ?? undefined,
        locked_by: status?.lockedBy ?? undefined,
        unlock_conditions: [
          '人类在工作台中手动解锁，并可选择重置失败计数',
          '人类在动态中发布明确指令（如“已修复配额，恢复该对话”），AI 读取到后解除锁定',
          '根因被外部修复后，人类确认执行一次试探恢复；成功则解锁并重置计数，失败则保持锁定',
        ],
      }
    },
  }

  return [
    postUpdateToFeed, readFeed,
    createPlanItem, updatePlanStatus, readPlan,
    createConversation, handoffConversation, requestExecutionLock, releaseExecutionLock,
    shareConversationReadonly, referenceConversation,
    queryAssets, saveToAssets, linkAssetToConversation,
    readHumanInstructions,
    inspectResumeState, publishResumeNote, requestManualResume,
    verifyIdempotency, queryResumeLock,
  ]
}

/** The 20 names, exported so tests and the design document can assert them. */
export const TOOL_NAMES = [
  'post_update_to_feed', 'read_feed',
  'create_plan_item', 'update_plan_status', 'read_plan',
  'create_conversation', 'handoff_conversation', 'request_execution_lock',
  'release_execution_lock', 'share_conversation_readonly', 'reference_conversation',
  'query_assets', 'save_to_assets', 'link_asset_to_conversation',
  'read_human_instructions',
  'inspect_resume_state', 'publish_resume_note', 'request_manual_resume',
  'verify_idempotency', 'query_resume_lock',
]

/**
 * Register all tools on the calling context.
 *
 * Each registration is an effect, so unloading the plugin (or an HMR replace)
 * unregisters every tool. The disposer list is returned for callers that need
 * to remove them earlier.
 */
export function registerTools(ctx, deps) {
  const definitions = createToolDefinitions(deps)
  const disposers = []
  const tools = ctx.get('tools')
  if (tools === undefined || typeof tools.register !== 'function') {
    deps.log?.('ai-buddy: tools service unavailable; Agent tools not registered')
    return () => {}
  }
  for (const definition of definitions) {
    try {
      // Wrap `execute` so the JSON-sanitizing rule is enforced once, for every
      // tool, instead of depending on each definition remembering it. The
      // wrapper is transparent otherwise: same signature, same thrown errors.
      const wrapped = {
        ...definition,
        async execute(args, exec) {
          return jsonSafe(await definition.execute(args, exec))
        },
      }
      const disposer = tools.register(wrapped)
      disposers.push(disposer)
    } catch (error) {
      deps.log?.(`ai-buddy: failed to register tool ${definition.name}: ${error?.message ?? error}`)
    }
  }
  return () => {
    for (const disposer of disposers) {
      try {
        disposer()
      } catch {
        /* already disposed */
      }
    }
  }
}

export { newId, jsonSafe }
