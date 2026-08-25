# Agent Loop plugin development

## Control architecture

`lib/control.mjs` is the stable compatibility facade. MCP, the Governor, scripts,
and tests should import `LoopController`, `LoopControlError`, and
`rootContextFromMcpMessage` from that file rather than reaching into
`lib/control/`.

The implementation under `lib/control/` is split by responsibility:

- command adapters: `draft`, `root-commands`, `report-command`, and `queries`;
- authoritative state changes: `mutation-engine`, `history-apply`,
  `history-validator`, `history-facts`, and `state-reducer`;
- identity and action authorization: `identity-plane` and `capabilities`;
- compatibility-only paths: `legacy-identity`, `legacy-recovery`,
  `recovery-plane`, and `recovery-barrier`;
- shared validation and deterministic helpers: `input`, `identifiers`, `state`,
  `invariants`, `constants`, and `errors`.

Every implementation function receives the controller runtime explicitly. The
runtime contains `store`, `now`, `fault`, and the in-process action token cache.
This keeps dependencies visible and avoids a second public class hierarchy.

The split must preserve these boundaries:

- `lib/control.mjs` remains the only public control entry point;
- control modules have no import cycles;
- persisted contracts, identifiers, request digests, and transition order do
  not change during file moves;
- legacy native-worker and quarantine code stays isolated until a separate
  compatibility decision removes it;
- the MCP process continues to execute JavaScript on Node.js 24.

`tests/control-architecture.test.mjs` protects the facade contract, module size
bound, loadability, and acyclic import graph. The behavior suite protects the
state machine and wire protocol.

## TypeScript migration plan

Codex plugins can contain TypeScript source, but the plugin host does not build
or execute TypeScript. `.mcp.json` must point to JavaScript that already exists
in the installed plugin. Do not make the runtime depend on `tsx`, `ts-node`, or
an `npx` download.

Use a separate change for the migration:

1. Add `src/` and a plugin runtime `tsconfig` using `.mts`, `NodeNext` module
   resolution, an ES2024 target, strict checking, and `dist/` output.
2. Define `ControlRuntime`, `LoopStorePort`, state, receipt, projection, and
   command input/output types. Derive contract types from the versioned schemas
   where practical, while keeping runtime validators authoritative at trust
   boundaries.
3. Move the complete Node runtime into the build graph. During the transition,
   `allowJs` may copy unchanged ESM modules to `dist`; new or converted control
   modules use `.mts`. This avoids imports that jump between source and output
   trees.
4. Migrate leaf modules first, then the reducer and history verifier, then
   mutation commands, queries, the facade, and finally the MCP server. Keep each
   step behavior-neutral and run the full Node 24 suite after it.
5. Point `.mcp.json` to `./dist/mcp/server.mjs` only after tests execute the
   compiled tree. Personal marketplace installs do not run a build lifecycle,
   so release or cachebuster updates must include generated `dist/` artifacts.
6. Make the build reproducible: build from a clean checkout, fail when generated
   output differs, run plugin validation and the isolated-install probe, then
   reinstall the cache-busted plugin in a new Codex task.

The TypeScript change must not alter schema versions, durable paths, tool names,
or the `LoopController` public method set. Those are separate migrations.
