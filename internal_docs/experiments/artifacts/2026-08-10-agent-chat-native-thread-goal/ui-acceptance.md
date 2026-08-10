# Native thread goal UI acceptance

日期：2026-08-10

独立 Codex Browser task：`019fedc4-bfc3-77a3-90e1-c4d80bf5b9f9`（GPT 5.5, High）。
任务只使用 Chrome Browser Control 操作 `http://127.0.0.1:48273/`，没有修改源码或提交代码。
每轮 runtime 都使用独立 storage。

## 最终结果

- New Chat 选择 Codex 与仓库 cwd 后，`/goal <objective>` 创建真实 native goal；
- compact progress row 显示 objective、`ACTIVE`、tokens/time、Pause/Clear；
- Pause 后 chat 为 `IDLE`、goal 为 `PAUSED`，显示 Resume/Clear；
- 暂停 run 的未完成 activity 收到明确 terminal update，不再残留 `running`；
- Resume 回到 `ACTIVE`；Clear 后 progress row 消失；
- 浏览器 console 没有 error/warn；最终 P0=0、P1=0。

## 修复闭环

首轮 UI smoke 覆盖完整 active/pause/resume/clear，未发现控制面问题。主任务复核截图时发现
pause 后 activity 仍可显示 `running`。第二轮复现确认主进程事实已经终结 activity，但 renderer
没有收到对应的轻量终结事件；修复为发送 synthetic `item.completed(status=failed)` 后，第三轮
复验确认页面不再保留运行态。该路径另有 manager 级 transport assertion。

## 截图

- [Active goal](./ui-goal-active.png)
- [Paused goal](./ui-goal-paused.png)
