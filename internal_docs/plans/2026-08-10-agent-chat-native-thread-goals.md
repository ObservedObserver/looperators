# Agent Chat 原生线程目标（`/goal`）轻量实现计划

日期：2026-08-10
状态：已完成；自动验收、独立 UI 验收、Sonnet code review 与 Fable 5 最终复核均通过

## 1. 目标与术语

在 looperators Desktop 的 Agent Chat 中支持 Codex 原生 `/goal`：用户给当前聊天设置一个持久目标，Codex 在每个 turn 完成后自行判断是否继续，直到完成、暂停、阻塞或达到使用限制。

这里的 Goal 是 **Codex thread lifecycle state**，不是：

- reasoning effort / model option；
- CLI 的 `-go` 或 `--goal` 参数；
- looperators 已有的 “Run until goal” Worker/Judge workflow。

官方 Codex app-server 是事实源：

- RPC：`thread/goal/set`、`thread/goal/get`、`thread/goal/clear`；
- notification：`thread/goal/updated`、`thread/goal/cleared`；
- status：`active | paused | blocked | usageLimited | budgetLimited | complete`；
- active goal 在 thread idle 时由 Codex 自动注入 continuation，所以 set/resume 后 **禁止再发 `turn/start`**；
- goal 只支持已经 materialize 的非 ephemeral thread；objective 非空且最多 4,000 字符。

## 2. 调研结论与取舍

### 2.1 可借鉴部分

T3 Code 当前主分支没有合入 `/goal`；可参考的是其已关闭 PR #4260，而不是一项已上线功能。PR 中值得保留的原则：

1. provider capability 决定 UI 是否暴露 goal；
2. `/goal` 是独立的 thread lifecycle，不塞进 per-turn model options；
3. 新聊天先 materialize thread，再 set goal，绝不额外开始普通 turn；
4. provider notification 投影为 UI 状态；resume 时向 provider 对账；
5. composer 上方只放一个 compact progress row。

### 2.2 不照搬部分

不复制 T3 的 event-sourcing、WebSocket command、SQLite projection migration、activity fallback 与通用 provider adapter 大改。本项目已有 GraphState、kernel command、provider runtime event、IPC/HTTP 和 session persistence；沿现有链路增加最小能力即可。

### 2.3 v1 范围

- 仅 Codex app-server 支持；Claude Code / Grok 明确提示不支持，且不得启动 provider/session recovery 副作用。
- 命令：
  - `/goal`：查看当前 goal；
  - `/goal <objective>`：设置新目标；
  - `/goal set <objective>`：转义 objective 恰好为 `pause` / `resume` / `clear` 等关键字；
  - `/goal pause`、`/goal resume`、`/goal clear`；
  - `/goal edit` 不做 modal；paused/terminal goal 可在 composer 用新的 `/goal ...` 替换。
- compact progress row：status、objective、tokens/time（有值才显示）、Pause/Resume、Clear。
- v1 不提供 token budget 输入；set RPC 不发送 `tokenBudget: null`。
- 不做本地 autonomous loop，不用 prompt injection 模拟其他 provider，不新增 sidebar/timeline/modal。
- 不支持带附件的 `/goal` 命令；附件存在时 parser preflight 明确报错，绝不静默降级为普通消息或丢附件。

## 3. 轻量设计

### 3.1 共享契约和 parser

新增一个小型共享模块，包含：

- `ThreadGoal` / `ThreadGoalStatus`；
- `parseGoalComposerCommand()`；
- provider payload 的 defensive normalizer（objective、status、计数与时间戳）；
- 4,000 字符校验。

在 `ProviderCapability` 增加 `supportsThreadGoals`：Codex 为 true，其余 false。UI 只读 capability，不写 provider 特判。

`AgentSession` 增加可选 `threadGoal`，仍由现有 GraphState snapshot 持久化。恢复时只保留合法 goal；不新增 schema version 或数据库 migration。

### 3.2 Canonical runtime event

新增两个事件：

- `thread.goal.updated { goal }`
- `thread.goal.cleared`

Codex mapper 将 app-server notification 映射成这两个事件。`SessionRuntimeController`、renderer lightweight state patch 和 persistence recovery 只投影这个小字段。上游 Codex 是事实源，本地值只是持久化 UI cache。

projection 同时保留一个内部 `threadGoalLastAppliedAt` 水位：updated 优先使用 provider `goal.updatedAt`，cleared 使用 canonical event 接收时间。早于水位的迟到 notification 被忽略，防止 clear 后旧 updated 复活 cache；新 set 的 provider `updatedAt` 越过 clear 水位后正常生效。该水位只是乱序保护，不是第二份 goal 状态或 accounting。

