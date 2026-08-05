# looperators Codex Agent Loop：localhost-first 轻量 Plugin 计划

- 日期：2026-08-02
- 分支：`codex/looperators-agent-loop-p1-data-root-fix`
- 状态：实施完成；Gate A / Gate B 均为 `GO`
- 目标：把当前研究型 P1 收敛为普通用户可安装、以右侧 live review surface 为主的轻量 Plugin

## 1. 已确认的产品决策

以下是本计划的约束，不在实施中重新讨论或自行改变：

1. **localhost sidecar 是主产品 surface，不是 fallback。** looperators 是重图、实时、
   可交互功能；主要验收对象是 Codex Desktop 右侧 Browser 中的 live graph。
2. **默认 Plugin 不携带 Hooks。** 普通安装不能要求用户信任
   `SessionStart`、`PreToolUse`、`PostToolUse`、`SubagentStart`、`SubagentStop`、`Stop`
   等命令 hooks。
3. **默认模式是 cooperative governance。** Governor 与 worker 通过 Skill 和 typed MCP
   遵守协议；默认模式不宣称可以强制阻止任意 Agent 结束，也不宣称能观察每个原生
   tool/subagent lifecycle event。
4. **Hooks 只可能成为未来单独安装的 advanced governance mode。** 本计划不实现该
   模式，也不允许它阻塞默认模式。
5. **Inline 退出核心路径。** 本计划不再以 `::codex-inline-vis` 为完成标准，不继续修补
   inline host。已有 inline 实现只在 localhost 主路径通过后再决定删除或保留为可选
   静态摘要。
6. **右侧 surface 的准确名称是 Codex 内置 Browser 中的 localhost Web App。** 当前
   没有把第三方原生 Artifact 创建能力当作公开稳定依赖；可靠基线是返回可点击 URL，
   并在能力可用时帮助用户在右侧打开。
7. **looperators Desktop 现有图 UI 是视觉与交互的权威来源。** localhost surface
   禁止从零重做一套“相似的图”。必须先从 Desktop 现有实现抽取可移植组件和交互原语，
   Plugin 只提供 projection adapter、控制 callback 和 host glue。

### 1.1 Desktop UI 复用边界

当前 `@looperators/agent-graph-ui` 是一次简化抽取：它保留 ReactFlow、节点/边选择、
zoom/fit 和基础详情，但没有完整复用 Desktop 的图产品。以下 Desktop 模块是本次抽取
的 authority baseline：

```text
src/components/session-graph-panel.tsx
src/components/canvas.tsx
src/components/loop-panel.tsx
src/components/relationship-inspector-panel.tsx
src/hooks/use-canvas.ts
src/lib/graph-view.ts
```

应最大力度直接复用或提取到共享 package：

- ReactFlow canvas shell、Background、Controls、MiniMap、pan/zoom/fit；
- Agent node 的角色、provider/model、状态、报告/verdict、选中与 activity 视觉；
- relationship edge 的 routing、label、active/recent/pending 状态和选择交互；
- node/edge/pane selection 与 keyboard focus；
- Relationship inspector 的 from/when/then/gate/firing/stop condition 结构；
- Loop panel 的 lap、当前责任角色、latest verdict、blocking issues、recovery、timeline、
  stop confirmation 与终止原因；
- light/dark theme tokens、responsive layout 和 presentation-level node dragging。

只有依赖 Desktop runtime authority 的行为允许通过 adapter 替换：

- `runtimeApi` mutation；
- 打开 Desktop chat、diff、provider settings 或 workflow builder；
- 新建/连接任意 Agent、修改通用拓扑、freeze cluster；
- Desktop 持久化 node position。

这些行为不得在共享组件内部硬编码。共享组件暴露 typed callbacks 和 capability flags：
Plugin sidecar 有等价 authority 时接入；没有 authority 时明确隐藏/禁用并解释，不创建
假的本地行为。节点拖拽可以作为当前 Browser session 的 presentation state，但不能
改写 authoritative loop projection。

实施顺序仍遵守此前约定：

