#!/usr/bin/env node

import {
  lstat,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAX_FRAGMENT_BYTES = 2 * 1024 * 1024;
const OUTPUT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function readJsonIfPresent(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return fallback;
    }
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  }
}

async function readJsonLinesIfPresent(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw new Error(`Cannot read ${filePath}: ${error.message}`);
  }
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Cannot parse ${filePath}:${index + 1}: ${error.message}`,
        );
      }
    });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asCount(value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function shortIdentifier(value) {
  const identifier = asString(value);
  if (!identifier) {
    return "unknown";
  }
  return identifier.length <= 14
    ? identifier
    : `${identifier.slice(0, 4)}…${identifier.slice(-6)}`;
}

function semanticEventsFrom(deliveries) {
  const selected = new Map();
  for (const [index, event] of deliveries.entries()) {
    const key =
      asString(event?.semantic_key) ??
      `delivery:${asString(event?.delivery_key) ?? index}`;
    const existing = selected.get(key);
    if (!existing || (existing.lane !== "primary" && event?.lane === "primary")) {
      selected.set(key, event);
    }
  }
  return [...selected.values()].sort((left, right) => {
    const leftSequence = Number.isFinite(left?.sequence)
      ? left.sequence
      : Number.MAX_SAFE_INTEGER;
    const rightSequence = Number.isFinite(right?.sequence)
      ? right.sequence
      : Number.MAX_SAFE_INTEGER;
    if (leftSequence !== rightSequence) {
      return leftSequence - rightSequence;
    }
    return String(left?.captured_at ?? "").localeCompare(
      String(right?.captured_at ?? ""),
    );
  });
}

function countsByEvent(events) {
  const counts = new Map();
  for (const event of events) {
    const name = asString(event?.event) ?? "Unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function stopObservation(kind, events) {
  const stopEvent = kind === "root" ? "Stop" : "SubagentStop";
  const stops = events.filter((event) => event?.event === stopEvent);
  const initialStops = stops.filter(
    (event) => event?.stop_hook_active === false,
  ).length;
  const continuations = stops.filter(
    (event) => event?.stop_hook_active === true,
  ).length;
  let status = "Observed";
  if (continuations > 0) {
    status = "Continuation completed";
  } else if (initialStops > 0) {
    status = "Initial stop observed";
  } else if (
    events.some((event) =>
      kind === "root"
        ? ["SessionStart", "UserPromptSubmit"].includes(event?.event)
        : event?.event === "SubagentStart",
    )
  ) {
    status = "Started";
  } else if (events.length === 0) {
    status = "Unknown";
  }
  return { status, initialStops, continuations };
}

function timelineEntry(event) {
  const details = [];
  if (asString(event?.tool_name)) {
    details.push(event.tool_name);
  }
  if (event?.stop_hook_active === false) {
    details.push("initial stop");
  } else if (event?.stop_hook_active === true) {
    details.push("continuation stop");
  }
  if (asString(event?.turn_id)) {
    details.push(`turn ${shortIdentifier(event.turn_id)}`);
  }
  return {
    sequence: Number.isFinite(event?.sequence) ? event.sequence : null,
    event: asString(event?.event) ?? "Unknown",
    capturedAt: asString(event?.captured_at),
    details,
  };
}

function nodeView(node, semanticEvents) {
  const kind = node.kind;
  const rawIdentifier =
    kind === "root"
      ? asString(node.session_id) ??
        asString(node.id)?.replace(/^session:/u, "") ??
        null
      : asString(node.agent_id) ??
        asString(node.id)?.replace(/^agent:/u, "") ??
        null;
  const stableIdentifier =
    asString(node.id) ??
    (rawIdentifier
      ? `${kind === "root" ? "session" : "agent"}:${rawIdentifier}`
      : null);
  const relatedEvents = semanticEvents.filter((event) => {
    if (kind === "root") {
      return (
        !asString(event?.agent_id) &&
        (!rawIdentifier || event?.session_id === rawIdentifier)
      );
    }
    return rawIdentifier && event?.agent_id === rawIdentifier;
  });
  const stop = stopObservation(kind, relatedEvents);
  return {
    id: stableIdentifier,
    rawId: rawIdentifier,
    shortId: shortIdentifier(rawIdentifier ?? stableIdentifier),
    kind,
    label:
      asString(node.label) ?? (kind === "root" ? "Root session" : "Subagent"),
    status: stop.status,
    eventCount: relatedEvents.length,
    initialStops: stop.initialStops,
    continuations: stop.continuations,
    eventCounts: countsByEvent(relatedEvents),
    timeline: relatedEvents.map(timelineEntry),
  };
}

export async function loadNormalizedArtifactData(artifactDir) {
  const directory = path.resolve(artifactDir);
  const metadata = await stat(directory);
  if (!metadata.isDirectory()) {
    throw new Error(`Artifact path is not a directory: ${directory}`);
  }
  const [graph, events, summary] = await Promise.all([
    readJsonIfPresent(path.join(directory, "normalized-graph.json"), {
      nodes: [],
      edges: [],
    }),
    readJsonLinesIfPresent(path.join(directory, "normalized-events.jsonl")),
    readJsonIfPresent(path.join(directory, "normalized-summary.json"), {}),
  ]);
  return { artifactDir: directory, graph, events, summary };
}

export function buildLoopViewModel({ graph, events, summary }) {
  const graphObject = asObject(graph);
  const deliveries = asArray(events).filter(
    (event) => event && typeof event === "object",
  );
  const semanticEvents = semanticEventsFrom(deliveries);
  const sourceNodes = asArray(graphObject.nodes).filter(
    (node) =>
      node &&
      typeof node === "object" &&
      ["root", "subagent"].includes(node.kind),
  );
  const nodes = sourceNodes.map((node) => nodeView(node, semanticEvents));
  const nodeIds = new Set(nodes.map((node) => node.id).filter(Boolean));
  const edges = asArray(graphObject.edges)
    .filter(
      (edge) =>
        edge &&
        typeof edge === "object" &&
        edge.kind === "spawned" &&
        nodeIds.has(edge.source) &&
        nodeIds.has(edge.target),
    )
    .map((edge) => ({
      id: asString(edge.id),
      source: asString(edge.source),
      target: asString(edge.target),
      kind: "spawned",
    }));
  const summaryObject = asObject(summary);
  const warnings = [];
  if (asArray(graphObject.nodes).length === 0) {
    warnings.push("normalized-graph.json has no nodes");
  }
  if (deliveries.length === 0) {
    warnings.push("normalized-events.jsonl has no events");
  }
  return {
    schemaVersion: 1,
    counts: {
      deliveries: asCount(summaryObject.total_deliveries, deliveries.length),
      semanticEvents: asCount(
        summaryObject.total_semantic_events,
        semanticEvents.length,
      ),
      graphNodes: asArray(graphObject.nodes).length,
      graphEdges: asArray(graphObject.edges).length,
      agentNodes: nodes.length,
      agentEdges: edges.length,
    },
    deliveryEventCounts: asObject(summaryObject.deliveries_by_event),
    semanticEventCounts: countsByEvent(semanticEvents),
    nodes,
    edges,
    warnings,
  };
}

function jsonForHtml(value) {
  return JSON.stringify(value)
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function nodeButtonMarkup(node) {
  const identifier = asString(node.id);
  const dataIdentifier = identifier
    ? ` data-node-id="${htmlEscape(identifier)}"`
    : "";
  const disabled = identifier ? "" : " disabled";
  const label = `${node.label}, ${node.kind}, ${node.shortId}`;
  return `<button class="btn viz-tile" type="button"${dataIdentifier} data-kind="${htmlEscape(node.kind)}" aria-label="${htmlEscape(label)}" aria-pressed="false"${disabled}>
  <span class="loop-node-content">
    <strong>${node.kind === "root" ? "Root" : "Subagent"}</strong>
    <code>${htmlEscape(node.shortId)}</code>
    <span class="text-small">${htmlEscape(node.status)} · ${node.eventCount} events</span>
  </span>
