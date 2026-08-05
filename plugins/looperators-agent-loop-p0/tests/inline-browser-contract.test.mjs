import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { generateInlineVisualization } from "../scripts/generate-inline-visualization.mjs";
import { createRecordedArtifactFixture } from "./recorded-artifact-fixture.mjs";

const execFileAsync = promisify(execFile);

async function loadPlaywright() {
  const moduleDirectory = process.env.LOOPERATORS_P0_PLAYWRIGHT_MODULE_DIR;
  if (moduleDirectory) {
    return import(
      pathToFileURL(path.join(moduleDirectory, "playwright", "index.mjs")).href
    );
  }
  return import("playwright");
}

async function findFragmentFrame(page) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const frame of page.frames()) {
      if (
        frame !== page.mainFrame() &&
        (await frame.locator("#looperators-agent-loop-p06").count()) === 1
      ) {
        return frame;
      }
    }
    await page.waitForTimeout(25);
  }
  throw new Error("Official preview did not expose the inline fragment frame");
}

test("official preview executes selection, details, zoom, filter, follow-up, and narrow layout", async (t) => {
  let playwright;
  try {
    playwright = await loadPlaywright();
  } catch (error) {
    t.skip(`Playwright is unavailable: ${error.message}`);
    return;
  }
  const renderScript = process.env.LOOPERATORS_P0_RENDER_PY;
  if (!renderScript) {
    t.skip("LOOPERATORS_P0_RENDER_PY is not set");
    return;
  }
  await access(renderScript);

  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "looperators-p0-browser-contract-"),
  );
  const recordedArtifactDir = await createRecordedArtifactFixture();
  const fragmentPath = path.join(temporary, "looperators-agent-loop.html");
  const previewPath = path.join(temporary, "looperators-agent-loop-preview.html");
  await generateInlineVisualization({
    artifactDir: recordedArtifactDir,
    outputPath: fragmentPath,
  });
  await execFileAsync(process.env.PYTHON ?? "python3", [
    renderScript,
    fragmentPath,
    previewPath,
  ]);

  const browser = await playwright.chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 736, height: 1000 },
  });
  await context.addInitScript(() => {
    window.__looperatorsFollowUps = [];
    window.openai = {
      sendFollowUpMessage: async (payload) => {
        window.__looperatorsFollowUps.push(payload);
        return { accepted: true };
      },
    };
  });
  const page = await context.newPage();
  await page.goto(pathToFileURL(previewPath).href);
  const frame = await findFragmentFrame(page);
  const root = frame.locator("#looperators-agent-loop-p06");
  await root.waitFor();

  const summary = frame.locator("#loop-acceptance-summary");
  assert.match(await summary.inputValue(), /JS ready=pass/u);
  const followUp = frame.locator("#loop-follow-up");
  assert.equal(await followUp.isDisabled(), true);

  const rootButton = frame.locator('[data-kind="root"]');
  await frame.locator("#loop-zoom-reset").focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await frame.evaluate(
      () => document.activeElement?.getAttribute("data-kind"),
    ),
    "root",
  );
  await page.keyboard.press("Enter");
  assert.equal(await rootButton.getAttribute("aria-pressed"), "true");
  assert.match(
    await frame.locator("#loop-detail-id").textContent(),
    /session:019f9a38-9f26-71d0-b908-df3626a5d40c/u,
  );
  assert.match(
    await frame.locator("#loop-timeline").textContent(),
    /SessionStart[\s\S]*Stop/u,
  );

  const subagents = frame.locator('[data-kind="subagent"]');
  await page.keyboard.press("Tab");
  assert.equal(
    await frame.evaluate(
      () => document.activeElement?.getAttribute("data-node-id"),
    ),
    "agent:019f9a39-0485-75f0-b6cf-8beba2cc59cd",
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  assert.equal(
    await frame.evaluate(
      () => document.activeElement?.getAttribute("data-node-id"),
    ),
    "agent:019f9a39-1681-7b90-98e1-55ac153248dd",
  );
  await page.keyboard.press("Space");
  assert.equal(await subagents.nth(1).getAttribute("aria-pressed"), "true");
  assert.match(
    await frame.locator("#loop-detail-id").textContent(),
    /agent:019f9a39-1681-7b90-98e1-55ac153248dd/u,
  );
  assert.match(
    await frame.locator("#loop-detail-counts").textContent(),
    /3 semantic events · initial stops 1 · continuations 1/u,
  );

  await frame.locator("#loop-zoom-in").click();
  assert.equal(await frame.locator("#loop-zoom-value").textContent(), "110%");
  await frame.locator("#loop-zoom-out").click();
  await frame.locator("#loop-zoom-out").click();
  assert.equal(await frame.locator("#loop-zoom-value").textContent(), "90%");
  await frame.locator("#loop-zoom-reset").click();
  assert.equal(await frame.locator("#loop-zoom-value").textContent(), "100%");

  const filter = frame.locator("#loop-filter");
  await filter.selectOption("subagent");
  assert.equal(await rootButton.isHidden(), true);
  assert.equal(await subagents.nth(0).isVisible(), true);
  await filter.selectOption("root");
  assert.equal(await rootButton.isVisible(), true);
  assert.equal(await subagents.nth(0).isHidden(), true);
  await filter.selectOption("all");
  assert.equal(await rootButton.isVisible(), true);
  assert.equal(await subagents.nth(1).isVisible(), true);

  await followUp.click();
  await frame
    .locator("#loop-follow-up-status")
    .filter({ hasText: "Follow-up requested." })
    .waitFor();
  const followUps = await frame.evaluate(() => window.__looperatorsFollowUps);
  assert.equal(followUps.length, 1);
  assert.match(
    followUps[0].prompt,
    /stable identifier "agent:019f9a39-1681-7b90-98e1-55ac153248dd"/u,
  );
  assert.match(followUps[0].prompt, /separating recorded facts from inference/u);
  assert.equal(followUps[0].title, "Explain loop node 019f…3248dd");

  const finalSummary = await summary.inputValue();
  for (const check of [
    "JS ready=pass",
    "node selected=pass",
    "details updated=pass",
    "zoom changed/reset=pass",
    "filter changed=pass",
    "follow-up requested=pass",
  ]) {
    assert.match(finalSummary, new RegExp(check.replace("/", "\\/"), "u"));
  }

  await page.setViewportSize({ width: 320, height: 1600 });
  await page.waitForTimeout(50);
  const layout = await frame.evaluate(() => {
    const visualization = document.getElementById(
      "looperators-agent-loop-p06",
    );
    const rootRect = visualization.getBoundingClientRect();
    const visibleControls = [...visualization.querySelectorAll("button, select, textarea")]
      .filter((element) => {
        const style = getComputedStyle(element);
        return !element.hidden && style.display !== "none";
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          label:
            element.getAttribute("aria-label") ??
            element.textContent.trim().slice(0, 40),
          left: rect.left,
          right: rect.right,
        };
      });
    return {
      documentClientWidth: document.documentElement.clientWidth,
      documentScrollWidth: document.documentElement.scrollWidth,
      rootClientWidth: visualization.clientWidth,
      rootScrollWidth: visualization.scrollWidth,
      rootLeft: rootRect.left,
      rootRight: rootRect.right,
      stageHeight: document.getElementById("loop-stage").getBoundingClientRect()
        .height,
      stageViewportHeight: document
        .getElementById("loop-stage-viewport")
        .getBoundingClientRect().height,
      visibleControls,
    };
  });
  assert.equal(
    layout.documentScrollWidth <= layout.documentClientWidth + 1,
    true,
    JSON.stringify(layout),
  );
  assert.equal(
    layout.rootScrollWidth <= layout.rootClientWidth + 1,
    true,
    JSON.stringify(layout),
  );
  assert.equal(
    layout.stageViewportHeight >= layout.stageHeight - 1,
    true,
    JSON.stringify(layout),
  );
  for (const control of layout.visibleControls) {
    assert.equal(
      control.left >= layout.rootLeft - 1 &&
        control.right <= layout.rootRight + 1,
      true,
      JSON.stringify({ control, layout }),
    );
  }

  const evidenceDir = process.env.LOOPERATORS_P0_BROWSER_EVIDENCE_DIR;
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await root.screenshot({
      path: path.join(evidenceDir, "headless-inline-320.png"),
    });
    await page.setViewportSize({ width: 736, height: 1000 });
    await page.waitForTimeout(50);
    await root.screenshot({
      path: path.join(evidenceDir, "headless-inline-736.png"),
    });
    await writeFile(
      path.join(evidenceDir, "headless-browser-contract.json"),
      `${JSON.stringify(
        {
          officialRenderScript: renderScript,
          fragmentBytes: (await readFile(fragmentPath)).byteLength,
          nodeCount: await frame.locator("[data-node-id]").count(),
          finalSummary,
          followUps,
          narrowLayout: layout,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
});
