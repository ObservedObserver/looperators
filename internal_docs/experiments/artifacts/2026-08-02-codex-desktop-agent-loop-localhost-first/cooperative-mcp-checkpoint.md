# Cooperative typed MCP checkpoint

Date: 2026-08-02

## Scope

This checkpoint removes Hooks and native-worker observation from the default Codex Plugin
surface. The loop is explicitly cooperative: root schedules one logical role at a time and the
worker reports through a typed, action-scoped MCP capability.

## Product surface

The default MCP server lists exactly eight tools:

1. `looperators_preview_loop`
2. `looperators_start_loop`
3. `looperators_pause_loop`
4. `looperators_resume_loop`
5. `looperators_cancel_loop`
6. `looperators_report`
7. `looperators_get_loop`
8. `looperators_get_snapshot`

Removed default surfaces include Hook collection/readiness, worker prepare/bind tools, probe
tools and inline graph rendering. Calling a removed tool by name returns method-not-found.

## Capability boundary

- The token is random and opaque. Its plaintext is never persisted; the shared store contains only
  its SHA-256 digest and action identity.
- The durable record binds run, logical role, pending transition and pending action revision, so a
  native worker's independent MCP process can validate the root-issued token.
- A token cannot act for the other role or a later action.
- Cancel and terminal state revoke the action.
- A new Governor MCP process rotates the current token on root `get_loop`; the Governor must not
  perform that recovery read while a worker is in flight.
- Exact cross-process report retries remain idempotent after the transition advances.

This is not cryptographic proof of a native Codex subagent identity. That limitation is deliberate
in the default no-Hooks mode and is stated in the Plugin README and skill.

## Reproduction

From `/Users/observedobserver/Documents/GitHub/orrery`:

```sh
node --test --test-concurrency=4 plugins/looperators-agent-loop/tests/*.test.mjs
npm run test:plugin-agent-loop-ui
npm run lint
```

Observed result:

- direct Plugin suite: 60 passed, 0 failed;
- repository Plugin UI build plus suite: 60 passed, 0 failed;
- shared graph package typecheck/library/inline/embed builds passed as part of the repository script;
- lint exited 0 with pre-existing warnings; no new lint error.

The suite covers no-Hook start, logical bindings, token-plaintext non-persistence,
cross-controller and three-real-MCP-process reporting, implementer-to-reviewer
and reviewer-to-terminal transitions, wrong-role/stale token rejection, pause/resume, cancel,
restart rotation, idempotent and conflicting retries, concurrent reports, issues-to-cap,
verified snapshots, prepared-start crash recovery and real MCP stdio framing/tool dispatch.

## Deferred by design

The existing developer sidecar tests remain green, but the MCP-owned product sidecar and the full
shared ReactFlow production embed are the next checkpoint. No Desktop UI acceptance or fresh
Plugin install is claimed here.