</button>`;
}

export function renderInlineVisualization(viewModel) {
  const data = jsonForHtml(viewModel);
  const rootNodes = viewModel.nodes
    .filter((node) => node.kind === "root")
    .map(nodeButtonMarkup)
    .join("\n");
  const subagentNodes = viewModel.nodes
    .filter((node) => node.kind === "subagent")
    .map(nodeButtonMarkup)
    .join("\n");
  return `<div id="looperators-agent-loop-p06">
  <div class="viz-row loop-overview" aria-label="Snapshot totals">
    <span class="viz-badge" id="loop-delivery-count"></span>
    <span class="viz-badge" id="loop-semantic-count"></span>
    <span class="viz-badge" id="loop-agent-count"></span>
    <span class="viz-badge" id="loop-edge-count"></span>
  </div>

  <div class="viz-controls" aria-label="Agent Loop controls">
    <label class="form-label" for="loop-filter">Show
      <select class="form-select" id="loop-filter" aria-label="Filter Agent Loop nodes">
        <option value="all">All agents</option>
        <option value="root">Root only</option>
        <option value="subagent">Subagents only</option>
      </select>
    </label>
    <div class="viz-row" role="group" aria-label="Zoom controls">
      <button class="btn" id="loop-zoom-out" type="button" aria-label="Zoom out">Zoom out</button>
      <output id="loop-zoom-value" aria-live="polite">100%</output>
      <button class="btn" id="loop-zoom-in" type="button" aria-label="Zoom in">Zoom in</button>
      <button class="btn btn-ghost" id="loop-zoom-reset" type="button" aria-label="Reset zoom">Reset</button>
    </div>
  </div>

  <div class="loop-stage-viewport" id="loop-stage-viewport">
    <div class="loop-stage" id="loop-stage" role="group" aria-label="Agent Loop graph">
      <div class="loop-lane" id="loop-root-lane" aria-label="Root agent">
