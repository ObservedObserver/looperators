# Internal Commit Log 索引

- [2026-08-10 · Agent Chat native thread goals](./2026-08-10-agent-chat-native-thread-goals.md)
  —— 记录 Codex-only `/goal` 生命周期、禁止额外 turn/start、秒级 timestamp 水位、pause activity
  终结 transport，以及真实 headless 与独立 Browser 截图验收闭环。
- [2026-08-08 · Agent Session Fork](./2026-08-08-agent-session-fork.md)
  —— 记录 Assistant action toolbar、idle conversation mirror、Claude/Codex 原生 lazy fork、
  Provider turn identity、worktree/历史边界，以及三轮真实 UI 验收中的协议修复。
- [2026-08-06 · Agent Provider Discovery & Settings P1](./2026-08-06-agent-provider-discovery-settings-p1.md)
  —— 记录 durable sanitized readiness snapshot、TTL/profile/cwd invalidation、多个同类 Provider
  profile、New Chat 精确 scope gate、安全诊断、Grok 显式 force 与独立 review/UI/真实 provider 验收。
- [2026-08-06 · Agent Provider Discovery & Settings P0](./2026-08-06-agent-provider-discovery-settings-p0.md)
  —— 记录有界 login-shell/launchctl PATH 恢复、单一 Provider launch resolver、Codex/Claude
  语义 readiness、Agents settings、New Chat 修复入口，以及独立 review/UI/真实 provider 验收。
- [2026-07-30 · Codex inline visualization 调试复盘](./2026-07-30-codex-inline-visualization-debugging-retrospective.md)
  —— 总结 Plugin 安装/能力绑定、data root、artifact 协议、inline host runtime
  与验收证据为何被混为一个问题，以及最终 framework-free SVG/DOM 解法和后续
  Plugin 排障清单。
- [2026-07-28 · Codex Desktop Agent Loop P1 data-root closure](./2026-07-28-codex-desktop-agent-loop-p1-data-root-closure.md)
  —— 记录 platform-owned shared root、ordinary-task hook 静默隔离、
  0.2.1 isolated/real install identity，以及开发版本不做 hot-upgrade 兼容的边界。
- [2026-07-26 · Codex Desktop Agent Loop P1-E release candidate](./2026-07-26-codex-desktop-agent-loop-p1-e-release-candidate.md)
  —— 记录 exact legacy recovery、immutable quarantine receipt、
  graph-projection-v3、temporary 0.2.0 install identity、bundled-Codex
  0→7 native journey 与用户 Desktop manual gate。
- [2026-07-26 · Codex Desktop Agent Loop P1-D native graph](./2026-07-26-codex-desktop-agent-loop-p1-d-native-graph.md)
  —— 记录 authoritative graph-projection-v2、root-only MCP snapshot、
  task-scoped inline graph、token-protected loopback sidecar 与 cross-surface
  canonical digest gate。
- [2026-07-26 · Codex Desktop Agent Loop P1-C continuation governor](./2026-07-26-codex-desktop-agent-loop-p1-c-continuation-governor.md)
  —— 记录 finite Stop/SubagentStop continuation、receipt-chain recovery、
  stable logical-role targets、真实 persisted resume 与四轮独立 gate。
- [2026-07-26 · Codex Desktop Agent Loop P1-B control plane](./2026-07-26-codex-desktop-agent-loop-p1-b-control-plane.md)
  —— 记录 preview/control、prepare-spawn identity barrier、typed report、
  facts→receipt→CAS、真实 native workers 与 P1-C 门禁。
- [2026-07-26 · Codex Desktop Agent Loop P1-A 数据平面](./2026-07-26-codex-desktop-agent-loop-p1-a-data-plane.md)
  —— 记录正式候选 plugin、共享 data root、versioned contracts、immutable store、
  MCP identity gate、capability-token fallback、并发/恢复边界和 P1-B 约束。
