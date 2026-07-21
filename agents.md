# Agent Notes

Branding boundary: the customer-facing product name is `looperators`. `Orrery` / `orrery`
remains the internal codename and technical namespace; do not rename code symbols, IPC/MCP
names, environment variables, storage paths, CLI files, or historical records solely for rebranding.

For project vision and designs, please check the documentation under the `design-docs/`.

- Vision / initial idea: `design-docs/reactive-agent-session-graph.md` — why looperators manages agents as a graph instead of a session list.
- Design (current source of truth for development): `design-docs/orrery-design.md` — the concrete control model (Skills membrane, Master Agent, scopes/clusters), UI shape, v1 scope, and the §12 Skill API.
- v1 plan: `design-docs/v1-implementation-plan.md` — phased implementation plan (critical path P0–P3 + parallel workstreams A–C), with goals and acceptance criteria.
- Internal implementation roadmap / current post-P4 baseline: `design-docs/internal_docs/plans/master-agent-plan-council-implementation-plan.md` — Master-as-Intent-Compiler/Governor/Replanner, Plan Council as the first high-frequency workflow, reliability convergence, correlation/barriers, dynamic topology, and concurrency/safety. Its rationale and discussion replay live in `design-docs/internal_docs/commit-log/2026-07-12-master-agent-plan-council-direction.md`. This roadmap supersedes the old priority of expanding manual canvas authoring first; existing kernel semantics remain governed by `design-docs/session-graph-kernel.md` until each migration phase lands.

- Verification: headless-first, three tiers — `npm run test:kernel` (kernel unit tests, fake providers allowed), `npm run acceptance:headless` (real-scenario acceptance on real providers with the cheap model preset, artifacts in `output/acceptance/`), then final UI acceptance. Commands are documented below; scenario-authoring rules live in `design-docs/AGENTS.md`.

For development and technical planning, follow the design doc and the v1 plan.

## Current product surface

Run the app with `npm run dev`. The default entry points are `New Chat` and
`New Workflow`:

- `New Chat` opens an empty composer. The user chooses a provider, confirms the
  project cwd, and sends the first message. The runtime creates a session and
  an independent graph node.
- `New Workflow` exposes the primary customer outcomes: Compare plans, Review
  until clean, Handoff, and Run until goal. Each workflow uses shared Agent
  configuration and a Preview/Run flow; configuration must not start provider
  work.
- `Create Agent from this Chat` is a one-Agent shortcut that records provenance.
  It does not create ongoing automation.
- The chat header shows provider, cwd, status, updated time, and id. Plans,
  runtime activity, requests, user-input prompts, recovery notices, and
  optional raw provider diagnostics appear in the conversation surface.
- The Chats tab provides history search, hidden/archived sessions, restore, and
  recovery context.
- `Advanced` contains governed Master/Cluster flows and uncommon trigger-based
  workflows. It is not required for the primary workflows.

Golden journeys:

- Plan Council: configure 2–4 read-only Planners and a Synthesizer, preview the
  Council, then run independent proposals, peer review, and synthesis.
- Review: configure Coder + Reviewer + blocking rule + lap cap, inspect the
  two-way Preview, then Run.
- Handoff: configure a new or existing Source and Receiver. An existing Source
  transfers its current result immediately; a new Source runs first and hands
  off exactly once when it finishes.
- Goal: configure a new or existing Worker, define done in one sentence, and
  choose a lap cap. The Judge visibly inherits the Worker configuration. Both
  Goal relationships must exist before the Worker starts.

## Runtime architecture

- Shared graph-state contract:
  - renderer: `src/shared/graph-state.ts`
  - Electron runtime: `shared/graph-state.ts`
- Session manager: `electron/runtime/sessionManager.ts`
- IPC bridge: `electron/main.ts` and `electron/preload.ts`
- Electron build output: `dist-electron/electron/main.js`
- Invariant: `nodeId === sessionId`
- Production providers: Claude Agent SDK, Codex app-server, and Grok Build over
  ACP.