1. 从 Desktop 现有实现抽取/扩充共享组件并独立验收；
2. Plugin localhost surface 使用共享组件并完成 Gate A / Gate B；
3. Plugin 验收通过前，不修改 Desktop 的 import；Desktop 后续切换到共享 package 是
   单独工作，不阻塞本次 Plugin 交付。

## 2. 为什么改线

当前 P1 已证明 typed report、有限 loop、projection、共享图组件、sidecar 安全边界和
真实 subagents 都能工作，但它作为普通用户 Plugin 是 **NO-GO**：

- 七个默认 Hooks 带来项目/定义信任、hash 变化后重新信任和跨版本字段耦合；
- Hook readiness、native agent identity binding、prepare/poll/bind 与 continuation
  governor 把核心流程变成一条脆弱的宿主生命周期链；
- Plugin source、安装 cache、已启动 MCP process 和 task capability 可能同时处于不同
  版本；
- inline 是非公开宿主协议上的只读快照，却占用了大量兼容与验收成本；
- 当前 Plugin 暴露 15 个 MCP tools，包含 probe、legacy recovery、worker binding 和
  inline render，普通 Agent 很难稳定选择正确路径。

现有成果并非全部推倒重来。继续复用：

- versioned store、canonical JSON、projection digest 与 typed report schema；
- `@looperators/agent-graph-ui` 的 package/build/test 基础，并用 Desktop authority
  baseline 补齐其节点、边、inspector、loop panel 和交互，而不是保留当前简化版作为
  最终设计；
- sidecar 已有的 `127.0.0.1`、随机 secret、HttpOnly cookie、Host/Origin 校验、CSP、
  bounded SSE、watcher 和 backpressure；
- preview/start/report/pause/resume/cancel 的领域语义。

## 3. 目标架构

```text
Codex root task (Governor)
  │
  ├─ Skill：规定 cooperative review-until-clean 流程
  ├─ typed MCP：唯一 mutation/query 接口
  │    ├─ preview/start/report/control
  │    ├─ durable store + verified projection
  │    └─ review-surface lifecycle manager
  │
  ├─ native implementer/reviewer subagents
  │    └─ role-scoped capability → typed report
  │
  └─ http://127.0.0.1:<random>/runs/<run-id>
       ├─ Desktop-derived full ReactFlow graph
       ├─ live SSE projection
       └─ authenticated pause/resume/cancel intents
```

核心 authority 规则：

- store 和 typed MCP 是业务事实源；Browser UI 不从 transcript 推断状态；
- sidecar 只展示 verified projection，mutation 复用与 MCP 相同的 controller；
- UI 不直接调用 Codex collaboration tools，也不伪装成能唤醒或强制终止原生 Agent；
- native `agent_id` 不再是默认模式的授权基础；默认模式使用 role/run/transition-scoped
  capability，store 只保存 capability digest；
- lap cap 在 typed report transition 中结算，不依赖 `Stop`/`SubagentStop` hook；
- pause/cancel 对 looperators 状态和后续 report/transition 立即生效，但不能强杀已经运行
  的 Codex worker。Governor 在每次 worker 返回后重新读取 authoritative state，禁止继续
  调度已暂停或取消的 run；
- 每个 pending action 使用随机 opaque capability；共享 data root 只保存 SHA-256 digest
  与 run/role/transition/revision 身份，不保存明文。这样 root 与原生 worker 各自的 MCP
  进程可以跨进程验证同一个 action。Governor MCP 重启后，root `get_loop` 会旋转当前
  token；因此 Governor 不得在 worker in-flight 时轮询 `get_loop`。该恢复路径不依赖
  `SessionStart`、Hooks 或 transcript。

## 4. 用户旅程

### 4.1 Preview

1. 用户选择 looperators Plugin 并请求 `review-until-clean`。
2. Governor 调用 `looperators_preview_loop`；只创建 draft，不启动 subagent。
3. MCP 同时确保 review surface 已启动，并返回一个短摘要和一次性登录 URL。
4. 用户点击 URL，在右侧 Browser 看到 draft 图、角色、lap cap 和待确认状态。

### 4.2 Confirm and run