${rootNodes}
      </div>
      <div class="loop-edge" id="loop-edge-label" aria-label="Spawned relationships"></div>
      <div class="loop-lane loop-subagents" id="loop-subagent-lane" aria-label="Subagents">
${subagentNodes}
      </div>
      <p class="text-muted loop-empty" id="loop-empty" hidden>No matching agent nodes were recorded.</p>
    </div>
  </div>

  <section class="card loop-details" id="loop-details" aria-live="polite" aria-label="Selected node details">
    <div class="viz-row loop-detail-heading">
      <strong id="loop-detail-label">Select a node</strong>
      <span class="viz-badge" id="loop-detail-status">No selection</span>
    </div>
    <p class="text-small"><code id="loop-detail-id">No stable identifier selected</code></p>
    <p class="text-small" id="loop-detail-counts">Select a recorded root or subagent to inspect its events.</p>
    <div id="loop-event-counts"></div>
    <ol class="loop-timeline" id="loop-timeline"></ol>
    <div class="viz-row">
      <button class="btn btn-primary" id="loop-follow-up" type="button" aria-label="Ask Codex about selected node" disabled>Ask Codex about selected node</button>
      <span class="text-small" id="loop-follow-up-status" role="status">Select a node first.</span>
    </div>
  </section>

  <div class="loop-acceptance" aria-label="P0.6 acceptance status">
    <div class="viz-row">
      <strong>P0.6 acceptance</strong>
      <span class="viz-badge" data-check="js">JS ready: pending</span>
      <span class="viz-badge" data-check="selected">node selected: pending</span>
      <span class="viz-badge" data-check="details">details updated: pending</span>
      <span class="viz-badge" data-check="zoom">zoom changed/reset: pending</span>
      <span class="viz-badge" data-check="filter">filter changed: pending</span>
      <span class="viz-badge" data-check="followup">follow-up requested: pending</span>
    </div>
    <label class="form-label" for="loop-acceptance-summary">Return summary</label>
    <textarea class="form-control" id="loop-acceptance-summary" rows="2" readonly aria-label="Copyable P0.6 acceptance summary"></textarea>
  </div>

  <p class="text-small text-muted loop-footer">Interactive snapshot · local controls · no live network/tool calls</p>
  <p class="text-small text-destructive" id="loop-source-warning" hidden></p>
</div>

