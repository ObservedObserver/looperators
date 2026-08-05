# looperators Agent Loop

This directory contains the lean Codex Plugin for one bounded
`review-until-clean` loop inside a Codex task.

## Runtime prerequisite

The current local-development Plugin requires a PATH-visible Node.js `24.x`
runtime. It is verified with Node.js `24.11.1`, matching this repository's
`engines` field and CI. Check the exact Desktop launch environment before
installing:

```sh
node --version
```

An older Node runtime produces an actionable MCP startup error. If `node` is
absent from PATH entirely, Codex cannot start the MCP process and the Plugin
itself cannot emit a diagnostic; fix the Desktop launch PATH and reload the
Plugin. The Plugin does not currently bundle Node, so broad public distribution
remains gated on either a self-contained runtime or installer-level prerequisite
validation.

## Default product boundary

- The root task is Governor; 1–2 native Codex subagents are cooperative roles.
- Typed MCP state and immutable facts are authoritative.
- The default plugin ships **no Hooks** and needs no Hook trust approval.
- The plugin does not inspect transcripts or guess native agent ids.
- Inline visualization is outside the critical path. The primary review surface
  is the authenticated `127.0.0.1` sidecar managed by MCP.
- Cooperative mode cannot force a worker to report or force Codex to continue a
  turn; the Skill makes missing obligations explicit.

## MCP lifecycle

The default tool surface is intentionally small:

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

`open_review_surface` starts or reuses one MCP-owned server bound to the literal
`127.0.0.1` on a random OS port. It returns a short-lived, one-time URL that is
redeemed for an HttpOnly, SameSite, run-scoped cookie. The live page uses the
shared Desktop-derived ReactFlow graph, verified projection SSE, and same-origin
CSRF-protected pause/resume/cancel calls. Probe, native-id binding, legacy
quarantine, and inline render tools are not callable product tools.

`start` and root-only `get_loop` return the current action-scoped
`roleCapability`. The token binds the run, logical role, pending transition,
and action revision. Token plaintext is never persisted; the shared data root
stores only its SHA-256 digest and action identity so independent native-worker
MCP processes can report. Old-action, wrong-role, and post-cancel tokens are
rejected. A root read after a Governor MCP restart rotates the current token.
The Governor must not call `get_loop` while a worker is in flight because that
restart/recovery read can invalidate the dispatched token.

## Local data

`LOOPERATORS_DATA_DIR` is an optional absolute override for isolated tests and
advanced setups. Otherwise MCP uses the looperators-owned platform path:

| Platform | Default |
| --- | --- |
| macOS | `~/Library/Application Support/looperators/codex-agent-loop/v1` |
| Linux/Unix | `$XDG_DATA_HOME/looperators/codex-agent-loop/v1`, otherwise `~/.local/share/looperators/codex-agent-loop/v1` |
| Windows | `%LOCALAPPDATA%\looperators\codex-agent-loop\v1` |

The store never falls back to the repository, worktree, plugin cache, or
`~/.codex`. POSIX directories are `0700`. The store survives uninstall so an
unfinished run is not deleted as an installation side effect.

## Verification

```sh
node --test \
  plugins/looperators-agent-loop/tests/cooperative-loop.test.mjs \
  plugins/looperators-agent-loop/tests/cooperative-mcp-server.test.mjs
npm run build:plugin-agent-loop-ui
```

The complete Gate A suite additionally covers the sidecar, security controls,
restart behavior, typed state projection, and the shared graph UI.
