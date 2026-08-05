# MCP-owned localhost live review checkpoint

Date: 2026-08-02

## Result

PASS for the headless localhost product surface. This is not yet the isolated Codex Desktop
fresh-install Gate B.

The MCP process now owns one sidecar per open run. The sidecar serves the full shared
Desktop-derived ReactFlow graph and writes pause/resume/cancel to the same authoritative typed
store used by MCP reports.

## Product protocol

- Bind address: literal `127.0.0.1` only, random OS-assigned port.
- Route: stable `/runs/<runId>` with run-scoped subordinate routes.
- Entry: short-lived one-time ticket; redemption redirects to the ticket-free route.
- Session: independent HttpOnly, SameSite=Strict cookie scoped to the run path.
- Mutation: exact Origin, JSON content type, session cookie and independent CSRF token.
- Live state: bounded SSE snapshots with projection digest IDs, Last-Event-ID support, client cap,
  backpressure close and authoritative replay on store changes.
- Lifecycle: MCP `open_review_surface` starts/reuses the process-owned sidecar;
  `close_review_surface` closes it; MCP stdin shutdown closes all remaining sidecars.
- Expired, consumed or unauthenticated entry renders a bounded safety page instead of exposing the
  graph.

No Hooks, inline renderer, host-private UI API, external asset server, `0.0.0.0` listener or
transcript tail is involved.

## Automated reproduction

From `/Users/observedobserver/Documents/GitHub/orrery`:

```sh
npm test -w @looperators/agent-graph-ui
npm run test:plugin-agent-loop-ui
npm run lint
```

Observed:

- shared graph package: 6 passed, 0 failed;
- Plugin build and full suite: 58 passed, 0 failed;
- real stdio MCP test opened the live surface, redeemed its ticket, loaded the page, rejected a
  replayed ticket and hostile Origin, executed pause/resume, completed the typed loop and closed
  the listening port;
- lint exited 0; generated Plugin UI assets are excluded like other build output, while source
  warnings remain the repository's pre-existing warnings.

## Browser acceptance

The Playwright CLI opened the actual randomized localhost URL in Chromium. Verified DOM state:

- title `looperators Agent Loop live review`;
- verified/running/live status;
- 3 role nodes and 4 relationship edges;
- ReactFlow zoom controls and MiniMap;
- node selection and inspector state;
- pause control changed the authoritative projection to `paused` through SSE;
- resume control changed it back to `running` through SSE;
- two control POSTs returned HTTP 200;
- console: 0 errors, 0 warnings.

Evidence:

- [interactive-resumed-live-graph.png](../../../../output/playwright/agent-loop-localhost-checkpoint/interactive-resumed-live-graph.png)

The first browser run exposed a real production-only failure: the bundle referenced the Node
`process` global and fell back to semantic HTML. The fix defines `process.env.NODE_ENV=production`
in the Plugin Vite build, which removes the unsafe development branch. The acceptance was then
repeated from a fresh sidecar/browser session and the full graph rendered with no console error.

The cooperative logical `role:*` bindings are intentionally not projected as native worker IDs;
the UI no longer makes the false claim that a native worker identity was observed.

## Remaining gates

1. Gate A: a real root task must create native implementer and reviewer subagents, receive typed
   reports, exercise issues-to-clean or cap, and prove cancel/restart behavior against this live
   surface.
2. Gate B: install the packaged Plugin from an isolated source and capture a Codex Desktop system
   screenshot with this localhost page in the right-side built-in Browser.

The official Codex manual documents that the Desktop built-in Browser can open local web apps,
share the view beside a task, interact with the page and capture screenshots. That establishes the
intended host surface, but only Gate B can prove the installed Plugin experience on this machine.
