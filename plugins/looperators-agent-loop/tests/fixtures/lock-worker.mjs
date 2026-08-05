import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "../../lib/fs-utils.mjs";

const [root, lockPath] = process.argv.slice(2);
const sentinel = path.join(root, "locks", "critical-section.json");
const result = await withFileLock(
  lockPath,
  async () => {
    let handle;
    try {
      handle = await open(sentinel, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") {
        return { overlap: true };
      }
      throw error;
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { overlap: false };
    } finally {
      await handle.close();
      await unlink(sentinel);
    }
  },
  {
    root,
    staleMs: 0,
    timeoutMs: 5_000,
    retryMs: 1,
  },
);
process.stdout.write(`${JSON.stringify(result)}\n`);
