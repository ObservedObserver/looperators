# Gate B：Codex Desktop right Browser 验收

- 日期：2026-08-03
- verdict：`GO`
- Codex Desktop：`26.727.51351`（build `6119`）
- Codex CLI：`0.146.0-alpha.9.2`
- Plugin：`0.3.2+codex.20260803073424`

## 结论

fresh Desktop task 通过 typed MCP 完成一个真实 root + implementer + reviewer loop，
Codex 内置右侧 Browser 显示共享 Desktop-derived ReactFlow 图。独立 run 从页面点击
`Request pause`，DOM 与 authoritative MCP state 均返回 `paused`。没有默认 Hooks、
没有 shell/Node 脚本代调 MCP、没有仓库修改或 worker transcript 作为协议。

## 实际步骤

1. 使用 Desktop-bundled CLI 安装本地 marketplace Plugin，并核对安装版本为
   `0.3.2+codex.20260803073424`。
2. 通过本地 marketplace Plugin detail 确认 Desktop 显示目标版本、1 个 MCP server、
   1 个启用 Skill；随后创建 fresh Desktop task。
3. task 调用 `preview → start → report(done) → report(clean) → get_snapshot`；恰好一个
   implementer 与一个 reviewer 参与。
4. 调用 `open_review_surface`，只兑换一次短期 ticket；在 Codex 内置 Browser 中读取
   localhost 页面 DOM，并保存右侧 Browser 页面截图。
5. 创建独立 control run，start 后不派 worker；从 localhost UI 点击唯一
   `Request pause`，随后同时检查 DOM 与 `looperators_get_loop`。

## 真实 loop 结果

- Desktop task：`019fc7b9-aa76-77d1-ac72-e4c3855772a8`
- run：`run_6fc56d7d04232a324a59cd132a18b8246db045adc291eb3a2540f8746f9f22cc`
- projection digest：
  `bef9a9a2541d8c3a60dde9bc3170010dbdf4d8e38aa3870564a3cae385e3ef16`
- status：`succeeded`
- worker reports：implementer `done`，reviewer `clean`
- Browser DOM：`verified`、`succeeded`、`live`；Governor、Implementer、Reviewer；
  governs、handoff、feedback、verdict；Controls、MiniMap。

## Control round-trip

- Desktop task：`019fc7c0-3a1f-7733-a0c7-88b01d291053`
- run：`run_5b9e832b226b7a2312ef9a6d633ec6b4fcd4f72d18932b18503c3e70f9b79bb4`
- projection digest：
  `cee9cc4df8fd12acae291635df4f2f596c4779a9b8e5609fe9192bc63ec11b31`
- action：右侧 UI 唯一 `Request pause` 按钮点击一次
- DOM status：`paused`
- MCP status：`paused`
- subagent / worker report：0 / 0

## 截图证据

- [右侧 Browser 页面截图](gate-b-desktop-right-browser.png)：完整 localhost graph viewport。
- 全屏 Codex Desktop 截图不进入公共仓库，因为它包含与本实验无关的本地 task、用户与
  系统元数据。公开证据只保留裁定 Gate B 所需的右侧 Browser surface。

SHA-256：

- `gate-b-desktop-right-browser.png`：
  `5a1cf867ba74795501868100437b77298c6baf14d49affb1205c8c92fb97b4df`

## 失败与修正

- 已启动 Desktop task 不会热加载外部 CLI 更新的 dynamic tools；必须在 Desktop 识别目标
  Plugin detail/version 后创建 fresh task。
- 旧 `0.2.0` 需要 `LOOPERATORS_DATA_DIR` / `PLUGIN_DATA`，因此出现
  `DATA_ROOT_UNAVAILABLE`；目标 `0.3.2` 默认使用 looperators-owned platform data path。
- 同一 one-time ticket 被重复打开时，首次兑换页正常，其余页面显示
  `Review link unavailable`。最终验收严格 mint 一次、导航一次。
- 初始验收 prompt 为禁止协议脚本而同时禁止了官方 Browser 控制运行时，导致 Agent 只生成
  URL 没有实际导航。修正为：继续禁止 shell/独立 Node/MCP 代调，只允许官方 Browser
  skill 的内部控制运行时。

## 安全与隐私

- 未保存 ticket、cookie、capability token、完整 worker transcript 或私密 prompt。
- localhost 只监听 `127.0.0.1`；公开截图不含凭据或无关本地 task 元数据。
- evidence 只记录 run/thread id、projection digest、状态和可复现产品版本。
