# ai-buddy

AI 与 AI 的多对话协作工作台 —— DSH 插件。

把 WorkBuddy 的团队协作模型从「人—人」重构为「AI—AI」：动态、计划、任务、资产四大模块共享一套项目级执行权模型，人类作为项目发起者、动态中的指挥者和最终审批者参与。内置**中断恢复**与**幂等性守卫**子系统，以及**意外中断锁**作为恢复失败的止损机制。

完整设计说明见 [DESIGN.md](./DESIGN.md)。

---

## 仓库结构

```
ai-buddy/
├── lib/
│   ├── index.js            插件入口：装配工具、系统提示、HTTP API、周期任务
│   ├── config.js           配置归一化（永不抛错，逐项 clamp）
│   ├── store.js            JSON 真相层 + Markdown 摘要层
│   ├── util.js             无依赖工具函数
│   ├── markdown.js         Markdown 渲染（纯函数）
│   ├── web.js              工作台 HTTP API
│   ├── core/               纯逻辑，不依赖 Cordis —— 可脱离宿主测试
│   │   ├── feed.js         动态：append-only + 限流
│   │   ├── plan.js         计划：写权 + 阻塞推导 + 血缘
│   │   ├── task.js         任务 = 对话绑定 + 移交
│   │   ├── assets.js       资产：写权 + 高风险集合
│   │   ├── locks.js        执行权队列
│   │   ├── checkpoint.js   检查点 schema
│   │   ├── resume.js       恢复子系统 + 幂等性守卫 + 中断锁
│   │   ├── messages.js     唯一的消息出口（宿主进程安全，见下）
│   │   ├── prompts.js      提示词
│   │   ├── team.js         团队名册与角色
│   │   └── requests.js     协作请求
│   ├── host/               需要真实宿主服务 —— 副作用集中在这里
│   │   ├── team-runtime.js 创建 / 唤醒 / 停用 / 投递
│   │   └── watch.js        leader 的后台巡检
│   └── tools/              Agent 工具（20 个 + 7 个团队工具）
├── client.js               工作台前端（浏览器侧）
├── cordis.patch.yml        bundle patch 行与默认配置
├── locale/{zh,en}.json     前端文案
├── icon.svg
├── docs/                   设计文档目录
├── test/                   测试套件（见下）
├── CONTRACT.md             模块间契约
├── DESIGN.md               完整设计说明（§13 是宿主进程安全）
├── CHANGELOG.md
└── LICENSE
```

`lib/core/` 与 `lib/host/` 的分界是刻意的：**core 不依赖 Cordis**，所以它能被单元测试直接驱动；所有真实副作用（创建会话、投递消息）集中在 `host/`，只有两个文件。

---

## 测试

```bash
npm test          # 239 项断言，纯离线，不碰宿主、不调模型
npm run test:live # 追加 7 项真机断言（需要 DSH 在运行）
```

| 套件 | 断言 | 覆盖 |
|---|---|---|
| `test/modules.mjs` | 73 | 四大模块 + 锁 + 检查点的联动 |
| `test/web.mjs` | 21 | 工作台 HTTP API |
| `test/json.mjs` | 39 | 工具返回值的无损 JSON |
| `test/team.mjs` | 63 | 团队子系统 |
| `test/host-safety.mjs` | 28 | **宿主进程安全**（见下） |
| `test/autospawn.mjs` | 15 | **启用插件不得自动创建对话** + **团队可拆除** |
| `test/live.mjs` | 7 | **真机端到端**：对着活的宿主建团队，让真的模型跑一轮 |

真机套件需要环境变量 `DSH_BASE`（默认 `http://127.0.0.1:3080`）和 `DSH_HOME`（默认 `~/.dsh`）。它会创建真实会话，因此是**可选**的。

---

## 它解决什么问题

多 AI 协作比单 Agent 场景更容易因中断而产生不一致状态：一个对话中断时，其他 AI 可能已经基于旧状态做了计划变更、资产写入或执行权移交。因此恢复逻辑不能只是"继续"，必须：

1. **恢复前核对状态** —— 动态、计划、资产、执行权、本地工作区五个维度
2. **执行前校验幂等性** —— 按操作类型 × 结果状态决定跳过 / 重试 / 先核对 / 请求人类
3. **反复失败时止损** —— 连续失败且仍被服务端拒绝时锁定对话，转交人类裁决

---

## 安装

```bash
# 在 DSH Web GUI 的插件管理里安装本地目录，或：
dsh plugin install <path-to-ai-buddy>
```

安装后在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里会新增一行 `ai-buddy`。所有可调参数都在该行的 `config` 下，改动即时生效于新写入的状态。

---

## 四大模块

