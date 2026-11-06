# ai-buddy 设计交付文档

> 版本：1.0.0
> 适用运行时：DeepSeek Harness `>=0.2.0-rc.1 <0.3.0-0`
> 文档定位：`ai-buddy` 是 DSH 的一个 bundle 插件，把「人来协调多个 AI 对话」改成「AI 之间协作、人类只做指挥与审批」。
> 本文档的每一条行为断言都对应仓库里的一个真实文件；实现与 `CONTRACT.md` 冲突时以代码为准，冲突记在文末「已知偏差」。

---

## 0. 一句话定位与三个不变量

`ai-buddy` 在 DSH 之上补的是一个**协作层**，不是模型层、也不是传输层。它回答三个问题：

1. **谁可以动手**——四个模块（动态 / 计划 / 任务 / 资产）共享一套执行权模型，同一时刻一个对话只有一个执行权持有者。
2. **动手之后崩了怎么续**——检查点（checkpoint）+ 跨模块核对（cross-module verification）+ 幂等性守卫（idempotency guard）。
3. **一直续不上怎么办**——意外中断锁（interruption lock）止损，把决定权交回人类。

三个贯穿全局的不变量：

- **JSON 是真相层，Markdown 是投影。** `<dataDir>/projects/<projectId>/*.json` 是唯一权威；`md/*.md` 只写不读，删掉下一次刷新就会重建。
- **所有写入都是原子的。** 每个文档都走 `writeJsonAtomic()`（临时文件 + `rename`），崩溃永远不会留下一份半写的 JSON 让后续恢复流程读成真状态。
- **模型只能看到工具。** Agent 的所有能力收敛为 20 个工具（本文 §2），没有模型可见的旁路；人通过 Web 工作台写入的每一条变更都同时落成一条 feed 事件，让 AI 看得见人的动作。

### 关于配置：故意不导出 `Config`

`lib/config.js` **没有**导出 `Config`，只导出 `DEFAULT_CONFIG` / `resolveConfig()` / `dataDirOf()`。这是刻意的：一个 bundle 声明了 `Config` 就让 Loader 校验它的 patch 行，而校验失败会**卸载插件**。工作台因为某个数值开关被写成字符串就整个不加载，比钳位到一个合法值糟糕得多。因此配置层是无 schema 的，`resolveConfig()` 只做深合并 + 钳位，永不抛错。

---

## 1. 插件目录结构与核心文件

### 1.1 分层

```
lib/index.js        入口 apply(ctx, config)：装配服务、注册 20 个工具、挂 Web 路由、启动清扫定时器
lib/tools/index.js  Agent 工具定义；这是模型面向的唯一表面
lib/web.js          人类工作台 HTTP API（同源，无独立 token）
lib/core/*.js       领域逻辑，不 import Cordis、不碰 ctx、纯 JS 对象
lib/store.js        持久化：JSON 真相层 + Markdown 投影
lib/util.js         id、时钟、原子写、哈希、路径与 glob
```

`lib/core/*` 与 `lib/store.js` 必须**能在没有 Host 的情况下被 Node 直接 import 并运行**（单元测试用临时目录构造 Store）。`lib/core/` 下任何文件都不许触碰 `ctx`。

### 1.2 完整目录树

```
ai-buddy/
├── package.json                 # name/version/exports/engines + dsh.bundle.patch、dsh.client 清单
├── cordis.patch.yml             # bundle patch：一行 `ai-buddy` Host 插件，携带全部默认配置
├── icon.svg                     # 侧边栏图标（插件唯一的美术资源）
├── CONTRACT.md                  # 模块间内部契约（实现必须服从它，本文档与代码冲突时以代码为准）
├── DESIGN.md                    # 本文档
├── locale/
│   ├── zh.json                  # 中文文案（工作台标题 / 描述）
│   └── en.json                  # 英文文案
├── lib/
│   ├── index.js                 # 入口：apply(ctx, config)，装配 Store、工具、Web、定时清扫
│   ├── config.js                # DEFAULT_CONFIG + resolveConfig()（无 schema、深合并、钳位）+ dataDirOf()
│   ├── util.js                  # newId / nowIso / sha256 / 原子读写 / glob 匹配 / parseSince
│   ├── store.js                 # Store 类：项目/feed/plan/task/asset/checkpoint/resume 持久化 + MD 刷新
│   ├── markdown.js              # 四个 Markdown 渲染器（纯函数，只被 store 调用）
│   ├── web.js                   # 工作台 HTTP API + 单页 HTML shell + SSE 失效流
│   ├── tools/
│   │   └── index.js             # registerTools(ctx, deps)：20 个 Agent 工具的唯一定义处
│   └── core/
│       ├── feed.js              # 动态：post / read / summarize / humanInstructions（AI 发言限流）
│       ├── plan.js              # 计划：create / updateStatus / read / recomputeBlocking / setLockedByInterrupt
│       ├── task.js              # 任务：create / handoff / archive / shareReadonly / reference / read
│       ├── assets.js            # 资产：save / update / remove / query / linkToConversation / canRead
│       ├── locks.js             # 执行权调度器：request / release / holder / refresh / sweep / canWrite
│       ├── checkpoint.js        # 检查点：build（读活库填跨模块快照）/ write（append）
│       ├── resume.js            # 恢复子系统：分类失败、退避、计划恢复、简报、幂等守卫、中断锁
│       └── prompts.js           # resumeMessage（注入的「继续」消息）/ sectionBody（系统提示词段落）
└── client.js                    # 浏览器端：__ModuleLoader__ 模块，侧边栏入口 + 五面板工作台
```

### 1.3 每个文件的职责（逐行说明）

| 文件 | 角色 | 关键导出 / 说明 |
|---|---|---|
| `package.json` | 打包清单 | `main` 指向 `./lib/index.js`；`dsh.bundle.patch` 指向 `./cordis.patch.yml`；`dsh.client = { platform: 'web', immediately: false }` 让浏览器半边从同一包挂载，**不需要第二行 patch**。`engines.node >= 22`、`engines.dsh >= 0.2.0-rc.1 < 0.3.0-0`。 |
| `cordis.patch.yml` | bundle patch | 只有一行 `insert: [{ id: ai-buddy, name: ai-buddy, config: {...} }]`。配置文件头明确写了：**同 id 的 profile 覆盖行会整体替换 `config` 字段（Loader 是赋值不是深合并）**，所以 `lib/config.js` 的 `resolveConfig()` 负责把覆盖行漏掉的键补齐。 |
| `icon.svg` | 侧边栏图标 | 无文案、无颜色依赖，跟随 `currentColor`。 |
| `lib/index.js` | 入口 | `export function apply(ctx, config)`。构造 `resolveConfig(config)` → `dataDirOf()` → `new Store({ dir, config })`；`registerTools(ctx, deps)`；`enableWeb` 为真时调 `registerWeb(ctx, deps)`；注册执行权清扫定时器与系统提示词 section；返回 disposer 释放定时器与 Store。 |
| `lib/config.js` | 配置层 | `DEFAULT_CONFIG`（与 `cordis.patch.yml` 逐键对应）、`resolveConfig(overrides, env)`（永不抛错、数值钳位）、`dataDirOf(config, env)`（`<DSH_HOME>/ai-buddy` 或相对 DSH_HOME 解析）。 |
| `lib/util.js` | 纯工具 | `newId(prefix)` → `p_/f_/pl_/t_/a_/cp_/rs_` + 16 位小写十六进制；`writeJsonAtomic()` 用 `file.<pid>.tmp` + `renameSync`（pid 进临时名，防两个进程互相覆盖）；`globToRegExp()` 支撑 `highRiskGlobs`；`parseSince()` 接受 ISO / epoch 毫秒 / 空。 |
| `lib/store.js` | 检查点存储 + 全部持久化 | `class Store`：`snapshot()` 返回结构化克隆；所有变更同步落盘并 `_notify()`；`appendCheckpoint()` 按 `config.checkpoints.perConversationRetention` 截断；`getResumeState()` 会用一个空壳合并旧版本状态（向前兼容）；Markdown 刷新由 **1.5s 合并定时器**（`MD_THROTTLE_MS`，`unref()`）驱动。 |
| `lib/markdown.js` | 人类可读投影 | `renderFeedMd` / `renderPlanMd` / `renderAssetsMd` / `renderResumeMd`，全是纯函数；文件头写着「**Do not edit by hand**」。 |
| `lib/web.js` | 人类视图接口 | `registerWeb(ctx, deps)` 在 `ctx.webServer` 上挂 `/ai-buddy/*` 路由；返回 HTML shell、`/api/state`、各类变更 POST、`/api/events`（SSE 失效流）。人类的每次变更都写一条 `source: 'human'` 的 feed 事件。 |
| `lib/tools/index.js` | Agent 工具定义 | `registerTools(ctx, deps)`，`deps = { store, config, projectIdFor(agent), actorFor(agent), services, log }`。20 个 `ctx.tools.register({ name, description, parameters, output, execute })`；结果**有界**（id + 短摘要），细节指向后续读工具。 |
| `lib/core/feed.js` | 动态模块 | 只对 `source: 'agent'` 施加 `config.feed.aiPostsPerMinute` 限流；`category` 按封闭集合校验；锁事件 `pinned: true`。 |
| `lib/core/plan.js` | 计划模块 | `updateStatus()` 强制**计划级写权**（当前执行权持有者或人类）；`recomputeBlocking()` 派生 `blockedBy`；`locked_by_interrupt` 只由中断锁写入。 |
| `lib/core/task.js` | 任务模块 | `handoff()` 只搬运「执行编排权」，返回描述符由调用方写检查点与 feed；`shareReadonly()` / `reference()` 建立只读共享与交叉引用。 |
| `lib/core/assets.js` | 资产模块 | `allowedAgents` 非空即构成 **Agent 级访问边界**；`highRisk` 由 `config.assets.highRiskGlobs` 匹配文件名得出；覆盖高风险资产或删除需要 `confirmed === true`。 |
| `lib/core/locks.js` | 执行权调度器 | FIFO 队列 + `timeoutMs` 过期 + `maxQueueDepth` + `queueMaxWaitMs`；`release()` 把锁交给 `queue[0]`；`canWrite()` 是其他模块共用的唯一判定谓词。 |
| `lib/core/checkpoint.js` | 检查点构造/落盘 | `build()` 从**活库**填 `cross_module_snapshot`，从 resume state 填 `resume_lock_state`——检查点因此永远不会对另外三个模块说谎；`write()` = `build()` + `store.appendCheckpoint()`。 |
| `lib/core/resume.js` | 恢复子系统 | `classifyFailure` / `nextBackoff` / `planResume` / `brief` / `injectResume` / `guard` / `GUARD_MATRIX` / `verify` / `acquireResumeLock` / `releaseResumeLock` / `recordResumeAttempt` / `recordStable` / `engageLock` / `releaseLock` / `lockStatus`。本插件最大的模块。 |
| `lib/core/prompts.js` | 提示词 | `resumeMessage(brief)` 必须携带跨模块核对清单，**裸「继续」是 bug**（有测试守着）；`sectionBody(config)` 是注入系统提示词的协作模型说明。 |
| `client.js` | 浏览器端 | `window.__ModuleLoader__.load({ id: 'ai-buddy', factory })`；注册 `sidebar.panellist` 入口与 `main` keyed 入口；五面板工作台；只用 `--dsw-alias-*` 主题令牌；所有可见字符串走 `ctx.locale`。 |

### 1.4 数据落盘位置

`dataDirOf()` 的结果默认是 `<DSH_HOME>/ai-buddy`（`DSH_HOME` 未设置时回退 `~/.dsh`）。每个项目一个目录：

```
<DSH_HOME>/ai-buddy/
└── projects/
    └── <projectId>/
        ├── project.json              # Project：标题、成员（agent / human）
        ├── feed.json                 # { version, events: FeedEvent[] }，按 feed.retention 截尾
        ├── plan.json                 # { version, items: PlanItem[] }
        ├── tasks.json                # { version, tasks: Task[] }
        ├── assets/
        │   ├── manifest.json         # { version, assets: Asset[] }
        │   └── blobs/<assetId>       # 原始字节，按 id 命名，不透明
        ├── checkpoints/
        │   └── <conversationId>.json # { version, checkpoints: Checkpoint[] }
        ├── resume/
        │   └── <conversationId>.json # ResumeState（热写路径，独立小文档）
        └── md/
            ├── feed.md               # 动态摘要（置顶事件 + 最近 200 条）
            ├── plan.md               # 计划看板（按状态分组）
            ├── assets.md             # 资产清单
            └── resume-history.md     # 恢复历史（每对话的锁状态 + 尝试表）
```

**为什么 checkpoint / resume 要独立成小文档而不是塞进 `tasks.json`？** 恢复流程在崩溃边缘写入，写的是「这一轮做到哪了」。如果它和 `tasks.json` 共用一个文档，一次热写就会带着整个任务列表一起重写；独立小文档让热写路径的写放大降到常数级，也让一次写失败只影响一个对话。

---

## 2. Agent 可调用的工具清单

这 20 个工具是模型的**全部**协作表面。设计约束来自 agent-experience 原则：返回值**有界**（id + 一句话摘要 + 下一步提示），需要全貌时再调用对应的「读」工具，避免一次工具调用把几百条事件灌进上下文。

### 2.1 工具总表

