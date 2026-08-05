# Gate A real native-agent loop

## Result

Gate A's core real-agent journey passed with Desktop-bundled Codex
`0.146.0-alpha.9.2`: one root Governor created exactly one native implementer and one native
reviewer. The same two workers were followed up across lap 1. The authoritative typed sequence was
`implementer done → reviewer issues → implementer done → reviewer clean`; revision advanced from 1
to 5 and terminated as `succeeded`. The final fixture contained two passing tests.

The localhost surface opened on a random literal `127.0.0.1` port while the MCP process was alive.
The origin in the JSON artifact is evidence only and is intentionally no longer reachable after the
headless MCP process exited.

## Core failure found and fixed

The first real run exposed a genuine architecture bug: root and native workers each receive an
independent MCP server process. The old HMAC token used a process-local secret/epoch, so the worker
could never validate the root-issued capability. Re-signing from root only repeated the mismatch.

The replacement is an opaque 48-byte action token. Only its SHA-256 digest plus
`runId/role/pendingTransitionId/actionRevision` is stored. Independent worker MCP processes validate
against that durable record; plaintext never enters JSON state. A new Governor MCP process rotates
the current token during root `get_loop`, so the skill forbids root polling while a worker is in
flight.

## Reproduction shape

The real run used the Desktop-bundled CLI with user config and the Plugin registry disabled. It
enabled native multi-agent support and manually registered only the source MCP server against an
isolated data root:

```sh
/Applications/ChatGPT.app/Contents/Resources/codex exec \
  --ignore-user-config --disable plugins --enable multi_agent \
  --dangerously-bypass-approvals-and-sandbox --json \
  -C output/acceptance/agent-loop-gate-a-fixture \
  -c 'mcp_servers.looperators_gate_a.command="/usr/local/bin/node"' \
  -c 'mcp_servers.looperators_gate_a.args=["<repo>/plugins/looperators-agent-loop/mcp/server.mjs"]' \
  -c 'mcp_servers.looperators_gate_a.env={ LOOPERATORS_DATA_DIR = "<temporary-data-root>" }' \
  '<bounded Gate A prompt>'
```

No Hooks, Personal Plugin, Desktop reload, Node protocol helper, commit, or push was used. Shell was
available only to the workers for editing the isolated fixture and running its test.

## Evidence boundary

- [gate-a-real-loop.json](./gate-a-real-loop.json) contains sanitized thread lineage, revisions and
  typed report sequence.
- Native session metadata confirmed one depth-1 implementer and one depth-1 reviewer under the root.
- Each child rollout contained two direct `looperators_report` completions, matching the four durable
  report facts. Rollout text and capability-bearing call arguments were not copied into the repo.
- Automated tests additionally use three simultaneous real stdio MCP processes and a separate
  Governor-restart process. They verify token rotation, stale-token rejection and cancel.

This transcript inspection is acceptance evidence, not a product protocol. Runtime authority remains
the versioned typed store; looperators does not tail transcripts.
