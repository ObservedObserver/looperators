#!/usr/bin/env node
// Dev convenience for the L2 ingestion choke point: fire one external event
// at a running runtime HTTP server. Used while developing adapters, in
// CodeX headless acceptance, and for demos.
//
//   npm run emit -- <sourceId> '<json-payload>' [--dedupe <key>] [--topic <t>] \
//     [--token <token>] [--url http://127.0.0.1:48274]

const args = process.argv.slice(2);
const positional = [];
const options = {};
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--dedupe' || arg === '--topic' || arg === '--token' || arg === '--url') {
    options[arg.slice(2)] = args[i + 1];
    i += 1;
  } else {
    positional.push(arg);
  }
}

const [sourceId, payloadRaw] = positional;
if (!sourceId) {
  console.error("Usage: npm run emit -- <sourceId> '<json-payload>' [--dedupe <key>] [--topic <t>] [--token <token>] [--url <base>]");
  process.exit(2);
}

let payload = {};
if (payloadRaw !== undefined) {
  try {
    payload = JSON.parse(payloadRaw);
  } catch {
    console.error(`Payload is not valid JSON: ${payloadRaw}`);
    process.exit(2);
  }
}

const base = options.url ?? process.env.ORRERY_RUNTIME_URL ?? 'http://127.0.0.1:48274';
const body = {
  sourceId,
  payload,
  ...(options.dedupe ? { dedupeKey: options.dedupe } : {}),
  ...(options.topic ? { topic: options.topic } : {}),
};

const response = await fetch(`${base}/api/runtime/external-events`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    ...(options.token ? { 'X-Orrery-Source-Token': options.token } : {}),
  },
  body: JSON.stringify(body),
});

const text = await response.text();
console.log(`${response.status} ${text.trim()}`);
process.exit(response.ok ? 0 : 1);
