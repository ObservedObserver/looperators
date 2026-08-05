import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const rootSessionId = "019f9a38-9f26-71d0-b908-df3626a5d40c";
const agentIds = [
  "019f9a39-0485-75f0-b6cf-8beba2cc59cd",
  "019f9a39-1681-7b90-98e1-55ac153248dd",
];
const toolIds = ["bash", "spawn-a", "spawn-b", "wait"];

function fixtureEvents() {
  const events = [];
  let semanticSequence = 0;
  const add = (event, fields = {}, duplicate = false) => {
    const semanticKey = `fixture:${semanticSequence}:${event}`;
    const base = {
      schema_version: 1,
      event,
      session_id: rootSessionId,
      semantic_key: semanticKey,
      captured_at: `2026-07-25T17:01:${String(semanticSequence).padStart(2, "0")}.000Z`,
      ...fields,
    };
    events.push({
      ...base,
      sequence: events.length,
      lane: "primary",
      delivery_key: `${semanticKey}:primary`,
    });
    if (duplicate) {
      events.push({
        ...base,
        sequence: events.length,
        lane: "parallel",
        delivery_key: `${semanticKey}:parallel`,
      });
    }
    semanticSequence += 1;
  };

  add("SessionStart", { source: "startup" });
  add("UserPromptSubmit");
  for (const toolId of toolIds) {
    add(
      "PreToolUse",
      { tool_use_id: `tool-${toolId}`, tool_name: toolId },
      true,
    );
    add("PostToolUse", {
      tool_use_id: `tool-${toolId}`,
      tool_name: toolId,
    });
  }
  for (const agentId of agentIds) {
    add("SubagentStart", { agent_id: agentId, agent_type: "default" });
  }
  for (const agentId of agentIds) {
    add("SubagentStop", { agent_id: agentId, stop_hook_active: false });
    add("SubagentStop", { agent_id: agentId, stop_hook_active: true });
  }
  add("Stop", { stop_hook_active: false });
  add("Stop", { stop_hook_active: true });
  return events;
}

function fixtureGraph() {
  const rootId = `session:${rootSessionId}`;
  const toolNodes = toolIds.map((toolId) => ({
    id: `tool:${toolId}`,
    kind: "tool",
    label: toolId,
    tool_use_id: `tool-${toolId}`,
  }));
  const agentNodes = agentIds.map((agentId) => ({
    id: `agent:${agentId}`,
    kind: "subagent",
    label: "default",
    agent_id: agentId,
  }));
  return {
    schema_version: 1,
    nodes: [
      {
        id: rootId,
        kind: "root",
        label: "Root session",
        session_id: rootSessionId,
      },
      ...toolNodes,
      ...agentNodes,
    ],
    edges: [
      ...toolNodes.map((node) => ({
        id: `${rootId}->${node.id}:used`,
        source: rootId,
        target: node.id,
        kind: "used",
      })),
      ...agentNodes.map((node) => ({
        id: `${rootId}->${node.id}:spawned`,
        source: rootId,
        target: node.id,
        kind: "spawned",
      })),
    ],
  };
}

export async function createRecordedArtifactFixture() {
  const artifactDir = await mkdtemp(
    path.join(os.tmpdir(), "looperators-p0-recorded-artifacts-"),
  );
  const events = fixtureEvents();
  await Promise.all([
    writeFile(
      path.join(artifactDir, "normalized-graph.json"),
      `${JSON.stringify(fixtureGraph(), null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(artifactDir, "normalized-events.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    ),
    writeFile(
      path.join(artifactDir, "normalized-summary.json"),
      `${JSON.stringify(
        {
          schema_version: 1,
          total_deliveries: events.length,
          total_semantic_events: 18,
          deliveries_by_event: {
            PostToolUse: 4,
            PreToolUse: 8,
            SessionStart: 1,
            Stop: 2,
            SubagentStart: 2,
            SubagentStop: 4,
            UserPromptSubmit: 1,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
  ]);
  return artifactDir;
}
