import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("folder Diff lists files beyond a partial baseline, previews unknown originals honestly and follows external edits", async ({}, info) => {
  test.setTimeout(120_000);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-review-partial-")),
  );
  const project = join(directory, "broad-folder");
  const nested = join(project, "aaa-nested-project");
  await mkdir(nested, { recursive: true });
  for (let offset = 0; offset < 2010; offset += 100)
    await Promise.all(
      Array.from({ length: Math.min(100, 2010 - offset) }, (_, index) =>
        writeFile(
          join(nested, `filler-${String(offset + index).padStart(4, "0")}.txt`),
          "original\n",
        ),
      ),
    );
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
      AGENTTEAM_ENABLE_LIVE: "0",
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const agentId = await page.evaluate(async (folder) => {
      const snapshot = await window.agentteam.request("GET", "/snapshot");
      const { id, createdAt, control, ...config } = snapshot.agents[0];
      await window.agentteam.request("PUT", `/agents/${id}`, {
        ...config,
        workspaces: [{ path: folder, access: "write", active: true }],
      });
      return id as string;
    }, project);
    await page.getByRole("tab", { name: "Diff", exact: true }).click();
    const review = page.getByRole("region", { name: "Code review" });
    await expect(review.getByTestId("folder-scan-incomplete")).toContainText(
      "Folder scan incomplete",
    );
    await expect(
      review.getByText("No pending changes.", { exact: true }),
    ).toHaveCount(0);
    await expect(review).not.toContainText(
      "Too many changed files: showing the first 0",
    );
    await expect(review).toContainText("The comparison is incomplete");

    // No Refresh click: Diff must subscribe to the same external-change events as Files.
    const filename = "Duty Writer.txt";
    await writeFile(
      join(project, filename),
      "I am Duty Writer, reporting for duty.\n",
    );
    const files = review.getByRole("navigation", { name: "Changed files" });
    const duty = files.getByRole("button", { name: /Duty Writer\.txt/ });
    await expect(duty).toBeVisible({ timeout: 20_000 });
    await duty.click();
    await expect(duty).toContainText("Not compared");
    const preview = review.getByLabel("Current file contents", { exact: true });
    await expect(preview).toContainText(
      "I am Duty Writer, reporting for duty.",
    );
    await expect(review).toContainText("Original unavailable");
    await expect(
      review.getByLabel("New file contents", { exact: true }),
    ).toHaveCount(0);
    await expect(review.locator(".review-file-stats")).not.toContainText("+");
    await review.getByLabel("Filter changed files").fill("Duty Writer");
    await writeFile(
      join(project, filename),
      "I am Duty Writer, updated externally.\n",
    );
    await expect(preview).toContainText("updated externally", {
      timeout: 20_000,
    });
    await expect(review.getByLabel("Filter changed files")).toHaveValue(
      "Duty Writer",
    );
    await expect(duty).toHaveAttribute("aria-current", "true");

    // Reproduce an old baseline that silently stopped at 2,000 files with truncated:false.
    const db = new DatabaseSync(join(directory, "data", "agentteam.sqlite"));
    const key = `${agentId}::${project}`;
    const row = db
      .prepare(
        "SELECT data FROM entities WHERE kind='workspace-baseline' AND id=?",
      )
      .get(key) as { data: string };
    const saved = JSON.parse(row.data);
    const legacy = {
      id: saved.id,
      agentId: saved.agentId,
      workspace: saved.workspace,
      capturedAt: saved.capturedAt,
      files: saved.files,
      truncated: false,
    };
    expect(Object.keys(legacy.files)).toHaveLength(2000);
    expect(legacy.files[filename]).toBeUndefined();
    db.prepare(
      "UPDATE entities SET data=? WHERE kind='workspace-baseline' AND id=?",
    ).run(JSON.stringify(legacy), key);
    db.close();
    await review.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(duty).toBeVisible();
    await duty.click();
    await expect(preview).toContainText("updated externally");
    await expect(review.getByTestId("folder-scan-incomplete")).toContainText(
      "saved baseline is incomplete",
    );
    await expect(review).not.toContainText("No pending changes.");
    await review.screenshot({
      path: info.outputPath("partial-baseline-current-file.png"),
    });
    const unchangedDb = new DatabaseSync(
      join(directory, "data", "agentteam.sqlite"),
      { readOnly: true },
    );
    const after = JSON.parse(
      (
        unchangedDb
          .prepare(
            "SELECT data FROM entities WHERE kind='workspace-baseline' AND id=?",
          )
          .get(key) as { data: string }
      ).data,
    );
    unchangedDb.close();
    expect(after.capturedAt).toBe(legacy.capturedAt);
    expect(after.files[filename]).toBeUndefined();
    await writeFile(
      join(project, filename),
      "x".repeat(5500) + "\n".repeat(7000),
    );
    await expect(preview.locator("tr")).toHaveCount(6000, { timeout: 20_000 });
    await expect(preview).toContainText("[line truncated]");
    await expect(review).toContainText("Current contents preview shortened");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