1. 用户在 task 中明确确认；Governor 调用 `looperators_start_loop`。
2. start 返回 authoritative `nextAction` 和 implementer 的 role-scoped report capability。
3. Governor 创建原生 implementer，把 bounded work packet 与 capability 交给 worker。
4. implementer 调用 `looperators_report(done)`；controller 原子消费当前 transition，激活
   reviewer 并签发 reviewer capability。
5. reviewer 调用 `looperators_report(issues|clean)`：
   - `issues` 且未到 cap：产生下一次 implementer action；
   - `clean`：进入 `succeeded`；
   - `issues` 且到 cap：进入 `capped`，不再签发 worker action。
6. 每次 report/control 后，sidecar 通过 SSE 更新同一张图。

### 4.3 Sidecar controls

- `pause`：立即把 run 设为 paused，拒绝 report 和新的 worker action；in-flight worker
  可能仍会返回，但其 report 会明确失败。UI 必须显示这一限制。普通 resume 后，尚未
  被 root recovery read 旋转的当前 capability 可继续使用。
- `cancel`：立即终止 looperators run，后续 report 明确失败且不得重新激活角色。
- `resume`：恢复 durable run 状态。普通 pause/resume 不旋转未消费 capability；Governor
  MCP 重启后的 root `get_loop` 必须旋转并返回新 capability。localhost 页面不能主动
  唤醒 Codex task；UI 显示“已恢复，返回 task
  继续”，并提供可复制的短 follow-up。
- `start`：仍要求在 Codex task 中明确确认；sidecar 不绕过对话中的确认门。

## 5. MCP surface 收敛

默认用户可见 tools 收敛为：

```text
looperators_preview_loop
looperators_start_loop
looperators_report
looperators_get_loop
looperators_get_snapshot
looperators_pause_loop
looperators_resume_loop
looperators_cancel_loop
looperators_open_review_surface
looperators_close_review_surface
```

从默认 MCP tool list 移除：

- identity/shared-root probes；
- prepare worker spawn、poll observed worker、native agent bind；
- inline render；
- unpublished-version legacy recovery/quarantine。

开发 probe 可以保留在测试目录，但不能继续污染普通 Agent 的 tool selection。

`start`/`report` 协议调整：

- `start` 不再读取 `UserPromptSubmit` hook readiness；显式 user confirmation 由 Skill 与
  Governor 当前 turn 负责；
- capability 至少绑定 `runId + role + pendingTransitionId + action revision`；
- mutation 继续要求 stable `requestId`，重复调用返回同一结果；
- report token 只返回一次或按当前 action 重新签发，durable store 只保存 digest；
- cancel、cap 和 terminal state 立即拒绝全部未消费 capability；旧 capability report
  返回 bounded error 且不改变 run。pause 期间 report 同样被拒绝；普通 resume 后当前
  token 仍可使用，Governor restart recovery read 则旋转 token；
- 默认模式接受“持有 capability 即代表该 role”的安全模型，并在文档中明确 root 理论上
  也能代 worker 调用 report；这不是强身份证明。

## 6. Localhost review surface 产品化

当前 `scripts/sidecar-server.mjs` 从 developer script 升级为 MCP 管理的 product service：

1. MCP process 内维护一个 idempotent sidecar manager；同一进程只启动一个
   `127.0.0.1` listener，多个 run 使用稳定路由 `/runs/<run-id>`。
2. 端口由 OS 随机分配；每次 `open` 签发短时、一次性 login ticket，兑换为独立
   `HttpOnly; SameSite=Strict` session cookie。每个 browser session 只授权 ticket
   指定的 run，cookie path 绑定 `/runs/<run-id>`；不能枚举或读取同一 MCP process 的
   其他 run。ticket 不写 store、不进日志。
3. 保留 exact Host/Origin、CSP、no-store、nosniff、no-referrer、client/backpressure
   上限；所有 mutation 只接受 authenticated same-origin POST，并要求 idempotent
   `requestId` 与 CSRF token。
4. SSE 继续传 verified projection + digest；重连使用 `Last-Event-ID`，projection 不一致
   时全量重发。
5. 页面使用从 Desktop authority baseline 抽取的完整
   `@looperators/agent-graph-ui` ReactFlow bundle，不使用 inline 专用 DOM/SVG
   renderer，也不另写 Plugin-only node/edge/inspector。