- [2026-07-23 · Agent Session 流式卡顿根因与系统性修复](./2026-07-23-agent-session-streaming-performance.md) —— 记录从 renderer 误判、失真 browser mock 到真实 Electron/SQLite 测量的完整分析链；解释 2026-07-10 旧优化为何只缓解局部，并归档 hot-state 压缩、异步日志、轻量 command result、顺序安全 batching、per-session store、canvas view-state 边界及真实 `npm run dev` 验收。
- [2026-07-22 · Session Manager 解压重构集成（PR #10）](./2026-07-22-session-manager-decompression-integration.md) —— 在最新 main 上先合 PR #12、再以语义 owner 方式迁移 PR #10；保留 native auto 与默认并行策略，并记录 Codex 21 场真实验收、跨 provider Reviewer 修复、周期触发活锁约束和 PR #13 的后续重取边界。
- [2026-07-03 · Kernel G4：渲染层（意图边 + 内核时间线）](./2026-07-03-kernel-g4-rendering.md) —— 订阅意图边为画布主结构（gate/firings/until 徽章、pending 脉冲、cluster 锚点降级）、Kernel timeline 面板（actor 徽章 + reason，tail 取最新、SSE 增量）、auto 放行带 reason；真实 Haiku live loop 的画布验收逐条达成；G0–G4 全部完成。
- [2026-07-03 · Kernel G3：订阅 + gate + coalesce + 静态检查](./2026-07-03-kernel-g3-subscriptions.md) —— 意图层落地：graph state v7 订阅/槽位第一类对象、调度器接线（graph-core evaluate）、gate 三流（auto/master/human，授权按 R1 实时重算）、hero loop 迁移为 preset 编译的 S1/S2（旧状态机删除，iterations=S2.firings）；真实验收剥出三层问题（SDK membrane 权限豁免、SDK allow 结果缺 updatedInput 的全局潜伏缺陷、廉价模型提示词优先级），§12.5 事件链逐 seq 对齐通过。
- [2026-07-02 · Kernel G2：Context Channel（数据面）](./2026-07-02-kernel-g2-context-channel.md) —— per-session inbox + manifest + topic 取代 + 确定性激活前导；`deliver`/`activate` 新命令与膜工具，`resume` 变组合动词，create 预置 channel；内核事件 `activated`/`delivered` 落地；含 channel 读权限挂死的定位与修复（provider allowlist + controller 初始化时序 + realpath）、Codex 交叉 review 记录、§8.1 真实验收证据链。
- [2026-07-02 · Kernel G1：graph-core 纯逻辑包](./2026-07-02-kernel-g1-graph-core.md) —— `shared/graph-core/`：fold（State=fold(Log)）、LCA 治理路由 R1/R2、调度决策函数（stop 先于触发、coalesce/deliver 数据面）、静态环检查（与"存在无护栏环"数学等价）；41 个确定性单测 + 重放精确性；含 stop 观察范围的语义裁决。
- [2026-07-02 · Kernel G0：SQLite 事件日志 + 统一命令通道](./2026-07-02-kernel-g0-event-log.md) —— kernel doc §9 G0 落地：`kernelStore.ts`（events/snapshots/meta）、JSON→SQLite 迁移、dispatchCommand 收口三条改状态路径、causeId 因果链贯通 hero loop、kernel-events 读取面（HTTP/client/CLI/SSE）；含 review 修复记录与存储恢复语义。
- [2026-07-02 · Headless 验收机制 Phase 4：真实场景库](./2026-07-02-headless-acceptance-phase4-scenarios.md) —— acceptance runner + 产物落盘、四个真实 provider 场景（含 master loop）、npm script 重组为 `test:kernel:*` / `acceptance:*`；附真实 Haiku 验收记录与场景编写约定。
- [2026-07-02 · Headless 验收机制 Phase 3：link 边](./2026-07-02-headless-acceptance-phase3-link-edges.md) —— schema v6、`linkSessions`/`removeEdge` + edges HTTP 端点、membrane skill `link_sessions`、CLI `edge add/remove`、vite 同源代理；含 v5/v6 迁移语义与浏览器端到端验证记录。
- [2026-07-02 · Headless 验收机制 Phase 2：调试 CLI](./2026-07-02-headless-acceptance-phase2-cli.md) —— `scripts/orrery-cli.mjs`：sessions/show/tail/graph/state/events 全命令面、id 前缀解析、`--readonly` 守卫、tail 就绪信号；`npm run cli`。
- [2026-07-01 · Headless 验收机制 Phase 1](./2026-07-01-headless-acceptance-phase1.md) —— runtime 读取端点（sessions/graph/events 游标）、projection 镜像、headless client + harness、模型预设；含镜像同步与 404 前缀契约等注意事项。
- [2026-07-01 · 图机制（Session Graph Kernel）设计定稿](./2026-07-01-session-graph-kernel.md) —— 无代码变更；产出 kernel 基准设计 + rationale 讨论记录，含 G0–G4 落地路径与开发注意事项。
