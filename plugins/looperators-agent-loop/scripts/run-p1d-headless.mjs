#!/usr/bin/env node

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../lib/canonical-json.mjs";
import { LoopController } from "../lib/control.mjs";
import {
  HOOK_COLLECTOR_PROTOCOL,
  normalizeHookEvent,
} from "../lib/contracts.mjs";
import { resolveDataRoot } from "../lib/data-root.mjs";
import { atomicReplaceJson } from "../lib/fs-utils.mjs";
import { currentHookDefinitionDigest } from "../lib/hook-readiness.mjs";
import { LoopStore } from "../lib/store.mjs";
import { renderInlineGraph } from "./render-inline-graph.mjs";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function clock() {
  let seconds = 0;
  return () => {
    const value = new Date(
      Date.UTC(2026, 6, 26, 23, 0, seconds),
    ).toISOString();
    seconds += 1;
    return value;
  };
}

async function putSpawnEvidence(
  store,
  runId,
  rootSessionId,
  rootTurnId,
  role,
  agentId,
  index,
) {
  await store.putEvent(
    runId,
    normalizeHookEvent(
      {
        session_id: rootSessionId,
        turn_id: rootTurnId,
        hook_event_name: "PreToolUse",
        tool_use_id: `p1d-spawn-${index}`,
        tool_name: "collaborationspawn_agent",
        tool_input: { task_name: role },
      },
      {
        observedAt:
          `2026-07-26T23:10:0${index}.000Z`,
      },
    ),
  );
  const start = normalizeHookEvent(
    {
      session_id: rootSessionId,
      turn_id: `p1d-worker-turn-${index}`,
      hook_event_name: "SubagentStart",
      agent_id: agentId,
      agent_type: "worker",
    },
    {
      observedAt:
        `2026-07-26T23:10:0${index}.500Z`,
    },
  );
  await store.putEvent(runId, start);
  return start;
}

async function allJsonText(directory) {
  const values = [];
  async function walk(current) {
    for (const entry of await readdir(current, {
      withFileTypes: true,
    })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(target);
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".json")
      ) {
        values.push(await readFile(target, "utf8"));
      }
    }
  }
  await walk(directory);
  return values.join("\n");
}

