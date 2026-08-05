# looperators Agent Loop P0 plugin

This is a compatibility probe, not a production orchestration runtime. It keeps
four boundaries intentionally small:

- Codex hook inputs are collected as one atomic file per delivery.
- `scripts/normalize-events.mjs` derives a deterministic event stream and graph.
- `scripts/generate-inline-visualization.mjs` projects the real root and
  subagents into an interactive, thread-scoped native HTML fragment.
- `mcp/server.mjs` exposes that graph as both structured tool output and an
  MCP App resource.
- `scripts/sidecar-server.mjs` is a token-protected, loopback-only SSE fallback.

No looperators Desktop runtime, provider adapter, workflow kernel, or transcript
tailing is included.

## Local checks

```sh
node --test plugins/looperators-agent-loop-p0/tests/*.test.mjs
```
