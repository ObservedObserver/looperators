import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildLoopViewModel,
  generateInlineVisualization,
  loadNormalizedArtifactData,
  renderInlineVisualization,
} from "../scripts/generate-inline-visualization.mjs";
import { createRecordedArtifactFixture } from "./recorded-artifact-fixture.mjs";

test("generator projects the recorded three agents and two spawned edges", async () => {
  const recordedArtifactDir = await createRecordedArtifactFixture();
  const source = await loadNormalizedArtifactData(recordedArtifactDir);
  const model = buildLoopViewModel(source);

  assert.deepEqual(model.counts, {
    deliveries: 22,
    semanticEvents: 18,
    graphNodes: 7,
    graphEdges: 6,
    agentNodes: 3,
    agentEdges: 2,
  });
  assert.deepEqual(
    model.nodes.map((node) => node.id),
    [
      "session:019f9a38-9f26-71d0-b908-df3626a5d40c",
      "agent:019f9a39-0485-75f0-b6cf-8beba2cc59cd",
      "agent:019f9a39-1681-7b90-98e1-55ac153248dd",
    ],
  );
  assert.equal(model.edges.every((edge) => edge.kind === "spawned"), true);
  assert.deepEqual(model.semanticEventCounts, {
    PostToolUse: 4,
    PreToolUse: 4,
    SessionStart: 1,
    Stop: 2,
    SubagentStart: 2,
    SubagentStop: 4,
    UserPromptSubmit: 1,
  });
  for (const node of model.nodes) {
    assert.equal(node.status, "Continuation completed");
    assert.equal(node.initialStops, 1);
    assert.equal(node.continuations, 1);
  }
  assert.equal(model.warnings.length, 0);
});

test("generated output is a deterministic, network-free inline fragment with real data", async () => {
  const recordedArtifactDir = await createRecordedArtifactFixture();
  const source = await loadNormalizedArtifactData(recordedArtifactDir);
  const model = buildLoopViewModel(source);
  const first = renderInlineVisualization(model);
  const second = renderInlineVisualization(model);

  assert.equal(first, second);
  assert.equal(Buffer.byteLength(first) < 2 * 1024 * 1024, true);
  assert.doesNotMatch(first, /<!doctype|<html(?:\s|>)|<head(?:\s|>)|<body(?:\s|>)/iu);
  assert.doesNotMatch(first, /\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  assert.doesNotMatch(first, /expandable|Static thread-scoped|display-only/u);
  assert.match(
    first,
    /Interactive snapshot · local controls · no live network\/tool calls/u,
  );
  assert.match(first, /window\.openai\.sendFollowUpMessage/u);
  assert.match(first, /session:019f9a38-9f26-71d0-b908-df3626a5d40c/u);
  assert.match(first, /agent:019f9a39-0485-75f0-b6cf-8beba2cc59cd/u);
  assert.match(first, /agent:019f9a39-1681-7b90-98e1-55ac153248dd/u);
  assert.match(first, /"PreToolUse":4/u);
  assert.match(first, /"SubagentStop":4/u);
  assert.match(first, /<button class="btn viz-tile"/u);
  assert.match(first, /aria-label="Ask Codex about selected node"/u);
});

test("generator degrades to an empty observed snapshot and rejects output symlinks", async () => {
  const artifactDir = await mkdtemp(
    path.join(os.tmpdir(), "looperators-p0-empty-artifacts-"),
  );
  const outputDir = await mkdtemp(
    path.join(os.tmpdir(), "looperators-p0-inline-output-"),
  );
  const output = path.join(outputDir, "looperators-agent-loop.html");
  const result = await generateInlineVisualization({
    artifactDir,
    outputPath: output,
  });
  assert.equal(result.viewModel.counts.agentNodes, 0);
  assert.equal(result.viewModel.counts.agentEdges, 0);
  assert.deepEqual(result.viewModel.nodes, []);
  assert.deepEqual(result.viewModel.edges, []);
  assert.deepEqual(result.viewModel.warnings, [
    "normalized-graph.json has no nodes",
    "normalized-events.jsonl has no events",
  ]);
  assert.match(
    await readFile(output, "utf8"),
    /No matching agent nodes were recorded/u,
  );
  assert.equal((await lstat(output)).mode & 0o777, 0o600);

  const targetDir = path.join(outputDir, "target");
  await mkdir(targetDir);
  const symlinkOutput = path.join(outputDir, "symlink-output.html");
  await symlink(path.join(targetDir, "missing.html"), symlinkOutput);
  await assert.rejects(
    generateInlineVisualization({
      artifactDir,
      outputPath: symlinkOutput,
    }),
    /Refusing to replace output symlink/u,
  );
});