| # | 工具名 | 关键参数 | 做什么 | 什么时候该调 |
|---|---|---|---|---|
| 1 | `post_update_to_feed` | `content`、`category`、`taskId?`、`planItemId?`、`assetId?`、`pinned?` | 以 AI 主动发言身份（`source: 'agent'`）向共享动态写一条事件；受 `feed.aiPostsPerMinute` 限流 | 完成一个可被别人依赖的中间结论、要告知其它 Agent「我改了 X」时。不要用它写过程日志 |
| 2 | `read_feed` | `sinceEventId?`、`sinceTime?`、`categories?`、`limit?`、`includePinned?` | 读共享动态，可按时间/事件 id 增量读、按类别过滤 | 接手别人工作前；恢复流程的第一步（本对话检查点之后发生了什么） |
| 3 | `create_plan_item` | `title`、`description?`、`assignee?`、`dependsOn?`、`dueAt?`、`mode`、`priority?`、`taskId?` | 新建计划条目；`mode: 'pre'` 事前计划 / `'live'` 事中计划 | 拆解出新的可交付项、发现必须新增的前置依赖时 |
| 4 | `update_plan_status` | `planItemId`、`newStatus`、`note?` | 改计划条目状态（`pending` / `in_progress` / `paused` / `done`）；受**计划级写权**约束 | 自己负责的条目开始/完成时。跨 Agent 改派、删除会被拒绝并返回 `needHumanConfirmation` |
| 5 | `read_plan` | `status?`、`assignee?`、`includeBlocked?` | 读计划看板，含派生的 `blockedBy` | 每轮开始确认「我的前置是否已完成」；恢复流程的第二步 |
| 6 | `create_conversation` | `title`、`description?`、`ownerAgent?`、`planItemId?`、`workspace?` | 创建一条任务（对话），绑定到项目；`conversationId` 在 Host 会话绑定前为 `null` | 需要拉起一个新会话专门做某件事时 |
| 7 | `handoff_conversation` | `taskId`、`targetAgent`、`summary`、`artifacts?`、`unfinished?` | 把执行编排权移交另一个 Agent，并写交接检查点 + `directed / task.handoff` 动态 | 自己的工作段结束、需要把上下文与未完成项交给下一个 Agent 时 |
| 8 | `request_execution_lock` | `taskId` | 申请会话级执行权；无人持有时立即获得，有人持有时进 FIFO 队列 | 准备对共享文件/资产做写操作前**必调** |
| 9 | `release_execution_lock` | `taskId`、`force?` | 释放执行权，队列里的下一个自动获得 | 写操作结束、或要长时间离开时。`force` 只给人类与清理路径用 |
| 10 | `share_conversation_readonly` | `taskId`、`targetAgent` | 把任务以只读方式共享给另一个 Agent（不转移执行权） | 需要别人「看得到但不许改」时 |
| 11 | `reference_conversation` | `sourceTaskId`、`targetTaskId` | 建立两个任务之间的引用关系（跨对话引用证据/结论） | 复用另一个对话的产出时，留下可追溯的引用边 |
| 12 | `query_assets` | `query?`、`scope?`、`agent?` | 按关键词检索资产；结果受 `allowedAgents` 边界过滤 | 需要既有素材/数据时。读不到不是错误，是权限边界 |
| 13 | `save_to_assets` | `name`、`bytes`/`artifactRef`、`contentType?`、`folder?`、`allowedAgents?`、`sourceTaskId?` | 把产物沉淀为项目资产，算 sha256、置版本号、写入 blob | 产出一个要被别人复用的文件时。这是「交接靠资产不靠转述」的落点 |
| 14 | `link_asset_to_conversation` | `assetId`、`taskId` | 把资产挂到某个对话/任务上 | 让后来者从任务就能找到源文件 |
| 15 | `read_human_instructions` | `since?` | 只读人类指令类事件（`human.instruction` / `human.priority` / `human.pause` / `human.resume` / `human.unlock` / `human.reply`） | 每轮开始、以及恢复流程开始前，确认人有没有下新指令 |
| 16 | `inspect_resume_state` | `conversationId?` | 读本对话（或指定对话）的恢复状态：恢复锁、中断锁、连续失败数、最近检查点、最近失败原因 | 不确定自己是不是被恢复起来的、或想知道为什么没被恢复时 |
| 17 | `publish_resume_note` | `conversationId`、`summary`、`nextExpectedActor?`、`feedEventIds?` | 主动写一条恢复说明检查点（`event_type: 'resume_success'` 或 `resume_attempt`），并把跨模块快照固化下来 | 恢复完成后第一次成功推进时。这是让「下一次崩溃」有据可依的动作 |
| 18 | `request_manual_resume` | `conversationId`、`reason`、`trial?` | 请求人工确认恢复；`trial: true` 时在被锁定状态下消耗一次试验性恢复额度 | 自己判断需要人拍板才能继续，或中断锁已锁定需要人类解锁时 |
| 19 | `verify_idempotency` | `operationType`、`targetRef` | 拿真库比对某个「可能已经做过」的操作，返回 `confirmed` / `unconfirmed` / `failed` / `changed_by_other` 与证据 | 恢复后准备重做任何写操作**之前**必调；这也是幂等矩阵的查询入口 |
| 20 | `query_resume_lock` | `conversationId?` | 只读查询恢复锁与执行权的当前归属（谁持有、是否可在本对话恢复） | 想恢复但不确定当前有没有别的恢复流程在跑时；先查后抢，避免双恢复 |

### 2.2 分组与调用节奏

- **读类（无副作用，可随意调）**：`read_feed`、`read_plan`、`read_human_instructions`、`query_assets`、`inspect_resume_state`、`query_resume_lock`、`verify_idempotency`。
- **写类（有副作用，成对使用）**：`post_update_to_feed`、`create_plan_item`、`update_plan_status`、`create_conversation`、`save_to_assets`、`link_asset_to_conversation`、`share_conversation_readonly`、`reference_conversation`。
- **权类（改变归属，必须配对释放）**：`request_execution_lock` / `release_execution_lock`、`handoff_conversation`。
- **恢复类（只在恢复流程内调）**：`inspect_resume_state`、`query_resume_lock`、`verify_idempotency`、`publish_resume_note`、`request_manual_resume`。

推荐的每轮开场顺序是固定的：`read_human_instructions` → `read_plan` → `read_feed`（增量） → 再做自己的事。这个顺序本身就是「人类优先、计划次之、同伴动态第三」的优先级编码。

---

## 3. 执行权状态机

四个模块共享一套执行权，但「权」的粒度不同：会话级是**独占锁 + 队列**，计划级与资产级是**谓词判定**，动态是**append-only + 限流**。

### 3.1 会话级执行权（`lib/core/locks.js`）

每个 `Task` 携带一个 `ExecutionLock`：

```js
{ holder: string | null,          // agent 名，null = 无人持有
  acquiredAt: string | null,      // ISO
  expiresAt: string | null,       // acquiredAt + executionLock.timeoutMs
  queue: [{ agent, requestedAt, timeoutAt }] }
```

状态：

| 状态 | 判定条件 | 谁能写 |
|---|---|---|
| `free` | `holder === null` | 任何项目 Agent（但应先 `request`） |
| `held` | `holder !== null` 且未过期 | 只有 `holder` 与该项目的 human |
| `queued` | 非 holder 的 agent 出现在 `queue` 中且未超时 | 不能写；只能等 |
| `expired` | `expiresAt <= now` | 尚无 holder；下一次 `sweep()` / 读操作会把它回收成 `free` |

转移：

| 从 | 事件 | 到 | 说明 |
|---|---|---|---|
| `free` | `request(taskId, agent)` | `held` | 立即获得，`expiresAt = now + timeoutMs` |
| `held` | 他人 `request` | 自己 `held`，他人 `queued` | 入 FIFO 队尾；队列深度 > `maxQueueDepth`（默认 16）时拒绝 |
| `held` | `release(taskId, agent)` | `queued` 且队列非空 → `queue[0]` 变 `held`；否则 `free` | 释放即交接，不需要重新排队 |
| `held` | 超过 `timeoutMs`（默认 `1800000` = 30 分钟）无人 `refresh` | `expired` → `free` | 防止死掉的持有者冻结对话 |
| `queued` | 等待超过 `queueMaxWaitMs`（默认 `600000` = 10 分钟） | 出队并回报超时 | 排队者自己要知道等不到了 |
| `queued` | holder 释放 | `held`（该 agent 成为新 holder） | FIFO 严格按请求时间 |

**为什么是 FIFO 而不是优先级抢占？** 抢占会引入饥饿与「谁更重要」的判断，而这类判断在本插件里明确属于人类的职责（人类想插队就直接 `force` 释放）。FIFO 让模型的行为可预测：先申请的人先拿到，等待有确定的上界。

**为什么过期是「惰性清扫 + 定时器兜底」？** 因为锁的读路径（`canWrite()`）在每个写操作上都会跑，让它在读的时候就顺手回收过期锁，语义上永远不会出现过期锁阻塞写入；`lib/index.js` 里的定时器只是为了让 `sweep()` 的返回值（被释放的 taskId 列表）能落成 feed 事件，让人看见「某某的执行权超时被回收了」。

### 3.2 计划级写权（`lib/core/plan.js#updateStatus`）

计划条目没有锁对象，写权是**每次判定**出来的：

```
可以改状态  ⟺  actor 是 human
             ∨ actor 是该条目绑定 task 的当前执行权持有者
```

不符时返回 `{ needHumanConfirmation: true, reason }`，**不应用**变更。结构性变更（删除条目、把条目改派给另一个 Agent）一律走人工确认，即使当前持有执行权也不行——因为这类变动的后果是跨对话的，只有人能承担。

`blockedBy` 是**派生字段**，不存手工值：`recomputeBlocking()` 在任何状态变化后重算，规则是「任一 `dependsOn` 条目不是 `done` 则被阻塞」。这样做的好处是阻塞关系不可能与真实状态不一致——它就是真实状态的函数。

### 3.3 资产级写权（`lib/core/assets.js`）

资产有两条独立的边界：

1. **读边界**：`allowedAgents` 非空 → 只有名单内的 agent（加人类）可以读、引用、链接。`canRead(store, projectId, asset, agent)` 是唯一判定点。空数组 = 全项目成员可读。
2. **写/删边界**：`highRisk` 资产（名字命中 `config.assets.highRiskGlobs`，默认 `['**/预算*', '**/合同*', '**/*.final.*']`）的覆盖，以及**任何**资产的删除，都返回 `{ needHumanConfirmation: true }`，除非调用方显式传 `confirmed === true`。

`highRisk` 在写入时算一次并落在 `Asset` 上，读路径不再重新匹配 glob——这样即便之后改了配置，历史资产的「高风险」属性也不会被静默改写。

### 3.4 动态模块：append-only + 限流（`lib/core/feed.js`）

动态**没有执行权**，因为它是追加型数据：没有「覆盖」就没有写冲突。这里只有两个约束：

- **append-only**：事件一旦落盘不会被修改；状态变化通过新增事件表达。
- **AI 发言限流**：`config.feed.aiPostsPerMinute`（默认 20，滑动 60 秒窗口）**只对 `source: 'agent'` 生效**。人类的发言永不限流——人类是稀缺资源，AI 是噪声资源。超限时返回 `{ throttled: true }`，事件仍以 `meta.throttled` 标记记录，但不对外呈现。

`retention`（默认 5000）控制内存与单文件大小；超出的旧事件被裁掉，历史只留在 `md/feed.md`（最近 200 条）。

### 3.5 恢复锁与执行权的关系

两把锁是**正交且必须同时满足**的关系：

```
可以安全推进  ⟺  持有会话执行权  ∧  持有恢复锁（若处于恢复流程中）
```

- **执行权**回答「谁能写这个对话的共享产物」。它是一个**长期**租约（默认 30 分钟），跨多轮有效。
- **恢复锁**回答「谁在跑恢复流程」。它是一个**短**临界区（一次恢复流程的时长），目的是防止两个恢复源同时向同一个会话注入「继续」。

关键约束：**恢复流程开始时不强占执行权**。若执行权正被另一个 Agent 持有（说明那个对话还活着、别人在干活），恢复流程把该会话标记为 `paused` 而不是 `recovering`，等执行权释放后再说。强行恢复一个仍被持有的对话，等于制造两个并发写入者——这正是上游插件踩过的坑（见 §10）。

---

## 4. 恢复子系统状态机

### 4.1 每个对话一份 `ResumeState`

持久化在 `resume/<conversationId>.json`，由 `store.getResumeState()` 读取（缺失时返回空壳，旧版本状态会被合并补齐）：

```js
{ conversationId, taskId,
  resumeLock: { state: 'idle'|'recovering'|'awaiting_human'|'paused'|'locked',
                holder, since, reason },
  interruptLock: { state: 'unlocked'|'counting'|'locked'|'trial_resume',
                   consecutiveFailures, lastFailureReason, lockedAt, lockedBy,
                   trialResumesUsed, stableSince },
  autoResumeWindow: { startedAt, count },   // 滑动窗口自动恢复配额
  lastResumeAt, lastFailureAt, lastSucceededAt }
```

注意 `resumeLock.state = 'locked'` 与 `interruptLock.state = 'locked'` 是两个不同的东西：前者是「恢复锁当前不可获取」，后者是「中断锁已止损」。前者是后者的**投影**——`interruptLock` 锁定后，`acquireResumeLock()` 会拒绝，`planResume()` 会把这个对话从候选里剔除。

### 4.2 五个状态

| 状态 | 含义 | 谁能推进 |
|---|---|---|
| `idle` | 没有恢复流程在跑，可被 `acquireResumeLock` 获取 | 任何满足条件的恢复源 |
| `recovering` | 某个 holder 正在执行恢复（读检查点 → 核对 → 注入） | 只有 `holder` |
| `awaiting_human` | 恢复需要人裁决（幂等判定为 `request_human`，或需要试验性恢复额度） | 只有 human |
| `paused` | 暂缓恢复：执行权被别处持有，或人类暂停了这个对话 | 定时扫描会在条件满足时重新评估 |
| `locked` | 中断锁止损后不可恢复 | 只有 human（`releaseLock`） |

### 4.3 转移表

| 当前 | 触发 | 守卫 | 结果 |
|---|---|---|---|
| `idle` | `acquireResumeLock(projectId, conversationId, holder)` | `interruptLock.state !== 'locked'`；`autoResumeWindow` 配额未耗尽 | → `recovering`，记录 `holder` / `since` |
| `idle` | `acquireResumeLock` 被调用但中断锁已锁定 | 中断锁 `locked` | 拒绝，`reason: 'locked_by_interrupt'`，不改变状态 |
| `idle` | 发现执行权被其他 Agent 持有 | `locks.holder() !== null` 且不是本对话 | → `paused`，`reason` 说明等执行权 |
| `recovering` | 第二个恢复源 `acquireResumeLock` | — | **返回既有 holder，不覆盖**（见 4.4） |
| `recovering` | 恢复成功（注入后对话推进，且 `recordResumeAttempt({outcome:'succeeded'})`） | — | → `idle`，释放锁；`stableSince = now`（**不立即清零失败计数**） |
| `recovering` | 恢复失败（`rejected` / `interrupted_again`） | — | → `idle` 并释放锁，`consecutiveFailures += 1`；若命中中断锁条件 → `locked` |
| `recovering` | 幂等守卫返回 `request_human` | `GUARD_MATRIX[op][changed_by_other].action === 'request_human'` | → `awaiting_human`，写一条 `recovery / resume.failure` 动态 |
| `awaiting_human` | 人类在工作台点「手动恢复」，或调用 `request_manual_resume` | human actor | → `recovering`（新 holder = human 指定的恢复源） |
| `awaiting_human` | 人类选择放弃 | human actor | → `idle`，任务置 `paused` |
| `paused` | 执行权释放 / 人类继续 | 执行权 `free` 且中断锁非 `locked` | → `idle`（等下一轮 `planResume` 重新评估） |
| 任意 | `engageLock(...)` | 见 §5 | → `locked` |
| `locked` | `releaseLock(..., { by: human })` | human actor | → `idle`（或 `trial_resume` 路径见 §5） |

### 4.4 并发规则（三条）

1. **一个对话同一时刻只有一条恢复流程在跑。** `acquireResumeLock` 在 `state === 'recovering'` 时**返回既有 holder 而不是覆盖**。这是刻意的幂等设计：第二个恢复源拿到的是「谁在跑」，它可以据此决定等待或在下一个扫描周期再试，而不是把第一个踢掉造成两条注入。
2. **执行权被别处持有时延迟恢复。** 恢复流程不抢占执行权；它把状态置为 `paused`。理由见 §3.5。
3. **中断锁优先于一切。** `interruptLock.state === 'locked'` 时，`acquireResumeLock` 直接拒绝，`planResume` 在候选筛选阶段就把该对话剔除——**不存在「先试着恢复一下看看」的路径**，因为那正是要止损的行为。

### 4.5 自动恢复的配额与静默窗

`planResume(store, config, deps)` 产出候选列表，它同时施加全部边界：