<script type="application/json" id="looperators-agent-loop-p06-data">${data}</script>
<style>
  #looperators-agent-loop-p06 {
    color: var(--foreground);
    min-width: 0;
    max-width: 100%;
    overflow-wrap: anywhere;
  }
  #looperators-agent-loop-p06 .loop-overview,
  #looperators-agent-loop-p06 .viz-controls,
  #looperators-agent-loop-p06 .loop-acceptance,
  #looperators-agent-loop-p06 .loop-footer {
    margin-top: 0.75rem;
  }
  #looperators-agent-loop-p06 .loop-stage-viewport {
    max-width: 100%;
    overflow: hidden;
    margin-top: 0.75rem;
  }
  #looperators-agent-loop-p06 .loop-stage {
    width: 100%;
    transform-origin: top left;
  }
  #looperators-agent-loop-p06 .loop-lane {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
    gap: 0.5rem;
    min-width: 0;
  }
  #looperators-agent-loop-p06 .loop-node-content {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
    text-align: left;
  }
  #looperators-agent-loop-p06 .loop-node-content code {
    overflow-wrap: anywhere;
  }
  #looperators-agent-loop-p06 .loop-edge {
    color: var(--muted-foreground);
    text-align: center;
    margin: 0.5rem 0;
  }
  #looperators-agent-loop-p06 .loop-details {
    margin-top: 0.75rem;
    min-width: 0;
  }
  #looperators-agent-loop-p06 .loop-detail-heading {
    justify-content: space-between;
  }
  #looperators-agent-loop-p06 .loop-timeline {
    margin: 0.5rem 0;
    padding-inline-start: 1.25rem;
  }
  #looperators-agent-loop-p06 .loop-timeline li + li {
    margin-top: 0.25rem;
  }
  #looperators-agent-loop-p06 .loop-empty {
    text-align: center;
  }
  #looperators-agent-loop-p06 textarea {
    max-width: 100%;
    resize: vertical;
  }
  @media (max-width: 420px) {
    #looperators-agent-loop-p06 .loop-detail-heading {
      align-items: flex-start;
    }
  }