6. 开发时可以使用独立 Vite dev server/HMR；分发时 sidecar 提供静态 production
   bundle，业务更新协议只能是 typed store + SSE，不能把 Vite HMR 当产品协议。
7. MCP process 退出时 listener 干净关闭；进程重启后 `open` 返回新 URL。旧 Browser
   页面必须显示断线状态，而不是假装仍然 live。已消费、过期或属于旧进程的 ticket
   返回安全的失效页：“会话已失效，请回到 task 重新打开”，不得只显示裸 401，也不得
   泄露 run、token 或本地路径。

借鉴 Lottie 的是：稳定资源路由、文件/状态事实源、live preview、浏览器与 Agent 都能
观察当前状态。不会照搬它的未鉴权 dev server、Vite HMR 产品依赖、shell/npm 启动或
通用文件删除接口。

## 7. 实施顺序：一个交付，两个 Gate

本计划不拆成大量独立阶段。所有代码工作围绕一个交付版本完成，只设置两个必须关闭的
验收 Gate。

### Gate A：source-level lean loop + live surface

实施：

- 先建立 Desktop → shared package 的 interaction parity matrix；逐项标记 direct reuse、
  host adapter 或明确不适用，禁止用新做的简化替代品冒充复用。matrix 是 Gate A 必交
  artifact；每项必须链接 Desktop authority 源文件并说明分类理由，“不适用”不能只写
  结论；
- 从 Desktop authority baseline 抽取 canvas/node/edge/relationship inspector/loop panel
  和交互原语，保持 portable props + typed callbacks；独立 package build、dev server 和
  browser interaction tests 通过后，Plugin 才能接入；
- 从默认 Plugin 分发物中物理移除 hooks 声明；不能只加 runtime flag；
- 把 Hook/native-agent binding 改为 role capability 协议；
- 收敛 MCP tool list 和 `review-until-clean` Skill；
- 将 sidecar manager 接入 MCP，完成稳定 run route、ticket/session、SSE 和 controls；
- Plugin sidecar 改用完整 ReactFlow graph；inline 不进入该 Gate；
- 保留 store/projection 数据的版本化与幂等性，必要时为开发中 schema 直接升版，不做
  未发布版本兼容层。

自动验收：

- **Shared package 独立 checkpoint（先于 Plugin import）**：package build、dev server、
  production bundle 与 parity matrix 中所有 direct reuse/adapter interaction tests 全绿，
  保存 matrix、机器可读结果和关键截图；未通过时 Plugin 禁止 import 新组件；
- Plugin manifest/安装内容中没有默认 hooks；全新 task 不出现 hooks trust UI；
- preview 自动返回 review URL，且不启动 subagent；
- role capability 的合法、错误角色、错误 transition、重复、过期和泄漏日志检查通过；
- real root + implementer + reviewer 完成 `done → issues → done → clean`；
- cap、pause、resume、cancel、被拒绝的 late report 和 MCP restart recovery 通过；
- Browser production bundle 显示三节点四关系，并通过 Desktop parity matrix 中适用的
  selection、keyboard、pan/zoom/fit、MiniMap、node drag、relationship inspector、
  loop/lap/issues/recovery/timeline/details；
- Plugin bundle 不包含第二套 Plugin-only node/edge/inspector/loop panel 实现；
- SSE 实时更新 status/lap/active edge/report；断线和重连状态准确；
- sidecar 只监听 `127.0.0.1`，未认证、错误 Host/Origin、CSRF、重复 control 和慢客户端
  测试通过；
- 一个 browser session 只能访问其 ticket 指定的 run；跨 run 请求与 cookie 复用被拒绝；
- 已消费、过期、旧进程 ticket 显示明确失效页；
- ordinary Codex task 不触发 looperators 命令、不写 store、不出现 hook failure。

Gate A 失败时不安装到用户 Personal Plugins，不请求 Desktop reload。

### Gate B：fresh-install + Desktop right-side acceptance

前置：Gate A 全部通过，source cleanly packaged。

验收：