显式 `thread/goal/get` / `thread/goal/set` 的成功 RPC response 是 authoritative：直接覆盖 projection 并重置水位；水位只约束异步 notification。这样不会因双时钟边界误丢对账结果，进而让本地空 cache 绕过 active-goal 普通消息门禁。

普通 `thread/resume` 会收到 goal snapshot；goal control run 还会在 materialize/resume 后调用 `thread/goal/get` 做显式对账，避免 UI 只依赖旧 snapshot。

### 3.3 Provider run：复用现有 controller，增加 goal operation

当前 Codex adapter 是“一次 Orrery run = 一个 app-server 进程 = 一个 `turn/start`”。Goal active 后可能自动产生多个 Codex turns，因此只做一个窄扩展：

1. `SessionRuntimeController.startRun()` request 可携带 `providerOperation`；
2. `CodexAppServerRun` 支持 ordinary turn（现有行为不变）和一个 `goal-control` operation（action 为 set/status/clear）；
3. goal operation 初始化并 start/resume thread 后调用 goal RPC，**不调用 `turn/start`**；
4. active 时保留 app-server client，继续转发所有自动 turns；goal 进入 paused/blocked/usageLimited/budgetLimited/complete 或 cleared 后关闭；
5. 多个 Codex automatic turns 在 v1 归属于同一个 looperators run/lease；消息与 tool activity 仍按 provider item id 投影，kernel 只在整个 goal run 结束时产生一次 run completion；
6. 已有 active goal run 的 pause/clear 直接调用该 run 的 RPC；idle goal 的 resume/control 通过一个新的 goal control run 完成。

Goal run 不复用 ordinary run 的 `turnCompleted` promise 或 30 分钟总超时：

- 每次 `turn/started` 更新当前 Codex turn id，但首个 `turn/completed` 只表示一次 automatic turn 结束，不 settle 整个 run；
- 只由 terminal goal notification、goal cleared、client error/close 或显式 kill settle goal run；
- 不设固定的 goal 总时长；现有 resource policy 仍可执行用户配置的 duration budget；
- goal-aware `kill()` 对所有调用来源（Goal UI、普通 Kill、resource budget、runtime shutdown）统一先 best-effort `thread/goal/set { status: paused }`，等待请求 settle 或短超时，再关闭 client；不得只 interrupt/close 留下 upstream active goal。

这避免引入第二套 provider lifecycle、后台 worker 或本地计时/accounting。

### 3.4 Kernel command 和新聊天 materialization

新增 human command：

- `set_thread_goal`
- `clear_thread_goal`

`set_thread_goal` 支持两种输入：

1. 已有 `sessionId`：preflight session/provider/status 后控制现有 Codex thread；
2. New Chat：复用 `cmdCreateSession(..., { deferStart: true })` 原子创建 idle graph session，将 `/goal ...` 保留为本地 user message，随后清除 prepared ordinary prompt 并启动 `goal-create` provider operation。provider 侧只执行 `thread/start` + `thread/goal/set`，不执行普通 turn。

这样无需新增“无消息 session”概念，也不会让 objective 被普通 turn 重复发送。

约束：

- unsupported provider 在 session 创建前失败；
- goal operation 必须保持选择的 provider instance、cwd、model/runtime settings；
- active/nonterminal goal 不允许静默换 objective；先 clear 或 pause 后再 set；
- command draft 只有在 RPC 成功并收到 authoritative projection 后清空；失败保留 draft；
- bare `/goal` 只查看本地 cache；cache 为空就显示“没有目标”，不为了 view 启动 app-server。

普通消息路径增加一条硬门禁：Codex session 的本地 goal 为 `active` 时，`cmdResumeSession` / `cmdActivate` 不得进入 `thread/resume + turn/start`，而是提示用户先 Pause/Clear，或用 Goal Resume/Reconnect 恢复 native loop。这专门封住 app 重启后没有 live run、但 upstream goal 仍 active 时的双重启动。paused/blocked/limited/complete 不触发 native continuation，可继续走既有普通消息路径。

### 3.5 暂停、停止和恢复语义

