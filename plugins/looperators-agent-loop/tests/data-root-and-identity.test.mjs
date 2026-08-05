import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  digestJson,
  sha256,
} from "../lib/canonical-json.mjs";
import { normalizeHookEvent } from "../lib/contracts.mjs";
import {
  DataRootSplitError,
  DataRootUnavailableError,
  InvalidDataRootError,
  defaultDataRoot,
  resolveDataRoot,
} from "../lib/data-root.mjs";
import {
  bindHostIdentity,
  issueRunCapability,
  summarizeMcpIdentity,
  verifyRunCapability,
} from "../lib/identity.mjs";
import { loopState, tempStore } from "./helpers.mjs";

test("explicit data root overrides PLUGIN_DATA and keeps a stable marker", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "looperators-root-"));
  const ignoredPluginRoot = path.join(root, "ignored-plugin-data");
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await resolveDataRoot({
    env: { LOOPERATORS_DATA_DIR: root },
  });
  const second = await resolveDataRoot({
    env: {
      LOOPERATORS_DATA_DIR: root,
      PLUGIN_DATA: ignoredPluginRoot,
    },
    expectedInstanceId: first.marker.instanceId,
  });
  assert.equal(first.path, second.path);
  assert.equal(first.source, "LOOPERATORS_DATA_DIR");
  assert.equal(first.marker.instanceId, second.marker.instanceId);
  assert.equal(first.instanceIdDigest, second.instanceIdDigest);
  await assert.rejects(
    resolveDataRoot({ env: {}, platform: "win32" }),
    DataRootUnavailableError,
  );
  await assert.rejects(
    resolveDataRoot({ env: { LOOPERATORS_DATA_DIR: "relative" } }),
    InvalidDataRootError,
  );
});

test("platform defaults are deterministic and use native path semantics", () => {
  assert.equal(
    defaultDataRoot({
      platform: "darwin",
      env: {
        HOME: "/Users/example",
        XDG_DATA_HOME: "/must/be/ignored",
      },
      pathImplementation: path.posix,
    }),
    "/Users/example/Library/Application Support/looperators/codex-agent-loop/v1",
  );
  assert.equal(
    defaultDataRoot({
      platform: "linux",
      env: {
        HOME: "/home/example",
        XDG_DATA_HOME: "/var/example-data",
      },
      pathImplementation: path.posix,
    }),
    "/var/example-data/looperators/codex-agent-loop/v1",
  );
  assert.equal(
    defaultDataRoot({
      platform: "linux",
      env: { HOME: "/home/example" },
      pathImplementation: path.posix,
    }),
    "/home/example/.local/share/looperators/codex-agent-loop/v1",
  );
  assert.equal(
    defaultDataRoot({
      platform: "win32",
      env: {
        LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local",
      },
      pathImplementation: path.win32,
    }),
    "C:\\Users\\example\\AppData\\Local\\looperators\\codex-agent-loop\\v1",
  );
  assert.throws(
    () =>
      defaultDataRoot({
        platform: "linux",
        env: {
          HOME: "/home/example",
          XDG_DATA_HOME: "relative-data",
        },
        pathImplementation: path.posix,
      }),
    DataRootUnavailableError,
  );
});

test("platform defaults use the OS account home when Desktop omits HOME", () => {
  let resolutions = 0;
  const resolveSystemHome = () => {
    resolutions += 1;
    return "/Users/desktop-account";
  };
  assert.equal(
    defaultDataRoot({
      platform: "darwin",
      env: {},
      pathImplementation: path.posix,
      systemHomeDirectory: resolveSystemHome,
    }),
    "/Users/desktop-account/Library/Application Support/looperators/codex-agent-loop/v1",
  );
  assert.equal(
    defaultDataRoot({
      platform: "linux",
      env: {},
      pathImplementation: path.posix,
      systemHomeDirectory: () => "/home/desktop-account",
    }),
    "/home/desktop-account/.local/share/looperators/codex-agent-loop/v1",
  );
  assert.equal(resolutions, 1);
  assert.throws(
    () =>
      defaultDataRoot({
        platform: "darwin",
        env: {},
        pathImplementation: path.posix,
        systemHomeDirectory: () => "relative-home",
      }),
    DataRootUnavailableError,
  );
});