1. 临时 `CODEX_HOME` 执行 isolated plugin install，安装包中无 hooks、无重复 Plugin、
   source/cache digest 一致；
2. 最小环境启动 MCP，验证 data root、Node runtime prerequisite 和清晰失败信息；
3. fresh headless Codex task 只使用 Plugin typed tools 跑通真实 cooperative loop；
4. 更新当前 Personal Plugin 前先核对已安装版本/cache/process，不通过连续 reload 猜测；
5. 如运行中 Desktop registry 无法加载新分发物，只在所有自动 Gate 完成后请求一次 reload；
6. 新 Desktop root task 创建 preview，用户通过点击 URL 或手动把 URL 打开到 Codex 内置
   Browser，右侧显示 live graph。宿主把普通点击路由到外部浏览器不归因于 Plugin
   failure，但 Gate B 仍未通过；只有“Codex 内置 Browser 无法呈现该 localhost 页面”
   才判定 Plugin surface NO-GO；
7. 公开验收截图只保留裁剪或脱敏后的右侧 Browser surface，必须显示三节点关系图；
   pause/cancel 至少验证一个真实控制 round-trip；不得提交无关 task、用户或系统元数据；
8. Inline 不属于 Gate B，不得因 inline 未渲染而判定本版本失败。

Gate B 完成后，才清理默认 Plugin 中已经没有调用者的 hook/inline/legacy 实现与测试；
清理必须单独验证，不与首次 live surface 跑通混在一起。

## 8. 测试层级

### 每次改动

- contracts/store/controller unit tests；
- sidecar HTTP/security/SSE tests；
- shared graph model/component tests，以及 Desktop interaction parity regression；
- MCP protocol tests；
- schema validation、syntax、lint、`git diff --check`。

### Gate A 验收

- production sidecar bundle browser automation；
- isolated data root 下的真实 typed MCP server；
- 真实 Codex root + 两个 native subagents；
- restart/cap/cancel 故障旅程。

### Gate B 最终验收

- isolated install；
- fresh Desktop task；
- 右侧 Browser live graph 与一次 interactive control；
- 裁剪或脱敏后的右侧 Browser surface 截图。

不使用 transcript tail 作为协议或通过依据。原始 prompt、完整 worker transcript、token、
cookie 和 capability 不写入仓库 artifacts。

## 9. 明确风险与非承诺

### 9.1 无 Hooks 的能力代价

默认模式不能保证：

- 拦截任意 root/worker 的 Stop；
- 观察全部工具调用或 native subagent lifecycle；
- 把 native `agent_id` 强绑定到 logical role；
- 强杀已经在运行的 Codex worker；
- 在用户只操作 sidecar 时主动唤醒空闲 Codex task。

这些限制必须出现在 README 和 UI 状态文案中，不能只藏在内部文档。

### 9.2 Browser 打开方式

支持目标是：返回明确可点击 URL，并在当前 Codex capability 可用时协助打开到右侧
Browser。Plugin 不承诺第三方原生 Artifact API，也不把自动打开作为数据正确性的
前提。

### 9.3 Node runtime

当前 `.mcp.json` 以 `node ./mcp/server.mjs` 启动。Codex Plugin 安装本身不等于目标
机器一定具备可用 Node。Gate B 必须记录真实 prerequisite 行为；在对外发布前，必须
二选一：

1. 未来分发自包含、签名/校验的跨平台 runtime；或
2. 把 Node 版本作为明确 prerequisite，并提供安装前检查与可操作错误。

这不是 sidecar 架构问题，但它是普通用户“一次安装成功”的独立 release gate，不能
继续隐去。本交付只验证当前 macOS/Node 环境的 prerequisite 与清晰错误，不设计跨平台
runtime 打包/签名；后者进入对外发布前的独立 release plan。本交付不冒充已经完成
跨平台分发。

## 10. 预计修改边界

主要修改：

