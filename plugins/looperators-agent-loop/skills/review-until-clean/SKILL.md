---
name: review-until-clean
description: Preview and run a bounded looperators implementer–reviewer loop inside one Codex task. Use when the user asks for review-until-clean, an implementer/reviewer loop, iterative code review with a lap cap, or governed pause/resume/cancel controls.
---

# Review Until Clean

Use looperators typed MCP state as the only loop authority. The root task is
Governor; native Codex subagents are cooperative workers.

## Preview and confirmation

1. Collect the goal, separate implementer/reviewer instructions, and a lap cap
   from 1–6.
2. Call `looperators_preview_loop` with a fresh stable request id.
3. Show the topology and cap, then stop for explicit user confirmation.

Do not start work or create a subagent during preview. After confirmation call
`looperators_start_loop`. Default looperators has no Hooks and does not require
Hook trust. Start returns the first `roleCapability`. Then call
`looperators_open_review_surface` and give the returned localhost URL to Codex
Desktop's built-in Browser. Do not open the URL in an external browser unless
the user explicitly asks.

## Cooperative worker sequence

For each pending action:

1. Read `looperators_get_loop` as Governor. Treat its `pendingTransition` and
   `roleCapability` as authoritative. Do this before dispatching the worker;
   do not poll or re-read the loop while that worker is in flight.
2. Create or follow up exactly one native subagent for the returned role. Pass
   that worker its role, exact scoped instructions, `runId`, and current
   `capabilityToken`. Never save or show the token to the user.
3. Instruct the worker to call `looperators_report` directly:
   - implementer: `role=implementer`, `type=info`, `status=done`;
   - reviewer: `role=reviewer`, `type=verdict`, then `verdict=issues` with at
     least one structured issue or `verdict=clean` with no issues.
4. After the worker returns, re-read `looperators_get_loop`. Do not infer state
   from the worker's prose or transcript.

The capability is scoped to `runId + role + pendingTransitionId + action
revision`. Its plaintext never enters the shared store; independent MCP
processes verify it against a durable digest. A stale, wrong-role or
post-cancel token must fail. After a Governor MCP restart, a root-only
`get_loop` rotates the current token and invalidates the previously issued
one. Workers cannot use root-only read tools.

Do not run Node scripts, shell helpers, hook probes, bind-worker tools, or inline
renderers. The plugin MCP tools own the protocol.

## Govern and stop

- Success requires a typed reviewer `verdict=clean`.
- Stop at clean, cancellation, failure, or lap cap.
- Use `looperators_pause_loop`, `looperators_resume_loop`, and
  `looperators_cancel_loop` for explicit user control.
- Use a fresh request id for each distinct mutation; reuse it only to retry the
  exact same call.
- Give user steering or cancellation priority over the planned next action.
- Default mode is cooperative: it cannot force a native worker to call the
  report tool or prevent Codex from ending a turn. If a worker omits its typed
  report, follow up once; otherwise pause and report the missing obligation.

Keep the localhost review surface open as the primary live visualization. Its
pause/resume/cancel controls mutate the same authoritative typed store. Call
`looperators_close_review_surface` when the user asks to close it; otherwise
the MCP process owns its lifetime. Inline visualization is not part of this
workflow.