- Progress row 的 Stop/Pause 必须发 `status: paused`，不能只 kill 本地进程留下 upstream active goal。
- Resume 发 `status: active`，由 Codex 续跑，不额外 turn/start。
- Clear 调 `thread/goal/clear`；projection 水位阻止 clear 前的旧 notification 复活 cache。
- app/runtime 关闭时不伪造 goal 完成。恢复后的 cache 若仍为 active 但没有 live run，UI 显示 “Resume”/“Reconnect” 操作；用户触发后先 get 对账：upstream 已 complete/cleared 就只投影，upstream 为 paused 且用户请求 Resume 时才 set active，upstream 仍 active 时重新建立 goal run 但不重复替换 objective。v1 不在应用启动时自动消耗 token。
- active-path pause/clear 若恰逢 run terminal/close，command 自动降级到串行的 idle goal-control run并先 get 对账；不得无提示丢操作。
- 现有普通 Kill 仍是 session 终止语义；Goal UI 不调用它。所有 goal-aware kill 来源共用上节的 best-effort pause；pause RPC 失败则写 recovery diagnostic，保留本地 cache 供下次对账。

v1 明确接受以下资源粒度：整个 goal run 持有一次 writer workspace lease，并产生一个 looperators run completion / usage fact / checkpoint diff；开启 workspace serialization 时，同 cwd 其他 writer 会等到 goal terminal/pause/clear。Goal 仍受现有 resource policy 限制；budget kill 走 goal-aware pause。后续只有真实使用证明需要时才拆 automatic turn 粒度。

## 4. UI 数据流

`use-session-actions` 在普通 send 之前解析 standalone `/goal`：

1. capability preflight；
2. view 只展开/聚焦 progress row 或显示空状态；
3. set/pause/resume/clear 调 typed Runtime API；
4. 不进入 `createSession` / `resumeSession` 的普通消息路径。

`chat-detail` 在 composer 上方渲染单个 `thread-goal-progress-row.tsx`。复用现有 Button/Tooltip/status 色彩；没有 goal 时不占布局。New Chat 选择非 Codex provider 后输入 `/goal`，composer 内显示明确错误而不 materialize session。

IPC/preload/runtime-client/HTTP 只增加两条 typed 方法/route，全部汇入相同 kernel command，保证 Desktop 与 headless acceptance 同源。

## 5. 预计改动边界

核心文件（实际实施允许按现有拆分微调）：

- shared/types/parser：`shared/thread-goal.ts`、`src/shared/provider-runtime.ts`、两份 graph-state contract；
- provider：Codex adapter + mapper、ProviderService；
- runtime：command registry、SessionCommandRuntime、SessionRuntimeController、recovery/state patch；
- API：main/preload/runtime-client/HTTP server；
- renderer：`use-session-actions.ts`、`chat-detail.tsx`、新 compact row；
- tests：parser/mapper/kernel interaction + 一条真实 Codex acceptance scenario。

不修改 `agents.md`，不修改已有 Run until goal workflow，不改 graphStateVersion。

## 6. 测试与验收闭环

### 6.1 Unit / kernel

至少覆盖：

- parser：view/set/pause/resume/clear、大小写/空白、`/goal set pause`、超长/空 objective；
- capability：Codex-only，unsupported provider preflight 不创建 session、不启动 provider；
- ordinary message guard：active cached goal 不得走 `thread/resume + turn/start`；paused/terminal 不受误拦；
- Codex RPC：new materialized thread 后只发 `thread/goal/set`，不存在 `turn/start`；resume/set/clear 参数准确且不发送 tokenBudget null；
- mapper/projection：updated/cleared、六种 status、tokens/time/timestamp、malformed payload；
- lifecycle：active goal 跨多个 automatic turns 不在第一个 `turn/completed` 关闭；terminal/clear 才关闭；pause/resume failure 正确 reset；
- lifecycle kill：UI、普通 Kill、budget、shutdown 都 best-effort pause，且不受 ordinary 30 分钟总超时误杀；
- control race：active run close 时 pause/clear 降级 idle control；
- reconnect reconcile：upstream complete/cleared 只投影；paused 仅在用户 Resume 时 set active；active 重建 run但不重发 objective；
- persistence：goal cache 与 projection 水位恢复，clear 后不会由旧 snapshot/notification 复活；
- renderer reducer/parser action 的 draft 与 pending 状态。

运行与改动相关的 kernel tests，并最终跑 `npm run test:kernel`、`npm run lint`、`npm run build`。

### 6.2 Headless real Codex smoke

新增确定性、隔离 cwd 的真实 Codex scenario，显式 `--provider codex`：

1. `thread/start` 后立即 set goal，先证明 thread 已 materialize；若失败不得用空 turn fallback；
2. `/goal` 创建一个很短、可自行验证的文件任务；
3. 观察 goal updated，至少一次 provider turn，最终 complete；
4. 断言 objective/usage 投影、目标文件、session 终态；
5. 断言初始 goal set 路径没有客户端手发普通 `turn/start`；
6. 同一或独立短场景验证 pause → resume → clear；
7. 保存 transcript、events、graph-state 和 result 到 `output/acceptance/<run-id>/`。