| 模块 | 位置 | 作用 |
|---|---|---|
| 动态 | 工作台「动态」面板 | 项目级协作事件流，双向读写：AI 发进展、人类发指令 |
| 计划 | 工作台「计划」面板 | 任务安排与状态看板，AI 可主动创建/更新，人类做结构性调整 |
| 任务 | 工作台「任务」面板 | 一个任务 = 一个对话 + 工作空间 + 执行权锁 + 恢复锁 |
| 资产 | 工作台「资产」面板 | 项目共享资料底座，带 Agent 级访问边界 |

## 三个锁

| 锁 | 粒度 | 默认超时/阈值 | 作用 |
|---|---|---|---|
| 执行权锁 | 对话 | 30 分钟 | 一个对话同时只有一个 Agent 能产生新消息与产物 |
| 恢复锁 | 对话 | 运行时互斥 | 同一对话同时只有一个恢复流程在跑 |
| 意外中断锁 | 对话（持久化） | 连续失败 3 次 | 恢复反复失败时停止自动恢复，等人类裁决 |

---

## 20 个 Agent 工具

**动态**：`post_update_to_feed` · `read_feed`
**计划**：`create_plan_item` · `update_plan_status` · `read_plan`
**任务**：`create_conversation` · `handoff_conversation` · `request_execution_lock` · `release_execution_lock` · `share_conversation_readonly` · `reference_conversation`
**资产**：`query_assets` · `save_to_assets` · `link_asset_to_conversation`
**人类指令**：`read_human_instructions`
**恢复**：`inspect_resume_state` · `publish_resume_note` · `request_manual_resume` · `verify_idempotency` · `query_resume_lock`

## 另有 7 个团队协作工具

**消息与等待**：`send_message_to_member`（可 @ 指定成员，插队到其最近步骤）· `await_human_reply`（需要人类决策时休眠等待）
**任务协作**：`request_teammate`（成员申请增援）· `approve_request`（**仅 leader** 裁决：派现有成员 / 招新人 / 打回）
**团队管理**：`remove_member`（**仅 leader**，移除前自动备份对话为资产）· `review_member`（**仅 leader** 效率审查）· `list_team`

---

## AI 团队管理

初始化团队时由**人类指定**两件事，缺一不可：

1. **工作区** —— 所有 AI 会话建在这个目录下，并注册为 DSH Workspace，侧栏自动归组。
2. **leader 的模型** —— 全体成员默认继承它。

初始化后：

- 系统创建一个 `leader`，它负责引入新成员、与人对接、审查成员效率，**不直接参与执行**。
- 成员申请增援 → leader 裁决 → 派给现有成员或招新人（新人自动建会话并初始化）。
- 成员需要人类决策 → 在动态 @human → 进入休眠，人类回复后唤醒。
- 插件重载后会自动重建丢失的会话（休眠中的成员除外，那是明确决定）。

---

## 任务图

「任务图」标签页用思维导图式的树展示工作的分解结构：**人类指令在根**，向下分支到计划条目，每个节点左侧色条标出负责 AI 的实时状态（工作中/等待人类/空闲），并显示它此刻正在做什么。

与「计划」看板并存：看板适合按状态批量操作，任务图适合看全局结构与分工。

---

## 数据落在哪里

JSON 真相层 + Markdown 可读摘要，位于 `<DSH_HOME>/ai-buddy/projects/<projectId>/`：

```
project.json            项目元数据与成员
feed.json               动态事件流
plan.json               计划看板
tasks.json              任务（含执行权/恢复锁状态）
assets/manifest.json    资产清单
assets/blobs/<assetId>  资产原始字节
checkpoints/<conv>.json 检查点历史（每个对话一份）
resume/<conv>.json      恢复状态（恢复锁 + 意外中断锁）
md/feed.md              动态的可读摘要
md/plan.md              计划的可读摘要
md/assets.md            资产清单的可读摘要
md/resume-history.md    恢复历史的可读摘要
```

Markdown 是**派生**的：删掉 `md/` 会在下一次写入时自动重建，没有任何代码读回它。JSON 是唯一真相层。

---

## 与底层 DSH 重试机制的边界

`ai-buddy` **不重复实现** 底层短窗口请求重试——那是 DSH 自带的 `autoRetry` 的职责。它只补充三件底层做不到的事：

1. **协作级检查点** —— 在 handoff / 资产写入 / 计划变更 / 动态发布 / 创建对话这些节点写入可恢复的状态快照
2. **跨模块核对** —— 恢复时不是"继续"，而是要求接手方先读动态、核对计划、核对资产版本、核对执行权、核对本地工作区
3. **止损锁** —— 对话级恢复锁防止多个恢复触发源并发注入"继续"，意外中断锁防止无限重试

这样避免了多个重试插件叠加造成的层叠重试（`dsh-unstuck` 记录的问题）和重复续跑（`dsh-interrupted-resume` 与 `dsh-client-auto-continue` 的互斥警告）。

---

## 配置