- Model catalogs are discovered from the configured provider instance, cached
  in runtime state, and shared by every chat/workflow model picker. An empty
  model setting means provider default; Custom remains available for stale or
  private catalogs.
- Runtime persistence covers session restore, corrupt-state recovery, invalid
  cwd diagnostics, archive state, linked sessions, cluster/master state, Plan
  Council artifacts, workflow governance, and loop policy.

## Development commands

```sh
npm run dev                 # Electron app with live renderer/runtime rebuilds
npm run dev:web:real        # browser renderer backed by a real local runtime
npm run build
npm run lint
npm run acceptance:electron
```

## Verification

Use three tiers in order. Kernel tests may use fake provider binaries and only
verify graph-kernel logic and wire protocols; they do not constitute product
acceptance.

GitHub CI is intentionally narrower than the local verification matrix. It runs
`npm run test:ci`, which is limited to environment-independent graph-core unit
tests after lint and build. Do not add provider fakes, provider CLI probes,
runtime integration tests, smoke scripts, headless acceptance, or UI acceptance
to `test:ci`; those remain local-only checks in the tiers below.

### 1. Kernel regression checks

```sh
npm run test:kernel
npm run test:kernel:persistence
npm run test:kernel:orchestration
npm run test:kernel:master-loop
npm run test:kernel:membrane
npm run test:kernel:codex-interaction
```

- persistence: create, resume, restart recovery, invalid cwd diagnostics, and
  recovered-run resume;
- orchestration: node selection, cluster/master graph state, linked edges,
  freeze state, and master resume after cluster freeze;
- master loop: stop, max-iteration guards, kill handling, and freeze-on-stop;
- codex interaction: approval and user-input request/response plumbing;
- membrane: validation and stop cleanup for the Claude SDK bridge.

### 2. Headless real-scenario acceptance

These scenarios use real providers and real tokens. Use the cheap model preset
where a verified cheap model exists; Grok intentionally uses its provider
default. Artifacts land in `output/acceptance/<run-id>/`.

```sh
npm run acceptance:headless
npm run acceptance:headless -- --filter linked
npm run acceptance:headless -- --list
npm run acceptance:headless -- --provider grok --list
npm run acceptance:headless -- --provider grok --filter grok-two-turn-resume
npm run acceptance:membrane
```

Read the failed run's artifacts before rerunning. Scenario-authoring contracts,
workspace isolation rules, and evidence requirements are in
`design-docs/AGENTS.md` and `design-docs/headless-acceptance-harness.md`.

### 3. Final UI acceptance

UI acceptance is the final, low-frequency tier after kernel and headless
acceptance pass. Follow the Browser/Computer Use assignment and model rules in
`design-docs/AGENTS.md`; do not turn UI clicking into the daily test loop.

## Provider setup notes

Provider instances may use custom binary paths and launch arguments in Provider
setup or the following runtime environment variables:

- `ORRERY_CLAUDE_BIN`
- `ORRERY_CODEX_BIN`
- `ORRERY_GROK_BIN`

Grok Build requires an ACP-capable local CLI and launches `grok agent stdio`;
the integration baseline was verified with Grok `0.2.93`. Authenticate with
`grok login` or provide `XAI_API_KEY` to the looperators runtime process.
looperators reuses provider-managed authentication; it does not read, store, or
refresh Grok OAuth/API credentials. The readiness probe performs a real ACP
initialize/authenticate/session setup and therefore creates an upstream Grok
session because the current ACP exposes no verified session deletion method.

Provider setup accepts only non-sensitive `KEY=value` environment overrides.
Credential-like names such as `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, and
`CREDENTIAL` are rejected; credentials must be supplied to the looperators
process. Grok may still load native MCP servers from `~/.grok`; the runtime
injects and cleans up its per-turn graph membrane but does not isolate that user
configuration.

## Headless debugging

```sh
npm run cli -- sessions
npm run cli -- session show <id-prefix>
npm run cli -- session tail <id-prefix>
npm run cli -- graph
```

The full CLI debugging loop, programmatic orchestration client, and browser
preview setup are documented in `design-docs/AGENTS.md`.
