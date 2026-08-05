# Desktop → shared graph interaction parity

- 日期：2026-08-02
- Gate：A / shared package independent checkpoint
- 状态：shared package independent checkpoint passed；Plugin integration pending
- 规则：`not-applicable` 必须说明 authority 不存在或 fixed review loop 不需要；不能用它
  掩盖 shared package 缺失。

## Authority sources

- `src/components/session-graph-panel.tsx`：ReactFlow shell、selection、MiniMap、pan/zoom、
  node/edge routing 与 inspector/loop panel composition。
- `src/components/canvas.tsx`：Agent node、relationship edge、loop badge 及状态视觉。
- `src/components/relationship-inspector-panel.tsx`：关系结构、状态、stop action。
- `src/components/loop-panel.tsx`：lap、issues、recovery、timeline、stop confirmation。
- `src/hooks/use-canvas.ts`：projection→flow elements、drag、position、selection semantics。
- `src/lib/graph-view.ts`：portable-ish node/edge/product view model 与 label/routing semantics。

`packages/agent-graph-ui` 已按本矩阵扩展并通过独立验收；Desktop 源文件仍是语义和交互
authority，Gate A/B 完成前不改 Desktop import。

## Matrix

| Desktop behavior | Classification | Shared/Plugin contract | Acceptance |
| --- | --- | --- | --- |
| ReactFlow canvas + dotted background | direct reuse | shared canvas shell | production bundle 可见且无 console error |
| pan / wheel zoom / zoom buttons / fit view | direct reuse | shared canvas shell | mouse 与 controls 自动化 |
| MiniMap pannable/zoomable | direct reuse | shared canvas shell | MiniMap 可见并可操作 |
| node / edge / pane selection | direct reuse | controlled/uncontrolled selection props | click、pane clear、live update 后 selection 稳定 |
| keyboard node/edge selection | direct reuse | focusable node/edge labels | Enter/Space + focus-visible tests |
| presentation node dragging | host adapter | shared emits position change；sidecar 保存在当前 Browser session，不写 projection | drag 后位置变化；snapshot 更新不篡改 authority |
| durable Desktop node positions | not-applicable | Codex Plugin 无 Desktop runtime position authority | sidecar 不调用 store mutation |
| Agent node card hierarchy | direct reuse | shared portable AgentNode view model | role/identity/state/activity/report variants screenshots |
| provider/model/vendor identity | host adapter | optional bounded fields；无可信数据时显示 logical role/runtime，不伪造 native provider | present/absent variants |
| running/master/managed/frozen visual states | direct reuse where modeled | shared state/tone mapping | state fixture matrix |
| latest verdict / issue count / report summary | direct reuse | typed projection adapter | issues/clean/done fixtures |
| relationship edge routing/stroke/dash/arrow | direct reuse | shared portable edge model | four review-loop relationships 无交叠/裁剪 |
| edge label, active/recent/pending, report count | direct reuse | typed relationship status | fixtures + live SSE update |
| Relationship inspector layout | direct reuse | portable `RelationshipInspectorModel` | From/When/Then/Gate/State/Stop condition visible |
| relationship stop button | host adapter | injected capability + callback；default review loop maps to pause/cancel preview | enabled/disabled/pending/error tests |
| Loop badge node | direct reuse | portable loop product summary | headline/lap/status/stop reason visible |
| Loop panel status summary | direct reuse | portable `LoopPanelModel` | responsible role/verdict/stop reason states |
| blocking issues list | direct reuse | typed report issues only | file/line/severity and empty states |
| lap cards + report timeline | direct reuse | bounded typed timeline | issues→clean multiple lap fixture |
| recovery guidance | direct reuse | interrupted/capped recovery model | restart/cap fixtures |
| stop confirmation copy/interaction | direct reuse + host adapter | shared confirmation UI + injected cancel callback | confirm/cancel/action-pending tests |
| open responsible Agent | host adapter | optional callback; hidden with an explicit unavailable explanation when Codex cannot deep-link | capability present/absent tests |
| open final diff/provider settings/workflow builder | not-applicable | sidecar has no stable Desktop runtime/navigation authority | no fake buttons or shell commands |
| freeze participants / cluster controls | not-applicable | fixed cooperative review loop has no cluster freeze authority | absent from Plugin bundle |
| drag-to-connect / create arbitrary Agent | not-applicable | fixed three-role recipe; general graph authoring is out of scope | handles non-connectable; no mutation endpoint |
| source/clock/cluster synthetic nodes | not-applicable | fixed review loop projection contains root/implementer/reviewer only | no placeholder nodes |
| kernel/activity overlay | host adapter | bounded typed projection timeline, never transcript/hook tail | SSE updates typed activity only |
| light/dark theme tokens | direct reuse | shared CSS variables with Desktop-compatible tokens | light/dark screenshots |
| responsive wide/narrow layout | direct reuse | shared deterministic routing/layout | wide/narrow no overlap/crop |
| reduced motion | direct reuse | media query disables nonessential animation | browser media emulation |

## Independent checkpoint

Plugin UI may not import the expanded package until 1–5 已通过；第 6 项在 Plugin 接入后、
Gate A 关闭前执行：

1. portable component/model source with no Electron/runtime/MCP import;
2. dev server and shipped production bundle;
3. automated interaction coverage for every `direct reuse` row and every applicable adapter row;
4. machine-readable result with zero console errors and request inventory;
5. light/dark + wide/narrow screenshots including MiniMap, Relationship inspector and Loop panel;
6. static audit proving the Plugin does not ship a second node/edge/inspector/loop-panel implementation.

## Checkpoint result

- 结果：PASS
- machine-readable evidence：`shared-package-checkpoint.json`
- production build/test：`npm test -w @looperators/agent-graph-ui`，6/6 pass
- dev Browser：真实 Chromium 验证 zoom、drag、keyboard selection、edge selection、
  Relationship inspector、Loop panel/stop confirmation、wide/narrow、dark/light。
- production Browser：self-contained embed 显示 3 nodes + 4 edges + MiniMap；0 console error，
  `performance` resource inventory 为空。
- 初次验收拦截并修复两项真实缺陷：受控节点丢失 measured state 导致节点隐藏/边不渲染；
  重复 dimension change 导致 `ResizeObserver` warning storm。修复后重启 clean Browser session
  并重复 panel/resize 操作，dev server 无新增 warning。
- screenshots：
  - `output/playwright/agent-graph-ui-shared-checkpoint/graph-wide.png`
  - `output/playwright/agent-graph-ui-shared-checkpoint/graph-narrow.png`
  - `output/playwright/agent-graph-ui-shared-checkpoint/graph-light.png`
  - `output/playwright/agent-graph-ui-shared-checkpoint/loop-panel-wide.png`
  - `output/playwright/agent-graph-ui-shared-checkpoint/production-embed.png`

## Deferred Desktop migration

During Gate A/B the Desktop authority files remain unchanged. After Plugin acceptance, a separate
change switches Desktop imports to the accepted shared components and deletes the temporary duplicate
implementation. That later migration cannot weaken the Plugin checkpoint retroactively.
