#!/usr/bin/env node

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { atomicWriteJson, P0_EVENTS } from "../lib/event-utils.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readRecords(directory) {
  let names = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const records = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    const record = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    records.push({ ...record, evidence_file: `hook-events/${name}` });
  }
  return records.sort((left, right) => {
    const wall = left.captured_at.localeCompare(right.captured_at);
    if (wall !== 0) {
      return wall;
    }
    return BigInt(left.started_monotonic_ns) < BigInt(right.started_monotonic_ns)
      ? -1
      : 1;
  });
}

function normalizedRecord(record, sequence) {
  const input = record.input ?? {};
  return {
    schema_version: 1,
    sequence,
    event: input.hook_event_name ?? "Unknown",
    session_id: input.session_id ?? null,
    turn_id: input.turn_id ?? null,
    tool_use_id: input.tool_use_id ?? null,
    tool_name: input.tool_name ?? null,
    agent_id: input.agent_id ?? null,
    agent_type: input.agent_type ?? null,
    stop_hook_active: input.stop_hook_active ?? null,
    source: input.source ?? null,
    lane: record.lane,
    semantic_key: record.semantic_key,
    delivery_key: record.delivery_key,
    captured_at: record.captured_at,
    duration_ms: record.duration_ms,
    input_fields: Object.keys(input).sort(),
    evidence_file: record.evidence_file,
  };
}

function buildGraph(events) {
  const nodeMap = new Map();
  const edgeMap = new Map();
  const addNode = (id, kind, label, fields = {}) => {
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, kind, label, ...fields });
    }
  };
  const addEdge = (source, target, kind, fields = {}) => {
    const id = `${source}->${target}:${kind}`;
    if (!edgeMap.has(id)) {
      edgeMap.set(id, { id, source, target, kind, ...fields });
    }
  };

  for (const event of events) {
    if (!event.session_id) {
      continue;
    }
    const sessionId = `session:${event.session_id}`;
    addNode(sessionId, "root", "Root session", { session_id: event.session_id });
    if (event.agent_id) {
      const agentId = `agent:${event.agent_id}`;
      addNode(agentId, "subagent", event.agent_type ?? "Subagent", {
        agent_id: event.agent_id,
      });
      addEdge(sessionId, agentId, "spawned");
    }
    if (event.tool_use_id) {
      const toolId = `tool:${event.tool_use_id}`;
      addNode(toolId, "tool", event.tool_name ?? "Tool", {
        tool_use_id: event.tool_use_id,
      });
      addEdge(sessionId, toolId, "used");
    }
  }
  return {
    schema_version: 1,
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
  };
}

function analyzeConcurrency(records) {
  const groups = new Map();
  for (const record of records) {
    const list = groups.get(record.semantic_key) ?? [];
    list.push(record);
    groups.set(record.semantic_key, list);
  }
  const probes = [];
  for (const [semanticKey, group] of groups) {
    if (new Set(group.map((entry) => entry.lane)).size < 2) {
      continue;
    }
    const intervals = group.map((entry) => ({
      lane: entry.lane,
      start: BigInt(entry.started_monotonic_ns),
      finish: BigInt(entry.finished_monotonic_ns),
    }));
    let overlaps = false;
    for (let left = 0; left < intervals.length; left += 1) {
      for (let right = left + 1; right < intervals.length; right += 1) {
        overlaps ||= (
          intervals[left].start < intervals[right].finish &&
          intervals[right].start < intervals[left].finish
        );
      }
    }
    probes.push({
      semantic_key: semanticKey,
      lanes: intervals.map((entry) => entry.lane).sort(),
      overlaps,
      start_spread_ms:
        Number(
          intervals.reduce(
            (maximum, entry) => (entry.start > maximum ? entry.start : maximum),
            intervals[0].start,
          ) -
            intervals.reduce(
              (minimum, entry) => (entry.start < minimum ? entry.start : minimum),
              intervals[0].start,
            ),
        ) / 1e6,
    });
  }
  return probes;
}