test("non-creating platform open never initializes a store", async (t) => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "looperators-platform-home-"),
  );
  t.after(() => rm(home, { recursive: true, force: true }));
  const expected = defaultDataRoot({
    platform: "darwin",
    env: { HOME: home },
  });
  await assert.rejects(
    resolveDataRoot({
      env: { HOME: home },
      platform: "darwin",
      create: false,
    }),
    DataRootUnavailableError,
  );
  await assert.rejects(access(expected), { code: "ENOENT" });

  const created = await resolveDataRoot({
    env: {
      HOME: home,
      PLUGIN_DATA: path.join(home, "ignored-plugin-data"),
    },
    platform: "darwin",
  });
  assert.equal(created.path, await realpath(expected));
  assert.equal(created.source, "looperators-platform-data");
  assert.equal((await stat(expected)).mode & 0o777, 0o700);

  const opened = await resolveDataRoot({
    env: { HOME: home },
    platform: "darwin",
    create: false,
  });
  assert.equal(opened.marker.instanceId, created.marker.instanceId);
  await chmod(expected, 0o755);
  await resolveDataRoot({
    env: { HOME: home },
    platform: "darwin",
  });
  assert.equal(
    (await stat(expected)).mode & 0o777,
    0o755,
    "opening an existing platform root does not rewrite permissions",
  );

  const markerless = path.join(home, "markerless");
  await mkdir(markerless);
  await assert.rejects(
    resolveDataRoot({
      env: { LOOPERATORS_DATA_DIR: markerless },
      create: false,
    }),
    DataRootUnavailableError,
  );
  await assert.rejects(
    access(path.join(markerless, ".looperators-store-v1.json")),
    { code: "ENOENT" },
  );
});

test("resolver detects expected marker mismatch without persisting paths", async (t) => {
  const left = await mkdtemp(path.join(os.tmpdir(), "looperators-left-"));
  const right = await mkdtemp(path.join(os.tmpdir(), "looperators-right-"));
  t.after(async () => {
    await Promise.all([
      rm(left, { recursive: true, force: true }),
      rm(right, { recursive: true, force: true }),
    ]);
  });
  const leftInfo = await resolveDataRoot({
    env: { LOOPERATORS_DATA_DIR: left },
  });
  await assert.rejects(
    resolveDataRoot({
      env: { LOOPERATORS_DATA_DIR: right },
      expectedInstanceId: leftInfo.marker.instanceId,
    }),
    DataRootSplitError,
  );
  const diagnostics = await readdir(
    path.join(right, "diagnostics", "data-root-split"),
  );
  assert.equal(diagnostics.length, 1);
  const diagnostic = await readFile(
    path.join(right, "diagnostics", "data-root-split", diagnostics[0]),
    "utf8",
  );
  assert.match(diagnostic, /data_root_split/);
  assert.doesNotMatch(diagnostic, new RegExp(left));
  assert.doesNotMatch(diagnostic, new RegExp(right));
});

