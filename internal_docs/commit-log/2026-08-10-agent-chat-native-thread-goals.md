# 2026-08-10 · Agent Chat native thread goals

预期代码提交：`feat(chat): add native thread goals`。

## 背景与术语纠偏

本阶段给 desktop Agent Chat 增加 `/goal`。调研首先纠正了一个容易走偏的假设：它不是
`-go` CLI flag、reasoning effort、permission mode，也不是现有 `Run until goal` Workflow。
它是 Codex app-server 的 thread 级持久目标与自主续跑生命周期。

T3 Code 当前 main 没有已发布的 `/goal`；可参考的是关闭的 PR #4260，以及 main 中已经成熟的
provider capability/descriptor 分层。真正的协议真相来自 Codex app-server：
`thread/goal/set|get|clear`、`thread/goal/updated|cleared`，以及 active + idle 时由 provider
自动启动 continuation。由此确立最重要的约束：设置或恢复 native goal 后，looperators
绝不能再手工发送普通 `turn/start`。

完整实施计划与 Fable 5 的两轮方案评审记录见
[实施计划](../plans/2026-08-10-agent-chat-native-thread-goals.md)。首轮评审发现 active goal
普通 resume 可能 double-start、现有 adapter 以首个 turn/30 分钟结算与 goal 不兼容、以及
kill/reconnect/notification ordering 缺口；修订后复审结论为 GO。

## 最小方案

实现保持 Codex-only，不用 prompt injection 假造 Claude/Grok parity，也不引入通用 goal
orchestration、数据库 migration 或本地 autonomous loop：

1. provider metadata 只声明 `supportsThreadGoals`；shared contract 增加独立 `ThreadGoal`，
   不把生命周期状态塞进 model options；
2. parser 支持 `/goal` view、objective、pause/resume/clear 与 `/goal set ...` 转义；
3. 新 chat 先 materialize Codex thread，再调用 native set；existing chat 原地 control，close
   race 时回退到新的 goal-control run；
4. goal run 跨越多个 provider automatic turns，只有 paused/blocked/limited/complete/clear 或
   错误才释放本地 run；普通消息在 cached active goal 时被拒绝，避免 second turn；
5. composer 上方只增加一个 compact row，展示 status/objective/tokens/time 与
   Pause/Resume/Clear；没有 modal、sidebar、timeline schema 或 token-budget editor；
6. Codex 上游状态为真相；本地 snapshot 只作恢复与展示缓存，resume 必须先 get reconcile。

现有 `Run until goal` Workflow 未改动，继续作为 looperators 的多 Agent Worker/Judge 编排。

## 实施中发现的协议边界

### 秒级 timestamp 不能用严格大于

真实 Codex acceptance 发现 `active → complete` 可以共享同一秒的 `updatedAt`。最初用严格
`>` 的 notification watermark 会吞掉 complete，导致 native 已完成而 UI/state 仍 active。
修正为同秒按同一 stdio stream 的接收顺序接受 `>=`；authoritative get/set response 仍可
重置水位，clear 使用本地接收时间挡住旧 goal resurrection。新增 equal-timestamp 回归。

### Pause 必须同时关闭 renderer 的运行态

首次 UI 复核发现 pause 后 chat 已 idle、goal 已 paused，但先前 command activity 仍显示
`running`。主进程状态修正还不够，因为 per-session renderer store 主要消费轻量 provider
events。最终实现为 pause run 中所有 pending/running activity 生成明确的 synthetic
`item.completed(status=failed)`，通过同一 provider.runtime transport 投影；manager 测试同时
断言 durable state 与 renderer event，最终独立 Browser 复验 P0=0、P1=0。

### Kill 与 reconnect

goal run 的 kill 会 best-effort 把上游目标置为 paused，再关闭 client；set response 会先投影
authoritative paused；失败或超时时不伪造 paused，而是保留 active cache、写
`runtime.thread_goal_pause_unconfirmed` recovery diagnostic，继续用普通消息门禁避免 double-start。
kill pause 与其他 goal control 共用串行队列，kill 后的新 control 使用 typed unavailable error
回退到命令层处理。Reconnect 显式覆盖 complete/cleared/active/limited：active 只重新附着，
不重复 set objective/status，也不启动普通 turn。unsupported provider 在 session 创建和 recovery
之前失败，不能产生隐式 provider side effect。

### 防御性协议与恢复

`thread/goal/get` 返回 truthy 但不合法的 goal 时，在任何 mutation 前 fail-closed；
`thread/goal/set` 返回缺失或非法 goal 时显式失败，不能把陈旧 UI 当成成功。恢复时非法 persisted
goal 会被丢弃并写 diagnostic，非法 watermark 回退到合法 goal 的 provider epoch 秒时间戳。
这些异常路径都有 fake app-server / recovery 回归测试。

## 验收证据

- `npm run lint`：通过；
- `npm run build`：通过；
- goal/parser/mapper/adapter/provider/session/renderer 最终聚焦回归：54/54；
- `npm run test:kernel`：全套通过（含 persistence/orchestration/master-loop/membrane/
  Codex interaction 子门禁）；
- `npm run acceptance:electron`：通过；
- 真实 Codex cheap-model headless：set → pause → resume → automatic continuation → complete →
  clear，最终 1/1 通过；最终 artifact：
  `output/acceptance/2026-08-10T23-46-15-906Z`；
- 独立 UI Browser task 与截图：[验收记录](../experiments/artifacts/2026-08-10-agent-chat-native-thread-goal/ui-acceptance.md)。
- 最终评审：Claude Code Fable 5 **GO / no P0-P1**；Sonnet 最后聚焦复核 **CLEAN**。

## 后续必须遵守的约束

- goal set/resume 后禁止额外 `turn/start`；provider-native continuation 才是执行者；
- ephemeral/unmaterialized thread 不可直接设置目标；新 chat 必须先 materialize；
- 普通 chat resume 与 active goal reconnect 必须是互斥入口；
- `updatedAt` 是 provider timestamp，不保证每次状态改变都递增；不得恢复严格 `>`；
- pause/kill/close 后不能让 request、user-input 或 activity 在 UI 中保持 open/running；
- token budget input、跨 provider goal abstraction、local autonomous loop 都不属于这个轻量 v1，
  需要独立产品决策后再做。