| 边界 | 配置键 | 默认值 | 作用 |
|---|---|---|---|
| 中断锁 | — | — | `interruptLock.state === 'locked'` 的对话直接剔除 |
| 活跃窗口 | `resume.activeWindowMs` | `7200000`（2 小时） | 只恢复最近有活动的会话 |
| 用户主动停止 | 调用方谓词 `deps.wasUserAborted` | — | 人类按过停止的对话不自动恢复 |
| 滑动窗口配额 | `resume.maxAutoResumesPerWindow` / `resume.windowMs` | `5` / `3600000`（1 小时） | 每小时每对话最多 5 次自动注入 |
| 重启静默窗 | `resume.silentWindowMs` | `15000`（15 秒） | Host 重启后先等 15 秒，避免抢在用户第一次操作之前 |

静默窗的意义值得单独说：Host 刚重启时，用户往往正急着点第一次操作。如果恢复流程 200ms 就注入了五个「继续」，工作台会瞬间被模型输出淹没，用户的第一个动作被淹没在噪声里。15 秒是一个成本极低的对冲。

---

## 5. 意外中断锁状态机

中断锁是**止损**装置：它要回答的问题不是「能不能续」，而是「续了这么多次还不行，是不是该停下来叫人」。

### 5.1 五个状态与转移

```
unlocked ──(失败计数≥阈值)──▶ counting ──(再失败且最近一次是服务端拒绝)──▶ locked
    ▲                            │                                          │
    │                            └──(稳定窗口通过 / 一次实质操作)────────────┘
    │                                                                       │
    └────(试验性恢复成功且窗口通过)──── trial_resume ◀──(人类确认试验恢复)───┘
                                          │
                                          └──(试验失败)──▶ locked（不再自动重试）
```

| 状态 | 含义 | 进入条件 | 出口 |
|---|---|---|---|
| `unlocked` | 正常，没有连续失败 | 初始；或 `consecutiveFailures` 被清零 | 失败计数达阈值 → `counting` |
| `counting` | 连续失败累积中 | `recordResumeAttempt` 记录 `rejected` / `interrupted_again` | 满足两条件 → `locked`；稳定窗口通过或实质操作 → `unlocked` |
| `locked` | 已止损，禁止自动恢复 | `consecutiveFailures >= failureThreshold` **且** 最近一次失败是服务端拒绝 | 人类解锁；或人类批一次试验恢复 → `trial_resume` |
| `trial_resume` | 被允许试一次 | `releaseLock(..., { trial: true })` | 成功且稳定 → `unlocked`；失败 → 直接 `locked`，`trialResumesUsed += 1` |

### 5.2 两个条件必须同时成立

`recordResumeAttempt` 在累加失败计数后，只有在**两个条件同时为真**时才 `engageLock`：

1. `consecutiveFailures >= config.interruptLock.failureThreshold`（默认 **3**）
2. 最近一次失败的分类是**服务端拒绝**（`classifyFailure() === 'dead_end'`），不是瞬时抖动（`transient`）

为什么必须两个条件？因为它们单独都不足以证明「再试也没用」：

- **只看计数**：一次 3 秒的网络抖动连撞三次，会误锁一个完全正常的对话，把一次成功重试变成了人工工单。
- **只看分类**：一次鉴权失败就永久锁定，排除了「用户刚好重新登录了」这种常见情形，锁会变成一次性的。

两个条件合起来表达的是：「同一个**非瞬时**原因连续撞了三次」。这才是值得停下来叫人的信号。

### 5.3 稳定窗口（默认 10 分钟或一次实质操作）

计数清零不靠「成功」这个瞬时事件，而靠**稳定**：

- `config.interruptLock.stableWindowMs` 默认 `600000`（10 分钟）。恢复成功时不立刻清零，而是记 `stableSince = now`；之后某次检查（`recordStable`）若 `now - stableSince >= stableWindowMs`，才把 `consecutiveFailures` 归零、状态回 `unlocked`。
- **一次实质操作**也可以清零。实质操作指真的推进了项目状态的动作（写了计划状态、落了资产、发了交接），而不是「成功注入了一条消息」。注入成功只证明通道通了，实质操作才证明对话活过来了。

为什么不在成功那一刻清零？因为「注入成功 → 立刻又挂」是最常见的失败模式：模型被唤起、读了两条上下文、再次被服务端拒绝。若成功即清零，这个循环可以无限重复，每次都在计数归零后重新从 1 数起，锁永远不触发。稳定窗口把这个循环堵死。

### 5.4 试验性恢复（`trial_resume`）

- 额度：`config.interruptLock.maxTrialResumes`，默认 **1**。
- 入口：人类在工作台的任务面板点「试验性恢复」，或 Agent 调 `request_manual_resume({ trial: true })` 被人类批准。
- 规则：试验恢复期间 `state = 'trial_resume'`，`trialResumesUsed += 1`。若失败，**直接回到 `locked` 且不再自动重试**——试验失败是本对话「确实不可自动恢复」的最强证据。
- 额度耗尽后，`request_manual_resume({ trial: true })` 会被拒绝，只允许完整人工解锁（`resetCounter`）。

### 5.5 人类解锁入口（四个）

| 入口 | 位置 | 行为 |
|---|---|---|
| 「解除意外中断锁」按钮 | 工作台任务面板 / 动态面板的锁定事件卡片 | `releaseLock(..., { by: 'human', resetCounter: true })` → `unlocked` 且计数清零 |
| 「试验性恢复」按钮 | 工作台恢复状态指示面板 | `releaseLock(..., { trial: true })` → `trial_resume` |
| `POST /ai-buddy/api/task` `op: 'unlock'` | Web API | 同上，供脚本化使用 |
| 人类在动态中发言（`human.resume` / `human.unlock` 类事件） | 工作台动态面板 | 作为「人已介入」的信号记录，并解锁 |

锁定期间会发生什么，需要说清楚：对话被 `engageLock` 锁定后——

- `planResume()` 不再产出它；
- `acquireResumeLock()` 以 `locked_by_interrupt` 拒绝；
- 绑定的计划条目被 `setLockedByInterrupt()` 置为 `status: 'locked_by_interrupt'`（这是**唯一**能写这个状态的路径），在工作台计划看板上有醒目告警；
- 触发任务 `status: 'locked_by_interrupt'`，`sourceLocked` 的资产被标记；
- 写一条 `recovery / lock.engaged` 事件并 `pinned: true`，钉在动态顶部。

这就是「停得住」：锁定不是日志里的一行字，它同时改了计划、任务、资产三个模块的可写性与可见性，人类在工作台一打开就知道哪里停住了、为什么停。

---

## 6. 幂等性守卫判定矩阵

### 6.1 要解决的问题

中断恢复最危险的动作不是「没恢复」，而是「恢复了两次」。一条已经落盘的交接、一次已经写入的资产、一个已经创建的计划条目——如果恢复流程重做一遍，会得到重复的资产、两条冲突的交接、双份计划。模型自己无从判断：它的上下文在崩溃时已经丢了，它只知道自己「打算做」某件事。

所以恢复流程的规则是：**先判定，再行动**。判定输入是两个量：

- `operationType`：`handoff` | `asset_write` | `plan_update` | `feed_post` | `conversation_create`
- `resultStatus`（检查点里 `resume_context.last_operation.result_status` 的记录值）：`confirmed` | `unconfirmed` | `failed` | `changed_by_other`

输出是一个 `GuardVerdict`：

```js
{ action: 'skip' | 'retry' | 'verify_first' | 'request_human',
  reason, detail, evidence }
```

矩阵是 `(operationType, resultStatus)` 的**纯函数**，在 `lib/core/resume.js` 里以 `GUARD_MATRIX` 导出，测试与本文档共用同一份数据——不存在「文档写一套、代码跑另一套」的可能。

### 6.2 判定矩阵

| 操作类型 \ 记录状态 | confirmed | unconfirmed | failed | changed_by_other |
|---|---|---|---|---|
| **handoff** | `skip` —— 交接已落盘，重做会产生两条冲突的移交记录，接收方会收到两次上下文 | `verify_first` —— 先查目标任务的 `ownerAgent` 是否已经变成接收方，是则跳过 | `retry` —— 移交没有生效，执行权还在原持有者手里，可以安全重做 | `request_human` —— 期间有人改了归属，谁是合法持有者已不是模型能判断的 |
| **asset_write** | `skip` —— 但先读最新版本：资产可能已被他人升级到更高 `version`，直接覆盖会抹掉别人成果 | `verify_first` —— 按 `sha256` 比对 blob，一致说明写成功只是没记检查点；不一致才补写 | `retry` —— 字节没落盘，重写是幂等的（同内容同 sha256，版本号递增一次） | `request_human` —— 别人动过这个资产，覆盖等于覆盖他人的工作 |
| **plan_update** | `skip` —— 状态已是目标值，重写只会刷一次 `updatedAt` 并污染审计轨迹 | `verify_first` —— 读条目当前 `status`：已是目标值则跳过，否则补写 | `retry` —— 状态未变，重试无副作用 | `request_human` —— 状态被别人改成了第三个值，两种意图冲突 |
| **feed_post** | `skip` —— 动态 append-only，重发就是重复内容，且会吃掉限流配额 | `verify_first` —— 按 `feed_event_ids` 里记录的 id 回查，存在即跳过 | `retry` —— 事件确实没落盘，重发安全（限流允许的前提下） | `request_human` —— 别人已经就同一主题发过，重发会造成两个声音 |
| **conversation_create** | `skip` —— 对话已创建，重做会多出一条空会话绑同一个计划条目 | `verify_first` —— 查该项目是否已有绑定同一 `planItemId` 的活跃任务 | `retry` —— 创建失败，`conversationId` 仍为 `null`，可安全重建 | `request_human` —— 已有人为同一目的建了会话，重复创建会分裂上下文 |

### 6.3 四列的语义

| 列 | 含义 | 恢复流程的动作 |
|---|---|---|
| `confirmed` | 上次操作**确实生效了**（检查点或真库证据充分） | 跳过；不要重做。`asset_write` 额外要求先读最新版本 |
| `unconfirmed` | 记录为已发出，但**没有落盘证据**（典型场景：注入请求发出后、写检查点前崩溃） | 先到真库核对，按核对结果决定跳过还是补做。**绝不直接重做** |
| `failed` | 明确失败，没有任何副作用 | 可以重试；重试就是普通的正常执行 |
| `changed_by_other` | 期间被别人改动过，且改动方向与本次意图不一致 | 请求人工裁决；模型停止在该操作上的所有自动行为 |

### 6.4 `verify()`：把记录状态翻译成真库事实

矩阵吃的是「记录状态」，而恢复流程手里只有检查点里的记录。`verify(store, config, projectId, { operationType, targetRef })` 负责去活库里查，返回 `{ status, evidence }`：

- `asset_write`：读 `assets/manifest.json` 里该 id 的 `version` / `sha256` / `updatedAt`，与检查点比。
- `handoff`：读目标 `Task.ownerAgent` 与 `executionLock.holder`。
- `plan_update`：读 `PlanItem.status`。
- `feed_post`：按 `feed_event_ids` 回查事件是否存在。
- `conversation_create`：查是否存在绑定同一 `planItemId` 的任务。

`evidence` 是要塞进 `GuardVerdict` 给模型看的具体字段和值，不是一句「已验证」。

### 6.5 矩阵与恢复锁的联动

`guard()` 返回 `request_human` 时，恢复流程不会硬着头皮继续：它把 `resumeLock.state` 置为 `awaiting_human`，写一条 `recovery / resume.failure` 事件，然后停住。此时人类的解锁不影响中断锁（那只管连续失败次数），这是两个独立的人工入口。

---

## 7. 检查点数据 schema

### 7.1 位置与生命周期

- 落盘：`<dataDir>/projects/<projectId>/checkpoints/<conversationId>.json`，形如 `{ version: 1, checkpoints: Checkpoint[] }`。
- 保留：`config.checkpoints.perConversationRetention`（默认 200）条，超出时保留最新的 N 条（`store.appendCheckpoint()` 用 `slice(-cap)` 裁尾）。
- 灌入简报：`config.checkpoints.briefInlineCount`（默认 3）条内联进 `ResumeBrief`。
- 写入时机：`handoff`、`plan_update`、`asset_write`、`feed_post`、`status_change`、`resume_attempt`、`resume_success`、`resume_failure`、`lock_engaged`、`lock_released`。

### 7.2 完整 schema（逐字段注释）

```js
{
  // ── 身份 ────────────────────────────────────────────────
  checkpoint_id: 'cp_<16hex>',        // util.newId('cp')；全局唯一，恢复简报据此引用
  timestamp: '2026-11-04T13:22:31.884Z', // nowIso()，写入时刻（不是操作发生时刻）
  trigger_agent: 'market-analyst',    // 谁触发的这次检查点；恢复时用来判断「该由谁接」
  conversation_id: '<Host SessionId>',// DSH 拥有的会话 id，本插件从不生成
  event_type: 'handoff',              // 见 7.3 的封闭集合

  // ── 三个模块的引用（不是值，是指针）────────────────────
  plan_snapshot_ref: 'plan.json@v1',  // 计划文档引用；恢复时按此读最新，不信任旧值
  asset_manifest_ref: 'assets/manifest.json@v1',
  feed_event_ids: ['f_9a1c…', 'f_3d7e…'], // 这次操作产生/关联的动态事件 id，供幂等回查

  // ── 给下一个执行者看的一句话 ────────────────────────────
  context_summary: '把市场部预算草案移交给财务复核，接口费率假设已确认。',
  next_expected_actor: 'finance-reviewer', // 下一个该动手的人；空字符串表示无

  // ── 恢复上下文（本子系统的核心）────────────────────────
  resume_context: {
    last_operation: {
      type: 'handoff',                // handoff|asset_write|plan_update|feed_post|conversation_create
      target_ref: 't_4f2b…',          // 操作对象 id（task / asset / planItem / event / task）
      result_status: 'confirmed',     // confirmed|unconfirmed|failed|changed_by_other
      verified_at: '2026-11-04T13:22:31.884Z' // 该状态最后一次被核实的时刻
    },

    // 另外三个模块在检查点那一刻的真实快照——由 build() 从活库读，不是抄旧值
    cross_module_snapshot: {
      feed_latest_event_id: 'f_9a1c…',        // 动态水位线：恢复时从这里往后读
      plan_item_states: {                     // 本对话任务 + 兄弟条目的状态
        'pl_1a2b…': 'done',
        'pl_7c8d…': 'in_progress'
      },
      asset_version_refs: { 'a_5e6f…': 3 },   // 资产 id → 版本号，供比对是否被别人升版
      execution_lock_holder: 'market-analyst' // 检查点时刻执行权在谁手里
    },

    // 中断锁状态的冗余副本：即使 resume/<id>.json 丢了，检查点里也有线索
    resume_lock_state: {
      consecutive_failures: 0,
      last_failure_reason: null,
      locked: false,
      locked_at: null,
      locked_by: null
    }
  }
}
```

### 7.3 `event_type` 的封闭集合