function analyzeSubagentOverlap(events) {
  const lifetimes = new Map();
  for (const event of events) {
    if (!event.agent_id) {
      continue;
    }
    const lifetime = lifetimes.get(event.agent_id) ?? {
      agent_id: event.agent_id,
      start: null,
      initial_stop: null,
      continuation_stop: null,
    };
    if (event.event === "SubagentStart") {
      lifetime.start = Date.parse(event.captured_at);
    } else if (event.event === "SubagentStop" && event.stop_hook_active === true) {
      lifetime.continuation_stop = Date.parse(event.captured_at);
    } else if (event.event === "SubagentStop") {
      lifetime.initial_stop = Date.parse(event.captured_at);
    }
    lifetimes.set(event.agent_id, lifetime);
  }
  const completed = [...lifetimes.values()].filter(
    (entry) => entry.start !== null && (entry.continuation_stop ?? entry.initial_stop) !== null,
  );
  const overlaps = [];
  for (let left = 0; left < completed.length; left += 1) {
    for (let right = left + 1; right < completed.length; right += 1) {
      const leftStop =
        completed[left].continuation_stop ?? completed[left].initial_stop;
      const rightStop =
        completed[right].continuation_stop ?? completed[right].initial_stop;
      const overlapMs =
        Math.min(leftStop, rightStop) -
        Math.max(completed[left].start, completed[right].start);
      overlaps.push({
        agents: [completed[left].agent_id, completed[right].agent_id].sort(),
        overlaps: overlapMs > 0,
        overlap_ms: Math.max(0, overlapMs),
      });
    }
  }
  return {
    lifetimes: completed.map((entry) => ({
      agent_id: entry.agent_id,
      start: new Date(entry.start).toISOString(),
      initial_stop: entry.initial_stop
        ? new Date(entry.initial_stop).toISOString()
        : null,
      continuation_stop: entry.continuation_stop
        ? new Date(entry.continuation_stop).toISOString()
        : null,
    })),
    overlaps,
  };
}

export async function normalizeArtifactDirectory(artifactDir) {
  const records = await readRecords(path.join(artifactDir, "hook-events"));
  const events = records.map(normalizedRecord);
  const deliveriesByEvent = Object.fromEntries(
    [...new Set(events.map((event) => event.event))]
      .sort()
      .map((eventName) => [
        eventName,
        events.filter((event) => event.event === eventName).length,
      ]),
  );
  const semanticCounts = new Map();
  for (const event of events) {
    semanticCounts.set(
      event.semantic_key,
      (semanticCounts.get(event.semantic_key) ?? 0) + 1,
    );
  }
  const continuationPairs = events
    .filter((event) => ["Stop", "SubagentStop"].includes(event.event))
    .reduce((result, event) => {
      const key = [
        event.session_id,
        event.turn_id,
        event.event,
        event.agent_id ?? "-",
      ].join(":");
      const current = result[key] ?? { initial: 0, continuation: 0 };
      current[event.stop_hook_active === true ? "continuation" : "initial"] += 1;
      result[key] = current;
      return result;
    }, {});
  const summary = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    total_deliveries: events.length,
    total_semantic_events: semanticCounts.size,
    deliveries_by_event: deliveriesByEvent,
    required_event_coverage: Object.fromEntries(
      P0_EVENTS.map((eventName) => [
        eventName,
        (deliveriesByEvent[eventName] ?? 0) > 0,
      ]),
    ),
    semantic_duplicate_groups: [...semanticCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([semantic_key, count]) => ({ semantic_key, count })),
    concurrency_probes: analyzeConcurrency(records),
    subagent_concurrency: analyzeSubagentOverlap(events),
    continuation_pairs: continuationPairs,
    transcript_paths: [
      ...new Set(
        records
          .map((record) => record.input?.transcript_path)
          .filter((entry) => typeof entry === "string"),
      ),
    ].sort(),
    agent_transcript_paths: [
      ...new Set(
        records
          .map((record) => record.input?.agent_transcript_path)
          .filter((entry) => typeof entry === "string"),
      ),
    ].sort(),
  };
  const graph = buildGraph(events);
  await atomicWriteJson(path.join(artifactDir, "normalized-summary.json"), summary);
  await atomicWriteJson(path.join(artifactDir, "normalized-graph.json"), graph);
  await writeFile(
    path.join(artifactDir, "normalized-events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") +
      (events.length ? "\n" : ""),
    { mode: 0o600 },
  );
  return { events, graph, summary };
}

async function main() {
  const artifactDir = path.resolve(
    argument(
      "artifact-dir",
      process.env.LOOPERATORS_P0_ARTIFACT_DIR ??
        path.join(process.cwd(), "output", "looperators-agent-loop-p0"),
    ),
  );
  const result = await normalizeArtifactDirectory(artifactDir);
  process.stdout.write(
    `${JSON.stringify({
      artifact_dir: artifactDir,
      deliveries: result.events.length,
      semantic_events: result.summary.total_semantic_events,
      event_coverage: result.summary.required_event_coverage,
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