```text
plugins/looperators-agent-loop/.codex-plugin/plugin.json
plugins/looperators-agent-loop/hooks/**          # 从默认分发移除
plugins/looperators-agent-loop/lib/control.mjs
plugins/looperators-agent-loop/lib/store.mjs
plugins/looperators-agent-loop/lib/projection.mjs
plugins/looperators-agent-loop/lib/identity.mjs   # 收缩为 role capability
plugins/looperators-agent-loop/mcp/server.mjs
plugins/looperators-agent-loop/scripts/sidecar-server.mjs
plugins/looperators-agent-loop/skills/review-until-clean/**
plugins/looperators-agent-loop/ui/**
plugins/looperators-agent-loop/tests/**
packages/agent-graph-ui/**                       # 按 §1.1 parity matrix 抽取/扩充；不以 sidecar 当前最小需求为上限
internal_docs/**
```

Plugin Gate A / Gate B 期间不修改：

```text
electron/**
src/components/session-graph-panel.tsx
src/components/canvas.tsx
src/components/loop-panel.tsx
src/components/relationship-inspector-panel.tsx
src/hooks/use-canvas.ts
src/lib/graph-view.ts
shared/graph-state.ts
plugins/looperators-agent-loop-p0/**
/Users/observedobserver/Documents/GitHub/lottie/**
```

Desktop authority files 在本计划中只作为权威来源；把可移植实现提取/复制到 shared
package，但不修改 Desktop import 或 Desktop 行为。这会产生一段有意、短期的重复代码。
只有 Plugin 完成 Gate B 后，才另行把 Desktop import 切到已验收的 shared package 并
删除重复实现。

不移植 Desktop sessionManager/workflowKernel/provider adapters，不迁移 package manager，
不开发 MCP App iframe，不创建通用 Canvas editor。

## 11. 完成定义

本版本只有在以下结果同时成立时才是 GO：

1. 新用户默认安装不出现 looperators Hooks 信任流程；
2. fresh task 可以 preview，并在右侧 Browser 打开受保护的 live graph；
3. root + implementer + reviewer 通过 typed MCP 完成至少一次 issues→clean；
4. cap、pause、cancel 和 restart 不会产生新的错误 transition；
5. UI 实时反映 verified projection，并至少完成一次 interactive control；
6. 普通非 looperators task 零 hook、零写入、零干扰；
7. 裁剪或脱敏后的 Browser surface 截图证明右侧图真实显示；
8. README 清楚说明 cooperative mode 的能力代价、Browser 打开方式和 runtime prerequisite。
9. Desktop interaction parity matrix 中所有适用于 fixed review loop 的项目均由共享
   package 提供；Plugin 没有并行维护第二套图组件。

若第 2、3 或 7 项失败，本版本 NO-GO；不得用 inline、普通浏览器静态 HTML、mock graph
或单元测试代替。

Gate B 后只决定 inline 代码是删除还是保留为可选静态摘要；本计划不实现新的 inline
能力，也不重新打开 inline host 兼容工作。

## 12. Fable 5 评审问题

请只评审以下高价值问题，不扩展到 Desktop UI、MCP App、Yarn、通用 Canvas 或未来
advanced Hooks 实现：

1. 默认无 Hooks 后，role capability + typed transition 是否足以形成诚实、可恢复的
   cooperative loop；是否有被忽略的 authority 混淆？
2. MCP-owned sidecar manager、一次性 ticket、cookie、CSRF、SSE 与 control mutation
   的边界是否足够安全和可测试？
3. 两个 Gate 是否聚焦核心交付，是否仍混入会分散注意力的工作？
4. 哪些现有模块应直接复用，哪些必须从默认分发物中物理移除？
5. Node runtime、Browser 无法唤醒 task、不能强停 in-flight worker 是否已被足够明确地
   表达为 release/product boundary？

## 13. Fable 5 评审与最终共识

- Claude Code：`2.1.218`
- 模型：`claude-fable-5`
- 模式：只读 `Read`，无 Bash/edit/web/subagent
- verdict：`GO_WITH_AMENDMENTS`
- blocking：无
- scope drift：无新增实现范围；明确阻止重新实现 inline 和在本交付设计跨平台 runtime
- accepted amendments：
  1. 初始建议由 MCP/action epoch 接管无 Hook 的 interrupted recovery；
  2. 固定 pause/cancel/cap/restart 下的 capability 失效语义；
  3. browser session cookie 绑定单个 run；
  4. 区分“点击被宿主路由到外部浏览器”和“内置 Browser 无法呈现页面”；
  5. 为已消费、过期和旧进程 ticket 提供明确安全失效页。