| 值 | 何时写 |
|---|---|
| `handoff` | `handoff_conversation` 执行权移交 |
| `plan_update` | 计划条目创建或状态变化 |
| `asset_write` | 资产保存 / 覆盖 |
| `feed_post` | AI 主动发动态（重要结论） |
| `status_change` | 任务状态变化（暂停/完成/归档） |
| `resume_attempt` | 开始一次恢复尝试 |
| `resume_success` | 恢复后第一次成功推进（`publish_resume_note`） |
| `resume_failure` | 恢复失败或被拒 |
| `lock_engaged` | 中断锁止损 |
| `lock_released` | 中断锁解除（人类或试验恢复） |

### 7.4 为什么 `cross_module_snapshot` 必须从活库读

`checkpoint.build()` 的每一条跨模块字段都是**构建那一刻去 store 现读的**：`feed_latest_event_id` 取最后一条事件 id，`plan_item_states` 取绑定条目的当前 status，`asset_version_refs` 取当前 version，`execution_lock_holder` 取当前 holder。

这么做的理由是：检查点的用途是**证伪**，不是**记录**。它存在的意义是「我当时以为的」与「现在真实的」可以比对。如果 `build()` 抄的是调用方传进来的旧值，检查点就只是把错误复制了一遍，恢复流程拿它核对永远不会发现差异——它会对着一份自我印证的文档说「一切正常」。所以：快照字段由 build 独占填写，调用方**无法**污染它们。

### 7.5 一个填满的真实例子

市场部年度预算编制项目中，`market-analyst` 完成草案后移交给 `finance-reviewer`：

```json
{
  "checkpoint_id": "cp_7f3a91c0d24e5b68",
  "timestamp": "2026-11-04T13:22:31.884Z",
  "trigger_agent": "market-analyst",
  "conversation_id": "sess_01J9K2M4XQ",
  "event_type": "handoff",
  "plan_snapshot_ref": "plan.json@v1",
  "asset_manifest_ref": "assets/manifest.json@v1",
  "feed_event_ids": ["f_9a1c4b02e7d1", "f_3d7e8a55c019"],
  "context_summary": "市场部预算草案 v1 已落资产；接口费率按 6.8% 假设完成，待财务复核口径。",
  "next_expected_actor": "finance-reviewer",
  "resume_context": {
    "last_operation": {
      "type": "handoff",
      "target_ref": "t_4f2b9c17ae30",
      "result_status": "confirmed",
      "verified_at": "2026-11-04T13:22:31.884Z"
    },
    "cross_module_snapshot": {
      "feed_latest_event_id": "f_3d7e8a55c019",
      "plan_item_states": {
        "pl_1a2b3c4d5e6f": "done",
        "pl_7c8d9e0f1a2b": "in_progress",
        "pl_3b4c5d6e7f80": "pending"
      },
      "asset_version_refs": {
        "a_5e6f7a8b9c0d": 2,
        "a_1b2c3d4e5f60": 1
      },
      "execution_lock_holder": "market-analyst"
    },
    "resume_lock_state": {
      "consecutive_failures": 0,
      "last_failure_reason": null,
      "locked": false,
      "locked_at": null,
      "locked_by": null
    }
  }
}
```

注意 `execution_lock_holder` 仍是 `market-analyst`：交接是**编排权**的移交，执行权租约到下一个 Agent 真正 `request_execution_lock` 时才转移。这个「两个概念不同步」是有意的，见 §3.5 与 §9 第 4 行。

---

## 8. 端到端示例

以下三个场景都用同一个项目形态：`<DSH_HOME>/ai-buddy/projects/p_8c1d…/`，成员为三个 Agent（`market-analyst`、`finance-reviewer`、`ops-planner`）与一个人类（`human`）。

### 8.1 场景 A：四模块联动——市场部年度预算编制

**目标**：展示动态、计划、任务、资产四个模块在一次真实协作中如何互相支撑，以及人类的两次必要介入点。

#### 第 1 步：人类下达指令（human → feed）

人类在**工作台动态面板**的输入框输入：「今年预算口径改成滚动 12 个月，各部门 11/15 前提交草案。@market-analyst 你先牵头。」

对应 `POST /ai-buddy/api/feed`，写入：

```json
{ "kind": "human", "category": "human.instruction", "source": "human",
  "actor": { "type": "human", "id": "human", "name": "Human" },
  "content": "今年预算口径改成滚动 12 个月，各部门 11/15 前提交草案。@market-analyst 你先牵头。",
  "targetRefs": ["market-analyst"], "pinned": false, "highRisk": false }
```

人类发言不受 `feed.aiPostsPerMinute` 限制。

#### 第 2 步：market-analyst 读指令并拆计划（plan 模块）

`market-analyst` 的会话被唤起，它按固定开场顺序调用：

1. `read_human_instructions({ since: '2026-11-04T00:00:00Z' })` → 读到上面那条指令。
2. `read_plan({})` → 空，项目刚起步。
3. `read_feed({ limit: 20 })` → 只有人类那一条。

随后拆解，连续调 `create_plan_item` 三次：

| 调用参数 | 返回 |
|---|---|
| `{ title: '市场部预算草案 v1', mode: 'pre', assignee: 'market-analyst', priority: 3, dueAt: '2026-11-10' }` | `pl_1a2b3c4d5e6f` |
| `{ title: '财务口径复核', mode: 'pre', assignee: 'finance-reviewer', dependsOn: ['pl_1a2b3c4d5e6f'], priority: 3, dueAt: '2026-11-12' }` | `pl_7c8d9e0f1a2b` |
| `{ title: '汇总并提交管理层', mode: 'pre', assignee: 'ops-planner', dependsOn: ['pl_7c8d9e0f1a2b'], priority: 2, dueAt: '2026-11-15' }` | `pl_3b4c5d6e7f80` |

`recomputeBlocking()` 在每次写入后重算，得到：

```
pl_1a2b…  blockedBy: []        （无依赖，可开始）
pl_7c8d…  blockedBy: [pl_1a2b…]  （等草案）
pl_3b4c5d… blockedBy: [pl_7c8d…] （等复核）
```

同时每条 `plan.create` 写一条 `member / plan.create` 动态事件（`source: 'auto'`——这是系统记录的副作用，不是 AI 主动发言）。三者还各自触发一条 `event_type: 'plan_update'` 的检查点。

#### 第 3 步：market-analyst 申请执行权并产出资产（locks + assets）

它有写操作要做，先 `request_execution_lock({ taskId: 't_4f2b9c17ae30' })` → 立即获得，`expiresAt = now + 1800000`。

然后生成草案文件，调 `save_to_assets({ name: '市场部预算草案-v1.xlsx', bytes: <buffer>, contentType: 'application/vnd…sheet', sourceTaskId: 't_4f2b9c17ae30', folder: '预算/市场部' })`：

- 文件名命中 `highRiskGlobs` 的 `**/预算*` → `highRisk: true`。
- `sha256` 由 `util.sha256()` 算出，`version: 1`，字节落 `assets/blobs/a_5e6f7a8b9c0d`。
- 返回 `{ assetId: 'a_5e6f7a8b9c0d', version: 1, needHumanConfirmation: false }`——**首次保存**不需要确认，只有覆盖高风险资产才需要。

接着 `link_asset_to_conversation({ assetId: 'a_5e6f7a8b9c0d', taskId: 't_4f2b9c17ae30' })`，以及一条 `post_update_to_feed({ content: '草案 v1 已落资产，接口费率按 6.8% 假设。', category: 'asset.upload', assetId: 'a_5e6f7a8b9c0d' })`。

#### 第 4 步：计划推进 + 状态回写

`update_plan_status({ planItemId: 'pl_1a2b3c4d5e6f', newStatus: 'done', note: '草案 v1 已交付' })` → 通过，因为调用者正是绑定 task 的执行权持有者。写入后 `recomputeBlocking()` 解开 `pl_7c8d…` 的阻塞。

#### 第 5 步：Handoff 给 finance-reviewer（task 模块 + 检查点）

`handoff_conversation({ taskId: 't_4f2b9c17ae30', targetAgent: 'finance-reviewer', summary: '市场部预算草案 v1 已落资产；接口费率按 6.8% 假设完成。', artifacts: ['a_5e6f7a8b9c0d'], unfinished: ['口径待财务复核'] })`。

这一步同时产生：

1. `Task.ownerAgent` 改为 `finance-reviewer`；
2. 一条 `directed / task.handoff` 动态事件；
3. 一条 `event_type: 'handoff'` 的检查点（内容见 §7.5 的完整例子）；
4. 一条 `release_execution_lock` 的语义效果——编排权走了，租约仍在原持有者手里直到过期或显式释放。

#### 第 6 步：人类的结构性调整（唯一必须人类的动作）

`finance-reviewer` 复核后发现口径需要拆分，想新增一个条目并调整优先级。它调 `update_plan_status({ planItemId: 'pl_3b4c5d6e7f80', newStatus: 'pending' })` 可以，但**改派给别人**或**删除条目**会返回：

```json
{ "needHumanConfirmation": true,
  "reason": "结构性变更（改派/删除）需要人类确认：跨对话影响只有在人类处才可裁决。" }
```

人类在工作台计划看板把 `pl_3b4c5d6e7f80` 的负责人改为 `ops-planner`，并通过 `POST /ai-buddy/api/plan` `{ op: 'assign' }` 落盘——这次变更写一条 `source: 'human'` 的动态事件，所有 Agent 下一轮 `read_feed` 就能看到人的调整。

#### 第 7 步：四模块的最终一致状态

```json
{
  "feed": { "events": 14, "latest": "f_3d7e8a55c019", "pinned": 0 },
  "plan": {
    "pl_1a2b3c4d5e6f": { "status": "done",        "blockedBy": [] },
    "pl_7c8d9e0f1a2b": { "status": "in_progress", "blockedBy": [] },
    "pl_3b4c5d6e7f80": { "status": "pending",     "blockedBy": ["pl_7c8d9e0f1a2b"] }
  },
  "tasks": {
    "t_4f2b9c17ae30": { "ownerAgent": "finance-reviewer", "executionLock": { "holder": "market-analyst" } }
  },
  "assets": {
    "a_5e6f7a8b9c0d": { "version": 1, "highRisk": true, "sourceTaskId": "t_4f2b9c17ae30" }
  }
}
```

四模块通过「一个事件流 + 一个派生阻塞关系 + 一个执行权持有者 + 一个资产版本号」互相校验：计划状态能推出谁该动手，执行权能推出谁有权动手，动态水位线能推出别人做了什么，资产版本能推出产物是否被替换。

### 8.2 场景 B：Handoff 过程中崩溃的多 AI 中断恢复

**目标**：展示检查点、跨模块核对、幂等守卫在崩溃点上的实际作用。

#### 第 1 步：崩溃发生的位置很关键

`market-analyst` 执行 `handoff_conversation` 的内部顺序是：

```
① 校验执行权 → ② 改 Task.ownerAgent（落盘）→ ③ 写 feed 事件（落盘）
→ ④ 写检查点（落盘）→ ⑤ 返回工具结果给模型
```

假设 Host 进程在 **③ 与 ④ 之间**被杀掉。

此时磁盘上的真实状态是：

- `tasks.json`：`ownerAgent` 已是 `finance-reviewer`；
- `feed.json`：多了一条 `directed / task.handoff` 事件；
- `checkpoints/<conversationId>.json`：**没有**这次的 handoff 检查点（最近一条还是上一轮的 `plan_update`）。

也就是说：世界已经变了，但没有任何「我变了」的完备记录。这是最坏的情况，也是本子系统存在的全部理由。

#### 第 2 步：Host 重启，静默窗

`lib/index.js` 启动后：

1. 加载 Store，读回所有项目文档；
2. 启动执行权清扫定时器（`sweep()`）；
3. 等 `config.resume.silentWindowMs`（15 秒）——不抢在用户第一个动作之前。

#### 第 3 步：`planResume()` 产出候选

15 秒后，恢复扫描调用 `planResume(store, config, deps)`，其中 `deps` 提供 `now`、`isRunning(sessionId)`、`sessionLastActivityAt(sessionId)`、`wasUserAborted(sessionId)`、`restartAt`。

对该对话的逐项筛选：

| 检查 | 结果 |
|---|---|
| `interruptLock.state !== 'locked'` | 通过（`unlocked`） |
| 活动时间在 `activeWindowMs`（2 小时）内 | 通过（崩于 4 分钟前） |
| 不是用户主动停止 | 通过（`wasUserAborted` 为 false） |
| 滑动窗口配额未耗尽 | 通过（本窗口内 0/5） |
| 已过 `silentWindowMs` | 通过 |

→ 进入候选列表，元素形如 `{ projectId, conversationId, taskId, trigger: 'restart', reason: 'handoff-incomplete' }`。

#### 第 4 步：抢恢复锁

恢复扫描对候选调用 `acquireResumeLock(projectId, conversationId, 'resume-scheduler')`：

- `resumeLock.state` 是 `idle` → 成功，置为 `recovering`，`holder: 'resume-scheduler'`。
- 此时若**另一个**恢复源（例如用户在另一个标签页点了「手动恢复」）也来抢，它拿到的返回值是 `{ acquired: false, holder: 'resume-scheduler' }`——**不是覆盖，是返回既有持有者**。两条注入路径从源头被合并成一条。

#### 第 5 步：`brief()` 拼装跨模块核对载荷

`brief(store, config, projectId, conversationId)` 返回 `ResumeBrief`，它装着：

1. **最近检查点**（`briefInlineCount: 3` 条内联，最新一条在最前）——最近一条是上一轮的 `plan_update`，它的 `last_operation` 说明「上次做的是改计划状态，已确认」。
2. **检查点之后的动态事件**——按 `cross_module_snapshot.feed_latest_event_id` 往后读。这一步是**关键**：它读到的正是崩溃前那条 `task.handoff` 事件。于是 `finance-reviewer` 在恢复消息里会看到「有人把任务移交给你了」，而不是「你要继续做预算草案」。
3. **计划条目的当前状态与依赖**——`pl_1a2b…` 已 `done`，`pl_7c8d…` 已解除阻塞。
4. **检查点之后变化的资产版本引用**——`a_5e6f7a8b9c0d` 仍是 v1，没被别人改。
5. **当前执行权持有者**——仍是 `market-analyst`（租约未过期）。
6. **幂等判定**——对检查点里 `last_operation` 调 `guard()`。

#### 第 6 步：幂等守卫给出裁决

检查点里记的是 `plan_update / confirmed` → `GUARD_MATRIX.plan_update.confirmed.action === 'skip'`。

但真正的危险在于那条**没有检查点覆盖的** handoff。恢复流程因此调 `verify_idempotency({ operationType: 'handoff', targetRef: 't_4f2b9c17ae30' })`，`verify()` 去活库查到：

```json
{ "status": "confirmed",
  "evidence": { "taskId": "t_4f2b9c17ae30", "ownerAgent": "finance-reviewer",
                "expectedTarget": "finance-reviewer",
                "feedEventFound": "f_3d7e8a55c019" } }
```

→ `confirmed` → `skip`。**不重做交接。** 如果它重做了，`finance-reviewer` 会收到两条交接、两条动态、两份上下文，而第二条的 `summary` 可能是模型在恢复后凭猜测重建的——两份互相矛盾的交接比没有交接更糟。

#### 第 7 步：注入恢复消息