test("MCP identity summary trusts host metadata shape but not tool arguments", () => {
  const summary = summarizeMcpIdentity({
    method: "tools/call",
    params: {
      name: "looperators_identity_probe",
      arguments: {
        fromNode: "self-claimed-agent",
        agent_id: "also-untrusted",
      },
      _meta: {
        threadId: "thread-host",
        "x-codex-turn-metadata": {
          thread_id: "thread-host-metadata",
          turn_id: "turn-host",
          agent_id: "agent-host",
        },
        progressToken: "not-an-identity",
      },
    },
  });
  assert.equal(summary.classification, "host-metadata-v1");
  assert.equal(summary.trustedIdentityAvailable, true);
  assert.deepEqual(summary.untrustedArgumentIdentityClaims, [
    "agent_id",
    "fromNode",
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /thread-host|agent-host/);

  const arbitrary = summarizeMcpIdentity({
    method: "tools/call",
    params: {
      arguments: {},
      _meta: {
        arbitrary_user_echo: {
          thread_id: "thread-untrusted",
          agent_id: "agent-untrusted",
        },
      },
    },
  });
  assert.equal(
    arbitrary.classification,
    "trusted_identity_unavailable",
  );

  const unavailable = summarizeMcpIdentity({
    method: "tools/call",
    params: {
      arguments: { fromNode: "claimed" },
      _meta: { progressToken: 1 },
    },
  });
  assert.equal(
    unavailable.classification,
    "trusted_identity_unavailable",
  );
});

test("session opt-in bindings are validated against their durable location", async (t) => {
  const { root, store } = await tempStore(t);
  const state = loopState();
  await store.initializeRun(state);
  assert.equal(
    await store.activeRunForSession(state.rootSessionId),
    state.runId,
  );
  const bindingDirectory = path.join(
    root,
    "session-bindings",
    sha256(state.rootSessionId),
  );
  const bindingPath = path.join(bindingDirectory, `${state.runId}.json`);
  const binding = JSON.parse(await readFile(bindingPath, "utf8"));
  await writeFile(
    bindingPath,
    `${JSON.stringify({
      ...binding,
      bindingId: `session_${"0".repeat(64)}`,
    })}\n`,
  );
  await assert.rejects(
    store.activeRunForSession(state.rootSessionId),
    { code: "INVALID_CONTRACT" },
  );
});

test("host identity binding requires an in-process host proof and observed lineage", async (t) => {
  const { store } = await tempStore(t);
  await store.initializeRun(loopState());
  for (const [agentId, turnId] of [
    ["agent-reviewer", "turn-reviewer"],
    ["agent-other", "turn-other"],
  ]) {
    await store.putEvent(
      "run-p1a",
      normalizeHookEvent(
        {
          session_id: "session-root",
          turn_id: turnId,
          hook_event_name: "SubagentStart",
          agent_id: agentId,
          agent_type: "reviewer",
        },
        { observedAt: "2026-07-26T00:00:00.000Z" },
      ),
    );
  }
  const summary = summarizeMcpIdentity({
    method: "tools/call",
    params: {
      arguments: {},
      _meta: {
        "x-codex-turn-metadata": {
          thread_id: "child-session",
          parent_thread_id: "session-root",
          turn_id: "child-turn",
          agent_id: "agent-reviewer",
        },
      },
    },
  });
  assert.equal(summary.classification, "host-metadata-v1");
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.candidateFields), true);

  await assert.rejects(
    bindHostIdentity(store, {
      runId: "run-p1a",
      agentId: "agent-reviewer",
      rootSessionId: "session-root",
    }),
    { code: "TRUSTED_IDENTITY_UNAVAILABLE" },
  );
  await assert.rejects(
    bindHostIdentity(store, {
      runId: "run-p1a",
      agentId: "agent-reviewer",
      rootSessionId: "session-root",
      identitySummary: JSON.parse(JSON.stringify(summary)),
    }),
    { code: "TRUSTED_IDENTITY_UNAVAILABLE" },
  );
  await assert.rejects(
    bindHostIdentity(store, {
      runId: "run-p1a",
      agentId: "agent-reviewer",
      rootSessionId: "wrong-root",
      identitySummary: summary,
    }),
    { code: "AGENT_NOT_OBSERVED" },
  );
  await assert.rejects(
    bindHostIdentity(store, {
      runId: "run-p1a",
      agentId: "agent-other",
      rootSessionId: "session-root",
      identitySummary: summary,
    }),
    { code: "HOST_IDENTITY_MISMATCH" },
  );
  const proofSymbol = Object.getOwnPropertySymbols(summary)[0];
  const mutableSummary = {
    ...summary,
    candidateFields: summary.candidateFields.map((candidate) => ({
      ...candidate,
    })),
  };
  Object.defineProperty(mutableSummary, proofSymbol, {
    value: summary[proofSymbol],
  });
  const racedBinding = bindHostIdentity(store, {
    runId: "run-p1a",
    agentId: "agent-other",
    rootSessionId: "session-root",
    identitySummary: mutableSummary,
  });
  const mutableAgentCandidate =
    mutableSummary.candidateFields.find(
      (candidate) => candidate.kind === "agent",
    );
  mutableAgentCandidate.valueDigest = digestJson({
    key: mutableAgentCandidate.key,
    value: "agent-other",
  });
  await assert.rejects(racedBinding, {
    code: "HOST_IDENTITY_MISMATCH",
  });
  const binding = await bindHostIdentity(store, {
    runId: "run-p1a",
    agentId: "agent-reviewer",
    rootSessionId: "session-root",
    identitySummary: summary,
    createdAt: "2026-07-26T00:00:01.000Z",
  });
  assert.equal(binding.method, "host-metadata-v1");
  assert.equal(
    (await store.readIdentityBinding(
      "run-p1a",
      "agent-reviewer",
    )).hostIdentityDigest,
    binding.hostIdentityDigest,
  );
});

