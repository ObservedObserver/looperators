---
name: agent-loop-visualization
description: Normalize looperators P0 Codex hook events and render a small thread-scoped Agent Loop graph with the native codex-inline-vis directive. Use only when the user asks for the looperators Agent Loop P0 visualization or compatibility probe.
---

# looperators Agent Loop visualization

This skill is an explicit P0 compatibility probe. Do not treat it as a durable
or implicit orchestration protocol.

1. Require the exact experiment artifact directory from the user's request.
   Resolve it to an absolute path and verify that it is a directory. Do not
   search other tasks, guess a repository, or infer state by tailing a Codex
   transcript.
2. If `<artifact-dir>/hook-events/` exists, run:

   `node "${PLUGIN_ROOT}/scripts/normalize-events.mjs" --artifact-dir "<artifact-dir>"`

   If it does not exist, proceed only when `normalized-graph.json` or
   `normalized-events.jsonl` already exists. Otherwise report the missing input
   and stop. Never generate sample nodes or substitute another artifact set.
3. Use only the thread-scoped visualization directory exposed as a writable
   root for the current task. Verify that it is an existing directory. Do not
   guess a `CODEX_HOME` path, create a global fallback, or write through a
   symlink.
4. Generate the deterministic fragment from the normalized artifacts:

   `node "${PLUGIN_ROOT}/scripts/generate-inline-visualization.mjs" --artifact-dir "<artifact-dir>" --output "<thread-visualization-dir>/looperators-agent-loop.html"`

   The generator rejects output symlinks, writes atomically with mode `0600`,
   includes only observed data, and rejects fragments at or above 2 MiB.
5. Read the generated file back and verify that it is a regular fragment named
   `looperators-agent-loop.html`, contains no full HTML shell, and reports no
   source warning unless the input really is partial.
6. On success, emit only this directive, on its own line and outside a code
   fence:

   `::codex-inline-vis{file="looperators-agent-loop.html"}`

If the artifact directory, normalized inputs, or writable thread directory is
unavailable, report that exact limitation and do not emit the directive.
Presentation controls and `sendFollowUpMessage` stay inside the native card;
they do not make live network requests or arbitrary tool calls.