`injectResume(agent, brief, deps)` 用 `deps.createUserMessage(prompts.resumeMessage(brief))` 构造消息，交 `agent.followup(...)`。

`resumeMessage()` 渲染出来的文本**不是**「继续」。它包含五条核对要求（§10.2 有完整清单）、幂等裁决（「交接已完成，不要重做」）、以及下一步该做什么。

#### 第 8 步：恢复成功后写回

`finance-reviewer` 完成复核后，调 `publish_resume_note({ conversationId, summary: '交接确认：草案 v1 口径已复核，进入汇总。', nextExpectedActor: 'ops-planner', feedEventIds: [...] })`：

- 写一条 `event_type: 'resume_success'` 的检查点（跨模块快照重新从活库读，成为下次恢复的基线）；
- `recordResumeAttempt({ outcome: 'succeeded' })` → `stableSince = now`（**不清零计数**）；
- `releaseResumeLock(projectId, conversationId, 'resume-scheduler')` → `resumeLock.state` 回 `idle`；
- 写一条 `recovery / resume.summary` 动态事件，`source: 'auto'`。

#### 第 9 步：稳定窗通过后计数清零

10 分钟后定时检查调 `recordStable()`：`now - stableSince >= 600000` → `consecutiveFailures = 0`、`interruptLock.state = 'unlocked'`。这一次崩溃在恢复子系统里留下了完整痕迹，但**没有触发任何止损**——因为一次成功就够了。

### 8.3 场景 C：意外中断锁触发与解除

**目标**：展示止损路径——什么情况下**必须**停下来叫人。

#### 第 1 步：持续的服务端拒绝

`ops-planner` 的对话进入一种坏状态：每次被恢复唤起，读完上下文发起第一次模型调用就收到 **403（API key 被轮换后权限不足）**。三次恢复，三次同样结果。

`classifyFailure()` 把 403 归类为 `dead_end`（与 `rate_limit` / `transient` / `interrupted` 区分开——这个分类是整个锁的前提）。

#### 第 2 步：三次尝试的逐次记账

| 次数 | `outcome` | `classifyFailure` | `consecutiveFailures` | 中断锁判定 |
|---|---|---|---|---|
| 1 | `rejected` | `dead_end`（403） | 1 | 1 < 3 → `counting` |
| 2 | `rejected` | `dead_end`（403） | 2 | 2 < 3 → `counting` |
| 3 | `rejected` | `dead_end`（403） | 3 | 3 >= 3 **且** 最近失败为 `dead_end` → **`engageLock`** |

对比一下**不会**锁定的两种情形，这能说明两条件设计的必要性：

| 情形 | 计数 | 最近失败分类 | 结果 |
|---|---|---|---|
| 网络抖动连撞三次 | 3 | `transient` | **不锁**，继续按退避梯重试 |
| 一次 403 就被人修好了 | 1 | `dead_end` | **不锁**，计数还不到阈值 |

#### 第 3 步：`engageLock()` 的连带动作

`engageLock(store, config, projectId, conversationId, reason)` 一次写全四处：

1. `resume/<conversationId>.json`：`interruptLock.state = 'locked'`，`lockedAt`、`lockedBy: 'auto'`、`lastFailureReason: '403 forbidden: api key lacks scope'`。
2. `resumeLock.state = 'locked'`（投影）。
3. `plan.setLockedByInterrupt()`：把绑定的 `pl_3b4c5d6e7f80` 置为 `status: 'locked_by_interrupt'`。这是这个状态的**唯一**写入路径。
4. 任务 `status: 'locked_by_interrupt'`；写 `recovery / lock.engaged` 动态事件，`pinned: true`、`highRisk: true`。

`md/plan.md` 里对应条目会落到单独的 `## ⚠ 因意外中断锁锁定` 段落，`md/resume-history.md` 里该对话显示 `意外中断锁：locked，连续失败 3 次` 与最近失败原因。

#### 第 4 步：锁定期间的行为

从这一刻起：

- `planResume()` 在候选筛选阶段剔除该对话（**不是**恢复时才发现，是不进候选）；
- `acquireResumeLock()` 返回 `{ acquired: false, reason: 'locked_by_interrupt' }`；
- 工作台任务面板该任务显示红色锁定标记与「解除意外中断锁」按钮；
- 动态顶部钉着那条 `lock.engaged` 事件。

关键点：**没有任何自动路径能把它救回来**。这是设计目标——止损的含义就是「自动机制已经证明自己无效，现在轮到人」。

#### 第 5 步：人类修好根因

人类在工作台的设置面板做两件事：更新 API key 的权限作用域（Host 侧），然后在任务面板点「试验性恢复」。

这个动作对应 `releaseLock(store, config, projectId, conversationId, 'human', { trial: true })`：

- `interruptLock.state = 'trial_resume'`；
- `trialResumesUsed: 0 → 1`；
- `lockedAt` 保留（试验期仍算「曾被锁定」）、`lastFailureReason` 保留；
- 计划条目从 `locked_by_interrupt` 回到 `pending`；
- 写 `recovery / lock.released` 动态事件（`meta.trial: true`）。

#### 第 6 步：试验恢复的两种结局

**结局一：成功。** 恢复流程跑一遍 §8.2 的第 4–7 步，`ops-planner` 真的推进了任务。`stableSince = now`，10 分钟后 `recordStable()` 清零计数 → `unlocked`，`trialResumesUsed` 归零。

**结局二：失败。** 假设权限其实没修好，还是 403。那么：

- `state` 从 `trial_resume` 直接回 **`locked`**；
- `recordResumeAttempt({ outcome: 'rejected' })` → `consecutiveFailures: 3 → 4`；
- **不再自动重试**，即使配额看起来还没用完（`maxTrialResumes: 1` 已耗尽）。

此时人类再点「试验性恢复」会被拒绝，返回：

```json
{ "error": { "message": "试验性恢复额度已耗尽（1/1）。请排查根因后使用「解除中断锁」，或联系任务所有者。" } }
```

只剩完整解锁一条路：`releaseLock(..., { resetCounter: true })` → `state = 'unlocked'`、`consecutiveFailures = 0`、`trialResumesUsed = 0`。

#### 第 7 步：解锁后的第一个动作是核对，不是重试

解锁不等于「再来一次」。恢复流程仍然从 `brief()` 开始，仍然要过 §10.2 的五条核对，仍然要过 `GUARD_MATRIX`。人类解锁解的是**权限**，不是**判断**——这套设计不允许任何一条路径绕过幂等性守卫。

---

## 9. 与 WorkBuddy 原模型的差异说明

WorkBuddy 是一个「人类在动态里发言、人类维护计划、人类上传资产、人类创建与转交任务」的协作模型。`ai-buddy` 保留它的数据形态（动态 / 计划 / 任务 / 资产四个模块，以及「人能看到什么，Agent 才能读到什么」的权限直觉），但把**发起权**从人下放给 AI，把**审批权**与**结构性裁决权**留在人手里。

### 9.1 六行对照表

| WorkBuddy 原机制 | `ai-buddy` 中的替换 |
|---|---|
| 人类成员在动态中发消息、分享任务 | AI Agent 也可以发动态、创建任务、发起 Handoff；人类保留指挥与审批 |
| 人类手动维护计划看板 | AI 可以在执行中主动创建/更新计划条目；人类负责结构性调整与确认 |
| 人类上传/修改资产 | AI 可以将产物沉淀为资产、引用资产；覆盖/删除高风险资产需人类确认 |
| 任务由人类创建、分享、转交 | AI 可以主动创建对话、拉起其他 Agent、移交执行权 |
| 权限模型「人能看到什么，Agent 才能读到什么」 | 翻译为 Agent 级资产访问边界和工具集边界，人类保留最终审批权 |
| 单人或多人协作中的手动「继续」 / 人工判断中断后如何接续 | 三层恢复子系统 + 意外中断锁：运行中同回合重试、重启后跨模块状态核对、恢复前幂等性守卫；恢复连续失败且仍被拒绝时自动止损锁定，人类保留解锁入口 |

### 9.2 逐行展开：怎么做到的

**第 1 行 · 动态的作者从「人」扩展到「AI」，但区分来源。**

`FeedEvent` 有一个 `source` 字段，取值 `'auto'` / `'agent'` / `'human'`，三个值语义严格不同：

- `auto`：系统记录的一次副作用（`update_plan_status` 自动写的那条 `plan.status` 事件）。没人「说」什么，是系统记账。
- `agent`：模型主动调 `post_update_to_feed`。这才算 AI 发言，**只有它受限流约束**（`feed.aiPostsPerMinute`，默认 20/分钟）。
- `human`：人类在工作台发言。永不限流。

`category` 是封闭集合，且按 `kind` 分组：`member`（成员动作）、`directed`（定向动作，如 `task.share`、`task.transfer`）、`human`（人类动作）、`recovery`（恢复动作）。这个分法让人一眼能看出「这句话是谁在什么语境下说的」，也让 `read_human_instructions` 能精确地只捞人类指令。人类的指挥没有被削弱：`human.priority` 事件会同时钉在动态顶部，任何 Agent 下一轮开场读 feed 时第一眼看到的就是它。

**第 2 行 · 计划的作者下放，结构性变更上收。**

AI 调 `create_plan_item` 与 `update_plan_status` 是正常路径，`mode: 'pre' | 'live'` 区分「事前计划」和「事中计划」——后者意味着 AI 在执行过程中发现自己需要拆一个新条目，可以直接落盘而不必等人批准。

但两类操作被强制上收：**删除条目**与**跨 Agent 改派**。它们返回 `{ needHumanConfirmation: true, reason }` 而不应用。同时 `blockedBy` 是派生的、由 `recomputeBlocking()` 在每次状态变化后重算——所以「计划看板是否准确」这件事不再依赖任何人的手工维护纪律：它就是真实状态的函数，AI 和人都不可能让它变脏。

**第 3 行 · 资产的写入下放，高风险资产的覆盖上收。**

AI 用 `save_to_assets` 把产物沉淀为资产（自动算 sha256、置版本号、写 blob），用 `query_assets` 检索，用 `link_asset_to_conversation` 挂到对话上。`highRisk` 由名字匹配 `assets.highRiskGlobs` 得出（默认 `**/预算*`、`**/合同*`、`**/*.final.*`）。

覆盖高风险资产、以及删除任何资产，都需要 `confirmed === true`，否则返回 `{ needHumanConfirmation: true }`。这里的关键不是"禁止"，而是"改由人确认一个已经存在的对象"——**创建**是自由的，**破坏**是受控的。这条规则在恢复流程里还有第二重意义：一个刚崩过的 Agent 在重写资产前，`GUARD_MATRIX.asset_write.confirmed` 会要求它先读最新版本，防止覆盖别人在上一次崩溃之后升级过的版本。

**第 4 行 · 任务的发起与移交下放，但移交是「编排权」而非「执行权」。**

AI 调 `create_conversation` 创建任务（`conversationId` 在 Host 会话绑定前是 `null`），调 `handoff_conversation` 移交。移交时发生的是：`Task.ownerAgent` 改变、写一条 `directed / task.handoff` 动态、写一条 `event_type: 'handoff'` 检查点。

但 `executionLock.holder` **不变**。执行权租约要等下一个 Agent 真的去 `request_execution_lock` 才转移。这个分离是刻意的：交接瞬间如果同时转移执行权，接收方可能还没读完上下文就被当成持有者，而原持有者若还在写就可能造成双写。让"谁负责"和"谁有权动手"错开一个 `request` 的间隔，冲突窗口就被消除了。`share_conversation_readonly` 与 `reference_conversation` 则提供两个不转移权的通道：前者让别的 Agent 能读，后者建立可追溯的引用边。

**第 5 行 · 权限直觉翻译成两个具体的可执行边界。**

原模型的一句话原则是「人能看到什么，Agent 才能读到什么」。`ai-buddy` 把它拆成两个模型可判定的东西：

1. **Agent 级资产访问边界**：`Asset.allowedAgents` 非空时，只有名单内的 agent（加人类）能读、引用、链接。`canRead()` 是唯一判定点，`query_assets` 的结果被它过滤。注意这里比原模型更细：不是"人可见则所有 Agent 可见"，而是"这个资产对这几个 Agent 可见"。
2. **工具集边界**：20 个工具即是全部表面（§2）。没有模型可见的 HTTP 旁路，Web API 只服务于人类工作台。一个 Agent 能做的所有事，都能在工具清单里被列举和审计。

人类保留最终审批权，通过三个具体闸门实现：`needHumanConfirmation`（结构性变更/高风险覆盖/删除）、`awaiting_human`（恢复时幂等判定为 `request_human`）、`releaseLock`（解锁中断锁）。

**第 6 行 · 手动「继续」被三层恢复 + 一道止损替代。**

原模型里中断后的接续靠人：人看到对话停了，判断做到哪了，打一句「继续」。这在单人或小规模下可用，在多个 AI 并发协作下会立刻失效——因为「继续」这句话本身不携带任何状态，而多 AI 场景里状态已被别人改过。

`ai-buddy` 把它拆成三层（细节见 §10）：

1. **运行中同回合重试**：失败分类 + 退避梯，`classifyFailure()` 区分 `dead_end` / `rate_limit` / `transient` / `interrupted`，`nextBackoff()` 走 `[30s, 60s, 120s, 180s]` 并尊重 `Retry-After`。
2. **重启后跨模块状态核对**：检查点 + `brief()` 拼装五类核对载荷，注入的消息**不是**「继续」。
3. **恢复前幂等性守卫**：`GUARD_MATRIX` 三选一（跳过 / 先核 / 重试），第四种情况（`changed_by_other`）直接交人。

止损是第四道：三层都已经尽力，仍然连撞三次同一个非瞬时原因 → `engageLock()`，把决定权交回人类。人类的入口没有被取消，只是从"每次都靠人"变成"只在需要时靠人"。

### 9.3 保留了什么

值得明确：`ai-buddy` **没有**推翻 WorkBuddy 的数据形态。四个模块还在，动态仍然是一条流，计划仍然有依赖与状态，任务仍然绑定对话，资产仍然有目录与版本。改变的是**谁有权限写哪一部分**，以及**中断之后如何不靠猜**。这种"形态保留、权限重排"的选择让一个熟悉原模型的人能在工作台上立刻找到位置：五面板的布局就是原四个模块 + 一个恢复状态指示。

---

## 10. 与底层 DSH 重试机制的边界

### 10.1 明确边界：不重造请求级重试

**`ai-buddy` 不重新实现短窗口请求重试。** DSH 自身有 `autoRetry`，负责"一次模型请求失败了，隔几十毫秒到几秒再发一次"。那一层处理的是**传输与瞬时错误**：连接被重置、5xx、流中断。它不知道"这是一次交接"或"这条计划条目已经完成了"，也不需要知道。

`ai-buddy` 补的是**协作级**的三件事：

