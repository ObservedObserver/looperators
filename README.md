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
  - Electron runtime: `shared/graph-state.ts`
- Session manager: `electron/runtime/sessionManager.ts`
- IPC bridge: `electron/main.ts` and `electron/preload.ts`
- Electron build output: `dist-electron/electron/main.js`
- Invariant: `nodeId === sessionId`
- Providers: Claude Code SDK, Codex, and legacy Claude CLI
- Runtime persistence covers session restore, corrupt-state recovery, invalid
  cwd diagnostics, archive state, linked sessions, cluster/master state, and
  loop policy.

## Verification

The test taxonomy has three tiers (see
`design-docs/headless-acceptance-harness.md`): kernel unit tests (fake
provider binaries allowed — they verify graph-kernel logic and wire
protocols), headless real-scenario acceptance (real providers on a cheap
model preset), and final UI acceptance.

Build and lint:

```sh
npm run build
npm run lint
npm run test:kernel
npm run acceptance:electron
```

Kernel regression checks (fake provider binaries, seconds-fast):

```sh
npm run test:kernel:persistence
npm run test:kernel:orchestration
npm run test:kernel:master-loop
npm run test:kernel:membrane
npm run test:kernel:codex-interaction
```

- Create, resume, restart recovery, invalid cwd diagnostics, and recovered-run
  resume: `npm run test:kernel:persistence`
- Node selection model, cluster/master graph state, linked edges, freeze state,
  and master resume after cluster freeze: `npm run test:kernel:orchestration`
- Loop stop, max-iteration guards, kill handling, and freeze-on-stop behavior:
  `npm run test:kernel:master-loop`
- Provider request/response UI plumbing for approvals and user input:
  `npm run test:kernel:codex-interaction`
- Membrane validation and stop cleanup for the Claude CLI bridge:
  `npm run test:kernel:membrane`

Headless real-scenario acceptance (real providers, cheap model preset,
minutes per scenario; artifacts land in `output/acceptance/<run-id>/`):

```sh
npm run acceptance:headless                       # all scenarios
npm run acceptance:headless -- --filter linked    # by name
npm run acceptance:headless -- --list             # list scenarios
npm run acceptance:membrane                       # live membrane create/resume/report
```

Headless debugging against a dev instance:

```sh
npm run cli -- sessions
npm run cli -- session show <id-prefix>
npm run cli -- session tail <id-prefix>
npm run cli -- graph
```

Legacy CLI spikes are still available when validating the old Claude CLI path:

```sh
npm run runtime:spike
npm run runtime:spike:kill
```