export async function runP1dHeadless(
  outputDirectory,
  options = {},
) {
  if (!path.isAbsolute(outputDirectory)) {
    throw new TypeError("--output must be absolute");
  }
  await mkdir(outputDirectory, {
    recursive: true,
    mode: 0o700,
  });
  const canonicalOutput = await realpath(outputDirectory);
  if (canonicalOutput !== path.resolve(outputDirectory)) {
    throw new Error("--output must use a canonical non-symlink path");
  }
  const visualizationRoot = path.join(
    canonicalOutput,
    "visualization",
  );
  await mkdir(visualizationRoot, {
    recursive: true,
    mode: 0o700,
  });
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "looperators-p1d-headless-"),
  );
  const dataRoot = path.join(temporary, "data");
  try {
    const rootInfo = await resolveDataRoot({
      env: { LOOPERATORS_DATA_DIR: dataRoot },
    });
    const store = new LoopStore(rootInfo);
    const controller = new LoopController(store, {
      now: clock(),
    });
    const previewContext = {
      rootSessionId: "p1d-headless-root",
      turnId: "p1d-headless-turn",
      threadSource: "user",
    };
    const preview = await controller.preview(previewContext, {
      requestId: "p1d-preview",
      goal: "Exercise a bounded synthetic review-until-clean loop.",
      implementerInstructions:
        "Return a typed done report after each synthetic implementation.",
      reviewerInstructions:
        "Return one issues verdict, then a clean verdict.",
      lapCap: 2,
    });
    const context = {
      ...previewContext,
      turnId: "p1d-headless-confirmed-turn",
    };
    await store.putEvent(
      preview.runId,
      normalizeHookEvent(
        {
          session_id: context.rootSessionId,
          turn_id: context.turnId,
          hook_event_name: "UserPromptSubmit",
        },
        {
          observedAt: "2026-07-26T23:00:01.000Z",
          hookCollectorProtocol:
            HOOK_COLLECTOR_PROTOCOL,
          hookDefinitionDigest:
            await currentHookDefinitionDigest(),
        },
      ),
    );
    await controller.start(context, {
      runId: preview.runId,
      requestId: "p1d-start",
    });

    const tokens = {};
    for (const [index, role, agentId] of [
      [1, "implementer", "p1d-native-implementer"],
      [2, "reviewer", "p1d-native-reviewer"],
    ]) {
      const baseline =
        await controller.prepareWorkerSpawn(context, {
          runId: preview.runId,
          requestId: `p1d-prepare-${role}`,
          role,
        });
      const observed = await putSpawnEvidence(
        store,
        preview.runId,
        context.rootSessionId,
        context.turnId,
        role,
        agentId,
        index,
      );
      const bound = await controller.bindWorker(context, {
        runId: preview.runId,
        requestId: `p1d-bind-${role}`,
        observationId: baseline.observationId,
        originEventId: observed.eventId,
        agentId,
        role,
      });
      tokens[role] = bound.capabilityToken;
    }

    await controller.report({
      runId: preview.runId,
      requestId: "p1d-implementer-first",
      agentId: "p1d-native-implementer",
      capabilityToken: tokens.implementer,
      type: "info",
      status: "done",
      summary: "Synthetic first implementation completed.",
    });
    await controller.report({
      runId: preview.runId,
      requestId: "p1d-reviewer-issues",
      agentId: "p1d-native-reviewer",
      capabilityToken: tokens.reviewer,
      type: "verdict",
      verdict: "issues",
      issues: [
        {
          message: "Synthetic review issue for the P1-D fixture.",
          file: "synthetic.js",
          line: 1,
          severity: "warn",
        },
      ],
      summary: "One synthetic issue remains.",
    });
    const issuesProjection =
      await controller.snapshotForRun(preview.runId);
    await atomicReplaceJson(
      path.join(canonicalOutput, "issues-projection.json"),
      issuesProjection,
      { root: canonicalOutput },
    );
    const inline = await renderInlineGraph({
      runId: preview.runId,
      visualizationRoot,
      expectedProjectionDigest:
        issuesProjection.projectionDigest,
      store,
      controller,
    });
    const threadInline = options.visualizationRoot
      ? await renderInlineGraph({
          runId: preview.runId,
          visualizationRoot: options.visualizationRoot,
          expectedProjectionDigest:
            issuesProjection.projectionDigest,
          store,
          controller,
        })
      : null;
    const threadInlineExactArtifactBytes = threadInline
      ? (
          await readFile(threadInline.output)
        ).equals(await readFile(inline.output))
      : null;
    if (
      threadInline &&
      !threadInlineExactArtifactBytes
    ) {
      throw new Error(
        "task-scoped inline bytes differ from the checked evidence fragment",
      );
    }

    await controller.report({
      runId: preview.runId,
      requestId: "p1d-implementer-fix",
      agentId: "p1d-native-implementer",
      capabilityToken: tokens.implementer,
      type: "info",
      status: "done",
      summary: "Synthetic issue addressed.",
    });
    await controller.report({
      runId: preview.runId,
      requestId: "p1d-reviewer-clean",
      agentId: "p1d-native-reviewer",
      capabilityToken: tokens.reviewer,
      type: "verdict",
      verdict: "clean",
      summary: "Synthetic review is clean.",
    });
    const succeededProjection =
      await controller.snapshotForRun(preview.runId);
    await atomicReplaceJson(
      path.join(
        canonicalOutput,
        "succeeded-projection.json",
      ),
      succeededProjection,
      { root: canonicalOutput },
    );
    const durableText = await allJsonText(dataRoot);
    const plaintextCapabilityPersisted = Object.values(
      tokens,
    ).some((token) => durableText.includes(token));
    if (plaintextCapabilityPersisted) {
      throw new Error(
        "headless fixture found a plaintext capability in durable state",
      );
    }
    const summary = {
      schemaVersion: 1,
      passed: true,
      runId: preview.runId,
      issues: {
        status: issuesProjection.status,
        revision: issuesProjection.revision,
        currentLap: issuesProjection.currentLap,
        pendingRole: issuesProjection.pending?.role,
        projectionDigest:
          issuesProjection.projectionDigest,
        eventWatermark:
          issuesProjection.eventWatermark,
      },
      succeeded: {
        status: succeededProjection.status,
        revision: succeededProjection.revision,
        currentLap: succeededProjection.currentLap,
        projectionDigest:
          succeededProjection.projectionDigest,
        eventWatermark:
          succeededProjection.eventWatermark,
      },
      inline: {
        outputName: inline.outputName,
        bytes: inline.bytes,
        projectionDigest: inline.projectionDigest,
        rereads: inline.rereads,
        drifted: inline.drifted,
      },
      ...(threadInline
        ? {
            threadInline: {
              outputName: threadInline.outputName,
              bytes: threadInline.bytes,
              projectionDigest:
                threadInline.projectionDigest,
              exactArtifactBytes:
                threadInlineExactArtifactBytes,
            },
          }
        : {}),
      stableNodeIds: succeededProjection.nodes.map(
        (node) => node.id,
      ),
      edgeCount: succeededProjection.edges.length,
      timelineBounded:
        succeededProjection.timeline.length <= 32,
      plaintextCapabilityPersisted,
      canonicalIssuesProjectionBytes: Buffer.byteLength(
        canonicalJson(issuesProjection),
        "utf8",
      ),
    };
    await atomicReplaceJson(
      path.join(canonicalOutput, "headless-summary.json"),
      summary,
      { root: canonicalOutput },
    );
    return summary;
  } finally {
    await rm(temporary, {
      recursive: true,
      force: true,
    });
  }
}

async function main() {
  const output = argument("output");
  if (!output) {
    throw new Error(
      "Usage: run-p1d-headless.mjs --output <absolute-directory> [--visualization-root <absolute-existing-task-directory>]",
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      await runP1dHeadless(output, {
        visualizationRoot: argument(
          "visualization-root",
        ),
      }),
    )}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(
      `${String(error?.code ?? "P1D_HEADLESS_FAILED")}: ${error?.message ?? error}\n`,
    );
    process.exitCode = 1;
  });
}
