# looperators

[English](./README.md) | **中文** | [Español](./README.es.md)

> **Design the loop, not every prompt.**

**looperators 把 AI Agent 铺在画布上，连成会自己转的 loop。**

写代码的 Agent 和做 Code Review 的 Agent 连成一个环：实现、review、修改，直到
review 干净自动停。你不用盯着，也不用一句一句 prompt——回来看一眼画布，就知道
转了几圈、为什么停。

<img width="3202" height="1518" alt="looperators-2" src="https://github.com/user-attachments/assets/cf02610e-0c44-4a1b-91cf-cb23a1a9d2b8" />

一次生成往往不是最终答案，真正出活的是"实现 → Code Review → 修改"这个
循环。而今天，这个循环的发动机通常是人——读输出、贴 feedback、再 prompt，
每一圈都要有人踩油门。

looperators 让这个循环自己转。在画布上把两个 Agent 连成环（Claude Code、
Codex、Grok Build 都可以，甚至可以让不同模型互相 review），设一句停止条件：
"直到 review 干净，最多 6 圈"。点 Run，然后去干别的。环上的徽章实时显示转到
第几圈；转完之后，loop 时间线一分钟读懂每一圈发生了什么。

和其他自动化工具不一样的是：**图上每个 Agent 都是一个真实的、长期存在的会话，
随时点得开。**转到第二圈发现 reviewer 在纠结命名风格？点开它，说一句"风格问题
忽略，只看逻辑"，loop 继续转——不用把整个 run kill 掉重来。

这就是 **loop-native** 的含义，也是这个 workspace 押下的赌注：会话生来就活在
关系里，关系与循环是系统的母语，而不是在孤立会话之上事后拼装的补丁。loop 只
需要设计一次，画布让它看得见、有边界、随时归你掌控。

## Agent 不该是孤岛

大多数 code agent 工具把每个会话当成一座孤岛，而你是往返其间的渡船。在
looperators 里，会话活在关系中：一个会话可以唤醒另一个、交换上下文、互相
review、把不合格的工作打回上游，一直转到真正的停止条件满足为止。

有两个问题塑造了这个产品：

> 你离开的时候，工作流还在不在转？
>
> 你回来的时候，能不能很快读懂发生了什么、为什么？

## 不是又一个 workflow builder

传统 workflow 工具要求你先手动搭好 pipeline 才能开工。looperators 从结果出发。

选一个现成的 loop，或者把目标描述给 Master Agent。系统会提议参与者、关系、
权限和停止条件；你审阅提案、批准，然后用 graph 去理解或调整这个工作流——而
不是从零开始画每一步。

| 传统 workflow builder            | looperators                                      |
| -------------------------------- | ------------------------------------------------ |
| 从空白画布开始                   | 从目标或现成的 loop 开始                         |
| 节点是无状态的 action            | 节点是长期存在的 Agent 会话                      |
| 边主要向前传数据                 | 关系承载上下文、review、证据、重试和触发         |
| 为 DAG 和 happy path 优化        | 拒绝、返工、打回和反复验证是原生语义             |
| 图描述的是计划好的 pipeline      | Agent 干活的时候，图是活的                       |

和把模型当一次性步骤调用的系统不同，looperators 的每个节点始终是一个真实
会话：像普通聊天一样点开，查看它的消息和工具活动，随时插话，冻结后续触发，
或带着已有历史继续运行（resume）。

## Graph 定义 loop，prompt 定义工作

looperators 不需要为 Agent 可能做的每件事内置一个 action。

Code Review、测试、调研、迁移、issue 分诊、总结、安全分析——这些都可以用
prompt 表达。graph 提供的是围绕它们的、可复用的控制语义：

- 什么事件触发下一个会话；
- handoff 时传递什么上下文；
- 一次流转是自动放行，还是需要判断；
- Agent 忙碌时新工作到达怎么处理；
- 什么结果、目标、截止时间或上限让 loop 停下；
- 哪些关系在未来的事件到来时继续生效。

所以 "Review until clean" 只是一种好用的 loop，不是 looperators 能力的边界。
换掉 prompt，同一个形状就变成安全审计、test-and-fix 循环、迁移检查或验证
工作流。

## 你可以搭的 loop

### Review until clean

一个 Agent 实现变更，另一个 Agent 做 Code Review 并返回 blocking issues。
review 结论会重新激活原来的会话，由它修复后再送回下一轮 review。

<img width="3840" height="1986" alt="looperators-review" src="https://github.com/user-attachments/assets/3af4c02e-aa7b-435c-b2e9-98997bae88d8" />

loop 只在 reviewer 报告 clean 或触到配置的护栏时停止。每一圈、每个 verdict、
每条打回路径都留在图上。

### 多模型规划与辩论

让几个 Agent 或模型作为独立规划者各自出方案，互相阅读、互相挑战，最后综合出
最强的结果。

<img width="3140" height="1532" alt="looperators-discuss2" src="https://github.com/user-attachments/assets/a1bb358a-0e07-486e-8d9b-350aa57ec29a" />

