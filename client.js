/**
 * ai-buddy — client half: the project workbench (§4).
 *
 * The workbench is five panels over one `/ai-buddy/api/state` document:
 *
 *   动态 — the collaboration feed, newest first, lock events pinned on top
 *   计划 — the plan board, grouped by status, with dependency chips
 *   任务 — tasks with owner, execution-right holder, resume history, lock state
 *   资产 — the asset library with upload, search, and reference
 *   恢复 — per-conversation recovery state indicator
 *
 * Three constraints shaped the implementation:
 *
 * 1. **Theme tokens only.** Every colour is `--dsw-alias-*`; a literal colour
 *    outside the artwork would break light/dark switching, which the host
 *    supports and this panel must inherit. The fallbacks in each `var()` are
 *    deliberate: they exist so the panel still renders legibly if a token is
 *    renamed, not as a second palette.
 *
 * 2. **Every string is localised.** The dict below carries zh and en; the
 *    component reads through `ctx.locale.bind('ai-buddy')` so switching the
 *    host language re-renders the panel without a reload.
 *
 * 3. **A crash in one panel must not blank the slot.** Each panel is wrapped in
 *    an error boundary; a thrown render becomes a one-line notice inside that
 *    panel instead of a dead sidebar entry.
 */

window.__ModuleLoader__.load({
  id: 'ai-buddy',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    const API = '/ai-buddy/api'
    const LOCALE_NS = 'ai-buddy'

    /** All UI copy. Keys are stable; `t()` falls back to the key. */
    const MESSAGES = {
      zh: {
        nav: 'AI 协作',
        title: '协作工作台',
        subtitle: 'AI 与 AI 的多对话协作项目空间',
        loading: '载入中…',
        empty: '暂无内容',
        refresh: '刷新',
        cancel: '取消',
        submit: '提交',
        save: '保存',
        delete: '删除',
        close: '关闭',
        search: '搜索',
        more: '详情',
        all: '全部',
        project: '项目',
        none: '—',

        tabFeed: '动态',
        tabPlan: '计划',
        tabGraph: '任务图',
        tabTeam: 'AI 团队',
        tabTask: '任务',
        tabAsset: '资产',
        tabRecovery: '恢复',

        // ---- OOBE setup page ----
        setupTitle: '初始化协作团队',
        setupSub: '完成这一步后才会进入协作界面。你在这里的决定会成为整个团队的默认设置。',
        setupWorkspace: '工作目录',
        setupWorkspaceHint: '团队的所有 AI 会话都建在这个目录下，并在侧栏自动归组。一个目录对应一个团队。',
        setupLeaderModel: 'leader 的模型',
        setupLeaderModelHint: 'leader 负责统筹：分配任务、审查效率、与人类对接。选一个擅长推理与协调的模型。',
        setupMemberModel: '成员的模型',
        setupMemberModelHint: '新引入的成员默认使用这个模型。可以和 leader 不同——成员偏执行，通常可以更轻量。',
        setupBrief: '给 leader 的额外提示词',
        setupBriefPlaceholder: '例如：本项目是市场部年度预算编制；汇报用中文；预算数字一律以万元为单位；每周五汇总一次进展…',
        setupBriefHint: '这段会追加在内置的协作规则之后，不会覆盖它们。留空则只用内置规则。',
        setupBriefChars: '字数',
        setupStart: '创建团队并进入协作界面',
        setupStarting: '正在创建…',
        setupAfterHint: '创建后 leader 会启动一个真实会话并待命。',
        setupSpawnFailed: '团队已创建，但 leader 会话启动失败',

        // ---- OOBE setup page ----
        setupTitle: 'Set up the team',
        setupSub: 'The collaboration view opens after this step. What you choose here becomes the team default.',
        setupWorkspace: 'Working directory',
        setupWorkspaceHint: 'Every AI session lives here and is auto-grouped in the sidebar. One directory = one team.',
        setupLeaderModel: 'Leader model',
        setupLeaderModelHint: 'The leader coordinates: assigns work, reviews efficiency, talks to you. Pick a strong reasoning model.',
        setupMemberModel: 'Member model',
        setupMemberModelHint: 'New members default to this. It may differ from the leader — members execute, so a lighter model often fits.',
        setupBrief: 'Extra instructions for the leader',
        setupBriefPlaceholder: 'e.g. This project is the marketing annual budget; reply in English; all figures in thousands; summarise every Friday…',
        setupBriefHint: 'Appended to the built-in collaboration rules, never replacing them. Leave empty to use only the built-ins.',
        setupBriefChars: 'characters',
        setupStart: 'Create team and enter',
        setupStarting: 'Creating…',
        setupAfterHint: 'The leader starts a real session and stands by.',
        setupSpawnFailed: 'Team created, but the leader session failed to start',

        // ---- workspace picker ----
        wsTitle: '选择协作工作区',
        wsSub: '一个工作目录对应一个协作团队。切换目录即切换团队、计划与动态。',
        wsExisting: '已有团队',
        wsNone: '这个目录还没有团队，可以新建一个。',
        wsPath: '工作目录',
        wsBrowse: '浏览',
        wsUse: '使用这个目录',
        wsSwitch: '切换工作区',
        wsCurrent: '当前',
        wsMembers: '成员',
        wsLeader: '领导者',
        wsPickFirst: '请先选择一个工作目录',
        wsInitHere: '在此目录创建团队',
        wsLoading: '读取中…',

        // ---- mention picker ----
        mentionHint: '输入 @ 选择成员',
        mentionNoMatch: '没有匹配的成员',
        mentionDelivered: '已投递给',
        mentionNotDelivered: '未能投递给',
        mentionUnknownReason: '原因未知',

        // ---- feed ----
        feedFilterAll: '全部',
        feedFilterHuman: '人类指令',
        feedFilterTeam: '团队消息',
        feedFilterRecovery: '恢复事件',
        feedCollapse: '只显示重要',
        graphTitle: '任务图',
        graphEmpty: '还没有任务。等人类发布指令，或由 AI 通过 request_teammate 提出协作请求。',
        graphExpand: '展开全部',
        graphCollapse: '收起全部',
        graphRoot: '起点',
        graphOrphan: '父节点已删除',
        graphNode: '节点',
        graphDepth: '层级',
        graphInProgress: '进行中',
        graphBlocked: '锁定',
        graphWorking: '正在执行',
        graphZoomIn: '放大',
        graphZoomOut: '缩小',
        graphReset: '重置视图',

        // ---- team ----
        teamTitle: 'AI 团队',
        teamEmpty: '团队尚未初始化。点下面的按钮创建团队，默认会引入一位名为 leader 的领导者。',
        teamInit: '初始化团队',
        teamInitHint: '初始化后 leader 会创建一个真实会话并开始待命。',
        teamLeader: '领导者',
        teamCoordinator: '后台调度',
        teamMember: '成员',
        teamAddMember: '引入新成员',
        teamNameLabel: '成员名',
        teamTitleLabel: '职责',
        teamReportsTo: '汇报给',
        teamRemove: '移除',
        teamSleep: '休眠',
        teamWake: '唤醒',
        teamReviewBtn: '审查',
        teamReviewTitle: '效率审查',
        teamScore: '评分 0-100',
        teamVerdict: '结论',
        teamAdvice: '建议',
        teamStats: '统计',
        teamTasksDone: '完成任务',
        teamPosts: '发言数',
        teamLastReview: '最近审查',
        teamCurrentTask: '正在做',
        teamNoTask: '暂无任务',
        teamRequests: '待裁决请求',
        teamNoRequests: '没有待裁决的协作请求。',
        teamApprove: '批准',
        teamReject: '打回',
        teamAssignTo: '派给',
        teamRecruitNew: '招募新人',
        teamNewName: '新成员名',
        teamWorkspace: '工作区',
        teamWorkspaceHint: '所有 AI 会话都建在这个工作区下，并会在侧栏自动归组。',
        teamModelLabel: 'leader 模型',
        teamModelHint: '你选定的模型会成为 leader 的模型，团队所有成员默认继承它。',
        teamInitDone: '团队已初始化',
        teamSpawnFailed: '会话创建失败',
        teamSession: '会话',

        stWorking: '工作中',
        stWaitingHuman: '等待人类',
        stIdle: '空闲',
        stDormant: '休眠',
        stOffline: '离线',
        stUnassigned: '未指派',

        feedTitle: '协作动态',
        feedPinned: '需要人工关注',
        feedPlaceholder: '以人类身份发布指令或回复 AI…',
        feedPost: '发布',
        feedCategory: '类型',
        catInstruction: '指令',
        catReply: '回复',
        catPriority: '调整优先级',
        catPause: '暂停/转向',
        catUnlock: '解除锁定',

        planTitle: '计划看板',
        planAdd: '新增条目',
        planNewTitle: '条目标题',
        planDesc: '描述与验收标准',
        planAssignee: '负责 Agent',
        planPriority: '优先级',
        planDue: '截止时间',
        planDeps: '依赖条目',
        planBound: '绑定任务',
        planBlocked: '上游阻塞',
        planLocked: '因中断锁定',
        planMode: '计划类型',
        modePre: '事前计划',
        modeLive: '事中计划',
        statusPending: '待开始',
        statusInProgress: '进行中',
        statusPaused: '已暂停',
        statusDone: '已完成',
        statusLocked: '因中断锁定',
        changeStatus: '改状态',

        taskTitle: '任务',
        taskAdd: '新建任务',
        taskNewTitle: '任务标题',
        taskOwner: '负责 Agent',
        taskHolder: '执行权',
        taskStatus: '状态',
        taskCheckpoint: '最近检查点',
        taskNoCheckpoint: '尚无检查点',
        taskArchive: '归档',
        taskArchivedCount: '已归档',
        taskRelease: '释放执行权',
        taskUnlock: '解除中断锁',
        taskBoundConv: '对话',
        taskBoundPlan: '计划条目',
        taskOpen: '在工作台打开对话',

        assetTitle: '资产',
        assetUpload: '上传',
        assetName: '文件名',
        assetFolder: '目录',
        assetVersion: '版本',
        assetSize: '大小',
        assetOwner: '所有者',
        assetScope: '可见范围',
        assetScopeAll: '全项目',
        assetHighRisk: '高风险',
        assetRef: '引用到任务',
        assetDelete: '删除',
        assetSearch: '按名称或目录搜索…',
        assetSourceLocked: '来源对话已锁定',

        recoveryTitle: '恢复状态',
        recoveryLast: '最近恢复',
        recoveryTrigger: '触发类型',
        recoveryRunning: '运行中',
        recoveryRestart: '重启',
        recoveryManual: '手动',
        recoveryVerified: '已核对模块',
        recoverySkipped: '跳过的重复操作',
        recoveryFailures: '连续失败',
        recoveryLockState: '意外中断锁',
        recoveryNone: '该对话还没有恢复记录。',
        lockUnlocked: '未锁定',
        lockCounting: '计数中',
        lockLocked: '已锁定',
        lockTrial: '试探恢复中',
        lockThreshold: '阈值',

        errorPanel: '此面板渲染出错',
        errorLoad: '载入失败',
        confirmDelete: '确认删除？此操作不可撤销。',
        human: '人类',
      },
      en: {
        nav: 'AI Buddy',
        title: 'Collaboration workbench',
        subtitle: 'A project space where AIs collaborate across conversations',
        loading: 'Loading…',
        empty: 'Nothing yet',
        refresh: 'Refresh',
        cancel: 'Cancel',
        submit: 'Submit',
        save: 'Save',
        delete: 'Delete',
        close: 'Close',
        search: 'Search',
        more: 'Details',
        all: 'All',
        project: 'Project',
        none: '—',

        tabFeed: 'Feed',
        tabPlan: 'Plan',
        tabGraph: 'Task graph',
        tabTeam: 'AI team',
        tabTask: 'Tasks',
        tabAsset: 'Assets',
        tabRecovery: 'Recovery',

        wsTitle: 'Choose a workspace',
        wsSub: 'One directory owns one collaboration team. Switching directory switches the team, plan and feed.',
        wsExisting: 'Existing teams',
        wsNone: 'This directory has no team yet — you can create one.',
        wsPath: 'Directory',
        wsBrowse: 'Browse',
        wsUse: 'Use this directory',
        wsSwitch: 'Switch workspace',
        wsCurrent: 'current',
        wsMembers: 'members',
        wsLeader: 'leader',
        wsPickFirst: 'Pick a working directory first',
        wsInitHere: 'Create the team here',
        wsLoading: 'Loading…',

        mentionHint: 'Type @ to pick a member',
        mentionNoMatch: 'No matching member',
        mentionDelivered: 'Delivered to',
        mentionNotDelivered: 'Not delivered to',
        mentionUnknownReason: 'unknown reason',

        feedFilterAll: 'All',
        feedFilterHuman: 'Human',
        feedFilterTeam: 'Team',
        feedFilterRecovery: 'Recovery',
        feedCollapse: 'Important only',

        graphTitle: 'Task graph',
        graphEmpty: 'No tasks yet. Wait for a human instruction, or have an AI raise a request_teammate.',
        graphExpand: 'Expand all',
        graphCollapse: 'Collapse all',
        graphRoot: 'origin',
        graphOrphan: 'parent deleted',
        graphNode: 'node',
        graphDepth: 'depth',
        graphInProgress: 'in progress',
        graphBlocked: 'locked',
        graphWorking: 'executing',
        graphZoomIn: 'Zoom in',
        graphZoomOut: 'Zoom out',
        graphReset: 'Reset view',

        teamTitle: 'AI team',
        teamEmpty: 'The team is not initialized. Create it below; a leader named "leader" is installed by default.',
        teamInit: 'Initialize team',
        teamInitHint: 'The leader gets a real session and starts standing by.',
        teamLeader: 'Leader',
        teamCoordinator: 'Coordinator',
        teamMember: 'Member',
        teamAddMember: 'Recruit member',
        teamNameLabel: 'Name',
        teamTitleLabel: 'Role',
        teamReportsTo: 'Reports to',
        teamRemove: 'Remove',
        teamSleep: 'Sleep',
        teamWake: 'Wake',
        teamReviewBtn: 'Review',
        teamReviewTitle: 'Efficiency review',
        teamScore: 'Score 0-100',
        teamVerdict: 'Verdict',
        teamAdvice: 'Advice',
        teamStats: 'Stats',
        teamTasksDone: 'Tasks done',
        teamPosts: 'Posts',
        teamLastReview: 'Last review',
        teamCurrentTask: 'Working on',
        teamNoTask: 'Nothing assigned',
        teamRequests: 'Requests awaiting adjudication',
        teamNoRequests: 'No collaboration requests awaiting a decision.',
        teamApprove: 'Approve',
        teamReject: 'Reject',
        teamAssignTo: 'Assign to',
        teamRecruitNew: 'Recruit new',
        teamNewName: 'New member name',
        teamWorkspace: 'Workspace',
        teamWorkspaceHint: 'Every AI session is created inside this workspace and auto-grouped in the sidebar.',
        teamModelLabel: 'Leader model',
        teamModelHint: 'The model you pick becomes the leader’s model; every member inherits it by default.',
        teamModelEmpty: 'No models available',
        teamInitDone: 'Team initialized',
        teamSpawnFailed: 'Session creation failed',
        teamSession: 'Session',

        stWorking: 'working',
        stWaitingHuman: 'waiting on human',
        stIdle: 'idle',
        stDormant: 'dormant',
        stOffline: 'offline',
        stUnassigned: 'unassigned',

        feedTitle: 'Collaboration feed',
        feedPinned: 'Needs your attention',
        feedPlaceholder: 'Post an instruction or reply to an AI as the human…',
        feedPost: 'Post',
        feedCategory: 'Category',
        catInstruction: 'Instruction',
        catReply: 'Reply',
        catPriority: 'Priority',
        catPause: 'Pause / redirect',
        catUnlock: 'Unlock',

        planTitle: 'Plan board',
        planAdd: 'Add item',
        planNewTitle: 'Item title',
        planDesc: 'Description and acceptance criteria',
        planAssignee: 'Assigned agent',
        planPriority: 'Priority',
        planDue: 'Due',
        planDeps: 'Depends on',
        planBound: 'Bound task',
        planBlocked: 'Blocked upstream',
        planLocked: 'Locked by interruption',
        planMode: 'Plan mode',
        modePre: 'Pre-plan',
        modeLive: 'Live plan',
        statusPending: 'Pending',
        statusInProgress: 'In progress',
        statusPaused: 'Paused',
        statusDone: 'Done',
        statusLocked: 'Locked by interruption',
        changeStatus: 'Change status',

        taskTitle: 'Tasks',
        taskAdd: 'New task',
        taskNewTitle: 'Task title',
        taskOwner: 'Owner',
        taskHolder: 'Execution right',
        taskStatus: 'Status',
        taskCheckpoint: 'Last checkpoint',
        taskNoCheckpoint: 'No checkpoint yet',
        taskArchive: 'Archive',
        taskArchivedCount: 'archived',
        taskRelease: 'Release execution right',
        taskUnlock: 'Unlock interruption',
        taskBoundConv: 'Conversation',
        taskBoundPlan: 'Plan item',
        taskOpen: 'Open conversation',

        assetTitle: 'Assets',
        assetUpload: 'Upload',
        assetName: 'Name',
        assetFolder: 'Folder',
        assetVersion: 'Version',
        assetSize: 'Size',
        assetOwner: 'Owner',
        assetScope: 'Visible to',
        assetScopeAll: 'Whole project',
        assetHighRisk: 'High risk',
        assetRef: 'Reference to task',
        assetDelete: 'Delete',
        assetSearch: 'Search by name or folder…',
        assetSourceLocked: 'Source conversation locked',

        recoveryTitle: 'Recovery status',
        recoveryLast: 'Last resume',
        recoveryTrigger: 'Trigger',
        recoveryRunning: 'Running',
        recoveryRestart: 'Restart',
        recoveryManual: 'Manual',
        recoveryVerified: 'Modules verified',
        recoverySkipped: 'Operations skipped',
        recoveryFailures: 'Consecutive failures',
        recoveryLockState: 'Interruption lock',
        recoveryNone: 'This conversation has no recovery record yet.',
        lockUnlocked: 'Unlocked',
        lockCounting: 'Counting',
        lockLocked: 'Locked',
        lockTrial: 'Trial resume',
        lockThreshold: 'Threshold',

        errorPanel: 'This panel failed to render',
        errorLoad: 'Failed to load',
        confirmDelete: 'Delete? This cannot be undone.',
        human: 'Human',
      },
    }

    // --------------------------------------------------------------- helpers

    /** `fetch` against the workbench API with a uniform failure shape. */
    async function callApi(path, options) {
      const res = await fetch(`${API}${path}`, {
        cache: 'no-store',
        headers: options?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        ...options,
      })
      const text = await res.text()
      let json
      try {
        json = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`非 JSON 响应（HTTP ${res.status}）`)
      }
      if (!res.ok || json?.error !== undefined) {
        throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
      }
      return json
    }

    function formatTime(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return String(iso)
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getMonth() + 1}/${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function formatBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1024 / 1024).toFixed(1)} MB`
    }

    /** Theme-token class names, defined once in the style block below. */
    const cls = {
      root: 'ab-root',
      header: 'ab-header',
      tabs: 'ab-tabs',
      tab: 'ab-tab',
      tabActive: 'ab-tab ab-tab--active',
      body: 'ab-body',
      card: 'ab-card',
      row: 'ab-row',
      muted: 'ab-muted',
      badge: 'ab-badge',
      badgeWarn: 'ab-badge ab-badge--warn',
      badgeError: 'ab-badge ab-badge--error',
      badgeOk: 'ab-badge ab-badge--ok',
      input: 'ab-input',
      textarea: 'ab-textarea',
      button: 'ab-btn',
      buttonPrimary: 'ab-btn ab-btn--primary',
      buttonDanger: 'ab-btn ab-btn--danger',
      select: 'ab-select',
      field: 'ab-field',
      label: 'ab-label',
      col: 'ab-col',
      colHead: 'ab-col-head',
      colBody: 'ab-col-body',
      error: 'ab-error',
      empty: 'ab-empty',
    }

    const STYLE = `
