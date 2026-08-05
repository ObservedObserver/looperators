import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { digestJson } from "../lib/canonical-json.mjs";
import {
  renderSidecarDocument,
} from "../lib/graph-view.mjs";
import {
  projectionToAgentGraphModel,
} from "../lib/projection-to-graph-model.mjs";

const assets = new URL("../ui/assets/", import.meta.url);

async function pairedScenarios() {
  return JSON.parse(
    await readFile(
      new URL("paired-scenarios.json", assets),
      "utf8",
    ),
  );
}

async function validProjection() {
  const fixture = JSON.parse(
    await readFile(
      new URL(
        "fixtures/schema/graph-projection-valid.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const { projectionDigest: _ignored, ...base } = fixture;
  return {
    ...base,
    projectionDigest: digestJson(base),
  };
}

test("plugin adapter maps every shared paired fixture exactly", async () => {
  const scenarios = await pairedScenarios();
  assert.equal(scenarios.length, 7);
  for (const scenario of scenarios) {
    assert.deepEqual(
      projectionToAgentGraphModel(scenario.projection, {
        expectedProjectionDigest:
          scenario.projection.projectionDigest,
        expectedRunId: scenario.projection.runId,
      }),
      scenario.expectedModel,
      scenario.name,
    );
  }
});

test("plugin adapter rejects unverified, invalid, drifted, and cross-run input", async () => {
  const [{ projection }] = await pairedScenarios();
  assert.throws(
    () =>
      projectionToAgentGraphModel({
        ...projection,
        integrity: {
          ...projection.integrity,
          status: "unverified",
        },
      }),
    { code: "GRAPH_VIEW_PROJECTION_UNVERIFIED" },
  );
  assert.throws(
    () =>
      projectionToAgentGraphModel({
        ...projection,
        edges: projection.edges.slice(1),
      }),
    { code: "GRAPH_VIEW_PROJECTION_INVALID" },
  );
  assert.throws(
    () =>
      projectionToAgentGraphModel(projection, {
        expectedProjectionDigest: "0".repeat(64),
      }),
    { code: "PROJECTION_DIGEST_MISMATCH" },
  );
  assert.throws(
    () =>
      projectionToAgentGraphModel(projection, {
        expectedRunId: "run-other",
      }),
    { code: "SNAPSHOT_IDENTITY_MISMATCH" },
  );
});

test("plugin sidecar ships the bounded shared ReactFlow production UI", async () => {
  const projection = await validProjection();
  const sidecar = renderSidecarDocument(projection, {
    eventsUrl: "/runs/run-projection-fixture/events",
    controlUrl: "/runs/run-projection-fixture/control",
    csrfToken: "c".repeat(43),
  });
  const [script, style] = await Promise.all([
    readFile(new URL("agent-loop-ui.iife.js", assets), "utf8"),
    readFile(new URL("agent-loop-ui.css", assets), "utf8"),
  ]);
  const [scriptStat, styleStat] = await Promise.all([
    stat(new URL("agent-loop-ui.iife.js", assets)),
    stat(new URL("agent-loop-ui.css", assets)),
  ]);

  assert.ok(
    Buffer.byteLength(sidecar, "utf8") < 2 * 1024 * 1024,
  );
  assert.ok(
    scriptStat.size + styleStat.size < 1.5 * 1024 * 1024,
  );
  assert.match(sidecar, /looperators-agent-loop-root/u);
  assert.match(sidecar, /looperators-agent-loop-fallback/u);
  assert.match(sidecar, /looperatorsAgentLoopView/u);
  assert.match(sidecar, /Agent Loop relationship graph/u);
  assert.match(sidecar, /react-flow__node/u);
  assert.match(sidecar, /\bResizeObserver\b/u);
  assert.match(sidecar, /\bcreateRoot\b/u);
  assert.match(sidecar, /new EventSource/u);
  assert.match(sidecar, /fetch\(/u);
  assert.doesNotMatch(sidecar, /looperators-inline-agent-graph/u);
  assert.doesNotMatch(
    sidecar,
    /(?:src|href)\s*=\s*["']https?:/iu,
  );
  assert.doesNotMatch(style, /(^|\})\s*(?::root|\*|body)\s*\{/u);
  assert.doesNotMatch(sidecar, /host\.callTool\s*=/u);
  assert.doesNotMatch(script, /\bprocess\.env\b/u);
  assert.equal(
    JSON.parse(
      sidecar.match(
        /id="looperators-agent-loop-data">([^<]+)<\/script>/u,
      )[1],
    ).expectedProjectionDigest,
    projection.projectionDigest,
  );
  assert.match(script, /react-flow__renderer/u);
});

test("default review skill uses only cooperative typed MCP product tools", async () => {
  const skill = await readFile(
    new URL("../skills/review-until-clean/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(skill, /`roleCapability`/u);
  assert.match(skill, /Default looperators has no Hooks/u);
  assert.doesNotMatch(
    skill,
    /looperators_(?:prepare_worker_spawn|bind_worker|render_graph)/u,
  );
  assert.doesNotMatch(skill, /codex-inline-vis/u);
});