全部参数在插件行的 `config` 下，也有工作台「设置」标签页可实时修改：

```yaml
- id: ai-buddy
  name: 'ai-buddy'
  config:
    dataDir: ''                  # 空 = <DSH_HOME>/ai-buddy
    enableWeb: true              # 挂载工作台 HTTP API 与页面
    executionLock:
      timeoutMs: 1800000         # 执行权无人续期则自动释放
      queueMaxWaitMs: 600000     # 排队最长等待
      maxQueueDepth: 16
    resume:
      silentWindowMs: 15000      # 重启后静默窗口，避免与用户操作竞争
      activeWindowMs: 7200000    # 只恢复最近有活跃交互的会话
      maxAutoResumesPerWindow: 5 # 滑动窗口内自动续跑上限
      windowMs: 3600000
      backoffMs: [30000, 60000, 120000, 180000]  # 限流类错误的长退避
      honorRetryAfter: true
      maxRetryWallMs: 1800000
    interruptLock:
      failureThreshold: 3        # 连续失败多少次触发锁定
      stableWindowMs: 600000     # 稳定运行多久后重置失败计数
      maxTrialResumes: 1         # 允许的试探恢复次数
    feed:
      aiPostsPerMinute: 20       # AI 发言限速（人类不受限）
      retention: 5000
    assets:
      maxAssetBytes: 33554432
      highRiskGlobs: ['**/预算*', '**/合同*', '**/*.final.*']
    checkpoints:
      perConversationRetention: 200
      briefInlineCount: 3
    team:
      autoSpawn: false             # 启用插件时是否自动重建丢失的会话（默认关）
      autoWakeMentions: false      # 后台巡检是否补投人类的 @提及（默认关）
```

### 关于 `team.autoSpawn`（重要）

**启用本插件不会创建任何 AI 对话。** 一个会话就是一次真实的、和真实模型的计费对话——插件不该在没被要求时替你花配额。

因此：

- 席位只在**人类明确要求**时才活过来：在初始化页面初始化团队、@ 一个成员、或在团队面板里唤醒它；
- `team.autoSpawn: true` 会让插件在激活时重建名册里"有名册但没有活 agent"的座位（含自动创建的 `调度` 协调者）；
- `team.autoWakeMentions: true` 会让 leader 的后台巡检把人类的 `@提及` 补投给当时没在运行的成员。

两者默认关闭时，后台巡检照常运行，但它**只能观察**：它不会创建协调者，不会唤醒成员，也不会向没有活 agent 的 leader 投递报告。

---

## 宿主进程安全

本插件**曾经把 DSH 宿主进程弄崩溃两次**。根因与修复记录在 `DESIGN.md` §13，这里只列结论：

1. **所有面向宿主的造消息与投递都走 `lib/core/messages.js`**。每条消息都带 UUID v4 的 `id`、`role: 'user'`、块数组 `content`、`source: { kind: 'user' }`——这是宿主会话校验器要求的形状。
2. **投递永不抛出**。宿主拒绝一条消息时（例如会话正在收尾），结果是 `delivered: false`，不是异常。
3. **空闲用 `followup`，运行中用 `steer`**。对已在工作的成员再 `followup` 会开出第二个并行回合。
4. **每个对话一份 id 台账**，重复 id 构造上不可能——宿主的收件箱对重复 id 的拒绝发生在宿主内部，插件接不住。
5. **所有异步调用都被 await**。没有 await 的 async 调用，其 rejection 会变成未处理拒绝，Node 把它升级为未捕获异常，宿主进程随之退出。

自检：`npm test`（含 `test/host-safety.mjs` 的 28 项断言，用一个忠实复刻宿主收件箱的替身验证上述每一条）。

---

## 已知限制

- 插件的自动恢复在**重启后**由定时器驱动，需要 Host 保持运行；DSH 退出期间不会做任何恢复。
- `resume.planResume` 的"活跃窗口"判断依赖已持久化的恢复状态，而非 DSH 内部的会话活跃时间戳（后者不对插件暴露）。
- 工作台的拖拽改状态与上传功能依赖浏览器原生 API，在受限的 WebView 环境里可能需要改用显式的下拉选择。
- 插件**故意不导出 `Config` schema**：`@deepseek-ai/schemastery` 校验失败会让整行卸载，而一个因为某个数字参数写成字符串就消失的工作台比参数略有偏差更糟。参数由 `lib/config.js` 的 `resolveConfig` 归一化并 clamp。
- 插件**无法 `import` `@deepseek-ai/dsh-llm` 的 `createUserMessage`**：宿主包在 `app.asar` 里，profile 里的插件解析不到它们（实测全部 `MODULE_NOT_FOUND`），而宿主也没有任何服务暴露消息工厂。所以消息形状只能自己复刻——复刻必须精确，这是 `lib/core/messages.js` 存在的全部理由。

---

## 许可

MIT