评审证据：
[fable-5-plan-review.json](../experiments/artifacts/2026-08-02-codex-desktop-agent-loop-localhost-first/fable-5-plan-review.json)。

Gate A 真实原生 subagent 验收随后证明：root 与 worker 使用不同 MCP 进程，进程内签名
epoch 会误拒绝合法 worker report。实现因此改为“opaque token + shared digest”，并用
三真实 MCP 进程、Governor restart rotation 和真实 issues→clean loop 重新验收。该修订
保持 Fable 要求的失效语义，但移除了不成立的同进程假设。

修订后由 Fable 5 再次只读复核，最终 verdict 为 **GO**：五项 amendment 均已在规范
层面关闭，无 blocker、无新增 scope drift。双方共识是：按当前计划开始实施，只使用
Gate A / Gate B 两个验收门；不得在实施中重新加入 inline、默认 Hooks、Desktop 改造
或跨平台 runtime 打包。

2026-08-02 用户进一步明确：localhost 图必须最大力度复用最早的 looperators Desktop
图组件和交互，不能把当前简化的 shared graph 当成最终设计。本约束已补入 §1.1、§2、
§6、Gate A 和 DoD。Fable 5 聚焦复核先给出两项措辞修订：shared package 的范围不得
被 sidecar 当前最小需求限制；parity matrix 必须是带 Desktop 源文件与分类理由的 Gate A
artifact，并在 Plugin import 前设置独立 checkpoint。两项均已合入，最终复核为 **GO**，
无 blocker。

## 14. 实施检查点

### Checkpoint 1：Desktop 图交互抽取（完成）

- commit：`b524f481 feat: extract desktop agent graph interactions`
- shared package build、unit test、dev/prod browser acceptance 均通过；
- production embed 显示 3 个节点、4 条边，无 console error/warning、无外部资源请求；
- Desktop authority 源文件保持不变，Plugin 验收前不切换 Desktop import。

### Checkpoint 2：无 Hooks cooperative typed MCP（完成）

- 默认 Plugin 不再携带 `hooks/hooks.json`、hook collector 或 hook readiness gate；
- 默认 MCP surface 收敛为 preview/start/pause/resume/cancel/report/get loop/get snapshot；
- start 返回绑定当前 pending action 的短期 role capability，明文 token 不持久化；
- wrong-role、stale-action 和 cancel/terminal token 均拒绝；
- pause/resume、cancel、restart rotation、跨 MCP 进程 report、并发 report、幂等重试和
  lap cap 均有自动化覆盖；
- 验证记录：
  [cooperative-mcp-checkpoint.md](../experiments/artifacts/2026-08-02-codex-desktop-agent-loop-localhost-first/cooperative-mcp-checkpoint.md)。

下一检查点只做 MCP-owned localhost live review surface，不恢复 inline 或默认 Hooks。

### Checkpoint 3：MCP-owned localhost live review surface（完成）

- MCP 新增 open/close review surface 两个 typed product tools；
- 每个 run 使用 `127.0.0.1` 随机端口、短期一次性 ticket、HttpOnly/SameSite/run-scoped
  cookie、同源 + CSRF control；
- 页面直接打包 shared Desktop-derived ReactFlow 组件，不维护第二套 Plugin graph；
- verified projection 通过 SSE 更新，pause/resume/cancel 写回同一个 typed store；
- MCP stdio 集成测试验证 open、ticket redemption、page load、pause/resume、close；
- Playwright 真实浏览器验证 3 节点、4 关系、node selection、pause→SSE paused、
  resume→SSE running，console 0 error / 0 warning；
- 验证记录：
  [localhost-sidecar-checkpoint.md](../experiments/artifacts/2026-08-02-codex-desktop-agent-loop-localhost-first/localhost-sidecar-checkpoint.md)。