test("capability token is returned once, stored only as a digest, and verified", async (t) => {
  const { root, store } = await tempStore(t);
  await store.initializeRun(loopState());
  await assert.rejects(
    issueRunCapability(store, {
      runId: "run-p1a",
      agentId: "agent-reviewer",
      rootSessionId: "session-root",
    }),
    { code: "AGENT_NOT_OBSERVED" },
  );
  await store.putEvent(
    "run-p1a",
    normalizeHookEvent(
      {
        session_id: "session-root",
        turn_id: "turn-spawn",
        hook_event_name: "SubagentStart",
        agent_id: "agent-reviewer",
        agent_type: "reviewer",
      },
      { observedAt: "2026-07-26T00:00:00.000Z" },
    ),
  );
  const issued = await issueRunCapability(store, {
    runId: "run-p1a",
    agentId: "agent-reviewer",
    rootSessionId: "session-root",
    createdAt: "2026-07-26T00:00:00.000Z",
  });
  assert.ok(issued.token.length >= 32);
  assert.equal(
    await verifyRunCapability(store, {
      runId: "run-p1a",
      agentId: "agent-reviewer",
      token: issued.token,
    }),
    true,
  );
  assert.equal(
    await verifyRunCapability(store, {
      runId: "run-p1a",
      agentId: "agent-reviewer",
      token: `${issued.token}wrong`,
    }),
    false,
  );
  const bindingPath = path.join(
    root,
    "runs",
    "run-p1a",
    "identity",
    `binding_${sha256("agent-reviewer")}.json`,
  );
  const originalBinding = JSON.parse(
    await readFile(bindingPath, "utf8"),
  );
  await writeFile(
    bindingPath,
    `${JSON.stringify({
      ...originalBinding,
      rootSessionId: "session-foreign",
    })}\n`,
  );
  assert.equal(
    await verifyRunCapability(store, {
      runId: "run-p1a",
      agentId: "agent-reviewer",
      token: issued.token,
    }),
    false,
  );
  await writeFile(
    bindingPath,
    `${JSON.stringify(originalBinding)}\n`,
  );
  const bindingText = await readFile(
    bindingPath,
    "utf8",
  );
  assert.doesNotMatch(bindingText, new RegExp(issued.token));
  await assert.rejects(
    issueRunCapability(store, {
      runId: "run-p1a",
      agentId: "agent-reviewer",
      rootSessionId: "session-root",
    }),
    { code: "CAPABILITY_ALREADY_ISSUED" },
  );
  const misplaced = JSON.parse(await readFile(bindingPath, "utf8"));
  await writeFile(
    bindingPath,
    `${JSON.stringify({ ...misplaced, agentId: "agent-other" })}\n`,
  );
  await assert.rejects(
    verifyRunCapability(store, {
      runId: "run-p1a",
      agentId: "agent-reviewer",
      token: issued.token,
    }),
    { code: "INVALID_CONTRACT" },
  );
});