内置的 **Plan Council** 会保留提案、分歧、互评和走到最终决定的完整路径——
而不只是最终答案。更复杂的辩论工作流可以持续交换 feedback，直到满足共识规则
或轮数上限。

### 分工、验证与修复

给不同的会话分配不同职责：调查、实现、review、测试、验证。独立分支可以并行
工作，在全部、任一或法定数量的结果就绪时汇合。

验证失败的会话可以把证据路由回负责的会话；验证通过则放行下一阶段。验证成为
工作流的一部分，而不是一句需要有人记得去跑的收尾 prompt。

### 转到目标真正完成为止

用一句话描述"完成"，给 Worker 配一个独立的 Judge。Judge 可以使用可执行的
证据——测试、lint、指标、检索或其他检查——然后返回结构化的 verdict。

检查失败，证据送回 Worker；检查通过，loop 停止。Worker 不能因为"有进展"
就宣布自己完工。

### 监听与响应

loop 不一定要由人发消息开始。它可以在定时、Git 变更、脚本结果、webhook 或
其他注册事件到来时醒来。

用它做定期维护、CI 失败响应、代码变更 review、issue 分诊或定时总结。不设
停止条件的话，一条关系可以一直待命，等下一次事件。

## 工作原理

### 长期存在的会话

每个参与者都是一个真实的 code agent 会话，有自己的历史、上下文、模型、工具
和工作区状态。loop 每一圈 resume 的是已经了解这份工作的那个会话，而不是每步
重新创建一个一次性 Agent。

### 可执行的关系

关系定义了谁响应谁、什么唤醒下一个会话、传递什么上下文、是否需要审批，以及
工作何时打回上游或停止。它们是持久的规则，不是执行完之后补画的连线。

### Outcome-first 的创建方式

从 **Review until clean**、**Run until goal**、**Handoff** 或 **Plan
Council** 开始，或者把更复杂的目标描述给 Master Agent。Master 是一个 intent
compiler：它提议参与者、关系、安全策略和图变更，不会不打招呼就开工。

你可以在批准前审阅并锁定提案。稳定运行的工作流里，Master 只在需要判断、异常
或重新规划时被唤醒，不会卡在每次机械流转的中间。

### 活的 graph 与时间线

graph 把同一份工作的三种视图放在一起：

- **意图（Intent）**：说明接下来应该发生什么的关系；
- **活动（Activity）**：已经发生的 turn、handoff、触发、verdict 和失败——
  以及原因；
- **治理（Governance）**：决定谁可以修改工作流的审批、锁、scope 和 Master
  角色。

loop 在图上是一个可读的整体：当前第几圈、状态、停止条件和时间线。一眼看出
它在转、在等 gate、被阻塞、已完成、被冻结还是被护栏拦停，然后点开能解释原因
的那个会话或事件。

## 确定性的机制，Agent 的判断

可靠的 agent loop 两者都需要。

机械的部分由 looperators 确定性地处理：事件匹配、上下文投递、激活、汇合、
停止规则、并发行为、持久化、恢复和资源上限。Agent 忙碌时到达的新事件会被
合并（coalesce），让它空闲后带着最新的累积状态处理一次，而不是排队消化一堆
过期的中间态。

需要判断的部分交给 Agent：规划、实现、review、综合、诊断，以及判定证据是否
满足目标。

这个分工让 loop 保持灵活，同时不要求模型——或人——记住每一个 turn 该怎么
路由。

## 为"放着跑"而设计

自主性只有在边界明确时才有用。视 loop 的配置，looperators 可以强制执行：

- 最大圈数、截止时间、fan-out、并发和会话数上限；
- 自动、Master Agent 或人工审批的 gate；
- 可选的用量警告或硬性预算；
- 工作区协调，避免并行写入者悄悄互相覆盖；
- 持久化的工作流状态、产物、决策和因果历史；
- 冻结、停止、重试和一致性恢复控制。

目标不是单纯启动更多 Agent，而是让长时间运行的 Agent 协作**看得见、有边界、
放心托付**。

## 快速开始

looperators 正在积极开发中，当前从源码运行。先安装并登录至少一个受支持的
code agent——Claude Code、Codex 或 Grok Build。在项目目录下运行：

```sh
npm install
npm run dev
```

从 **New Workflow** 选一个现成的 loop 开始，或者打开 Master 聊天描述一个更
复杂的目标。运行全程中，聊天和 Agent graph 都随时可用。

## 项目状态

looperators 处于早期 alpha 阶段。接口、存储契约和高级控制在稳定版本之前可能
调整。

当前构建包含：Agent 直连聊天、实时 Agent graph、handoff、Review-until-clean
loop、Goal loop、Plan Council、定时与外部触发、loop 时间线、Master 提案与
重新规划、barrier、持久化状态、用量与并发控制。

欢迎报告粗糙之处、失败的安装、不清晰的概念，以及你想跑的工作流。早期反馈会
直接塑造这个产品。

## License

基于 [Apache License 2.0](./LICENSE) 授权。