</style>
<script>
(() => {
  "use strict";
  const root = document.getElementById("looperators-agent-loop-p06");
  const dataElement = document.getElementById("looperators-agent-loop-p06-data");
  if (!root || !dataElement) return;

  const model = JSON.parse(dataElement.textContent);
  const byId = new Map(model.nodes.filter((node) => node.id).map((node) => [node.id, node]));
  const checks = {
    js: "pending",
    selected: "pending",
    details: "pending",
    zoom: "pending",
    filter: "pending",
    followup: "pending",
  };
  let selectedId = null;
  let zoom = 1;
  let zoomChanged = false;

  const elements = {
    deliveryCount: root.querySelector("#loop-delivery-count"),
    semanticCount: root.querySelector("#loop-semantic-count"),
    agentCount: root.querySelector("#loop-agent-count"),
    edgeCount: root.querySelector("#loop-edge-count"),
    filter: root.querySelector("#loop-filter"),
    viewport: root.querySelector("#loop-stage-viewport"),
    stage: root.querySelector("#loop-stage"),
    rootLane: root.querySelector("#loop-root-lane"),
    subagentLane: root.querySelector("#loop-subagent-lane"),
    edgeLabel: root.querySelector("#loop-edge-label"),
    empty: root.querySelector("#loop-empty"),
    detailLabel: root.querySelector("#loop-detail-label"),
    detailStatus: root.querySelector("#loop-detail-status"),
    detailId: root.querySelector("#loop-detail-id"),
    detailCounts: root.querySelector("#loop-detail-counts"),
    eventCounts: root.querySelector("#loop-event-counts"),
    timeline: root.querySelector("#loop-timeline"),
    followUp: root.querySelector("#loop-follow-up"),
    followUpStatus: root.querySelector("#loop-follow-up-status"),
    zoomValue: root.querySelector("#loop-zoom-value"),
    summary: root.querySelector("#loop-acceptance-summary"),
    warning: root.querySelector("#loop-source-warning"),
  };

  function setText(element, value) {
    element.textContent = String(value);
  }

  function updateAcceptance() {
    for (const [name, state] of Object.entries(checks)) {
      const badge = root.querySelector('[data-check="' + name + '"]');
      badge.textContent =
        badge.textContent.split(":")[0] + ": " + state;
    }
    const labels = {
      js: "JS ready",
      selected: "node selected",
      details: "details updated",
      zoom: "zoom changed/reset",
      filter: "filter changed",
      followup: "follow-up requested",
    };
    elements.summary.value =
      "P0.6 | " +
      Object.entries(checks)
        .map(([name, state]) => labels[name] + "=" + state)
        .join("; ");
  }

  function appendText(parent, tagName, text, className) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function renderNodes() {
    for (const button of root.querySelectorAll("[data-node-id]")) {
      button.addEventListener("click", () => selectNode(button.dataset.nodeId));
    }
    setText(
      elements.edgeLabel,
      model.counts.agentEdges === 1
        ? "↓ 1 recorded spawned edge"
        : "↓ " + model.counts.agentEdges + " recorded spawned edges",
    );
    applyFilter(false);
  }

  function eventCountText(node) {
    const entries = Object.entries(node.eventCounts);
    return entries.length
      ? entries.map(([name, count]) => name + " " + count).join(" · ")
      : "No related semantic events recorded.";
  }

  function renderDetails(node) {
    setText(elements.detailLabel, node.label + " · " + node.shortId);
    setText(elements.detailStatus, node.status);
    setText(elements.detailId, node.id || "Stable identifier unavailable");
    setText(
      elements.detailCounts,
      node.eventCount +
        " semantic events · initial stops " +
        node.initialStops +
        " · continuations " +
        node.continuations,
    );
    setText(elements.eventCounts, eventCountText(node));
    elements.timeline.replaceChildren();
    for (const entry of node.timeline) {
      const line = document.createElement("li");
      const time = entry.capturedAt ? entry.capturedAt : "time unavailable";
      const suffix = entry.details.length ? " · " + entry.details.join(" · ") : "";
      line.textContent = time + " · " + entry.event + suffix;
      elements.timeline.append(line);
    }
    if (node.timeline.length === 0) {
      appendText(elements.timeline, "li", "No related timeline entries recorded.");
    }
    elements.followUp.disabled = !node.id;
    setText(
      elements.followUpStatus,
      node.id ? "Ready to request a Codex explanation." : "Stable identifier unavailable.",
    );
  }

  function selectNode(id) {
    const node = byId.get(id);
    if (!node) return;
    selectedId = id;
    for (const button of root.querySelectorAll("[data-node-id]")) {
      button.setAttribute("aria-pressed", String(button.dataset.nodeId === id));
    }
    renderDetails(node);
    checks.selected = "pass";
    checks.details = "pass";
    updateAcceptance();
  }

  function resizeStage() {
    elements.viewport.style.height = "";
    requestAnimationFrame(() => {
      elements.viewport.style.height =
        Math.ceil(elements.stage.getBoundingClientRect().height) + "px";
    });
  }

  function applyZoom(nextZoom, action) {
    zoom = Math.max(0.8, Math.min(1.25, nextZoom));
    elements.stage.style.width = 100 / zoom + "%";
    elements.stage.style.transform = "scale(" + zoom + ")";
    setText(elements.zoomValue, Math.round(zoom * 100) + "%");
    if (action === "change") zoomChanged = true;
    if (action === "reset" && zoomChanged && zoom === 1) checks.zoom = "pass";
    resizeStage();
    updateAcceptance();
  }

  function applyFilter(markChanged = true) {
    const value = elements.filter.value;
    let visibleCount = 0;
    for (const button of root.querySelectorAll("[data-node-id]")) {
      const visible = value === "all" || button.dataset.kind === value;
      button.hidden = !visible;
      button.style.display = visible ? "" : "none";
      if (visible) visibleCount += 1;
    }
    elements.rootLane.hidden = value === "subagent";
    elements.rootLane.style.display = value === "subagent" ? "none" : "";
    elements.subagentLane.hidden = value === "root";
    elements.subagentLane.style.display = value === "root" ? "none" : "";
    elements.edgeLabel.hidden = value !== "all" || model.counts.agentEdges === 0;
    elements.edgeLabel.style.display =
      value !== "all" || model.counts.agentEdges === 0 ? "none" : "";
    elements.empty.hidden = visibleCount !== 0;
    elements.empty.style.display = visibleCount === 0 ? "" : "none";
    if (markChanged) checks.filter = "pass";
    resizeStage();
    updateAcceptance();
  }

  root.querySelector("#loop-zoom-in").addEventListener("click", () => {
    applyZoom(zoom + 0.1, "change");
  });
  root.querySelector("#loop-zoom-out").addEventListener("click", () => {
    applyZoom(zoom - 0.1, "change");
  });
  root.querySelector("#loop-zoom-reset").addEventListener("click", () => {
    applyZoom(1, "reset");
  });
  elements.filter.addEventListener("change", () => applyFilter(true));
  window.addEventListener("resize", resizeStage);
  if (typeof ResizeObserver === "function") {
    const stageObserver = new ResizeObserver(resizeStage);
    stageObserver.observe(elements.stage);
  }

  elements.followUp.addEventListener("click", async () => {
    const node = byId.get(selectedId);
    if (!node || !node.id) return;
    elements.followUp.disabled = true;
    setText(elements.followUpStatus, "Waiting for follow-up confirmation…");
    const prompt =
      'Explain the looperators Agent Loop node with stable identifier "' +
      node.id +
      '". Its observed kind is "' +
      node.kind +
      '", snapshot status is "' +
      node.status +
      '", and the snapshot records ' +
      node.eventCount +
      " semantic events, " +
      node.initialStops +
      " initial stops, and " +
      node.continuations +
      " continuation stops. Explain this node's role and state in the loop, separating recorded facts from inference.";
    const title = "Explain loop node " + node.shortId;
    try {
      if (
        !window.openai ||
        typeof window.openai.sendFollowUpMessage !== "function"
      ) {
        throw new Error("Codex follow-up host API is unavailable");
      }
      await window.openai.sendFollowUpMessage({ prompt, title });
      checks.followup = "pass";
      setText(elements.followUpStatus, "Follow-up requested.");
    } catch (error) {
      checks.followup = "fail";
      const message =
        error && typeof error.message === "string"
          ? error.message
          : "request canceled or failed";
      setText(elements.followUpStatus, "Follow-up canceled or failed: " + message);
    } finally {
      elements.followUp.disabled = false;
      updateAcceptance();
    }
  });

  setText(elements.deliveryCount, model.counts.deliveries + " deliveries");
  setText(elements.semanticCount, model.counts.semanticEvents + " semantic events");
  setText(elements.agentCount, model.counts.agentNodes + " agent nodes");
  setText(elements.edgeCount, model.counts.agentEdges + " spawned edges");
  if (model.warnings.length) {
    elements.warning.hidden = false;
    setText(elements.warning, model.warnings.join(" · "));
  }
  renderNodes();
  applyZoom(1, "initial");
  checks.js = "pass";
  updateAcceptance();
})();
</script>
`;
}

async function assertSafeOutput(outputPath) {
  const output = path.resolve(outputPath);
  if (!OUTPUT_NAME_PATTERN.test(path.basename(output))) {
    throw new Error(
      `Output filename must be lowercase ASCII hyphenated HTML: ${output}`,
    );
  }
  const parent = path.dirname(output);
  const parentMetadata = await lstat(parent);
  if (parentMetadata.isSymbolicLink()) {
    throw new Error(`Refusing to write through output directory symlink: ${parent}`);
  }
  if (!parentMetadata.isDirectory()) {
    throw new Error(`Output parent is not a directory: ${parent}`);
  }
  let metadata = null;
  try {
    metadata = await lstat(output);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (metadata?.isSymbolicLink()) {
    throw new Error(`Refusing to replace output symlink: ${output}`);
  }
  if (metadata && !metadata.isFile()) {
    throw new Error(`Output is not a regular file: ${output}`);
  }
  return output;
}

export async function writeInlineVisualization(outputPath, fragment) {
  const output = await assertSafeOutput(outputPath);
  const bytes = Buffer.byteLength(fragment);
  if (bytes >= MAX_FRAGMENT_BYTES) {
    throw new Error(
      `Inline visualization is ${bytes} bytes; limit is ${MAX_FRAGMENT_BYTES - 1}`,
    );
  }
  const temporary = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(fragment, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, output);
  } finally {
    if (handle) {
      await handle.close();
    }
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return { output, bytes };
}

export async function generateInlineVisualization({ artifactDir, outputPath }) {
  const source = await loadNormalizedArtifactData(artifactDir);
  const viewModel = buildLoopViewModel(source);
  const fragment = renderInlineVisualization(viewModel);
  const written = await writeInlineVisualization(outputPath, fragment);
  return { ...written, viewModel };
}

async function main() {
  const artifactDir = argument("artifact-dir");
  const outputPath = argument("output");
  if (!artifactDir || !outputPath) {
    throw new Error(
      "Usage: generate-inline-visualization.mjs --artifact-dir <directory> --output <looperators-agent-loop.html>",
    );
  }
  const result = await generateInlineVisualization({ artifactDir, outputPath });
  process.stdout.write(
    `${JSON.stringify({
      output: result.output,
      bytes: result.bytes,
      counts: result.viewModel.counts,
      warnings: result.viewModel.warnings,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