| 层次 | 归属 | 时间尺度 | 处理什么 | 状态感知 |
|---|---|---|---|---|
| 请求级重试 | DSH `autoRetry` | 毫秒–秒 | 传输失败、瞬时 5xx、流中断 | 无（只看请求成败） |
| 同回合内重试 | `ai-buddy`（`classifyFailure` / `nextBackoff`） | 30 秒–30 分钟 | 限流、需要退避的失败；区分可重试与死路 | 有（知道分类与 `Retry-After`） |
| 回合间恢复 | `ai-buddy`（`planResume` / `brief` / `injectResume`） | 分钟–小时 | 进程重启、对话中断后如何接续 | 有（检查点 + 跨模块快照） |
| 止损 | `ai-buddy`（`interruptLock`） | 跨多次恢复 | 自动恢复已证明无效时停下来叫人 | 有（连续失败 + 失败分类） |

再往下一层的短窗口重试**完全交给 DSH**。`ai-buddy` 的退避梯第一档是 30 秒，比 `autoRetry` 的窗口高一个数量级——这个数量级差本身就是边界的表达：能在毫秒级解决的，下面那层就解决了，根本不会走到 `classifyFailure()`。

### 10.2 注入的「继续」必须携带核对清单

`prompts.resumeMessage(brief)` 渲染的消息里，五条跨模块核对要求是本子系统的硬契约（`CONTRACT.md` §10 第 2 条由测试守着：渲染结果必须包含全部五项，**且不得存在一条不带这些项的裸「继续」**）：

1. **读检查点之后的动态**——从 `cross_module_snapshot.feed_latest_event_id` 往后读，看其他 AI 在你崩溃期间做了什么。
2. **重核计划条目与依赖**——当前 status、`blockedBy` 是否已被解开、有没有人改派。
3. **重核资产版本**——`asset_version_refs` 里的版本是否已被别人升级（若是，绝不能覆盖）。
4. **重核执行权**——`executionLock.holder` 现在是谁；不是自己就先 `request` 或 `query_resume_lock`。
5. **重核本地工作区**——文件、git 状态、后台任务，确认「代码世界」与「协作世界」一致。

这五条之所以必须是清单而不是一句「检查一下」：模型在恢复时的上下文是残缺的，你让它"自己小心"，它就会按最省事的路径走——重做一遍。清单把"小心"变成了五个具体的可执行动作。

消息里还会带上幂等裁决，并且措辞随裁决变化：`skip` → "不要重复"；`verify_first` → "先核实，不要重复"；`request_human` → "请求人类裁决"。

### 10.3 两把锁如何阻止多个恢复源并发注入

「多个恢复源」在真实部署里至少有四个：

1. Host 重启后的自动恢复扫描；
2. 用户在工作台点「手动恢复」；
3. 一个 Agent 自己调 `request_manual_resume`；
4. 某个定时器或另一个插件的「继续」注入。

如果其中任意两个同时向同一会话注入，模型会收到两条独立的 user 消息，各自以为自己是被唤醒的唯一原因，于是按两条指令各做一遍——重复建任务、重复写资产、互相覆盖。这是最坏的失败模式，因为它**看起来成功**。

两道锁各管一段：

**第一道 · 会话级恢复锁（`acquireResumeLock` / `releaseResumeLock`）** 管「同一时刻只有一条恢复流程」。它的关键设计是**第二个 acquire 返回既有 holder 而不是覆盖**：

```js
// 语义（非逐字代码）
acquireResumeLock(store, projectId, conversationId, holder):
  if interruptLock.state === 'locked' → { acquired: false, reason: 'locked_by_interrupt' }
  if resumeLock.state === 'recovering' → { acquired: false, holder: resumeLock.holder }  // 返回既有持有者
  resumeLock = { state: 'recovering', holder, since: now }
  → { acquired: true, holder }
```

返回既有 holder 而非拒绝，是为了让调用方能区分两种情况：「有人在跑，我等它」与「我不能跑」。前者是正常协作，后者是需要人介入。

**第二道 · 意外中断锁（`interruptLock`）** 管「连续失败之后不再有任何自动注入」。它在 `planResume()` 的**候选筛选阶段**生效——被锁定的对话根本不会进入候选列表，而不是走到最后一步才被拦。这个位置很重要：候选筛选是最早的门，错过了它，后面每条路径都要各自记得检查一次，而总有一条会忘。

两道锁的合成效果：

```
一条注入能发生  ⟺  对话未被中断锁锁定
                  ∧  本流程抢到了恢复锁
                  ∧  （若为自动恢复）滑动窗口配额未耗尽 ∧ 已过静默窗
                  ∧  执行权未被别处持有
```

### 10.4 借鉴了哪些上游插件的教训

以下四个上游插件的经验被编码进了本子系统。它们的教训是"在它们的场景里成立、在本插件里必须换一种做法"：

| 上游插件 | 它教的东西 | `ai-buddy` 怎么用 |
|---|---|---|
| `dsh-auto-rerun` | 它做的是**同回合内**的重试（一个回合失败后在同一个回合里再试）。这证明了同回合重试是有效的，但也划出了它的上限：它无法处理"进程没了、回合没了"的情形。 | 本插件的 `classifyFailure` / `nextBackoff` 承接同一位置，但明确**只处理需要退避的失败**（限流、需要等待的非死路），并把毫秒级短窗口交给 DSH 的 `autoRetry`。超出同回合的部分（重启、跨会话）交给 `planResume`。 |
| `dsh-interrupted-resume` | 它做**状态核对**，并且明确警告了**互斥**问题：多个恢复来源同时注入会造成重复推进。 | 状态核对被具体化为 `brief()` 的五类载荷 + `resumeMessage()` 的五条清单；互斥警告被实现为**会话级恢复锁**，并用「第二次 acquire 返回既有 holder」把警告变成机制（§10.3）。 |
| `dsh-client-auto-continue` | 它做**幂等性守卫**，并对**连续失败**设了上限。 | 幂等守卫被具体化为 `GUARD_MATRIX`（5 操作 × 4 状态）与 `verify()` 的真库核对；连续失败上限被具体化为 `interruptLock.failureThreshold`（默认 3），但**加了第二个条件**（最近失败必须是服务端拒绝）——只有计数会误锁正常对话（§5.2）。 |
| `dsh-unstuck` | 它用了**分层重试**，并警告了**层与层之间叠加**的风险：如果每一层都独立重试，总重试次数是各层之积，会打出远超预期的请求量。 | 分层的边界被写死并互相排斥（§10.1 的表）：请求级归 DSH，同回合级归 `backoffMs` 梯 + `maxRetryWallMs`（默认 30 分钟）封顶，回合间归 `maxAutoResumesPerWindow`（默认每小时 5 次）封顶，止损层归 `failureThreshold`。每层都有自己的配额和上限，**不存在无界叠加**。 |

这四个插件都在 `dsh-auto-rerun`、`dsh-interrupted-resume`、`dsh-client-auto-continue`、`dsh-unstuck` 这些**插件层**解决问题；`ai-buddy` 的位置不同——它是一个带持久化真相层与四模块共享状态的协作工作台，所以同样的教训在这里必须落到"状态在哪、谁有权写、怎么证明写过"上，而不只是"再试一次"。

### 10.5 一个反例：为什么不干脆"永远自动恢复"

如果去掉中断锁、让恢复无限重试，会发生什么？

- 一个 API key 失效的对话，会被每小时 5 次的配额持续唤起，每次都在 4 秒内失败，产生大量无意义 token 消耗与日志噪声。
- 更糟的是每次恢复都会写检查点、写 feed 事件。这些事件会挤掉真正有用的历史（`feed.retention` 是有限值），并在动态里制造"这个对话一直在动"的假象——人类会误以为它在推进。
- 由于 `stableSince` 永不被设为稳定，失败计数会缓慢爬升但永不触发任何处置，等于一个无声的失控。

中断锁的价值不在于"限制"，而在于**把一个持续的、无声的消耗变成一个显式的、一次性的、需要人做决定的事件**。锁定之后那条 `pinned: true` 的 `lock.engaged` 事件就是那个事件。

---

## 验证方式

### 在工作台里看

Harness Web UI 侧边栏会出现 **AI 协作**（`AI Buddy`）图标，点开就是五面板工作台：

| 标签 | 看什么 |
|---|---|
| 动态 | 谁在什么时候做了什么；锁定事件置顶并高亮 |
| 计划 | 五列看板（待开始 / 进行中 / 已暂停 / 因中断锁定 / 已完成），条目带依赖与阻塞标记 |
| 任务 | 每个对话的负责 Agent、执行权归属、最近检查点、恢复历史、失败计数、中断锁状态 |
| 资产 | 文件列表、上传、搜索、引用到任务；高风险与来源已锁定的资产有标记 |
| 恢复 | 每个对话的最近恢复时间、触发类型、核对过的模块、上次操作裁决、连续失败次数 |

工作台也可以直接作为普通页访问：`<DSH Web URL>/ai-buddy/`（例如 `http://127.0.0.1:3080/ai-buddy/`）。该路由返回一个只读概览，用于诊断或深度链接——真正的交互界面是 Harness 内的面板。

### 在磁盘上看

JSON 真相层与 Markdown 摘要落在 `<DSH_HOME>/ai-buddy/projects/<projectId>/`（默认 `<DSH_HOME>` 为 `~/.dsh`）：

```
project.json              项目元数据与成员
feed.json                 动态事件流（append-only，按 feed.retention 截断）
plan.json                 计划看板（含派生的 blockedBy）
tasks.json                任务（含 executionLock / resumeLock / interruptLock）
assets/manifest.json      资产清单（含版本历史与 allowedAgents）
assets/blobs/<assetId>    资产原始字节
checkpoints/<conv>.json   该对话的检查点历史（按 perConversationRetention 截断）
resume/<conv>.json        该对话的恢复状态（恢复锁 + 中断锁 + 滑动窗口计数）
md/feed.md                动态的可读摘要
md/plan.md                计划的可读摘要
md/assets.md              资产清单的可读摘要
md/resume-history.md      恢复历史与锁状态的可读摘要
```

**JSON 是唯一真相层，Markdown 是派生投影。** 删掉 `md/` 不会丢任何数据，下一次写入时会在 1.5 秒内自动重建；没有任何代码读回 Markdown。

所有 JSON 写入都走 `writeJsonAtomic()`（`<file>.<pid>.tmp` + `renameSync`），因此进程在任意时刻被杀都不会留下半个文件——这一点对恢复子系统尤其重要，因为它的全部判断都建立在这些文件上。

### 在运行时看

- **工具是否注册**：`cordis_inspect_query(platform='host', provider='Tool', method='listTools')` 应能列出全部 20 个工具名。
- **插件是否激活**：`plugin_manager(action='list_plugins')` 中 `include:ai-buddy` 应为 `fiberPhase: "active"`。
- **面板是否挂载**：`cordis_inspect_query(platform='client', provider='Slots', method='listSubTree', input={root:'main'})` 的 occupants 中应出现 `ai-buddy`。
- **API 是否可用**：`GET /ai-buddy/api/state` 返回 `{ projects, project, feed, plan, tasks, assets, resume, config }`。

### 自检脚本

仓库外的临时目录里跑过三组集成测试（不随包分发，避免把测试数据混进插件）：

| 测试 | 覆盖 | 结果 |
|---|---|---|
| 模块集成 | 四模块 + 锁 + 检查点 + 恢复状态机 + 20 工具 + 落盘 | 73/73 |
| Web API | 路由注册、state、feed/plan/task/asset/config、413、404、SSE、disposer | 21/21 |
| Lossless JSON | 每个工具返回值经 Host 同款校验，防止 `undefined` 逃逸 | 39/39 |
| 团队与任务图 | 名册状态机、上下级、审查、请求生命周期、血缘树、7 个团队工具 | 63/63 |

---

## 11. AI 团队管理子系统

本节描述第二阶段新增的组织层：让多个 AI 会话成为一个有上下级、有分工、有审查的团队，而不是一堆互不相识的对话。

### 11.1 组织模型

团队是项目级的，不是全局的：一个项目一份名册（`team.json`），成员有明确的汇报关系。

| 概念 | 存储位置 | 说明 |
|---|---|---|
| 名册 | `projects/<id>/team.json` | 成员、角色、上下级、状态、统计、最近审查 |
| 协作请求 | `projects/<id>/requests.json` | 待 leader 裁决的招募/任务请求，一次性生命周期 |
| 会话绑定 | 成员的 `sessionId` 字段 | 座位（seat）与会话解耦：会话可释放，座位保留 |

成员形态：

```js
{
  name, role: 'leader' | 'member', reportsTo,
  title, sessionId, workspace,
  model, modelSelection: { provider, model, reasoningEffort },
  status: 'working'|'waiting_human'|'idle'|'dormant'|'offline',
  currentTask, currentPlanItemId,
  stats: { tasksCompleted, tasksRejected, postsTotal, blockedCount },
  review: { at, by, score, verdict, advice }, lastReviewAt,
}
```

**座位与会话解耦**是关键设计：`sessionId` 可以被清空（成员休眠）而不丢座位，醒来时 resume 同一个会话，上下文不丢。

### 11.2 状态机

```
        ┌──────────── 人类回复 / 被唤醒 ────────────┐
        │                                          │
   ┌────▼────┐   turn/start    ┌─────────┐        │
   │  idle   │────────────────▶│ working │        │
   └────┬────┘                 └────┬────┘        │
        │                           │ turn/end     │
        │                           ▼              │
        │                      ┌─────────┐         │
        │                      │  idle   │         │
        │                      └─────────┘         │
        │                                          │
        │  await_human_reply(不睡)                  │
        ├──────────────────▶ ┌──────────────┐      │
        │                    │ waiting_human│──────┘
        │                    └──────────────┘
        │  await_human_reply(睡) / 人类让其休眠
        ├──────────────────▶ ┌─────────┐
        │                    │ dormant │──── 人类唤醒 ──▶ idle
        │                    └─────────┘
        │  插件重载 / agent 释放
        └──────────────────▶ ┌─────────┐
                             │ offline │──── 激活自愈 ──▶ idle
                             └─────────┘
```

两条不变量：

1. **粘性状态优先**：`waiting_human` 和 `dormant` 是意图，不被 `agent.status` 覆盖。一个成员因为等人类而停住，它的 agent 恰好空闲并不代表它可以去干别的。
2. **会话自愈**：插件激活后 8 秒做一次 reconcile，凡是 `sessionId` 存在但 agent 已释放的座位，重新建会话——但 `dormant` / `waiting_human` 除外，那是人类或 AI 的明确决定，自愈不能推翻它。

### 11.3 人类初始化裁定（阶段二新增）

初始化由人类发起，**两个必填项**缺一不可：

| 输入 | 为什么必填 |
|---|---|
| `workspace` | 所有 AI 会话都建在这个目录下，并注册成 DSH Workspace 以便侧栏归组 |
| `model` | leader 的模型由人类决定，全体成员默认继承 |

API 强制校验：任一缺失返回 400，不会静默回退到部署默认。这修正了一个真实缺陷——第一版回退到 `agentDefaultModel`，导致人类没选模型时团队静默跑在 HY4 上。

### 11.4 会话创建的三件事

`lib/host/team-runtime.js#spawn` 按顺序做三件事，缺一不可：

