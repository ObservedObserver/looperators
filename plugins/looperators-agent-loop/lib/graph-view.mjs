import { readFileSync } from "node:fs";
import { assertGraphProjectionIntegrity } from "./projection.mjs";

function readUiAsset(name) {
  const value = readFileSync(
    new URL(`../ui/assets/${name}`, import.meta.url),
    "utf8",
  );
  if (/<\/(?:script|style)\b/iu.test(value)) {
    throw new Error(`unsafe graph UI asset: ${name}`);
  }
  return value;
}

const UI_STYLE = readUiAsset("agent-loop-ui.css");
const UI_SCRIPT = readUiAsset("agent-loop-ui.iife.js");

function jsonForScript(value) {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function semanticFallback(projection) {
  const nodes = projection.nodes
    .map(
      (node) =>
        `<li><strong>${escapeHtml(node.label)}</strong>: ` +
        `${escapeHtml(node.state)}</li>`,
    )
    .join("");
  const edges = projection.edges
    .map(
      (edge) =>
        `<li>${escapeHtml(edge.source)} &rarr; ` +
        `${escapeHtml(edge.target)}: ${escapeHtml(edge.kind)}</li>`,
    )
    .join("");
  return `<section id="looperators-agent-loop-fallback" class="looperators-agent-loop-fallback" role="status">
  <h2>looperators Agent Loop</h2>
  <p>Verified ${escapeHtml(projection.status)} snapshot, lap ${projection.currentLap}/${projection.lapCap}.</p>
  <ul>${nodes}</ul>
  <ul>${edges}</ul>
  <p>revision ${projection.revision} &middot; digest ${projection.projectionDigest.slice(0, 12)}</p>
</section>`;
}

const FALLBACK_STYLE = `<style>
  .looperators-agent-loop-fallback {
    box-sizing: border-box;
    display: grid;
    gap: .5rem;
    width: 100%;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--foreground, #172033) 20%, transparent);
    border-radius: .75rem;
    background: color-mix(in srgb, var(--background, #fff) 94%, var(--foreground, #172033));
    padding: .75rem;
    color: var(--foreground, #172033);
    font: 13px/1.45 ui-sans-serif, system-ui, sans-serif;
  }
  .looperators-agent-loop-fallback[hidden] { display: none !important; }
  .looperators-agent-loop-fallback h2,
  .looperators-agent-loop-fallback p,
  .looperators-agent-loop-fallback ul { margin: 0; }
</style>`;

export function renderGraphFragment(
  projectionValue,
  options = {},
) {
  const projection = assertGraphProjectionIntegrity(
    projectionValue,
  );
  const mode = options.mode ?? "inline";
  if (!["inline", "sidecar"].includes(mode)) {
    throw new TypeError("graph view mode is invalid");
  }
  const driftNote =
    typeof options.driftNote === "string" &&
    options.driftNote.length <= 160
      ? options.driftNote
      : "";
  const envelope = jsonForScript({
    projection,
    expectedProjectionDigest: projection.projectionDigest,
    runId: projection.runId,
    mode,
    ...(driftNote ? { driftNote } : {}),
    ...(mode === "sidecar" && options.eventsUrl
      ? { eventsUrl: options.eventsUrl }
      : {}),
    ...(mode === "sidecar" && options.controlUrl
      ? { controlUrl: options.controlUrl }
      : {}),
    ...(mode === "sidecar" && options.csrfToken
      ? { csrfToken: options.csrfToken }
      : {}),
  });
  return `<div id="looperators-agent-loop-root"></div>
${semanticFallback(projection)}
<script type="application/json" id="looperators-agent-loop-data">${envelope}</script>
${FALLBACK_STYLE}
<style>${UI_STYLE}</style>
<script>${UI_SCRIPT}</script>`;
}

export function renderSidecarDocument(projection, options = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>looperators Agent Loop live review</title>
  <link rel="icon" href="data:,">
  <style>
    body {
      margin: 0;
      padding: 16px;
      background: var(--background, Canvas);
      color: var(--foreground, CanvasText);
    }
  </style>
</head>
<body>
${renderGraphFragment(projection, {
    ...options,
    mode: "sidecar",
  })}
</body>
</html>`;
}
