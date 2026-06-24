# Orrery

Orrery is an Electron + React prototype for managing real agent sessions as a
graph. See `design-docs/` for the product model and v1 implementation plan.

## P0 runtime foundation

P0 keeps scope narrow: a real Claude Code CLI subprocess can be spawned,
streamed, finished, and killed under Electron main-process control. The shared
graph-state contract lives in `src/shared/graph-state.ts` for renderer code and
`shared/graph-state.js` for Electron runtime code.

The P0 runtime uses:

- backend: `claude -p --output-format=stream-json --verbose`
- session manager: `electron/runtime/sessionManager.js`
- IPC: `orrery.runtime.getState()`, `createSession(input)`, `killSession(id)`,
  and `onEvent(listener)` from the preload bridge
- invariant: `nodeId === sessionId`
- membrane contract fields: runtime-owned `{ callId, source, ts }` envelopes are
  defined in schema/types but not implemented as skills until P2

## P0 acceptance

Run the non-UI CLI spikes:

```sh
npm run runtime:spike
npm run runtime:spike:kill
```

Run the app control surface:

```sh
npm run dev
```

In the left sidebar, use `Spawn Claude` to start a real Claude session. The
canvas will add a node whose `nodeId` is the runtime `sessionId`; the stream
inspector shows raw stream-json chunks, assistant text, result, and terminal
status. Use the square icon next to `Spawn Claude` to kill the selected pending
or running session.

Build verification:

```sh
npm run build
```