/* ------------------------------------------------------------------------
   Colour discipline (dark-mode correctness)

   The rule this file follows, everywhere: NEVER pair a theme-token background
   with a literal text colour. The first version of this panel did exactly that
   --
       background: var(--dsw-alias-brand-primary); color: #fff;
       background: var(--dsw-alias-state-error-primary); color: #fff;
   -- which renders correctly in light mode and becomes white-on-white in dark
   mode, because the accent token flips to a light value while the literal
   stays white. That was the reported bug.

   Three replacements are used instead:
     1. Tinted surface: a low-alpha wash of the accent over the current base,
        with the text left at its normal token colour. Both sides move together
        under a theme switch, so contrast is preserved by construction.
     2. Solid accent fills are kept ONLY for text that is a fixed colour that
        never derives from the theme -- and those are labelled as such below.
     3. Every colour is a var() with a *neutral* fallback (grey ramp), never a
        light-mode-specific literal. If a token is renamed, the panel degrades
        to greyscale but stays readable in both modes.
   ------------------------------------------------------------------------ */

.ab-root { display:flex; flex-direction:column; height:100%; min-height:0;
  background:var(--dsw-alias-bg-base,#111); color:var(--dsw-alias-label-primary,#e8e8e8);
  font:13px/1.55 ui-sans-serif,system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
.ab-header { padding:14px 18px 0; border-bottom:1px solid var(--dsw-alias-border-l1,#3a3a3a); }
.ab-title { font-size:15px; font-weight:600; margin:0; }
.ab-sub { font-size:12px; color:var(--dsw-alias-label-secondary,#a0a0a0); margin:2px 0 10px; }
.ab-tabs { display:flex; gap:4px; align-items:flex-end; flex-wrap:wrap; }
.ab-tab { appearance:none; border:none; background:transparent; cursor:pointer;
  padding:7px 12px; border-radius:8px 8px 0 0; font:inherit; font-size:13px;
  color:var(--dsw-alias-label-secondary,#a0a0a0); }
.ab-tab:hover { background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.12)); }
.ab-tab--active { background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.18));
  color:var(--dsw-alias-label-primary,#e8e8e8); font-weight:600;
  box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary,#5b8fd6); }
.ab-body { flex:1; min-height:0; overflow:auto; padding:14px 18px 22px; }
.ab-card { background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.10));
  border:1px solid var(--dsw-alias-border-l1,#3a3a3a); border-radius:10px;
  padding:12px 14px; margin-bottom:10px; }
.ab-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.ab-muted { color:var(--dsw-alias-label-secondary,#a0a0a0); font-size:12px; }

/* Badges: tinted wash + inherited text colour. The wash is the accent at low
   alpha over whatever the base surface is, so it works on light AND dark
   without naming a text colour at all. */
.ab-badge { display:inline-block; padding:1px 7px; border-radius:999px; font-size:11px;
  background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.16));
  color:var(--dsw-alias-label-secondary,#a0a0a0); }
.ab-badge--warn { background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c08a3e) 22%,transparent);
  color:var(--dsw-alias-label-primary,#e8e8e8); }
.ab-badge--error { background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0504d) 22%,transparent);
  color:var(--dsw-alias-label-primary,#e8e8e8); }
.ab-badge--ok { background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#4a9c6d) 22%,transparent);
  color:var(--dsw-alias-label-primary,#e8e8e8); }
.ab-badge--info { background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8fd6) 22%,transparent);
  color:var(--dsw-alias-label-primary,#e8e8e8); }

.ab-input,.ab-textarea,.ab-select { background:var(--dsw-alias-bg-base,#111);
  border:1px solid var(--dsw-alias-border-l2,#4a4a4a); border-radius:7px; padding:6px 9px;
  font:inherit; font-size:12px; color:var(--dsw-alias-label-primary,#e8e8e8); }
.ab-textarea { width:100%; min-height:62px; resize:vertical; box-sizing:border-box; }

/* Buttons: a subtle surface, never a solid accent behind inherited text. */
.ab-btn { appearance:none; cursor:pointer; font:inherit; font-size:12px;
  padding:5px 11px; border-radius:7px; border:1px solid var(--dsw-alias-border-l2,#4a4a4a);
  background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.10));
  color:var(--dsw-alias-label-primary,#e8e8e8); }
.ab-btn:hover { background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.20)); }
.ab-btn:disabled { opacity:.45; cursor:default; }
/* Primary = accent-TINTED, not accent-filled: the label keeps its normal token
   colour, so it cannot become white-on-white. */
.ab-btn--primary { background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8fd6) 24%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8fd6) 55%,transparent);
  color:var(--dsw-alias-label-primary,#e8e8e8); font-weight:600; }
.ab-btn--primary:hover { background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8fd6) 34%,transparent); }
.ab-btn--danger { background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0504d) 20%,transparent);
  border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0504d) 55%,transparent);
  color:var(--dsw-alias-label-primary,#e8e8e8); }
.ab-btn--danger:hover { background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0504d) 30%,transparent); }

.ab-field { display:flex; flex-direction:column; gap:3px; margin-bottom:8px; }
.ab-label { font-size:11px; color:var(--dsw-alias-label-secondary,#a0a0a0); }
.ab-cols { display:grid; grid-template-columns:repeat(5,minmax(160px,1fr)); gap:10px; align-items:start; }
@media (max-width:1100px){ .ab-cols { grid-template-columns:repeat(2,minmax(160px,1fr)); } }
.ab-col { background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.10)); border-radius:10px; padding:8px; min-height:80px; }
.ab-col-head { font-size:11px; font-weight:600; color:var(--dsw-alias-label-secondary,#a0a0a0);
  padding:2px 4px 7px; display:flex; justify-content:space-between; }
.ab-col-body { display:flex; flex-direction:column; gap:7px; }
.ab-error { padding:9px 12px; border-radius:8px; margin-bottom:10px; font-size:12px;
  background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0504d) 16%,transparent);
  color:var(--dsw-alias-label-primary,#e8e8e8); }
.ab-empty { padding:18px; text-align:center; color:var(--dsw-alias-label-secondary,#909090); font-size:12px; }
.ab-item { background:var(--dsw-alias-bg-base,#111); border-radius:8px; padding:9px 10px;
  border:1px solid var(--dsw-alias-border-l1,#3a3a3a); }
.ab-item--locked { border-color:var(--dsw-alias-state-error-primary,#c0504d); }
.ab-feed-row { padding:8px 0; border-bottom:1px solid var(--dsw-alias-border-l1,#3a3a3a); }
.ab-feed-row:last-child { border-bottom:none; }
.ab-feed-meta { font-size:11px; color:var(--dsw-alias-label-secondary,#909090); margin-bottom:2px; }
.ab-pinned { background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#c08a3e) 14%,transparent);
  border-left:3px solid var(--dsw-alias-state-warn-primary,#c08a3e);
  padding-left:9px; border-radius:4px; }
.ab-toolbar { display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
.ab-grow { flex:1; min-width:120px; }
.ab-kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:12px; }
.ab-kv dt { color:var(--dsw-alias-label-secondary,#a0a0a0); }
.ab-kv dd { margin:0; }

/* @-mention popup: a floating list above the composer. Surface + border come
   from the same tokens as every other raised element, so it reads correctly in
   both themes without a literal colour. */
.ab-mention { background:var(--dsw-alias-bg-overlay, rgba(40,40,40,.98));
  border:1px solid var(--dsw-alias-border-l2,#4a4a4a); border-radius:9px;
  box-shadow:0 6px 20px rgba(0,0,0,.28); padding:4px; }
.ab-mention-hint { font-size:10px; padding:3px 7px 5px;
  color:var(--dsw-alias-label-secondary,#a0a0a0); }
.ab-mention-item { display:flex; align-items:center; gap:4px;
  padding:5px 8px; border-radius:6px; cursor:pointer; font-size:12px;
  color:var(--dsw-alias-label-primary,#e8e8e8); }
.ab-mention-item--active { background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8fd6) 26%,transparent); }

/* Workspace picker cards */
.ab-ws-card { display:flex; gap:10px; align-items:center;
  background:var(--dsw-alias-bg-layer-1,rgba(128,128,128,.10));
  border:1px solid var(--dsw-alias-border-l1,#3a3a3a);
  border-radius:9px; padding:9px 11px; margin-bottom:7px; cursor:pointer; }
.ab-ws-card:hover { background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.18)); }
.ab-ws-card--current { border-color:var(--dsw-alias-brand-primary,#5b8fd6); }
`

    // ------------------------------------------------------------ primitives

    /** A labelled form field. */
    function Field({ label, children }) {
      return h('label', { className: cls.field },
        h('span', { className: cls.label }, label),
        children)
    }

    /**
     * Error boundary: a panel that throws renders a notice instead of taking
     * the whole slot down with it.
     */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        // Surfaced to the console only; the panel shows the localised notice.
        try {
          console.error('[ai-buddy] panel crashed', error)
        } catch {
          /* console may be gone */
        }
      }

      render() {
        if (this.state.error !== null) {
          return h('div', { className: cls.error },
            `${this.props.t('errorPanel')}: ${this.state.error?.message ?? this.state.error}`)
        }
        return this.props.children
      }
    }

    function Badge({ kind, children }) {
      const name = kind === 'warn' ? cls.badgeWarn : kind === 'error' ? cls.badgeError : kind === 'ok' ? cls.badgeOk : cls.badge
      return h('span', { className: name }, children)
    }

    const STATUS_LABEL_KEY = {
      pending: 'statusPending',
      in_progress: 'statusInProgress',
      paused: 'statusPaused',
      done: 'statusDone',
      locked_by_interrupt: 'statusLocked',
    }

    // ---------------------------------------------------------------- panels

    /** Feed: pinned lock events on top, then the reverse-chronological stream. */
    /**
     * A textarea with `@`-mention autocomplete.
     *
     * Typing `@` at a word boundary opens a filtered member list; arrows move,
     * Enter/Tab accepts, Escape dismisses. Selecting a name rewrites the token
     * in place and keeps focus where the human left it.
     *
     * Why a real caret-position parser rather than a simple "does the text end
     * with @" check: people mention someone mid-sentence far more often than at
     * the end, and a naive check would only ever work at the tail.
     */
    function MentionInput({
      value, onChange, members, placeholder, t, rows = 3, onSubmit,
    }) {
      const ref = useRef(null)
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [active, setActive] = useState(0)
      const [anchor, setAnchor] = useState(-1)

      const candidates = useMemo(() => {
        const q = query.toLowerCase()
        return members
          .filter((m) => q === '' || m.name.toLowerCase().includes(q))
          .slice(0, 8)
      }, [members, query])

      /** Find the `@token` the caret currently sits inside, if any. */
      const findMention = (text, caret) => {
        const before = text.slice(0, caret)
        const at = before.lastIndexOf('@')
        if (at < 0) return null
        // The `@` must start a word: `a@b` is an email, not a mention.
        if (at > 0 && !/\s/.test(before[at - 1])) return null
        const segment = before.slice(at + 1)
        // A mention token ends at whitespace; once the human types a space the
        // mention is complete and the popup should not reopen over plain text.
        if (/\s/.test(segment)) return null
        return { start: at, query: segment }
      }

      const sync = (text, caret) => {
        const mention = findMention(text, caret)
        if (mention === null) {
          setOpen(false)
          setAnchor(-1)
          return
        }
        setOpen(true)
        setQuery(mention.query)
        setAnchor(mention.start)
        setActive(0)
      }

      const commit = (memberName) => {
        const el = ref.current
        const caret = el?.selectionStart ?? value.length
        const start = anchor >= 0 ? anchor : caret
        const next = `${value.slice(0, start)}@${memberName} ${value.slice(caret)}`
        onChange(next)
        setOpen(false)
        // Restore the caret after React repaints the textarea.
        const target = start + memberName.length + 2
        setTimeout(() => {
          try {
            el?.focus()
            el?.setSelectionRange(target, target)
          } catch { /* element gone */ }
        }, 0)
      }

      const onKeyDown = (e) => {
        if (open && candidates.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => (i + 1) % candidates.length)
            return
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => (i - 1 + candidates.length) % candidates.length)
            return
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            commit(candidates[active].name)
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            setOpen(false)
            return
          }
        }
        // Cmd/Ctrl+Enter sends, matching the host composer's habit.
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && onSubmit !== undefined) {
          e.preventDefault()
          onSubmit()
        }
      }

      return h('div', { style: { position: 'relative' } },
        h('textarea', {
          ref,
          className: cls.textarea,
          style: { minHeight: rows * 22 },
          value,
          placeholder,
          onChange: (e) => {
            onChange(e.target.value)
            sync(e.target.value, e.target.selectionStart ?? e.target.value.length)
          },
          onKeyDown,
          onClick: (e) => sync(value, e.target.selectionStart ?? value.length),
          onBlur: () => setTimeout(() => setOpen(false), 150),
        }),
        open && candidates.length > 0
          ? h('div', {
              className: 'ab-mention',
              style: {
                position: 'absolute', left: 0, bottom: '100%', marginBottom: 4,
                minWidth: 180, maxWidth: 320, maxHeight: 220, overflow: 'auto', zIndex: 30,
              },
            },
            h('div', { className: 'ab-mention-hint' }, t('mentionHint')),
            candidates.map((m, i) => h('div', {
              key: m.name,
              className: i === active ? 'ab-mention-item ab-mention-item--active' : 'ab-mention-item',
              onMouseDown: (e) => { e.preventDefault(); commit(m.name) },
              onMouseEnter: () => setActive(i),
            },
            h('span', { style: { fontWeight: 600 } }, `@${m.name}`),
            m.title ? h('span', { className: cls.muted, style: { marginLeft: 6 } }, m.title) : null,
            h('span', { className: cls.grow }),
            h('span', { className: cls.muted }, m.status ?? ''))))
          : (open
              ? h('div', {
                  className: 'ab-mention',
                  style: { position: 'absolute', left: 0, bottom: '100%', marginBottom: 4, zIndex: 30 },
                }, h('div', { className: 'ab-mention-hint' }, t('mentionNoMatch')))
              : null))
    }

    /**
     * Feed: the collaboration timeline.
     *
     * Three readability rules, learned from how the feed looks once a team has
     * been running for a while:
     *
     * 1. **Group by day.** A flat reverse-chronological list loses all sense of
     *    "when did this happen" after a few hundred events; a day header costs
     *    one row and restores it.
     * 2. **Filter, don't truncate.** The old panel silently showed the last 150
     *    events, which quietly hid the beginning of a long conversation. A
     *    visible filter lets the human choose the slice instead of guessing what
     *    was dropped.
     * 3. **Pinned stays pinned.** Lock and human-decision events render in their
     *    own block at the top *and* in the stream (once), so a human scrolling
     *    back does not lose the one event that needs them.
     */
    function FeedPanel({ state, t, projectId, onMutated, setError }) {
      const [text, setText] = useState('')
      const [category, setCategory] = useState('human.instruction')
      const [busy, setBusy] = useState(false)
      const [filter, setFilter] = useState('all')
      const [notice, setNotice] = useState(null)

      const events = state.feed ?? []
      const team = state.team
      const members = (team?.members ?? []).map((m) => ({
        name: m.name, title: m.title, status: m.status,
      }))

      const matches = (event) => {
        if (filter === 'all') return true
        if (filter === 'human') return event.kind === 'human'
        if (filter === 'team') return String(event.category ?? '').startsWith('team.')
        if (filter === 'recovery') return String(event.kind ?? '') === 'recovery'
        return true
      }

      const visible = events.filter(matches)
      const pinned = visible.filter((e) => e.pinned)
      // Newest first for display; the underlying store is oldest-first.
      const rest = visible.filter((e) => !e.pinned).slice().reverse()

      const submit = async () => {
        if (text.trim() === '') return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          // A leading `@name` becomes the mention target, which the backend then
          // actually delivers to that member — waking it first if it is asleep.
          const mentionMatch = text.trim().match(/^@([^\s]+)/)
          const mentionName = mentionMatch === null ? undefined : mentionMatch[1]
          const validMention = mentionName !== undefined && members.some((x) => x.name === mentionName)
            ? mentionName
            : undefined

          const result = await callApi('/feed', {
            method: 'POST',
            body: JSON.stringify({
              projectId,
              content: text.trim(),
              category,
              mention: validMention,
            }),
          })
          setText('')

          // Report what actually happened to the mention. Silence here was the
          // reason the feature looked broken: the post succeeded, the member did
          // nothing, and the panel said nothing.
          if (validMention !== undefined) {
            const delivery = result?.delivery
            if (delivery?.delivered === true) {
              setNotice(
                `${t('mentionDelivered')} @${validMention}` +
                `${delivery.transport === 'followup' ? '' : ` (${delivery.transport})`}`,
              )
            } else {
              setNotice(
                `${t('mentionNotDelivered')} @${validMention}：` +
                `${delivery?.hint || delivery?.reason || t('mentionUnknownReason')}`,
              )
            }
          }
          onMutated()
        } catch (error) {
          setError(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      const dayKey = (iso) => {
        const d = new Date(iso)
        return Number.isNaN(d.getTime()) ? '—' : `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
      }

      const renderEvent = (event, isPinned) => {
        const isHuman = event.actor?.type === 'human'
        const cat = String(event.category ?? '')
        const tone = cat.startsWith('lock.') ? 'error'
          : cat.startsWith('team.request') || cat.startsWith('human.') ? 'warn'
            : cat.startsWith('resume.') ? 'info'
              : undefined
        return h('div', {
          key: event.id,
          className: isPinned ? 'ab-feed-row ab-pinned' : 'ab-feed-row',
        },
        h('div', { className: cls.feedMeta },
          formatTime(event.at), ' · ',
          isHuman ? t('human') : (event.actor?.name ?? '?'),
          ' · ',
          tone ? h(Badge, { kind: tone }, cat) : cat,
          event.source === 'agent' ? h('span', { className: cls.muted }, ' · AI') : null),
        h('div', { style: { whiteSpace: 'pre-wrap' } }, event.content))
      }

      // Group the stream by day, preserving newest-first order.
      const groups = []
      for (const event of rest) {
        const key = dayKey(event.at)
        const last = groups[groups.length - 1]
        if (last !== undefined && last.key === key) last.events.push(event)
        else groups.push({ key, at: event.at, events: [event] })
      }

      return h('div', null,
        h('div', { className: cls.toolbar },
          h('strong', null, t('feedTitle')),
          h('span', { className: cls.muted }, `${visible.length} / ${events.length}`),
          h('span', { className: cls.grow }),
          h('select', {
            className: cls.select, value: filter,
            onChange: (e) => setFilter(e.target.value),
          },
          h('option', { value: 'all' }, t('feedFilterAll')),
          h('option', { value: 'human' }, t('feedFilterHuman')),
          h('option', { value: 'team' }, t('feedFilterTeam')),
          h('option', { value: 'recovery' }, t('feedFilterRecovery')))),

        h('div', { className: cls.card },
          pinned.length > 0 ? h('div', { style: { marginBottom: 10 } },
            h('div', { className: cls.label, style: { marginBottom: 4 } }, t('feedPinned')),
            pinned.slice(-8).reverse().map((e) => renderEvent(e, true))) : null,

          notice !== null
            ? h('div', { className: cls.muted, style: { marginBottom: 6 } }, notice)
            : null,

          h(MentionInput, {
            value: text,
            onChange: setText,
            members,
            placeholder: t('feedPlaceholder'),
            t,
            onSubmit: submit,
          }),
          h('div', { className: cls.row, style: { marginTop: 8 } },
            h('select', {
              className: cls.select,
              value: category,
              onChange: (e) => setCategory(e.target.value),
              title: t('feedCategory'),
            },
            h('option', { value: 'human.instruction' }, t('catInstruction')),
            h('option', { value: 'human.reply' }, t('catReply')),
            h('option', { value: 'human.priority' }, t('catPriority')),
            h('option', { value: 'human.pause' }, t('catPause')),
            h('option', { value: 'human.unlock' }, t('catUnlock'))),
            h('span', { className: cls.muted }, t('mentionHint')),
            h('span', { className: cls.grow }),
            h('button', {
              className: cls.buttonPrimary,
              disabled: busy || text.trim() === '',
              onClick: submit,
            }, t('feedPost')))),

        rest.length === 0
          ? h('div', { className: cls.empty }, t('empty'))
          : groups.map((group) => h('div', { key: group.key, style: { marginTop: 12 } },
              h('div', {
                className: cls.label,
                style: { marginBottom: 4, opacity: 0.8 },
              }, dayKey(group.at)),
              group.events.map((e) => renderEvent(e, false)))))
    }

    /** Plan: five status columns with dependency chips and lock marks. */
    function PlanPanel({ state, t, projectId, onMutated, setError }) {
      const [adding, setAdding] = useState(false)
      const [draft, setDraft] = useState({ title: '', description: '', assignee: '', priority: 1 })
      const items = state.plan ?? []
      const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
      // Same source-of-truth rule as the task panel: the roster is the list of
      // real agents. Assignees already recorded on items are kept so a historical
      // name stays selectable even after its member left.
      const agents = useMemo(() => {
        const names = new Set()
        for (const m of state.team?.members ?? []) {
          if (typeof m.name === 'string' && m.name !== '') names.add(m.name)
        }
        for (const i of items) if (i.assignee) names.add(i.assignee)
        for (const task of state.tasks ?? []) if (task.ownerAgent) names.add(task.ownerAgent)
        return [...names].sort()
      }, [state.team, items, state.tasks])

      const post = async (body) => {
        setError(null)
        try {
          await callApi('/plan', { method: 'POST', body: JSON.stringify({ projectId, ...body }) })
          onMutated()
        } catch (error) {
          setError(String(error?.message ?? error))
        }
      }

      const create = async () => {
        if (draft.title.trim() === '') return
        await post({
          op: 'create',
          title: draft.title.trim(),
          description: draft.description,
          assignee: draft.assignee || undefined,
          priority: Number(draft.priority) || 1,
        })
        setDraft({ title: '', description: '', assignee: '', priority: 1 })
        setAdding(false)
      }

      const renderItem = (item) => {
        const locked = item.status === 'locked_by_interrupt'
        const bound = (state.tasks ?? []).find((task) => task.planItemId === item.id)
        return h('div', { key: item.id, className: locked ? 'ab-item ab-item--locked' : 'ab-item' },
          h('div', { style: { fontWeight: 600, marginBottom: 2 } }, item.title),
          h('div', { className: cls.feedMeta }, `P${item.priority} · ${item.assignee ?? t('none')}`),
          (item.blockedBy ?? []).length > 0
            ? h('div', { style: { marginTop: 4 } },
                h(Badge, { kind: 'warn' }, t('planBlocked')),
                h('span', { className: cls.muted, style: { marginLeft: 6 } },
                  item.blockedBy.map((id) => byId.get(id)?.title ?? id).join('、')))
            : null,
          locked ? h('div', { style: { marginTop: 4 } }, h(Badge, { kind: 'error' }, t('planLocked'))) : null,
          bound ? h('div', { className: cls.muted, style: { marginTop: 4 } }, `${t('planBound')}: ${bound.title}`) : null,
          h('div', { className: cls.row, style: { marginTop: 7 } },
            h('select', {
              className: cls.select,
              value: item.status,
              disabled: locked,
              title: t('changeStatus'),
              onChange: (e) => post({ op: 'status', planItemId: item.id, newStatus: e.target.value }),
            },
            ['pending', 'in_progress', 'paused', 'done'].map((s) =>
              h('option', { key: s, value: s }, t(STATUS_LABEL_KEY[s])))),
            h('select', {
              className: cls.select,
              value: item.assignee ?? '',
              onChange: (e) => post({ op: 'assign', planItemId: item.id, assignee: e.target.value || null }),
            },
            h('option', { value: '' }, t('planAssignee') + ' —'),
            agents.map((a) => h('option', { key: a, value: a }, a)))))
      }

      const columns = [
        ['pending', 'statusPending'],
        ['in_progress', 'statusInProgress'],
        ['paused', 'statusPaused'],
        ['locked_by_interrupt', 'statusLocked'],
        ['done', 'statusDone'],
      ]

      return h('div', null,
        h('div', { className: cls.toolbar },
          h('strong', null, t('planTitle')),
          h('span', { className: cls.muted }, `${items.length}`),
          h('span', { className: cls.grow }),
          adding
            ? h('button', { className: cls.button, onClick: () => setAdding(false) }, t('cancel'))
            : h('button', { className: cls.buttonPrimary, onClick: () => setAdding(true) }, t('planAdd'))),

        adding ? h('div', { className: cls.card },
          h(Field, { label: t('planNewTitle') },
            h('input', { className: cls.input, value: draft.title, autoFocus: true,
              onChange: (e) => setDraft({ ...draft, title: e.target.value }) })),
          h(Field, { label: t('planDesc') },
            h('textarea', { className: cls.textarea, value: draft.description,
              onChange: (e) => setDraft({ ...draft, description: e.target.value }) })),
          h('div', { className: cls.row },
            h(Field, { label: t('planAssignee') },
              h('select', { className: cls.select, value: draft.assignee,
                onChange: (e) => setDraft({ ...draft, assignee: e.target.value }) },
                h('option', { value: '' }, t('none')),
                agents.map((a) => h('option', { key: a, value: a }, a)))),
            h(Field, { label: t('planPriority') },
              h('input', { className: cls.input, type: 'number', min: 0, max: 3, value: draft.priority,
                onChange: (e) => setDraft({ ...draft, priority: e.target.value }) }))),
          h('div', { className: cls.row },
            h('button', { className: cls.buttonPrimary, onClick: create,
              disabled: draft.title.trim() === '' }, t('submit')))) : null,

        h('div', { className: cls.cols },
          columns.map(([status, key]) => {
            const group = items.filter((i) => i.status === status)
            return h('div', { key: status, className: cls.col },
              h('div', { className: cls.colHead },
                h('span', null, t(key)), h('span', null, String(group.length))),
              h('div', { className: cls.colBody },
                group.length === 0 ? h('div', { className: cls.empty }, t('empty'))
                  : group.map(renderItem)))
          })))
    }

    /** Tasks: ownership, execution right, checkpoint freshness, lock state. */
    function TaskPanel({ state, t, projectId, onMutated, setError }) {
      // Archived tasks stay in the store for the audit trail but must not clutter
      // the working list. Hiding them here is what makes the archive button feel
      // like it did something — previously the row stayed put and the click
      // looked dead even though the API had succeeded.
      const allTasks = state.tasks ?? []
      const tasks = allTasks.filter((task) => task.status !== 'archived')
      const archivedCount = allTasks.length - tasks.length

      const [adding, setAdding] = useState(false)
      const [draft, setDraft] = useState({ title: '', ownerAgent: '', planItemId: '' })
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)

      const post = async (body) => {
        setError(null)
        setBusy(true)
        try {
          const result = await callApi('/task', {
            method: 'POST',
            body: JSON.stringify({ projectId, ...body }),
          })
          onMutated()
          return result
        } catch (error) {
          setError(String(error?.message ?? error))
          return null
        } finally {
          setBusy(false)
        }
      }

      /**
       * The agents a task can be assigned to.
       *
       * Source of truth is the **team roster**, not `project.members`: the
       * project's member list is a legacy collaboration field that this plugin
       * stopped writing when the team subsystem landed, so it is empty on every
       * project created since. Reading it produced an empty dropdown — the
       * reported bug — while the roster right next to it held the real names.
       *
       * Task owners already in use are included as a fallback so archiving or
       * re-assigning an old task still shows its historical owner.
       */
      const agents = useMemo(() => {
        const names = new Set()
        for (const m of state.team?.members ?? []) {
          if (typeof m.name === 'string' && m.name !== '') names.add(m.name)
        }
        for (const task of tasks) if (task.ownerAgent) names.add(task.ownerAgent)
        return [...names].sort()
      }, [state.team, tasks])

      return h('div', null,
        h('div', { className: cls.toolbar },
          h('strong', null, t('taskTitle')),
          h('span', { className: cls.muted }, `${tasks.length}`),
          archivedCount > 0
            ? h('span', { className: cls.muted }, `· ${archivedCount} ${t('taskArchivedCount')}`)
            : null,
          h('span', { className: cls.grow }),
          adding
            ? h('button', { className: cls.button, onClick: () => setAdding(false) }, t('cancel'))
            : h('button', { className: cls.buttonPrimary, onClick: () => setAdding(true) }, t('taskAdd'))),

        notice !== null
          ? h('div', { className: cls.muted, style: { marginBottom: 8 } }, notice)
          : null,

        adding ? h('div', { className: cls.card },
          h(Field, { label: t('taskNewTitle') },
            h('input', { className: cls.input, value: draft.title, autoFocus: true,
              onChange: (e) => setDraft({ ...draft, title: e.target.value }) })),
          h('div', { className: cls.row },
            h(Field, { label: t('taskOwner') },
              h('select', { className: cls.select, value: draft.ownerAgent,
                onChange: (e) => setDraft({ ...draft, ownerAgent: e.target.value }) },
                h('option', { value: '' }, t('none')),
                agents.map((a) => h('option', { key: a, value: a }, a)))),
            h(Field, { label: t('taskBoundPlan') },
              h('select', { className: cls.select, value: draft.planItemId,
                onChange: (e) => setDraft({ ...draft, planItemId: e.target.value }) },
                h('option', { value: '' }, t('none')),
                (state.plan ?? []).map((i) => h('option', { key: i.id, value: i.id }, i.title))))),
          h('div', { className: cls.row },
            h('button', { className: cls.buttonPrimary, disabled: draft.title.trim() === '',
              onClick: async () => {
                await post({
                  op: 'create',
                  title: draft.title.trim(),
                  ownerAgent: draft.ownerAgent || undefined,
                  planItemId: draft.planItemId || undefined,
                })
                setDraft({ title: '', ownerAgent: '', planItemId: '' })
                setAdding(false)
              } }, t('submit')))) : null,

        tasks.length === 0 ? h('div', { className: cls.empty }, t('empty'))
          : tasks.map((task) => {
            const resumeState = task.resumeState
            const lockState = resumeState?.interruptLock?.state ?? 'unlocked'
            const locked = lockState === 'locked'
            const holder = task.executionLock?.holder
            return h('div', { key: task.id, className: locked ? 'ab-card ab-item--locked' : cls.card },
              h('div', { className: cls.row },
                h('strong', null, task.title),
                h(Badge, { kind: task.status === 'locked_by_interrupt' ? 'error' : (task.status === 'done' ? 'ok' : undefined) },
                  t(STATUS_LABEL_KEY[task.status] ?? 'statusPending')),
                locked ? h(Badge, { kind: 'error' }, t('lockLocked')) : null,
                h('span', { className: cls.grow }),
                locked ? h('button', { className: cls.buttonPrimary,
                  onClick: () => post({ op: 'unlock', taskId: task.id, resetCounter: true }) },
                  t('taskUnlock')) : null,
                holder ? h('button', { className: cls.button,
                  onClick: () => post({ op: 'release', taskId: task.id }) }, t('taskRelease')) : null,
                h('button', { className: cls.button, disabled: busy,
                  onClick: async () => {
                    const result = await post({ op: 'archive', taskId: task.id })
                    if (result !== null) setNotice(`已归档「${task.title}」`)
                  } }, t('taskArchive'))),

              h('dl', { className: cls.kv, style: { marginTop: 8 } },
                h('dt', null, t('taskOwner')), h('dd', null, task.ownerAgent ?? t('none')),
                h('dt', null, t('taskHolder')), h('dd', null, holder ?? t('none')),
                h('dt', null, t('taskBoundConv')), h('dd', null,
                  h('code', null, task.conversationId ?? t('none'))),
                h('dt', null, t('taskCheckpoint')), h('dd', null,
                  task.latestCheckpoint
                    ? `${formatTime(task.latestCheckpoint.timestamp)} · ${task.latestCheckpoint.event_type}`
                    : t('taskNoCheckpoint')),
                h('dt', null, t('recoveryFailures')), h('dd', null,
                  `${resumeState?.interruptLock?.consecutiveFailures ?? 0} / ${state.config?.interruptLock?.failureThreshold ?? 3}`),
                h('dt', null, t('recoveryLockState')), h('dd', null,
                  h(Badge, { kind: locked ? 'error' : (lockState === 'counting' ? 'warn' : 'ok') },
                    t(lockState === 'locked' ? 'lockLocked'
                      : lockState === 'counting' ? 'lockCounting'
                        : lockState === 'trial_resume' ? 'lockTrial' : 'lockUnlocked')))))
          }))
    }

    /** Assets: upload by file picker, search, and reference to a task. */
    function AssetPanel({ state, t, projectId, onMutated, setError }) {
      const [query, setQuery] = useState('')
      const [uploadFolder, setUploadFolder] = useState('')
      const fileRef = useRef(null)
      const assets = state.assets ?? []

      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        const live = assets.filter((a) => a.deletedAt === null || a.deletedAt === undefined)
        if (q === '') return live
        return live.filter((a) =>
          a.name.toLowerCase().includes(q) || (a.folder ?? '').toLowerCase().includes(q))
      }, [assets, query])

      const upload = async (file) => {
        if (file === undefined || file === null) return
        setError(null)
        try {
          const params = new URLSearchParams({
            op: 'upload', project: projectId, name: file.name,
            folder: uploadFolder, contentType: file.type || 'application/octet-stream',
          })
          const res = await fetch(`${API}/asset?${params.toString()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: file,
          })
          const json = await res.json().catch(() => ({}))
          if (!res.ok || json?.error) throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
          onMutated()
        } catch (error) {
          setError(String(error?.message ?? error))
        } finally {
          if (fileRef.current !== null) fileRef.current.value = ''
        }
      }

      const post = async (body) => {
        setError(null)
        try {
          await callApi('/asset', { method: 'POST', body: JSON.stringify({ projectId, ...body }) })
          onMutated()
        } catch (error) {
          setError(String(error?.message ?? error))
        }
      }

      return h('div', null,
        h('div', { className: cls.toolbar },
          h('strong', null, t('assetTitle')),
          h('span', { className: cls.muted }, `${filtered.length}`),
          h('input', {
            className: cls.input, style: { minWidth: 200 }, value: query,
            placeholder: t('assetSearch'),
            onChange: (e) => setQuery(e.target.value),
          }),
          h('input', {
            className: cls.input, style: { width: 120 }, value: uploadFolder,
            placeholder: t('assetFolder'),
            onChange: (e) => setUploadFolder(e.target.value),
          }),
          h('input', {
            type: 'file', ref: fileRef, style: { display: 'none' },
            onChange: (e) => upload(e.target.files?.[0]),
          }),
          h('button', { className: cls.buttonPrimary,
            onClick: () => fileRef.current?.click() }, t('assetUpload'))),

        filtered.length === 0 ? h('div', { className: cls.empty }, t('empty'))
          : filtered.map((asset) => h('div', { key: asset.id, className: cls.card },
            h('div', { className: cls.row },
              h('strong', null, asset.name),
              h(Badge, null, `v${asset.version}`),
              asset.highRisk ? h(Badge, { kind: 'warn' }, t('assetHighRisk')) : null,
              asset.sourceLocked ? h(Badge, { kind: 'error' }, t('assetSourceLocked')) : null,
              h('span', { className: cls.grow }),
              h('button', { className: cls.button,
                onClick: () => {
                  const taskId = (state.tasks ?? [])[0]?.id
                  if (taskId === undefined) {
                    setError('项目内还没有任务，无法引用资产。')
                    return
                  }
                  post({ op: 'link', assetId: asset.id, taskId })
                } }, t('assetRef')),
              h('button', { className: cls.buttonDanger,
                onClick: () => {
                  if (!window.confirm(t('confirmDelete'))) return
                  post({ op: 'delete', assetId: asset.id })
                } }, t('assetDelete'))),
            h('div', { className: cls.muted, style: { marginTop: 4 } },
              `${asset.folder || '/'} · ${formatBytes(asset.bytes)} · ${asset.ownerId}`,
              ' · ', (asset.allowedAgents ?? []).length === 0
                ? t('assetScopeAll')
                : `${t('assetScope')}: ${asset.allowedAgents.join('、')}`)))
      )
    }

    // --------------------------------------------------- workspace picker

    /**
     * The entry screen: pick a directory, get its team.
     *
     * Switching collaboration context IS switching directory — one folder owns
     * one team, one plan, one feed. So the panel opens here rather than on
     * whichever project loaded first; otherwise a human running two teams would
     * silently edit the wrong one.
     *
     * Selecting a directory that already hosts a team reuses it; selecting a
     * fresh one offers to create a team there.
     */
    function WorkspacePicker({ t, onPicked, currentProjectId }) {
      const [teams, setTeams] = useState([])
      const [path, setPath] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)

      const load = useCallback(async () => {
        setLoading(true)
        try {
          const result = await callApi('/workspaces')
          setTeams(result.teams ?? [])
          setError(null)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const usePath = (target) => {
        const trimmed = String(target ?? '').trim()
        if (trimmed === '') { setError(t('wsPickFirst')); return }
        const match = teams.find((x) =>
          x.workspace.replace(/\\/g, '/').toLowerCase() === trimmed.replace(/\\/g, '/').toLowerCase())
        onPicked({ workspace: trimmed, projectId: match?.projectId, existing: match !== undefined })
      }

      return h('div', { className: cls.root },
        h('style', null, STYLE),
        h('div', { className: cls.header },
          h('h1', { className: cls.title }, t('wsTitle')),
          h('p', { className: cls.sub }, t('wsSub'))),
        h('div', { className: cls.body },
          error !== null ? h('div', { className: cls.error }, error) : null,

          h('div', { className: cls.card },
            h(Field, { label: t('wsPath') },
              h('input', {
                className: cls.input, value: path, autoFocus: true,
                placeholder: 'C:\\path\\to\\workspace',
                onChange: (e) => setPath(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') usePath(path) },
              })),
            h('div', { className: cls.row },
              h('button', {
                className: cls.buttonPrimary, disabled: path.trim() === '',
                onClick: () => usePath(path),
              }, t('wsUse')))),

          h('div', { className: cls.label, style: { margin: '16px 0 6px' } }, t('wsExisting')),
          loading
            ? h('div', { className: cls.empty }, t('wsLoading'))
            : (teams.length === 0
                ? h('div', { className: cls.empty }, t('wsNone'))
                : teams.map((team) => h('div', {
                    key: team.projectId,
                    className: team.projectId === currentProjectId
                      ? 'ab-ws-card ab-ws-card--current'
                      : 'ab-ws-card',
                    onClick: () => usePath(team.workspace),
                  },
                  h('div', { style: { flex: 1, minWidth: 0 } },
                    h('div', { style: { fontWeight: 600 } }, team.title || team.workspace),
                    h('div', { className: cls.muted, style: {
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    } }, team.workspace)),
                  h('div', { className: cls.muted, style: { textAlign: 'right', flex: 'none' } },
                    `${t('wsLeader')} ${team.leader ?? '—'}`,
                    h('br'),
                    `${team.members} ${t('wsMembers')}`),
                  team.projectId === currentProjectId
                    ? h(Badge, { kind: 'info' }, t('wsCurrent'))
                    : null)))))
    }

    /**
     * The OOBE setup page.
     *
     * Shown **instead of** the workbench until the team exists. The brief asks
     * for exactly this: an initialization page that gates the discussion view,
     * where the human supplies three things before any AI starts costing money.
     *
     *   1. the workspace (one directory = one team),
     *   2. the leader's model, and
     *   3. the model new members get — kept separate because a leader that
     *      coordinates and members that execute can reasonably differ.
     *
     * Plus free-text instructions for the leader, **appended** to its built-in
     * brief rather than replacing it: the built-in text explains this plugin's
     * mechanics, which the human should not have to restate.
     */
    function SetupPage({ t, workspace, projectId, onDone, setError }) {
      const [models, setModels] = useState({ models: [], default: null })
      const [leaderModelKey, setLeaderModelKey] = useState('')
      const [memberModelKey, setMemberModelKey] = useState('')
      const [brief, setBrief] = useState('')
      const [busy, setBusy] = useState(false)
      const [localError, setLocalError] = useState(null)

      useEffect(() => {
        let cancelled = false
        callApi('/models')
          .then((result) => {
            if (cancelled) return
            setModels(result)
            const preset = result.default
            const presetKey = preset !== null && preset !== undefined && preset.provider !== ''
              ? `${preset.provider}\u0000${preset.model}`
              : (result.models[0] ? `${result.models[0].provider}\u0000${result.models[0].model}` : '')
            setLeaderModelKey(presetKey)
            setMemberModelKey(presetKey)
          })
          .catch(() => { /* the human can still proceed if the catalogue fails */ })
        return () => { cancelled = true }
      }, [])

      const split = (key) => {
        if (key === '') return { provider: '', model: '' }
        const [provider, model] = key.split('\u0000')
        return { provider: provider ?? '', model: model ?? '' }
      }

      const leaderModel = split(leaderModelKey)
      const memberModel = split(memberModelKey)
      const canSubmit = workspace.trim() !== '' && leaderModel.provider !== '' && leaderModel.model !== ''

      const submit = async () => {
        if (!canSubmit) return
        setBusy(true)
        setLocalError(null)
        try {
          const result = await callApi('/team', {
            method: 'POST',
            body: JSON.stringify({
              projectId,
              op: 'initialize',
              workspace: workspace.trim(),
              model: leaderModel,
              memberModel: memberModel.provider === '' ? undefined : memberModel,
              leaderBrief: brief,
            }),
          })
          if (result?.spawnError) {
            // The team exists but the leader could not start. Report it without
            // blocking entry: the roster is real and the human can retry from
            // the team panel.
            setError(`${t('setupSpawnFailed')}: ${result.spawnError}`)
          }
          onDone(result?.projectId ?? projectId)
        } catch (error) {
          setLocalError(String(error?.message ?? error))
        } finally {
          setBusy(false)
        }
      }

      const modelOptions = models.models.length === 0
        ? h('option', { value: '' }, t('teamModelEmpty'))
        : models.models.map((m) => h('option', {
            key: `${m.provider}\u0000${m.model}`,
            value: `${m.provider}\u0000${m.model}`,
          }, `${m.provider} / ${m.name}`))

      return h('div', { className: cls.root },
        h('style', null, STYLE),
        h('div', { className: cls.header },
          h('h1', { className: cls.title }, t('setupTitle')),
          h('p', { className: cls.sub }, t('setupSub'))),
        h('div', { className: cls.body },
          localError !== null ? h('div', { className: cls.error }, localError) : null,

          h('div', { className: cls.card },
            h(Field, { label: t('setupWorkspace') },
              h('input', {
                className: cls.input, value: workspace, readOnly: true,
                title: workspace,
              })),
            h('p', { className: cls.label, style: { marginBottom: 14 } }, t('setupWorkspaceHint'))),

          h('div', { className: cls.card },
            h(Field, { label: t('setupLeaderModel') },
              h('select', {
                className: cls.select, value: leaderModelKey,
                onChange: (e) => setLeaderModelKey(e.target.value),
              }, modelOptions)),
            h('p', { className: cls.label, style: { marginBottom: 12 } }, t('setupLeaderModelHint')),

            h(Field, { label: t('setupMemberModel') },
              h('select', {
                className: cls.select, value: memberModelKey,
                onChange: (e) => setMemberModelKey(e.target.value),
              }, modelOptions)),
            h('p', { className: cls.label, style: { marginBottom: 12 } }, t('setupMemberModelHint')),

            h(Field, { label: t('setupBrief') },
              h('textarea', {
                className: cls.textarea, value: brief,
                style: { minHeight: 120 },
                placeholder: t('setupBriefPlaceholder'),
                onChange: (e) => setBrief(e.target.value),
              })),
            h('p', { className: cls.label, style: { marginBottom: 4 } }, t('setupBriefHint')),
            h('p', { className: cls.muted, style: { marginBottom: 12 } },
              `${t('setupBriefChars')} ${brief.length} / 8000`)),

          h('div', { className: cls.row, style: { marginTop: 4 } },
            h('button', {
              className: cls.buttonPrimary, disabled: busy || !canSubmit,
              onClick: submit,
            }, busy ? t('setupStarting') : t('setupStart')),
            h('span', { className: cls.muted }, t('setupAfterHint')))))
    }

    // ------------------------------------------------------- task graph panel

    /**
     * Mind-map layout: a horizontal tree, roots on the left.
     *
     * Why a hand-rolled layout instead of a charting library: the panel ships
     * inside a plugin with no dependency budget, and the layout that matters
     * here -- "one column per depth, siblings stacked" -- is about forty lines
     * of arithmetic. A library would also want to own the theme, which this
     * panel cannot give it.
     *
     * The two passes: measure each subtree's height (so a parent centres against
     * its children), then place nodes top-down.
     */
    function layoutTree(roots, collapsed) {
      const NODE_W = 210
      const NODE_H = 58
      const GAP_Y = 14
      const GAP_X = 62

      const nodes = []
      const edges = []

      function measure(node) {
        const kids = collapsed.has(node.id) ? [] : node.children
        if (kids.length === 0) {
          node._h = NODE_H
          return NODE_H
        }
        let h = 0
        for (const kid of kids) h += measure(kid) + GAP_Y
        node._h = Math.max(NODE_H, h - GAP_Y)
        return node._h
      }

      function place(node, depth, top) {
        const kids = collapsed.has(node.id) ? [] : node.children
        const x = depth * (NODE_W + GAP_X)
        const y = kids.length === 0
          ? top + (node._h - NODE_H) / 2
          : top + (node._h - NODE_H) / 2
        const placed = { ...node, _x: x, _y: y, _w: NODE_W, _h: NODE_H, _hasKids: node.children.length > 0, _collapsed: collapsed.has(node.id) }
        nodes.push(placed)
        let cursor = top
        for (const kid of kids) {
          const kidPlaced = place(kid, depth + 1, cursor)
          edges.push({
            id: `${node.id}->${kid.id}`,
            x1: x + NODE_W,
            y1: y + NODE_H / 2,
            x2: kidPlaced._x,
            y2: kidPlaced._y + NODE_H / 2,
            state: kid.status,
          })
          cursor += kid._h + GAP_Y
        }
        return placed
      }

      let top = 0
      for (const root of roots) {
        measure(root)
        place(root, 0, top)
        top += root._h + GAP_Y * 2
      }

      const width = nodes.reduce((max, n) => Math.max(max, n._x + n._w), 0) + 40
      const height = Math.max(top, 120) + 20
      return { nodes, edges, width, height }
    }

    const GRAPH_STATE_COLOR = {
      working: 'var(--dsw-alias-state-success-primary,#4a9c6d)',
      waiting_human: 'var(--dsw-alias-state-warn-primary,#c08a3e)',
      idle: 'var(--dsw-alias-state-idle-primary,#888)',
      dormant: 'var(--dsw-alias-state-idle-primary,#888)',
      offline: 'var(--dsw-alias-state-idle-primary,#888)',
      unassigned: 'var(--dsw-alias-border-l2,#555)',
    }

    /** The task graph: human instruction at the root, work branching right. */
    function GraphPanel({ state, t }) {
      const [collapsed, setCollapsed] = useState(() => new Set())
      const [zoom, setZoom] = useState(1)
      const graph = state.taskGraph

      const toggle = (id) => {
        setCollapsed((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }

      const collectAll = (nodes, out) => {
        for (const n of nodes) {
          if (n.children.length > 0) out.push(n.id)
          collectAll(n.children, out)
        }
        return out
      }

      if (graph === undefined || graph === null || graph.roots.length === 0) {
        return h('div', null,
          h('div', { className: cls.toolbar }, h('strong', null, t('graphTitle'))),
          h('div', { className: cls.empty }, t('graphEmpty')))
      }

      const laid = layoutTree(graph.roots, collapsed)
      const statusKey = { pending: 'statusPending', in_progress: 'statusInProgress', paused: 'statusPaused', done: 'statusDone', locked_by_interrupt: 'statusLocked' }
      const stateKey = { working: 'stWorking', waiting_human: 'stWaitingHuman', idle: 'stIdle', dormant: 'stDormant', offline: 'stOffline', unassigned: 'stUnassigned' }

      return h('div', null,
        h('div', { className: cls.toolbar },
          h('strong', null, t('graphTitle')),
          h('span', { className: cls.muted },
            `${graph.stats.total} ${t('graphNode')} · ${t('graphDepth')} ${graph.stats.maxDepth} · ` +
            `${t('graphInProgress')} ${graph.stats.inProgress} · ${t('graphBlocked')} ${graph.stats.blocked}`),
          h('span', { className: cls.grow }),
          h('button', { className: cls.button, onClick: () => { setZoom((z) => Math.min(1.8, z + 0.15)) } }, '＋'),
          h('button', { className: cls.button, onClick: () => { setZoom((z) => Math.max(0.45, z - 0.15)) } }, '－'),
          h('button', { className: cls.button, onClick: () => setZoom(1) }, t('graphReset')),
          h('button', {
            className: cls.button,
            onClick: () => setCollapsed(new Set(collectAll(graph.roots, []))),
          }, t('graphCollapse')),
          h('button', { className: cls.button, onClick: () => setCollapsed(new Set()) }, t('graphExpand'))),

        h('div', { className: cls.card, style: { overflow: 'auto', padding: 8 } },
          h('svg', {
            width: Math.max(laid.width * zoom, 300),
            height: Math.max(laid.height * zoom, 160),
            viewBox: `0 0 ${laid.width} ${laid.height}`,
            style: { display: 'block' },
            role: 'img',
            'aria-label': t('graphTitle'),
          },
          // Edges first so nodes paint over them.
          laid.edges.map((edge) => {
            const midX = (edge.x1 + edge.x2) / 2
            const colour = edge.state === 'locked_by_interrupt'
              ? 'var(--dsw-alias-state-error-primary,#c0504d)'
              : edge.state === 'in_progress'
                ? 'var(--dsw-alias-state-success-primary,#4a9c6d)'
                : 'var(--dsw-alias-border-l2,#555)'
            return h('path', {
              key: edge.id,
              d: `M ${edge.x1} ${edge.y1} C ${midX} ${edge.y1}, ${midX} ${edge.y2}, ${edge.x2} ${edge.y2}`,
              fill: 'none',
              stroke: colour,
              strokeWidth: edge.state === 'in_progress' || edge.state === 'locked_by_interrupt' ? 2 : 1.2,
              opacity: 0.85,
            })
          }),
          laid.nodes.map((node) => {
            const stateColour = GRAPH_STATE_COLOR[node.agentState] ?? GRAPH_STATE_COLOR.idle
            const isLocked = node.status === 'locked_by_interrupt'
            return h('g', {
              key: node.id,
              transform: `translate(${node._x},${node._y})`,
              style: { cursor: node._hasKids ? 'pointer' : 'default' },
              onClick: node._hasKids ? () => toggle(node.id) : undefined,
            },
            h('rect', {
              width: node._w,
              height: node._h,
              rx: 9,
              fill: 'var(--dsw-alias-bg-layer-1, rgba(128,128,128,.10))',
              stroke: isLocked
                ? 'var(--dsw-alias-state-error-primary,#c0504d)'
                : 'var(--dsw-alias-border-l2,#555)',
              strokeWidth: isLocked ? 1.8 : 1,
            }),
            // Left rail: the agent's live state. This is the "what is each AI
            // doing right now" signal, so it is a colour + a word, not colour
            // alone.
            h('rect', { x: 0, y: 0, width: 4, height: node._h, rx: 2, fill: stateColour }),
            h('text', {
              x: 12, y: 18,
              fontSize: 11.5, fontWeight: 600,
              fill: 'var(--dsw-alias-label-primary,#e8e8e8)',
            }, node.title.length > 22 ? `${node.title.slice(0, 22)}…` : node.title),
            h('text', {
              x: 12, y: 34, fontSize: 9.5,
              fill: 'var(--dsw-alias-label-secondary,#a0a0a0)',
            }, `${node.assignee ?? t('stUnassigned')} · ${t(stateKey[node.agentState] ?? 'stIdle')}`),
            h('text', {
              x: 12, y: 48, fontSize: 9,
              fill: 'var(--dsw-alias-label-secondary,#909090)',
            }, `${t(statusKey[node.status] ?? 'statusPending')}${node.orphan ? ` · ${t('graphOrphan')}` : ''}`),
            node._hasKids
              ? h('circle', {
                  cx: node._w - 12, cy: node._h / 2, r: 8,
                  fill: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,.2))',
                })
              : null,
            node._hasKids
              ? h('text', {
                  x: node._w - 12, y: node._h / 2 + 3.5,
                  fontSize: 9, textAnchor: 'middle',
                  fill: 'var(--dsw-alias-label-secondary,#a0a0a0)',
                }, node._collapsed ? `+${node.children.length}` : '−')
              : null)
          })))
      )
    }

    // --------------------------------------------------------- team panel

    /** AI team: roster, org chart, reviews, and the request queue. */
    function TeamPanel({ state, t, projectId, workspace, onMutated, setError }) {
      const team = state.team
      const [busy, setBusy] = useState(false)
      const [workspace2, setWorkspace] = useState('')
      const [models, setModels] = useState({ models: [], default: null })
      const [modelKey, setModelKey] = useState('')
      const [adding, setAdding] = useState(false)
      const [draft, setDraft] = useState({ name: '', title: '', reportsTo: '' })
      const [reviewing, setReviewing] = useState(null)
      const [reviewDraft, setReviewDraft] = useState({ score: 80, verdict: '', advice: '' })

      const needsSetup = team === null || team === undefined || team.initialized !== true

      // Load the model catalogue only when the setup form is on screen: a Host
      // with many providers would otherwise pay that query on every panel open.
      useEffect(() => {
        if (!needsSetup) return
        let cancelled = false
        callApi('/models')
          .then((result) => {
            if (cancelled) return
            setModels(result)
            const preset = result.default
            if (preset !== null && preset !== undefined) {
              setModelKey(`${preset.provider}\u0000${preset.model}`)
            } else if (result.models.length > 0) {
              setModelKey(`${result.models[0].provider}\u0000${result.models[0].model}`)
            }
          })
          .catch(() => { /* the human can still type a model by hand */ })
        return () => { cancelled = true }
      }, [needsSetup])

      const post = async (body) => {
        setBusy(true)
        setError(null)
        try {
          const result = await callApi('/team', {
            method: 'POST',
            body: JSON.stringify({ projectId, ...body }),
          })
          onMutated()
          return result
        } catch (error) {
          setError(String(error?.message ?? error))
          return null
        } finally {
          setBusy(false)
        }
      }

      if (needsSetup) {
        const [provider, model] = modelKey === '' ? ['', ''] : modelKey.split('\u0000')
        // The workspace is already chosen by the picker; the field below is just
        // a reminder (and a way to correct a typo) rather than a second decision.
        const effectiveWorkspace = workspace2 !== '' ? workspace2 : (workspace ?? '')
        const canInit = effectiveWorkspace.trim() !== '' && provider !== '' && model !== ''
        return h('div', null,
          h('div', { className: cls.toolbar }, h('strong', null, t('teamTitle'))),
          h('div', { className: cls.card },
            h('p', { className: cls.muted, style: { marginTop: 0 } }, t('teamEmpty')),

            h(Field, { label: t('teamWorkspace') },
              h('input', {
                className: cls.input, value: effectiveWorkspace, placeholder: 'C:\\path\\to\\workspace',
                onChange: (e) => setWorkspace(e.target.value),
              })),
            h('p', { className: cls.label, style: { marginBottom: 10 } }, t('teamWorkspaceHint')),

            h(Field, { label: t('teamModelLabel') },
              h('select', {
                className: cls.select,
                value: modelKey,
                onChange: (e) => setModelKey(e.target.value),
              },
              models.models.length === 0
                ? h('option', { value: modelKey }, modelKey === '' ? t('teamModelEmpty') : modelKey.replace('\u0000', '/'))
                : models.models.map((m) => h('option', {
                    key: `${m.provider}\u0000${m.model}`,
                    value: `${m.provider}\u0000${m.model}`,
                  }, `${m.provider} / ${m.name}`)))),
            h('p', { className: cls.label, style: { marginBottom: 10 } }, t('teamModelHint')),

            h('div', { className: cls.row, style: { marginTop: 6 } },
              h('button', {
                className: cls.buttonPrimary, disabled: busy || !canInit,
                onClick: () => post({
                  op: 'initialize',
                  workspace: effectiveWorkspace.trim(),
                  model: { provider, model },
                }),
              }, t('teamInit')),
              h('span', { className: cls.muted }, t('teamInitHint')))))
      }

      const statusKey = { working: 'stWorking', waiting_human: 'stWaitingHuman', idle: 'stIdle', dormant: 'stDormant', offline: 'stOffline' }
      const requests = state.requests ?? []
      const pending = requests.filter((r) => r.status === 'pending')

      const renderMember = (member, depth) => {
        const reports = (team.byReportsTo[member.name] ?? [])
        return h('div', { key: member.name, style: { marginLeft: depth * 18 } },
          h('div', {
            className: cls.card,
            style: {
              padding: '8px 10px', marginBottom: 6,
              borderLeft: `3px solid ${GRAPH_STATE_COLOR[member.status] ?? GRAPH_STATE_COLOR.idle}`,
            },
          },
          h('div', { className: cls.row },
            h('strong', null, member.name),
            member.role === 'leader'
              ? h(Badge, { kind: 'info' }, t('teamLeader'))
              : (member.role === 'coordinator'
                  ? h(Badge, { kind: 'ok' }, t('teamCoordinator'))
                  : null),
            h(Badge, {
              kind: member.status === 'working' ? 'ok'
                : member.status === 'waiting_human' ? 'warn'
                  : member.status === 'dormant' ? undefined : undefined,
            }, t(statusKey[member.status] ?? 'stIdle')),
            h('span', { className: cls.grow }),
            h('span', { className: cls.muted },
              member.currentTask === null ? t('teamNoTask') : `${t('teamCurrentTask')}: ${member.currentTask}`)),

          h('div', { className: cls.row, style: { marginTop: 6 } },
            h('span', { className: cls.muted },
              `${member.title || t('teamMember')}` +
              `${member.reportsTo ? ` · ${t('teamReportsTo')} ${member.reportsTo}` : ''}` +
              `${member.lastReviewAt ? ` · ${t('teamLastReview')} ${formatTime(member.lastReviewAt)}` : ''}`),
            h('span', { className: cls.grow }),
            member.role !== 'leader'
              ? h('button', {
                  className: cls.button, disabled: busy,
                  onClick: () => post({ op: member.status === 'dormant' ? 'wake' : 'sleep', name: member.name }),
                }, member.status === 'dormant' ? t('teamWake') : t('teamSleep'))
              : null,
            h('button', {
              className: cls.button,
              onClick: () => {
                setReviewing(member.name)
                setReviewDraft({
                  score: member.review?.score ?? 80,
                  verdict: member.review?.verdict ?? '',
                  advice: member.review?.advice ?? '',
                })
              },
            }, t('teamReviewBtn')),
            // The coordinator is runtime-managed: it may be woken or slept, but
            // removing it by hand would just be re-created on the next watch
            // pass, so the button is hidden rather than silently failing.
            member.role === 'member'
              ? h('button', {
                  className: cls.buttonDanger, disabled: busy,
                  onClick: () => {
                    if (!window.confirm(`${t('teamRemove')} ${member.name}?`)) return
                    post({ op: 'remove', name: member.name })
                  },
                }, t('teamRemove'))
              : null),

          member.review?.advice
            ? h('div', { className: cls.muted, style: { marginTop: 5 } },
                `${t('teamAdvice')}: ${member.review.advice}`)
            : null,
          member.stats !== undefined
            ? h('div', { className: cls.muted, style: { marginTop: 3 } },
                `${t('teamTasksDone')} ${member.stats.tasksCompleted} · ${t('teamPosts')} ${member.stats.postsTotal}`)
            : null),

          reviewing === member.name
            ? h('div', { className: cls.card, style: { marginLeft: 18 } },
                h(Field, { label: t('teamScore') },
                  h('input', {
                    className: cls.input, type: 'number', min: 0, max: 100,
                    value: reviewDraft.score,
                    onChange: (e) => setReviewDraft({ ...reviewDraft, score: e.target.value }),
                  })),
                h(Field, { label: t('teamVerdict') },
                  h('input', {
                    className: cls.input, value: reviewDraft.verdict,
                    onChange: (e) => setReviewDraft({ ...reviewDraft, verdict: e.target.value }),
                  })),
                h(Field, { label: t('teamAdvice') },
                  h('textarea', {
                    className: cls.textarea, value: reviewDraft.advice,
                    onChange: (e) => setReviewDraft({ ...reviewDraft, advice: e.target.value }),
                  })),
                h('div', { className: cls.row },
                  h('button', {
                    className: cls.buttonPrimary,
                    disabled: busy || reviewDraft.advice.trim() === '',
                    onClick: async () => {
                      await post({
                        op: 'review',
                        name: member.name,
                        score: Number(reviewDraft.score),
                        verdict: reviewDraft.verdict,
                        advice: reviewDraft.advice,
                      })
                      setReviewing(null)
                    },
                  }, t('save')),
                  h('button', { className: cls.button, onClick: () => setReviewing(null) }, t('cancel'))))
            : null,

          reports.length > 0
            ? h('div', null, reports.map((r) => renderMember(r, depth + 1)))
            : null)
      }

      const roots = team.byReportsTo['__root__'] ?? team.members.filter((m) => m.reportsTo === null)

      return h('div', null,
        h('div', { className: cls.toolbar },
          h('strong', null, t('teamTitle')),
          h('span', { className: cls.muted },
            `${team.counts.total} · ${t('stWorking')} ${team.counts.working} · ` +
            `${t('stWaitingHuman')} ${team.counts.waitingHuman} · ${t('stDormant')} ${team.counts.dormant}`),
          h('span', { className: cls.grow }),
          adding
            ? h('button', { className: cls.button, onClick: () => setAdding(false) }, t('cancel'))
            : h('button', { className: cls.buttonPrimary, onClick: () => setAdding(true) }, t('teamAddMember'))),

        adding
          ? h('div', { className: cls.card },
              h('div', { className: cls.row },
                h(Field, { label: t('teamNameLabel') },
                  h('input', {
                    className: cls.input, value: draft.name, autoFocus: true,
                    onChange: (e) => setDraft({ ...draft, name: e.target.value }),
                  })),
                h(Field, { label: t('teamTitleLabel') },
                  h('input', {
                    className: cls.input, value: draft.title,
                    onChange: (e) => setDraft({ ...draft, title: e.target.value }),
                  })),
                h(Field, { label: t('teamReportsTo') },
                  h('select', {
                    className: cls.select, value: draft.reportsTo,
                    onChange: (e) => setDraft({ ...draft, reportsTo: e.target.value }),
                  },
                  h('option', { value: '' }, t('teamLeader')),
                  team.members.map((m) => h('option', { key: m.name, value: m.name }, m.name))))),
              h('div', { className: cls.row },
                h('button', {
                  className: cls.buttonPrimary,
                  disabled: busy || draft.name.trim() === '',
                  onClick: async () => {
                    await post({
                      op: 'add',
                      name: draft.name.trim(),
                      title: draft.title,
                      reportsTo: draft.reportsTo || undefined,
                    })
                    setDraft({ name: '', title: '', reportsTo: '' })
                    setAdding(false)
                  },
                }, t('submit'))))
          : null,

        // Org chart: roots first, direct reports nested beneath.
        roots.length === 0
          ? h('div', { className: cls.empty }, t('empty'))
          : roots.map((m) => renderMember(m, 0)),

        // The adjudication queue: the leader's inbox, visible to the human too,
        // because a stuck leader must not be able to stall the team silently.
        h('div', { className: cls.toolbar, style: { marginTop: 18 } },
          h('strong', null, t('teamRequests')),
          h('span', { className: cls.muted }, `${pending.length}`)),
        pending.length === 0
          ? h('div', { className: cls.empty }, t('teamNoRequests'))
          : pending.map((request) => h('div', { key: request.id, className: cls.card },
              h('div', { className: cls.row },
                h('strong', null, request.title),
                h(Badge, { kind: request.urgency === 'high' ? 'error' : 'warn' }, request.urgency),
                h('span', { className: cls.grow }),
                h('span', { className: cls.muted }, `${request.from ?? '?'} → ${request.leader ?? '?'}`)),
              h('div', { className: cls.muted, style: { marginTop: 4 } }, request.reason),
              request.skill ? h('div', { className: cls.muted }, `${request.skill}`) : null,
              h('div', { className: cls.row, style: { marginTop: 8 } },
                h('button', {
                  className: cls.button,
                  disabled: busy,
                  onClick: async () => {
                    const assignee = window.prompt(`${t('teamAssignTo')}（${team.members.filter((m) => m.role === 'member').map((m) => m.name).join(' / ') || '—'}）`)
                    if (assignee === null) return
                    await post({ op: 'decide', requestId: request.id, decision: 'approve', assignee })
                  },
                }, t('teamApprove')),
                h('button', {
                  className: cls.buttonDanger,
                  disabled: busy,
                  onClick: async () => {
                    const reason = window.prompt(`${t('teamReject')} — 理由`)
                    if (reason === null) return
                    await post({ op: 'decide', requestId: request.id, decision: 'reject', reason })
                  },
                }, t('teamReject')))))
      )
    }

    /** Recovery: the §4.5 status indicator, per conversation. */
    function RecoveryPanel({ state, t }) {
      const resumeStates = state.resume ?? []
      const threshold = state.config?.interruptLock?.failureThreshold ?? 3

      if (resumeStates.length === 0) {
        return h('div', null,
          h('div', { className: cls.toolbar }, h('strong', null, t('recoveryTitle'))),
          h('div', { className: cls.empty }, t('recoveryNone')))
      }

      return h('div', null,
        h('div', { className: cls.toolbar },
          h('strong', null, t('recoveryTitle')),
          h('span', { className: cls.muted }, `${resumeStates.length}`)),
        resumeStates.map((entry) => {
          const lock = entry.interruptLock ?? {}
          const lockState = lock.state ?? 'unlocked'
          const locked = lockState === 'locked'
          const task = (state.tasks ?? []).find((tk) => tk.conversationId === entry.conversationId)
          const checkpoint = task?.latestCheckpoint
          const snapshot = checkpoint?.resume_context?.cross_module_snapshot
          const lastOp = checkpoint?.resume_context?.last_operation
          return h('div', { key: entry.conversationId, className: locked ? 'ab-card ab-item--locked' : cls.card },
            h('div', { className: cls.row },
              h('strong', null, task?.title ?? entry.conversationId),
              h(Badge, { kind: locked ? 'error' : (lockState === 'counting' ? 'warn' : 'ok') },
                t(lockState === 'locked' ? 'lockLocked'
                  : lockState === 'counting' ? 'lockCounting'
                    : lockState === 'trial_resume' ? 'lockTrial' : 'lockUnlocked')),
              h('span', { className: cls.grow }),
              h('span', { className: cls.muted },
                `${t('recoveryFailures')} ${lock.consecutiveFailures ?? 0} / ${t('lockThreshold')} ${threshold}`)),

            h('dl', { className: cls.kv, style: { marginTop: 8 } },
              h('dt', null, t('recoveryLast')), h('dd', null, formatTime(entry.lastResumeAt)),
              h('dt', null, t('recoveryTrigger')), h('dd', null,
                entry.lastResumeAt === null
                  ? t('none')
                  : (entry.resumeLock?.holder ?? '').includes('restart') ? t('recoveryRestart')
                    : (entry.resumeLock?.holder ?? '').includes('human') ? t('recoveryManual')
                      : t('recoveryRunning')),
              h('dt', null, t('recoveryVerified')), h('dd', null,
                snapshot === undefined
                  ? t('none')
                  : ['动态', '计划', '资产', '执行权'].join('、')),
              h('dt', null, t('recoverySkipped')), h('dd', null,
                lastOp === undefined ? t('none')
                  : `${lastOp.type} → ${lastOp.result_status}`),
              lock.lastFailureReason
                ? h('div', { style: { gridColumn: '1 / -1', marginTop: 4 } },
                    h('dt', { style: { display: 'inline' } }, `${t('recoveryFailures')}: `),
                    h('dd', { style: { display: 'inline', color: 'var(--dsw-alias-state-error-primary,#d9534f)' } },
                      lock.lastFailureReason))
                : null))
        }))
    }

    // ------------------------------------------------------------------- app

    function Workbench({ t }) {
      const [state, setState] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [tab, setTab] = useState('feed')
      const [projectId, setProjectId] = useState(null)
      // `null` = the picker is showing. A workspace is chosen before any panel
      // renders, because "which team am I looking at" must never be a guess.
      const [workspace, setWorkspace] = useState(null)

      const load = useCallback(async (targetProject) => {
        // Each load starts from a clean slate for the panels it is about to
        // replace. Without this, switching workspace briefly rendered the
        // previous project's tasks and feed — the reported "leftover
        // conversations" — because React kept the old state until the new
        // response landed.
        setLoading(true)
        try {
          const query = targetProject ? `?project=${encodeURIComponent(targetProject)}` : ''
          const next = await callApi(`/state${query}`)
          setState(next)
          const nextProjectId = next.project?.id ?? null
          if (nextProjectId !== projectId) setProjectId(nextProjectId)
          setError(null)
        } catch (err) {
          setError(String(err?.message ?? err))
          // A failed load must not leave the previous project's data on screen:
          // that is precisely how one project's data appeared inside another.
          setState(null)
        } finally {
          setLoading(false)
        }
      }, [projectId])

      // Initial load plus the SSE invalidation stream. Both are created inside
      // the effect so an unmount closes the stream — a leaked EventSource is the
      // one resource here that outlives the panel.
      useEffect(() => {
        if (workspace === null) return undefined
        load(projectId)
        let source = null
        let disposed = false
        try {
          const query = projectId ? `?project=${encodeURIComponent(projectId)}` : ''
          source = new EventSource(`${API}/events${query}`)
          source.addEventListener('invalidate', () => {
            if (!disposed) load(projectId)
          })
          source.onerror = () => {
            // The browser retries on its own; a closed stream is not fatal.
            if (disposed) source?.close()
          }
        } catch {
          /* EventSource unavailable: mutations still refetch explicitly */
        }
        return () => {
          disposed = true
          try {
            source?.close()
          } catch {
            /* already closed */
          }
        }
      }, [load, projectId, workspace])

      const refresh = () => load(projectId)

      // No workspace chosen yet: the picker is the whole panel.
      if (workspace === null) {
        return h(WorkspacePicker, {
          t,
          currentProjectId: projectId,
          onPicked: (picked) => {
            // Switching workspace must reset the identity of "which project am I
            // looking at" before anything new is fetched. Keeping the old
            // projectId was what let the previous project's data survive the
            // switch: `load()` saw a truthy id and kept requesting it.
            setProjectId(picked.projectId ?? null)
            setState(null)
            setLoading(true)
            setWorkspace(picked.workspace)
            if (picked.projectId !== undefined) {
              load(picked.projectId)
            } else {
              // A fresh directory has no project yet. Ask for state with no
              // project so the server answers "empty", and let the Team panel
              // offer to initialize here.
              load(undefined)
            }
          },
        })
      }

      if (loading && state === null) {
        return h('div', { className: cls.root }, h('div', { className: cls.empty }, t('loading')))
      }

      /**
       * The OOBE gate.
       *
       * A workspace is chosen (that is the picker's job), but the team behind it
       * may not exist yet. In that case the setup page stands in front of the
       * workbench: no discussion view, no panels, no AI cost — until the human
       * has picked the models and optionally written the leader's brief.
       */
      const teamReady = state?.team?.initialized === true
      if (!teamReady) {
        return h(SetupPage, {
          t,
          workspace,
          projectId: state?.project?.id ?? projectId ?? undefined,
          setError,
          onDone: (id) => {
            if (id !== undefined && id !== null) setProjectId(id)
            load(id)
          },
        })
      }

      const panels = {
        feed: FeedPanel,
        graph: GraphPanel,

        team: TeamPanel,
        plan: PlanPanel,
        task: TaskPanel,
        asset: AssetPanel,
        recovery: RecoveryPanel,
      }
      const ActivePanel = panels[tab] ?? FeedPanel

      return h('div', { className: cls.root },
        h('style', null, STYLE),
        h('div', { className: cls.header },
          h('div', { className: cls.row },
            h('h1', { className: cls.title }, state?.project?.title ?? t('title')),
            h('span', { className: cls.grow }),
            h('button', {
              className: cls.button,
              title: workspace ?? '',
              onClick: () => { setWorkspace(null); setState(null); setLoading(true) },
            }, `${t('wsSwitch')}`)),
          h('p', { className: cls.sub }, workspace ?? t('subtitle')),
          h('div', { className: cls.tabs },
            [['feed', 'tabFeed'], ['graph', 'tabGraph'], ['team', 'tabTeam'],
             ['plan', 'tabPlan'], ['task', 'tabTask'],
             ['asset', 'tabAsset'], ['recovery', 'tabRecovery']].map(([id, key]) =>
              h('button', {
                key: id,
                className: tab === id ? cls.tabActive : cls.tab,
                onClick: () => setTab(id),
              }, t(key))))),

        h('div', { className: cls.body },
          error !== null ? h('div', { className: cls.error }, `${t('errorLoad')}: ${error}`) : null,
          h(PanelBoundary, { t },
            state === null
              ? h('div', { className: cls.empty }, t('empty'))
              : h(ActivePanel, {
                  state,
                  t,
                  projectId: state.project?.id ?? projectId,
                  workspace,
                  onMutated: refresh,
                  setError,
                }))))
    }

    // -------------------------------------------------------------- plugin

    return {
      // `slots` for the two registrations, `locale` for the dictionaries. Both
      // are optional at the call sites below so a Host that lacks one still
      // gets the other half instead of nothing.
      inject: ['slots', 'locale'],

      apply(ctx) {
        const slots = ctx.get('slots')
        const locale = ctx.get('locale')

        let t = (key) => key
        if (locale !== undefined && typeof locale.register === 'function') {
          // Registered inside an effect so an HMR reload disposes the
          // dictionary before re-registering it (register throws on duplicates).
          ctx.effect(
            () => locale.register(LOCALE_NS, { zh: MESSAGES.zh, en: MESSAGES.en }),
            'ai-buddy: locale dictionaries',
          )
          try {
            t = locale.bind(LOCALE_NS)
          } catch {
            /* bind unavailable: fall back to raw keys */
          }
        }

        if (slots === undefined) return

        /** The sidebar glyph: two collaborating agents over a plan board. */
        const Icon = ({ size = 20, active = false }) => h('svg', {
          viewBox: '0 0 32 32',
          width: size,
          height: size,
          'aria-hidden': true,
          style: {
            display: 'block',
            color: active
              ? 'var(--dsw-alias-brand-primary, #3b7ddd)'
              : 'var(--dsw-alias-label-secondary, #666)',
          },
        },
        h('circle', { cx: 10, cy: 12, r: 5, fill: 'currentColor', opacity: 0.85 }),
        h('circle', { cx: 22, cy: 12, r: 5, fill: 'currentColor', opacity: 0.55 }),
        h('rect', { x: 7, y: 22, width: 18, height: 3, rx: 1.5, fill: 'currentColor', opacity: 0.7 }),
        h('rect', { x: 7, y: 27, width: 11, height: 3, rx: 1.5, fill: 'currentColor', opacity: 0.45 }))

        ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: 'ai-buddy',
          order: 60,
          label: () => t('nav'),
        }, Icon)), 'ai-buddy: sidebar entry')

        ctx.effect(() => slots.inject('main', () => slots.register({
          name: 'main',
          key: 'ai-buddy',
          label: () => t('nav'),
        }, () => h(Workbench, { t }))), 'ai-buddy: main panel')
      },
    }
  },
})
