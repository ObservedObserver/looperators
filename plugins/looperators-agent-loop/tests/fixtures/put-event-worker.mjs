#!/usr/bin/env node

import { resolveDataRoot } from "../../lib/data-root.mjs";
import { LoopStore } from "../../lib/store.mjs";

const [runId, encodedEvent] = process.argv.slice(2);
const event = JSON.parse(Buffer.from(encodedEvent, "base64url").toString("utf8"));
const rootInfo = await resolveDataRoot();
const store = new LoopStore(rootInfo);
const result = await store.putEvent(runId, event);
process.stdout.write(`${JSON.stringify(result)}\n`);