先读失败 artifact 再修复、重跑，直到全部通过。

### 6.3 最终 UI acceptance（需要时）

该功能新增 composer command 与 progress row，完成 kernel/headless 后进行一次真实 UI smoke。严格按仓库策略创建独立 Codex Agent task（GPT 5.5 + High）操控 Chrome/Browser，当前开发 task 不直接操作 UI。

独立验收 task 必须保留截图：

- New Chat 的 `/goal` set 与 progress row；
- paused/resumed 状态；
- complete 或 cleared 状态；
- unsupported provider 的无副作用错误。

截图与验收说明放在本次 artifact 目录，并脱敏无关任务/用户信息。

## 7. Review 与提交门禁

1. 实施前：Claude Code Fable 5 对本计划做只读、单发、禁止 subagent 的评审；修订后取得 GO 共识。
2. 实施完成且自动测试通过后：按仓库 policy 使用 Claude Code Sonnet 5 的单发 `/code-review medium` 做最终轻量 code review；另可让 Fable 5 只核对“实现是否偏离计划”，但不把它当仓库规定的 code review 替代品。
3. 修复所有 P0/P1 和本次范围内的确定性问题，并重跑受影响测试；没有 P0/P1 才可提交。
4. 写 `internal_docs/commit-log/` 说明协议坑、长连接语义、验收证据并更新 index。
5. semantic commit。按仓库 policy，代码、测试注释与 commit message 不出现参考项目名称。

## 8. 请求 Fable 5 重点评审

1. 将多次 Codex automatic turns 归并为一个 looperators run 是否是当前最低成本且不破坏现有 session lifecycle 的做法？
2. New Chat 复用 deferred session 并保留 `/goal ...` 本地 user message，是否有更小且更一致的 materialization 路径？
3. active run 内直接控制 pause/clear、idle 时启动 goal control run，是否存在竞态或 close 顺序缺口？
4. restart 后不自动续跑、由用户显式 Resume/Reconnect，是否是安全且可接受的 v1 边界？
5. 是否还有会导致普通 `turn/start` 与 native goal continuation 重复启动的路径？
6. 此方案是否仍然过度工程化；哪些部分可以安全删除而不影响核心闭环？

## 9. Fable 5 首轮评审与修订

Claude Code 2.1.220 / Fable 5 以只读单发方式完成首轮评审，verdict 为 **REVISE**，同时确认以下主方向为 GO：

- automatic turns 归并为一个 looperators run；
- 复用 deferred session materialization；
- restart 后不自动续跑；
- 两个 canonical event + compact progress row 的范围足够轻。

本轮已纳入全部 P0/P1：

1. active cached goal 阻断普通 resume/activate，封住 native continuation 与客户端 `turn/start` 双启动；
2. goal run 改用 goal terminal/cleared settle，不复用单 turn promise/30 分钟总超时；
3. 所有 kill 来源统一 best-effort pause；
4. 明确整个 goal 的 lease/usage/checkpoint 粒度；
5. active close 竞态降级到 idle control；
6. 加 projection timestamp 水位；
7. Reconnect 先 get，再按 upstream status 条件化 set active；
8. 删除 bare `/goal` 的进程级 get，把附件行为固定为明确报错；
9. headless 首先验证 goal-first materialization，禁止空 turn fallback。

修订后由 Fable 5 再次只读聚焦复核，verdict 为 **GO**，无剩余 P0；其唯一边缘 P1 是 provider timestamp 与本地 clear 接收时间的双时钟水位。最终共识以两个一句话 amendment 收束：显式 get/set RPC response 直接作为 authoritative projection 并重置水位；测试显式覆盖 Reconnect 对账三分支。两项已写入 §3.2 和 §6.1，可以进入实现。

## 10. 最终实现与评审结论

实现、测试和真实验收完成后，Sonnet 标准 `/code-review medium` 共识别并推动修复了以下确定性问题：

- paused/limited/error/complete 终态的残留 activity 收口，且 complete 不误标失败；
- blocked/limited 状态的 Resume UI；
- reconnect 的 complete/cleared/active/limited 分支与串行 control；
- kill pause 失败时保留 active cache、写 recovery diagnostic，并继续阻断普通 turn；
- malformed `thread/goal/get|set` 响应 fail-closed，禁止无权威状态的静默 mutation/success；
- persisted goal/watermark 的 defensive recovery 与诊断。

最终 Fable 5 聚焦复核 verdict 为 **GO**，明确无 P0/P1；Sonnet 对最后两项协议防御修复的复核为 **CLEAN**。实现仍保持 Codex-only、小型共享契约、单一 progress row、无本地 autonomous loop、无数据库 migration，未偏离轻量方案。
