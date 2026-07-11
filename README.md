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

The default entry points are `New Chat` and `New Workflow`:

- `New Chat` opens an empty composer. Choose a provider, confirm the project
  cwd, send the first message, and Orrery creates a runtime session plus an
  independent graph node.
- `New Workflow` opens the three primary outcomes: Review until clean, Handoff,
  and Run until goal. Each uses the same Agent configuration, Preview, and
  `Run workflow` language; nothing starts while the workflow is being configured.
- `Create Agent from this Chat` is a one-Agent shortcut that records provenance.
  It does not create ongoing automation.
- The chat header shows provider, cwd, status, updated time, and id. Plans,
  runtime activity, requests, user-input prompts, recovery notices, and optional
  raw provider diagnostics are shown in the conversation surface.
- The Chats tab provides history search, hidden/archived sessions, restore, and
  recovery context.
- `Advanced` contains Master/Cluster governed loops and uncommon trigger-based
  workflows. It is not required for Review, Handoff, or Goal workflows.

### Golden journeys

- Review: configure Coder + Reviewer + blocking rule + lap cap, inspect the
  two-way Preview, then Run.
- Handoff: configure new or existing Source and Receiver. An existing Source
  transfers its current result immediately; a new Source runs first and hands
  off exactly once when it finishes.
- Goal: configure a new or existing Worker, define done in one sentence, and
  choose a lap cap. The Judge visibly inherits the Worker configuration. Orrery installs both
  Goal relationships before starting the Worker.

## Runtime Model

- Shared graph-state contract:
  - renderer: `src/shared/graph-state.ts`
  - Electron runtime: `shared/graph-state.ts`
- Session manager: `electron/runtime/sessionManager.ts`
- IPC bridge: `electron/main.ts` and `electron/preload.ts`
- Electron build output: `dist-electron/electron/main.js`
- Invariant: `nodeId === sessionId`
- Providers: Claude Code SDK, Codex app-server, and Grok Build over ACP
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
- Membrane validation and stop cleanup for the Claude SDK bridge:
  `npm run test:kernel:membrane`

Headless real-scenario acceptance (real providers, cheap model preset where a
verified cheap model exists; Grok intentionally uses its provider default,
minutes per scenario; artifacts land in `output/acceptance/<run-id>/`):

```sh
npm run acceptance:headless                       # all scenarios
npm run acceptance:headless -- --filter linked    # by name
npm run acceptance:headless -- --list             # list scenarios
npm run acceptance:headless -- --provider grok --list
npm run acceptance:headless -- --provider grok --filter grok-two-turn-resume
npm run acceptance:membrane                       # live membrane create/resume/report
```

## Grok Build setup

Orrery expects a local Grok Build CLI with ACP stdio support. The integration
baseline was verified with `grok 0.2.93` and launches `grok agent stdio`.

1. Install Grok Build and make `grok` available on `PATH`, or set
   `ORRERY_GROK_BIN` before starting Orrery. A custom binary path and launch
   arguments can also be saved in Provider setup.
2. Authenticate with `grok login`, or provide `XAI_API_KEY` to the Orrery
   runtime process. Orrery reuses that provider-managed authentication; it does
   not read, store, or refresh OAuth/API credentials.
3. Select **Grok Build** in New Chat. The lazy setup check performs a real ACP
   initialize/auth/session setup and discovers the available models. Because
   the current ACP exposes no verified delete-session method, this readiness
   check creates an upstream Grok session.

Provider setup accepts only non-sensitive `KEY=value` environment overrides.
Credential-like names such as `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, and
`CREDENTIAL` are rejected; pass credentials to the Orrery process instead.
Grok may still load native MCP servers from `~/.grok`. Orrery injects and cleans
up its per-turn graph membrane, but does not claim to isolate that user config.

Headless debugging against a dev instance:

```sh
npm run cli -- sessions
npm run cli -- session show <id-prefix>
npm run cli -- session tail <id-prefix>
npm run cli -- graph
```