下一步进入 Gate A 的真实 root + implementer + reviewer loop。Codex Desktop 右侧 Browser
隐私安全的 Browser surface 截图与 isolated fresh install 仍属于 Gate B，不能由本
checkpoint 代替。

### Checkpoint 4：Gate A 真实 native-agent loop（完成）

- 首次真实 run 发现并修复跨 MCP 进程 capability bug；进程内 HMAC/epoch 改为 opaque token
  + durable digest，明文仍不落盘；
- 三个真实 stdio MCP 进程分别承担 Governor/implementer/reviewer，typed report 通过；
- 新 Governor MCP 进程会旋转当前 token，旧 token 被拒绝；
- Desktop-bundled headless Codex 创建恰好一个 implementer 和一个 reviewer，并复用两者跑通
  `done → issues → done → clean`，revision 5、lap 1、terminal `succeeded`、2/2 tests；
- 全程未加载默认 Hooks、未使用 Personal Plugin、未 reload Desktop、未用 Node 脚本模拟
  协议；
- 验证记录：
  [gate-a-real-loop.md](../experiments/artifacts/2026-08-02-codex-desktop-agent-loop-localhost-first/gate-a-real-loop.md) / [gate-a-real-loop.json](../experiments/artifacts/2026-08-02-codex-desktop-agent-loop-localhost-first/gate-a-real-loop.json)。

下一步只进入 Gate B：重新执行 isolated install probe，然后更新 Personal Plugin；只有自动
安装、版本/cache/digest 核对完成后才允许一次 Desktop reload 与右侧 Browser 验收截图。

Gate B isolated preflight 已通过：Desktop-bundled Codex `0.146.0-alpha.9.2` 在临时
`CODEX_HOME` 中安装 `0.3.2+codex.20260803073424`，只出现一个 looperators record，87 个
文件，source/cache digest 同为
`59b77135857193515340769cc46129748e35c24379b14d8e9067490f2740cb15`。临时 HOME 已清理，
未修改全局配置。证据：
[isolated-install.json](../experiments/artifacts/2026-08-02-codex-desktop-agent-loop-localhost-first/isolated-install.json)。

### Checkpoint 5：Gate B Desktop right Browser（完成）

- Personal Plugin 最终加载版本：`0.3.2+codex.20260803073424`；Desktop 插件详情显示
  1 个 MCP server、1 个启用 Skill、无默认 Hooks；
- fresh Desktop task 使用 typed MCP 跑通真实只读 loop：恰好一个 implementer 与一个
  reviewer，reviewer 返回 `clean`，run 进入 `succeeded`；
- 成功 run：
  `run_6fc56d7d04232a324a59cd132a18b8246db045adc291eb3a2540f8746f9f22cc`，
  projection digest：
  `bef9a9a2541d8c3a60dde9bc3170010dbdf4d8e38aa3870564a3cae385e3ef16`；
- Codex 内置 Browser 的 DOM 与实际截图均确认 `verified / succeeded / live`，并显示
  Governor、Implementer、Reviewer 三节点、governs/handoff/feedback/verdict 四关系、
  ReactFlow Controls 与 MiniMap；
- 独立 control run 从右侧 localhost UI 点击唯一 `Request pause` 按钮；DOM 与
  `looperators_get_loop` 均确认 `paused`。该 run 未创建 subagent、未提交 worker report；
- 公开证据保留裁剪后的右侧 Browser live graph，不包含无关 Codex task、用户或系统元数据；
- 安装调试确认：外部 CLI 更新不会热刷新已启动 task 的 dynamic tool registry。可靠开发
  路径是安装后打开本地 marketplace 的 Plugin detail，确认目标 version/MCP/Skill，再创建
  fresh task。一次性 review ticket 只能导航一次；重复打开应显示安全失效页。

证据：

- [Gate B 记录](../experiments/artifacts/2026-08-02-codex-desktop-agent-loop-localhost-first/gate-b-desktop.md)
- [机器可读结果](../experiments/artifacts/2026-08-02-codex-desktop-agent-loop-localhost-first/gate-b-desktop.json)
- [右侧 Browser 页面截图](../experiments/artifacts/2026-08-02-codex-desktop-agent-loop-localhost-first/gate-b-desktop-right-browser.png)