1. **解析模型**：成员自己的 `modelSelection` → leader 的 `leaderModel` → 部署默认。三者都没有就抛错，不创建一个无法应答的 agent。
2. **注册 Workspace**：`workspaceRegistry.create(path)`（幂等）。**这是会话归组的关键**——只设 `meta.cwd` 不够，DSH 侧栏按 workspace 注册表分组，未注册目录下的会话显示为「未分组对话」。
3. **创建会话并挂载**：`agentLoop.create('session-<uuid>', model, { cwd })`，随后 `workspace.attachSession(sessionId)` 关闭索引竞态。

### 11.5 七个团队工具

| 工具 | 谁能调 | 作用 |
|---|---|---|
| `send_message_to_member` | 所有成员 | 发消息并可 @ 指定成员；被 @ 者收到插入消息，在最近步骤边界生效 |
| `await_human_reply` | 所有成员 | 需要人类决策时登记等待并休眠，停止空转 |
| `request_teammate` | 所有成员 | 提出招募/协作请求，由 leader 裁决 |
| `approve_request` | **仅 leader** | 裁决请求：批准派给现有成员 / 批准并引入新人 / 打回并说明理由 |
| `remove_member` | **仅 leader** | 移除成员，**先备份对话为资产**，有下属者不可直接移除 |
| `review_member` | **仅 leader** | 效率审查与建议，写入档案并（默认）直接发给对方 |
| `list_team` | 所有成员 | 查看名册、状态、汇报关系、当前任务 |

权限不是在提示词里约定，而是**在工具实现里检查调用者的名册角色**：成员调用 `approve_request` 会直接失败。这样即使 leader 拿到全部工具（按人类要求），它也无法从成员座位上行使裁决权。

### 11.6 leader 的职责边界

按人类要求，leader **拥有全部工具**，但系统提示词明确约束它不直接参与执行：

> 你的价值在于分配、审查和对外沟通——具体执行交给成员。只有在没有合适成员、且任务极小时才自己动手，并在动态里说明原因。

这是软约束，理由是这样比硬性剥夺工具更灵活：紧急情况下 leader 仍可兜底，但默认行为是统筹。

---

## 12. 任务图（思维导图视图）

### 12.1 为什么需要血缘，而不只是依赖

原有的 `dependsOn` 是 DAG（「必须先完成」），适合排期，**画不出树**——一个共享前置会让两条分支看起来交叉，而人想看的其实是「这个任务是怎么从人类指令分解下来的」。

所以计划条目增加 `parentId`，表示**血缘**而非依赖：

```js
// 依赖与血缘是两个正交的维度
{ id, title, parentId,      // 谁分解出了我 → 画树
  dependsOn: [...] }        // 我必须等谁 → 画排期标记
```

不变量：`parentId` 必须指向一个存活条目，否则 `create` 拒绝。删除父节点后，子节点不会消失，而是被**重新定根并标记 `orphan`**——静默丢失分支比标记「父已删除」更糟。

### 12.2 树的构建

`lib/core/plan.js#tree(store, projectId, { team })` 返回 `{ roots, index, stats }`，每个节点已经合并了渲染所需的一切：

| 字段 | 来源 | 用途 |
|---|---|---|
| `status` / `assignee` / `priority` | 计划条目 | 节点底色与标签 |
| `agentState` | 成员名册 | 左侧色条：工作中/等待人类/空闲/休眠 |
| `currentTask` | 仅 `in_progress` 条目 | 「这个 AI 此刻在做什么」 |
| `executionHolder` | 绑定任务的执行权 | 谁在写 |
| `depth` / `children` / `orphan` | 树的几何 | 布局与折叠 |

前端不 join 三个集合——服务端一次给全，避免视图层各自推算导致不一致。

### 12.3 布局与交互

`client.js` 的 `layoutTree()` 是两遍手写布局（约 40 行）：

1. **测量**：自底向上算每个子树的高度，让父节点能相对子节点垂直居中；
2. **放置**：自顶向下按深度排 x、按累计高度排 y，同时生成贝塞尔连线。

没有引入图表库：依赖预算是零，而这个布局的本质只是「一层一列、兄弟堆叠」，四十行算术比一个会接管主题的库更合适。

交互：点击有子节点的节点折叠/展开；工具栏有缩放、重置、全部展开/收起；连线颜色按子节点状态区分（进行中绿、锁定红）。

---

## 已知偏差

本节记录实现相对 `CONTRACT.md` 的真实偏移。契约是设计意图，代码是既成事实；冲突处以代码为准，并在此列出。

### 1. `assets.query()` 返回裸数组，不是 `{ assets, hiddenCount }`

`CONTRACT.md` §6.4 写的是返回 `{ assets, hiddenCount }`。实现返回 `Asset[]`。

**为什么**：`query()` 是一个纯过滤器，把「有多少条被权限挡掉了」的会计逻辑塞进它，会让它同时承担过滤与统计两件事，而统计只有工具层的 `query_assets` 需要。工具层现在的做法是再查一次 `scope:'all'` 并相减得出 `hidden_count`——代价是一次额外的内存遍历（不落盘），换来模块接口的单一职责。

### 2. `locks.request()` 用 `acquired/position`，`release()` 用 `handedTo`

`CONTRACT.md` 未固定这两个字段名。`lib/core/locks.js` 用 `acquired` / `position` / `handedTo`（其 JSDoc 明确列出），而工具契约（简报 §5 的输出形状）说的是 `granted` / `queue_position` / `next_holder`。

**处理**：映射放在 `lib/tools/index.js` 的边界上，两侧各说各的词汇，谁也不需要为对方加别名。这一处曾是一个真实缺陷（工具读 `result.granted` 恒为 `false`，导致 `request_execution_lock` 永远报告「未获得」），由设计文档负责人发现并已在工具层修正。

### 3. `lib/index.js` 不导出 `Config` schema，且 `inject` 为空

**为什么**：`@deepseek-ai/schemastery` 校验失败会**整行卸载**插件。一个因为 profile 覆盖行里某个数字写成字符串就消失的工作台，比参数略有偏差但仍在运行的工作台更糟。改由 `lib/config.js` 的 `resolveConfig()` 归一化、钳位、永不为缺失键抛错。

同理，所有服务都通过 `ctx.get(...)` / `ctx.inject([...])` 获取而非硬 `inject`：一个没有 `webServer` 的 Host 仍然得到全部 20 个工具，只是没有工作台页面。

**一个由此暴露的真实缺陷**：最初用 `ctx.interval(...)` 注册定时器，激活时抛 `cannot get property "timer" without inject`。改为 `ctx.get('timer')` 并在缺失时降级为「不做周期清扫」——清扫在每个工具调用路径上也会触发，所以丢定时器只损失新鲜度，不损失正确性。

### 4. `task.handoff()` 的 `last_operation.result_status` 是 `unconfirmed`

不是 `confirmed`。移交记录在**接收方尚未回应**时写入；标记为 `confirmed` 会让恢复流程跳过接收方从未做过的动作。这是 §7.3 的直接要求，也因此 `handoff` 在 `unconfirmed` 列映射到 `verify_first` 而不是 `skip`。

### 5. 活跃窗口用的是已持久化的恢复状态，不是 Host 的会话活跃时间戳

`planResume()` 的 `deps.sessionLastActivityAt` 由 `lib/index.js` 提供。DSH 不向插件暴露跨会话的活跃时间戳，所以实现退化为「该对话存在恢复记录即视为近期活跃」，真正的窗口过滤依靠 `activeWindowMs` 作用在恢复状态自身的时间字段上。

**影响**：一个长期没有任何恢复记录、但刚刚崩溃的对话可能不被自动拾起。这是保守的失败方向——漏恢复会被人发现，误恢复会静默产生副作用。

### 6. 工作台的拖拽改状态改为显式下拉

五面板工作台用 `<select>` 改状态、指派、优先级，没有实现 HTML5 拖拽。在受限 WebView 与触屏环境下拖拽的失败模式（拖到一半松手落在无效列）比下拉更糟，而下拉在两种输入方式下行为一致。拖拽不是本插件的能力主张，状态流转才是。

### 7. `trial_resume` 在检查点里折叠为 `locked: true`

`checkpoint.js` 写 `resume_lock_state.locked = (state === 'locked' || state === 'trial_resume')`。试探恢复期间对话仍须被其他自动流程视为锁定，否则一次试探会同时被两个恢复源拾起——这正是中断锁要防止的情形。

### 8. 阶段二修复的真实缺陷

以下每一条都是实现过程中真实触发并修复的，不是设计推演：

**(a) 工具返回值里的 `null` 导致工具静默消失。**
DSH 会按 `output.schema` 校验 `execute` 的返回值，schema 写 `string` 而返回 `null` 时**注册直接失败**，工具从模型列表里无声消失。第一版 7 个团队工具里有 4 个因此没注册上。修法不是在 schema 里放宽类型，而是让返回值永远给字符串或干脆省略——契约与实现对齐，而不是让契约迁就实现。附带教训：`type: ['string','null']` 这种 JSON Schema 联合类型 Host 不接受，别指望用它绕过。

**(b) `agentLoop.create(undefined, ...)` 产生退化 id。**
`create(id, options, meta)` 要求调用方提供会话身份，传 `undefined` 会得到 `session-1` 这类不可用的 id，且跨座位冲突。改为生成 `session-<uuid>`，与 DSH 自身的格式一致。

**(c) 只设 `meta.cwd` 不会让会话归组。**
这是人类实际看到「未分组对话」的根因。DSH 侧栏按 **workspace 注册表**分组，未注册目录下的会话不归组。必须 `workspaceRegistry.create(path)` 注册，再 `attachSession()` 显式挂载。只写会话头的 `cwd` 字段是不够的。

**(d) 模型回退到部署默认，违背人类意图。**
第一版在人类未选模型时静默使用 `agentDefaultModel`（当时是 HY4）。第二阶段改为：初始化时必须由人类指定模型，缺则 400 拒绝；成员 `addMember` 时复制 leader 的 `modelSelection` 三件套（provider/model/reasoningEffort）。验证方式：解码会话日志的 `request/header`，确认记录的是人类选的模型。

**(e) bootstrap 提示词让 leader 说「你的上级是你自己」。**
生成初始提示时没有区分「自己就是 leader」的情况。修复后 leader 与新成员拿到两份不同的简报：leader 的是统筹职责清单，成员的是执行与汇报规则。

### 9. 阶段三修复：`dormant` 是一个谎

这是本项目最严重的一个状态不一致，值得单独记录。

**现象**：成员名册显示 `status: "dormant"`（休眠），但同一份 API 响应里 `live: true`，且 `agents.get(sessionId)` 仍返回一个活着的 agent。

**根因**：`sleep()` 用 `agentLoop.create()` 创建 agent。该 API 返回一个**裸 `Agent`，由调用方的 fiber 拥有**；插件没有任何手段按需释放它。于是 `sleep()` 能做的最多是把名册字段改成 `dormant` 并 `subagents.interrupt()` 中断当前回合——**agent 从未真正停止**。"休眠"因此是一个只写在磁盘上的声明。

**代价**：休眠的成员继续占用模型配额与内存；更糟的是，人类在面板上看到"已休眠"，会认为它不再消耗资源。这正是"看起来成功"的失败模式。

**修复**：改用 `agentLoop.createAgent(ctx, {...})`，它返回 `AgentHandle`，其 `dispose()` 是真正释放 agent 的唯一途径。运行时持有 `handles: Map<sessionId, AgentHandle>`，`sleep()` 走完整三步：

1. `subagents.interrupt()` —— 先让当前回合干净收尾（直接 dispose 一个 mid-turn agent 会留下半截 assistant 消息）；
2. `handle.dispose()` —— 真正释放；
3. 复查 `agents.get(sessionId)`，**只有确认 agent 已消失才写 `dormant`**，否则写 `offline`。

第 3 步是这次修复的关键：状态不再是"我们希望它是什么"，而是"核实后它实际是什么"。`wake()` 同样用 `resume()` 拿回 handle 并存进 map，否则唤醒后的成员又会变回不可休眠。

**验证**：`sleep` 返回 `released: true`，随后 `live` 变为 `false`；`wake` 复用同一 session id 恢复，`live` 回到 `true`。另跑了 5 轮不变量检查（`working/idle ⇒ live:true`、`dormant/offline ⇒ live:false`），0 违规。

### 10. 阶段三新增：工作区即协作上下文

一个目录对应一个团队、一份计划、一条动态。这条规则替代了原先"全局只有一个项目"的假设，并带来三处改动：

| 位置 | 改动 |
|---|---|
| `Store` | `findProjectByWorkspace(path)` / `listTeamWorkspaces()`，路径比较忽略大小写与分隔符 |
| `GET /ai-buddy/api/workspaces` | 列出已有团队 + 可选目录浏览 |
| `POST /ai-buddy/api/team` (initialize) | 同目录重复初始化返回 `reused: true` 而不是报错或建重复项目 |

前端因此**以工作区选择器作为面板入口**：先选目录，再渲染任何标签页。理由是"我正在看哪个团队"绝不能靠猜——有两个团队的人一旦搞错，就会在错误的计划上操作。面板顶部常驻「切换工作区」。

### 11. 阶段三新增：成员名与 @ 提及

**成员名**改为人类易读：`小算` 优于 `budget-writer`。名册里到处都是这个名字——动态、组织图、@ 提及——slug 在每一种场合都更难读。leader 被邀请自己取名（`recruit_new.name`），留空则从 `NAME_POOL` 里挑一个未占用的；名字长度上限 16 字符，避免撑破任何一行。

**@ 提及**做成输入框内联自动完成：在词边界打 `@` 弹出发送者名单，方向键选择、Enter/Tab 确认、Esc 关闭。实现上用的是**光标位置解析**而不是"文本是否以 @ 结尾"——人几乎总是在句子中间提到别人，尾部判断只在最后才生效。

## 13. 阶段四：宿主进程安全（两次崩溃的根因与修复）

本节记录本插件**两次把 DSH 宿主进程弄崩溃**的完整根因、证据链与修复。这不是设计推演，是真实发生过的事。

### 13.1 两次崩溃的事实

| # | 时间 | 阶段 | 宿主报告 |
|---|---|---|---|
| 1 | 2026-11-06 17:48:48 | running | `dsh: fatal load failure: Error: message "undefined" is already pending` |
| 2 | 2026-11-06 17:58:45 | startup | `DesktopHostFatalError: Cannot read properties of undefined (reading 'authenticatedUrl')` |

崩溃 1 的调用栈（摘自 `crash-2026-11-06T09-48-48-593Z-host.log`）：

```
dsh: fatal load failure: Error: message "undefined" is already pending
    at ReactLoopInbox.mutate   (dsh-agent-loop/lib/index.js:186:35)
    at ReactLoopAgent.followup (dsh-agent-loop/lib/index.js:571:8)
    at Module.injectResume     (ai-buddy/lib/core/resume.js:1571:30)
```

崩溃 2 与 AI Buddy 无关：它是我自己的 `restore-profile.mjs` 脚本用错误的 `installed()` 判定把内置 asar bundle（`@deepseek-ai/dsh-base`、`dsh-web-app`）当成"未安装"从 profile 里删掉了，导致 `ctx.connection` 为 undefined。修法是用 `plugin_manager set_bundle` 恢复全部 11 个 bundle。**WorkBuddy 5.17.0 → 5.20.2 的升级只是触发了 profile 重写、把我的错误状态落盘，它是巧合不是原因。**

