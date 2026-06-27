# Orrery

Orrery is an Electron + React control surface for code-agent chat sessions. It
uses a graph as the durable product model: every chat is a node, linked chats and
master/worker actions are edges, and workflow state stays visible instead of
disappearing into a flat session list.

See `design-docs/` for the product model and v1 implementation plan.

## Product Path

Run the app:

```sh
npm run dev
```

The default entry point is the Chat tab:

- `New Chat` opens an empty composer. Choose a provider, confirm the project
  cwd, send the first message, and Orrery creates a runtime session plus an
  independent graph node.
- `Linked Chat` starts from an existing chat and creates a new node connected to
  the source session.
- The chat header shows provider, cwd, status, updated time, and id. Plans,
  runtime activity, requests, user-input prompts, recovery notices, and optional
  raw provider diagnostics are shown in the conversation surface.
- The Chats tab provides history search, hidden/archived sessions, restore, and
  recovery context.
- The Workflows tab lets users select worker chats, save a managed cluster,
  create or reuse a master chat, run a master loop, and freeze a worker or an
  entire cluster. Master decisions, reports, freezes, and session creation
  appear as graph edges.

## Runtime Model

- Shared graph-state contract:
  - renderer: `src/shared/graph-state.ts`
  - Electron runtime: `shared/graph-state.js`
- Session manager: `electron/runtime/sessionManager.js`
- IPC bridge: `electron/main.js` and `electron/preload.js`
- Invariant: `nodeId === sessionId`
- Providers: Claude Code SDK, Codex, and legacy Claude CLI
- Runtime persistence covers session restore, corrupt-state recovery, invalid
  cwd diagnostics, archive state, linked sessions, cluster/master state, and
  loop policy.

## Verification

Build and lint:

```sh
npm run build
npm run lint
```

Runtime regression checks:

```sh
npm run runtime:persistence
npm run runtime:canvas:orchestration
npm run runtime:master-loop
npm run runtime:membrane:validation
npm run runtime:codex-interaction
```

Phase 5 audit coverage:

- Create, resume, restart recovery, invalid cwd diagnostics, and recovered-run
  resume: `npm run runtime:persistence`
- Node selection model, cluster/master graph state, linked edges, freeze state,
  and master resume after cluster freeze: `npm run runtime:canvas:orchestration`
- Loop stop, max-iteration guards, kill handling, and freeze-on-stop behavior:
  `npm run runtime:master-loop`
- Provider request/response UI plumbing for approvals and user input:
  `npm run runtime:codex-interaction`
- Membrane validation and stop cleanup for the Claude CLI bridge:
  `npm run runtime:membrane:validation`
- Live agent-controlled create/resume/report through the membrane, when a real
  Claude environment is available: `npm run runtime:membrane:smoke`

Legacy CLI spikes are still available when validating the old Claude CLI path:

```sh
npm run runtime:spike
npm run runtime:spike:kill
```
