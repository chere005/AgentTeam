import { test, expect, _electron as electron } from "@playwright/test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fake `wolframscript` (never the real kernel): reads the validation source from the wrapper
// and prints the markers WolframscriptRunner parses. FAIL/SLEEP in the source pick the outcome.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const wrapper = fs.readFileSync(process.argv[3], "utf8");
const src = fs.readFileSync(wrapper.match(/Get\\["([^"]+)"\\]/)[1], "utf8");
console.log("@@AGENTTEAM-VERSION@@14.3.0 for Fake (ui test)");
if (src.includes("SLEEP")) { setTimeout(() => {}, 60000); return; }
const ok = !src.includes("FAIL");
console.log(ok ? "True" : "False");
console.log("@@AGENTTEAM-ASSERTIONS@@" + JSON.stringify([{ name: "identity", passed: ok }]));
`;

test.skip(process.platform === "win32", "fake kernel script is POSIX-only");

test("validation gate: Wolfram team project, model verification, panel, cancel, fail then pass", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-val-"));
  const work = join(directory, "work");
  await mkdir(work);
  const fake = join(directory, "fake-wolframscript");
  await writeFile(fake, FAKE);
  await chmod(fake, 0o755);
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: directory,
      AGENTTEAM_TEST: "1",
      AGENTTEAM_WOLFRAMSCRIPT: fake,
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      window.agentteam.request("PUT", "/execution", { enabled: true }),
    );
    // The Wolfram-validated TEAM from the library, then a PROJECT assigned to it.
    await page
      .getByRole("button", { name: "Saved teams", exact: true })
      .first()
      .click();
    await page
      .getByRole("list", { name: "Example teams" })
      .getByRole("button", { name: /Wolfram-validated reasoning team/ })
      .click();
    await page.getByRole("button", { name: "Insert…", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: /Insert “/ });
    await dialog.getByLabel("Insert with unverified models").check();
    await dialog
      .getByRole("button", { name: "Insert as new team", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: /^Projects/ }).click();
    await page
      .getByRole("button", { name: "Assign project", exact: true })
      .first()
      .click();
    const form = page.getByRole("form", { name: "Assign project" });
    await form
      .getByLabel("Project goal")
      .fill("Check that Sin^2 + Cos^2 equals 1 for real arguments");
    await form.getByLabel("Project workspace").fill(work);
    await form.getByRole("button", { name: "Create paused project" }).click();
    const wf = page.locator(".workflow").first();
    await expect(wf).toContainText("Sin^2 + Cos^2 equals 1");
    await expect(wf.locator(".badge").first()).toHaveText("paused");
    // Gate summary lists every validation-required step as blocked.
    await expect(wf.getByTestId("gate-line").first()).toContainText(
      "no validation record yet",
    );
    // Model mapping is unverified (no runtimes discovered in test mode) and resume is refused.
    await expect(wf.getByLabel("Model mapping")).toContainText("not verified");
    await wf.getByRole("button", { name: "Verify models" }).click();
    await expect(wf.getByLabel("Model mapping")).toContainText(
      "not installed or detected",
    );
    const refused = await page.evaluate(async () => {
      const snap = await window.agentteam.request("GET", "/snapshot");
      try {
        await window.agentteam.request(
          "POST",
          `/workflows/${snap.workflows[0].id}/pause`,
          { paused: false },
        );
        return "resumed";
      } catch (e) {
        return String(e);
      }
    });
    expect(refused).toContain("Verify the model mapping");

    // Validation panel on the first validation-required task.
    const task = wf.locator("details.task", {
      has: page.locator("summary", { hasText: "Derive and validate claim" }),
    });
    await task.locator("summary").click();
    const panel = task.getByLabel("Validation panel");
    await expect(panel.getByTestId("gate-reason")).toContainText(
      "no validation record",
    );
    await expect(panel.getByTestId("validation-caps")).toContainText(
      "at most 2 at a time",
    );
    const run = async (source: string, claim: string, notes = "") => {
      await panel.getByLabel("Claim").fill(claim);
      await panel.getByLabel("Derivation notes (Markdown)").fill(notes);
      await panel.getByLabel("Wolfram Language source (.wl)").fill(source);
      await panel.getByRole("button", { name: "Start validation run" }).click();
    };
    // 1) Start then cancel: record is "cancelled", gate stays closed, no attempt consumed.
    await run("(* SLEEP *) 1", "slow claim");
    await expect(
      panel.getByRole("button", { name: "Cancel run" }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Cancel run" }).click();
    await expect(panel.getByTestId("validation-record")).toHaveCount(1);
    await expect(panel.locator(".status-cancelled")).toBeVisible();
    await expect(panel.getByTestId("gate-reason")).toContainText("cancelled");
    await expect(panel.getByTestId("validation-caps")).toContainText("0 / 3");
    // 2) Deliberately wrong math fails.
    await run("(* FAIL *) 1", "wrong claim");
    await expect(panel.locator(".status-fail")).toBeVisible();
    await expect(panel.getByTestId("gate-reason")).toContainText("failed");
    // 3) Correct math passes with Markdown notes shown in a scrollable region.
    await run(
      "(* ok *) 1",
      "Sin^2+Cos^2==1",
      "## Derivation\n- uses **Pythagoras**\n- `Simplify` returns 1",
    );
    await expect(panel.locator(".status-pass")).toBeVisible();
    await expect(panel.getByTestId("gate-reason")).toContainText("Validated");
    await expect(panel.getByTestId("validation-caps")).toContainText("2 / 3");
    const rec = panel.getByTestId("validation-record").first();
    await expect(rec).toContainText("14.3.0 for Fake (ui test)");
    await expect(rec).toContainText("Symbolic proof");
    await expect(rec.locator(".validation-notes strong")).toHaveText(
      "Pythagoras",
    );
    await expect(wf.getByTestId("gate-line").first()).toContainText(
      "Validated for the current inputs",
    );
    // Task editor exposes the requiresValidation toggle.
    await wf.getByRole("button", { name: "Add task" }).click();
    await expect(
      wf.getByLabel("Requires Wolfram validation before it can run"),
    ).not.toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