### 13.2 崩溃 1 的根因链（三层，每层都必须修）

**第一层：宿主把 `message.id` 当作收件箱主键。**

`dsh-agent-loop` 的持久收件箱有两张待办表（`next-turn`、`next-step`）。每次插入都会对两张表的**并集**做去重，重复即抛：

```js
// dsh-agent-loop/lib/index.js  ReactLoopInbox.mutate
for (const message of target === "next-turn" ? [...candidate, ...state["next-step"]] : [...state["next-turn"], ...candidate]) {
    if (ids.has(message.id)) throw new Error(`message "${message.id}" is already pending`);
    ids.add(message.id);
}
```

这个 throw 发生在 `session.append("agent/inbox/spliced", …)` **之前**，所以失败的插入不会被持久化。但 `cancel(…, { keepInbox: true })` 与 dispose 会**保留**待办内容，于是重复 id 可以熬过重启，并在重放时再次抛出（`invalid persisted inbox splice at session seq N`）。

**关键：这个 throw 在宿主内部抛出，插件装在它外面，任何 `try/catch` 都接不住。** 它是"不可捕获异常"，Node 的默认 `--unhandled-rejections=throw` 会把它变成未捕获异常，宿主进程直接退出。

**第二层：插件生成了没有 `id` 的消息。**

`makeMessage()` 手写的消息对象漏了 `id`。后果是双重的：

- 两条 `id === undefined` 的消息进收件箱 → `Set` 看到两次 `undefined` → 抛 `message "undefined" is already pending` → **宿主退出**；
- 即使只有一条（不抛），它也会被写进会话日志——因为**活路径的校验比读取路径弱**——然后在下次加载时被 `assertMessageEventShape` 拒绝：

```js
// dsh-session/lib/index.js
if (typeof message["id"] !== "string" || message["id"] === "") throw new Error(`${subject} lacks an identified message`);
```

于是整份会话文件不可读：`stored session "…" is corrupt: session event at seq N lacks an identified message`。这正是人类看到的"我创建的 AI 对话全部失败"。

**第三层（放大器）：一个悬空 promise 把"可捕获"变成了"不可捕获"。**

```js
// 修复前
try {
    resume.injectResume(agent, brief, { … })   // ← 没有 await
} catch (error) {
    log(`ai-buddy: resume injection failed: …`)  // ← 永远抓不到
}
```

`injectResume` 是 `async` 的。`try/catch` 只看得见**同步**抛出；一个没有 `await` 的 async 调用返回的是 promise，它的 rejection 变成**未处理拒绝**，Node 升级为未捕获异常 → 进程退出。

所以修复**只加 `await` 不够**：即使消息合法，宿主若因为别的原因拒绝这次投递（比如会话正在收尾），rejection 依然会逃逸并终结宿主。

### 13.3 修复：唯一的消息出口 `lib/core/messages.js`

所有面向宿主的造消息与投递动作，收敛到一个纯模块（放在 `lib/core/` 是为了 `lib/core/resume.js` 也能用，而不违反"core 不依赖宿主"的分层）：

| 导出 | 职责 |
|---|---|
| `createUserMessage(text, summary, messageId?)` | 造一条**必然合法**的 `user/message`：`id` 为 UUID v4、`role: 'user'`、`content` 为块数组、`source` 为 `{ kind: 'user' }` |
| `isDeliverableMessage(message)` | 按宿主校验规则判定一条消息是否可投递 |
| `MessageLedger` | 每个对话一份已用 id 台账，使重复 id **构造上不可能** |
| `deliver(agent, message, options?)` | 选传输 + **永不抛出**的投递 |

**关于 `source` 的形状**：宿主自己的会话控制器（参考实现）写的是

```js
const source = { kind: "user", rpcId: request.requestId, …clientTimeZone, …principal }
```

`user` 这个 kind 的成员是**封闭的**：只有 `kind`，外加可选的 `rpcId` / `clientTimeZone` / `principal`。`form` 与 `summary` 属于 `plugin` kind（`plugin` + `form: 'notice'` 才配 `summary`）。旧版插件写的 `{ kind: 'user', form: 'notice', summary: … }` 能通过**活路径**校验（那里只查 `source.kind` 非空），但**违反类型契约**，会被会话格式规则拒绝。已改为 `{ kind: 'user' }`；来源标签改由 ai-buddy 自己的动态（feed）承载——那才是它该待的地方。

**关于传输的选择**：借用了 `dsh-connect-workbuddy` 的做法。它交付结果时**从不用** `followup`，而是按状态选 `steer`（空闲时开新回合）或 `inject`（运行中切入当前回合）——见其 `src/cli-bridge/inject.ts:218-220`。理由写在宿主的注释里：`followup` "撞上宿主自己的收尾动作"，而对已经在工作的成员再 `followup` 会"变成两条并行的意图"。

AI Buddy 采用同一条规则：

| 成员状态 | 传输 | 语义 |
|---|---|---|
| `idle` | `followup` | 开启新回合——"让这个成员干活"就是这个意思 |
| `running` | `steer` | 在下一个 step 边界切入当前回合，**不**开第二个回合 |

`inject`（排队但不唤醒）**不用于**面向人类的消息：一条不唤醒的消息会躺在收件箱里直到该成员碰巧再走一步，那正是"@ 没用"这个症状。它留给"只投递上下文、不该启动工作"的场合。

### 13.4 为什么不能直接 `import { createUserMessage } from '@deepseek-ai/dsh-llm'`

宿主确实有官方工厂（`dsh-llm/lib/index.js`）：

```js
function createMessage(input) {
    return deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }));
}
function createUserMessage(input) { return createMessage({ ...input, role: "user" }); }
```

但 profile 里的插件**无法导入它**，有三重障碍：

1. 包不在插件的解析范围内——实测从 `…\profiles\desktop\node_modules\ai-buddy\` 出发，`@deepseek-ai/dsh-llm`、`dsh-agent-loop`、`dsh-agent`、`dsh-session`、`cordis` 全部 `MODULE_NOT_FOUND`，只有 `schemastery` 与 `cosmokit` 被提升到 profile 里；
2. Loader 的 ESM 解析器锚定在 **profile 的 package scope**（`cordis-plugin-loader` 的 `createResolve(ctx.baseUrl)` → `resolveScope` 向上找最近的 `package.json`），而不是 asar；
3. 动态 Cordis 包里 `require` 被硬拦（"Node modules are unavailable. Use the cordis services on ctx instead"）。

**也没有任何宿主服务暴露消息工厂**——`ctx.llm` 的方法表里没有它，`ctx.agent` 这个服务不存在。所以**只能自己造**，但必须造对。这不是"偷懒的重复实现"，是被迫的、且必须精确的实现。

### 13.5 一条不能省的规则：await

现在 `injectResume` 通过依赖注入拿到投递函数（`deps.deliver`），由 `lib/core/messages.js` 的 `deliver` 保证"永不抛出"；调用点则**必须 await**：

```js
await resume.injectResume(agent, brief, {
    createUserMessage: createUserMessageFactory(conversationId),
    deliver,
})
```

`runResumePass()` 因此也变成 `async`，定时器回调用 `.catch()` 收口——**定时器回调绝不能返回 rejected promise**，否则又是一条未处理拒绝。

### 13.6 自检：宿主安全套件

新增 `test/host-safety.mjs`（28 项断言），用一个**忠实复刻宿主收件箱**的 `HostInbox`（两张表 + 并集去重 + 同样的 throw）做验证：

- 造出的消息必须通过宿主的会话校验与会话格式规则；
- 重复投递 50 次不得产生重复待办 id；
- 宿主拒绝时，`deliver` 返回 `delivered: false` 而不是抛出；
- **显式复现放大器**：不 await 的 `injectResume` 会产生一条未处理拒绝（`unhandledRejection` 事件被捕获到），await 的版本不会；
- 静态检查：运行期任何位置都不得直接调用 `agent.followup(`。

### 13.7 阶段四附带修复：启用插件不得自动创建对话

人类的要求是"保留 ai-buddy 并重新启用，但**不要自动创建 AI 对话**"。实测发现：**启用插件的那一瞬间，reconcile 逻辑为名册里每个座位创建了会话**——三个项目、9 个座位，就是 9 次真实的模型调用。

根因是 `reconcileTeamSeats()` 无条件为"有名册但没有活 agent"的座位重建会话。这本身是合理的设计（插件重载后座位不该变成幽灵），但它**默认开启**就等于"启用即花费配额"。

修法是把它变成**显式选择**：

| 配置 | 默认 | 作用 |
|---|---|---|
| `team.autoSpawn` | `false` | 允许在激活时重建丢失的会话（协调者也在内） |
| `team.autoWakeMentions` | `false` | 允许 leader 的后台巡检把人类的 `@提及` 补投给当时没在运行的成员 |

两者默认关闭后：席位只在**人类明确要求**时才活过来——初始化团队、@ 一个成员、或在团队面板里唤醒它。

同时修掉了 `reportToLeader` 的同源问题：它调用 `teamRuntime.send()`，而 `send()` 会唤醒目标，唤醒一个从未有过会话的座位**就会 spawn 一个**。现在它只在 leader **已有活 agent** 时才投递报告。

后台巡检本身照常运行——它只是**只能观察**。

### 13.8 阶段四附带修复：工作区目录必须存在

**现象**：初始化一个团队后，leader 的会话建立了、bootstrap 提示词也送达了，但第一轮在模型看到任何东西之前就死了。会话日志里写着：

```
turn/end  reason.kind = "error"
  working-directory: directory does not exist: "C:\...\ai-buddy-live-2026-…"
```

**根因**：会话的工作目录来自人类在初始化页选的那个路径。插件注册了它（`workspaceRegistry.create`）却**没有创建它**——注册一个不存在的目录是允许的，但宿主在第一轮解析工作目录时会拒绝它。

**为什么难发现**：会话创建成功、提示词成功送达、成员名册显示"工作中"。人类看到的是一个"启动了但没说话"的成员，真正的原因藏在一次 turn 错误里。

**修复**：`ensureWorkspace()` 先 `ensureDir(path)` 再注册。人类在初始化页选一个目录，意思就是"在这里干活"；为一个还不存在的目录拒绝开工是讲不通的。

### 13.11 阶段四附带修复：团队必须能被拆除

**现象**：真机自检跑完后，一个 leader 会话仍然活着。它手里攥着打开的会话日志文件；任何后续的清理（清理脚本、用户手动删除、磁盘回收）删掉那个文件，正在运行的 agent 就会失败：

```
Error: ENOENT: no such file or directory, open '…\session.v4.jsonl.zstd'
```

**为什么这不是插件的 bug**：agent 本该由宿主管理它的会话日志。但在这里，这个 agent 是**插件创建的**，而插件没有给它一条拆除路径——于是人成了唯一的拆除手段，而人是不会知道该删哪个文件的。

**根因**：`sleep()` 拒绝 leader（"the leader must stay awake to coordinate"）。这个拒绝对**人类的决策**是对的——领导者确实不该被"休眠"。但它顺带关掉了唯一的拆除入口：`remove_member` 只改名册，不释放 agent；`sleep` 够不着 leader。于是没有任何操作能把一个团队拆掉。

**修复**：新增 `dispose(projectId, memberName, reason)`，**对任何角色都可用**：

1. 中断当前回合，让回合干净收尾；
2. `handle.dispose()` —— 真正释放 agent；
3. 复查 `agents.get(sessionId)`，**只有确认 agent 已消失**才写 `dormant`，否则写 `offline`。

它与 `sleep` 的区别不是能力，是**意图**：

| | `sleep` | `dispose` |
|---|---|---|
| 语义 | 「这个成员在等人类，座位保留，可被唤醒」 | 「这个 agent 被释放，座位不再指向活会话」 |
| leader | 拒绝 | 允许 |
| 座位 | 保留 `sessionId`，可 `wake` 回来 | 同样保留 id，但 agent 已不在 |
| 用途 | 人类的决策 | 拆除一个用完的团队 |

工作台 API 同步新增 `POST /ai-buddy/api/team` 的 `op: 'dispose'`。

**真机自检现在自己收尾**：跑完就 `dispose` 掉它创建的 agent，所以它不再留下一个攥着日志文件的后台进程。清理脚本也因此改成了**先查活 agent 再删**：有活 agent 的工作区一律跳过并报告，绝不删除。

### 13.12 阶段四的自检套件

| 套件 | 断言数 | 覆盖 |
|---|---|---|
| `test/modules.mjs` | 73 | 模块层（feed/plan/task/assets/locks/checkpoint） |
| `test/web.mjs` | 21 | 工作台 HTTP API |
| `test/json.mjs` | 39 | 工具返回值的无损 JSON |
| `test/team.mjs` | 63 | 团队子系统 |
| `test/host-safety.mjs` | 28 | **宿主进程安全**（§13.6） |
| `test/autospawn.mjs` | 15 | **启用即建会话的闸门**（§13.7）+ **团队可拆除**（§13.11） |
| `test/live.mjs` | 7 | **真机端到端**：对着活的宿主建团队，让真的模型跑一轮 |

跑法：`npm test`（离线 236 项）、`npm run test:live`（追加真机 7 项）。真机套件可选——它会创建真实会话、消耗真实配额。

`test/live.mjs` 是最有价值的一个：它不 mock 任何东西。它通过真实 HTTP API 初始化一个团队，然后解码 zstd 压缩的会话日志，断言

- 每一条 `user/message` 都带非空 `id`、`role: 'user'`、数组 `content`、非空 `source.kind`；
- 插件自己发的那条消息的 `source` **恰好**是 `{ kind: 'user' }`（宿主自己发的 `runtime-context` 快照带 `form`/`sections` 是合法的，所以只断言我们自己的）；
- leader 真的产出了 `assistant/message`（模型跑过了）；
- 那一轮没有以错误结束；
- 期间宿主没有产生新的崩溃日志。

### 13.10 一条给未来的教训：解析宿主产物时，先验证你的假设

写这套 live 自检时，我在自己的测试里犯了三个错，每一个都让断言"稳定地失败"：

1. **猜错了会话目录的编码。** 我假设 `C:\Users\x` 会变成 `--C--Users-x--`（把 `:` 和 `\` 各换成 `-`），而宿主是把**每个**分隔符换成**一个** `-`。两次都"看起来对"。
2. **假设了文件布局。** 新建的会话把日志直接写在工作区目录里，恢复的会话写在 per-session 子目录里。两种都要接受。
3. **假设了时序。** 会话日志是在首次 append 或 flush 时才落盘；`turn/end` 可能比 `assistant/message` 晚一拍。

每一个错都表现为"断言失败但我确信代码是对的"——那种时候该怀疑的是**测试**，不是被测物。更糟的是它们在我第一次运行时**恰好通过**（因为那次的布局恰好是我猜的那种），于是我差点把一个脆弱的测试当成"已验证"。

真正有用的做法是：**断言前先把宿主产物 dump 出来看**。`dump-session.mjs` 就是这么来的——它打印每一条事件的类型、id、source，答案立刻就清楚了：bootstrap 消息完全合规（`id` 齐、`source` 正好是 `{kind:'user'}`、人类的要求被追加在最后），真正的问题只有一个——工作区目录不存在。



