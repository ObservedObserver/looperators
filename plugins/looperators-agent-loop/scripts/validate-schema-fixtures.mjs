#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateLegacyQuarantineReceipt } from "../lib/contracts.mjs";
import { atomicReplaceJson } from "../lib/fs-utils.mjs";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function json(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function moduleDefault(file) {
  const loaded = await import(pathToFileURL(file));
  return loaded.default?.default ?? loaded.default ?? loaded;
}

const moduleDirectory = argument("module-dir");
if (!moduleDirectory || !path.isAbsolute(moduleDirectory)) {
  throw new Error("--module-dir must be an absolute node_modules path");
}

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const Ajv2020 = await moduleDefault(
  path.join(moduleDirectory, "ajv", "dist", "2020.js"),
);
const addFormats = await moduleDefault(
  path.join(moduleDirectory, "ajv-formats", "dist", "index.js"),
);
const validator = new Ajv2020({
  allErrors: true,
  strict: true,
});
addFormats(validator);

const cases = [
  {
    contract: "governor-decision",
    schema: "governor-decision.schema.json",
    valid: "governor-decision-valid.json",
    invalid: "governor-decision-invalid-missing-lease.json",
  },
  {
    contract: "worker-observation",
    schema: "worker-observation.schema.json",
    valid: "worker-observation-valid.json",
    invalid: "worker-observation-invalid-duplicate.json",
  },
  {
    contract: "definition",
    schema: "definition.schema.json",
    valid: "definition-valid.json",
    invalid: "definition-invalid-lap-cap.json",
  },
  {
    contract: "operation",
    schema: "operation.schema.json",
    valid: "operation-valid-report.json",
    invalid: "operation-invalid-missing-report.json",
  },
  {
    contract: "report",
    schema: "report.schema.json",
    valid: "report-valid.json",
    invalid: "report-invalid-missing-verdict.json",
  },
  {
    contract: "product-report-revisions",
    schema: "report.schema.json",
    valid: "report-valid-product.json",
    invalid: "report-invalid-missing-revisions.json",
  },
  {
    contract: "identity-binding",
    schema: "identity-binding.schema.json",
    valid: "identity-valid-capability.json",
    invalid: "identity-invalid-missing-token.json",
  },
  {
    contract: "run",
    schema: "run.schema.json",
    valid: "run-valid.json",
    invalid: "run-invalid-consumed-over-granted.json",
  },
  {
    contract: "graph-projection",
    schema: "graph-projection.schema.json",
    valid: "graph-projection-valid.json",
    invalid: "graph-projection-invalid-corrupt.json",
  },
  {
    contract: "legacy-native-target-evidence",
    schema: "legacy-native-target-evidence.schema.json",
    valid: "legacy-native-target-evidence-valid.json",
    invalid: "legacy-native-target-evidence-invalid-field.json",
  },
  {
    contract: "legacy-quarantine",
    schema: "legacy-quarantine.schema.json",
    valid: "legacy-quarantine-valid.json",
    invalid: "legacy-quarantine-invalid-count.json",
  },
];

const compiledSchemas = new Map();
const results = [];
for (const item of cases) {
  let validate = compiledSchemas.get(item.schema);
  if (!validate) {
    validate = validator.compile(
      await json(path.join(pluginRoot, "schemas", item.schema)),
    );
    compiledSchemas.set(item.schema, validate);
  }
  const validAccepted = validate(
    await json(
      path.join(
        pluginRoot,
        "tests",
        "fixtures",
        "schema",
        item.valid,
      ),
    ),
  );
  const invalidAccepted = validate(
    await json(
      path.join(
        pluginRoot,
        "tests",
        "fixtures",
        "schema",
        item.invalid,
      ),
    ),
  );
  results.push({
    contract: item.contract,
    validAccepted,
    invalidRejected: !invalidAccepted,
    invalidErrorKeywords: (validate.errors ?? [])
      .map((error) => error.keyword)
      .sort(),
  });
}

const passed = results.every(
  (result) => result.validAccepted && result.invalidRejected,
);
const runtimeSemantic = {
  contract: "legacy-quarantine-revision-adjacency",
  validator: "validateLegacyQuarantineReceipt",
  validAccepted:
    validateLegacyQuarantineReceipt(
      await json(
        path.join(
          pluginRoot,
          "tests",
          "fixtures",
          "schema",
          "legacy-quarantine-valid.json",
        ),
      ),
    ).length === 0,
  invalidRejected:
    validateLegacyQuarantineReceipt(
      await json(
        path.join(
          pluginRoot,
          "tests",
          "fixtures",
          "schema",
          "legacy-quarantine-invalid-adjacency.json",
        ),
      ),
    ).length > 0,
};
const semanticPassed =
  runtimeSemantic.validAccepted &&
  runtimeSemantic.invalidRejected;
const evidence = {
  schemaVersion: 1,
  validator: "ajv-2020+runtime-semantic",
  passed: passed && semanticPassed,
  results,
  runtimeSemantic: [runtimeSemantic],
};
const output = argument("output");
if (output) {
  if (!path.isAbsolute(output)) {
    throw new Error("--output must be an absolute path");
  }
  await atomicReplaceJson(output, evidence);
}
process.stdout.write(
  `${JSON.stringify({
    ...evidence,
    ...(output ? { output } : {}),
  })}\n`,
);
if (!evidence.passed) {
  process.exitCode = 1;
}
