import { execFileSync } from "node:child_process";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile, rename, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

test("review: branch compare, side-by-side, keyboard navigation and narrow layout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-review2-"));
  const project = join(directory, "project");
  await mkdir(project);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  const lines = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`);
  await writeFile(join(project, "code.ts"), lines.join("\n") + "\n");
  await writeFile(join(project, "move-me.txt"), "same\ncontent\nhere\n");
  await writeFile(join(project, "run.sh"), "echo hi\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  lines[2] = "const v2 = 'changed'; // note";
  lines[35] = "const v35 = 350;";
  await writeFile(join(project, "code.ts"), lines.join("\n") + "\n");
  await rename(join(project, "move-me.txt"), join(project, "moved.txt"));
  await chmod(join(project, "run.sh"), 0o755);
  git("add", "-A");
  git("commit", "-qm", "feature work");
  // Main moves on: a merge-base comparison must not show this file.
  git("checkout", "-q", "main");
  await writeFile(join(project, "main-only.txt"), "only on main\n");
  git("add", "-A");
  git("commit", "-qm", "main work");
  git("checkout", "-q", "feature");
  // Uncommitted edits must stay out of the branch comparison.
  await writeFile(join(project, "dirty.txt"), "dirty\n");

  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await page.evaluate(async (folder) => {
      const snapshot = await window.agentteam.request("GET", "/snapshot");
      const { id, createdAt, control, ...config } = snapshot.agents[0];
      await window.agentteam.request("PUT", "/agents/" + id, {
        ...config,
        workspaces: [{ path: folder, access: "write", active: true }],
      });
    }, project);
    await openFeature(page, "Review changes");
    const review = page.getByRole("region", { name: "Code review" });
    await expect(review.getByText("dirty.txt").first()).toBeVisible();

    // Branch compare with an invalid revision is rejected clearly.
    await review.getByRole("button", { name: "Compare branches" }).click();
    await review.getByLabel("Base branch or commit").fill("no-such-branch");
    await review.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(review.getByRole("alert")).toContainText("not a known branch");
    await review.getByLabel("Base branch or commit").fill("main");
    await review.getByRole("button", { name: "Compare", exact: true }).click();
    const files = review.getByRole("navigation", { name: "Changed files" });
    await expect(files).toContainText("code.ts");
    await expect(files).toContainText("moved.txt");
    await expect(files).toContainText("run.sh");
    await expect(files).not.toContainText("main-only.txt");
    await expect(files).not.toContainText("dirty.txt");
    await expect(
      review.getByRole("status").filter({ hasText: "merge base" }),
    ).toBeVisible();

    // Side by side (wide pane) with highlighting and aligned old/new anchors.
    await files.getByRole("button", { name: /code\.ts/ }).click();
    const split = review.getByRole("table", { name: "Side-by-side diff" });
    await expect(split).toBeVisible();
    await expect(split.locator(".tok-str").first()).toContainText("changed");
    await expect(split.locator(".tok-com").first()).toContainText("// note");

    // Keyboard: hunks, then files.
    await expect(page.getByTestId("hunk-position")).toHaveText("Hunk 1 of 2");
    await review.getByLabel("Diff content").focus();
    await page.keyboard.press("n");
    await expect(page.getByTestId("hunk-position")).toHaveText("Hunk 2 of 2");
    await page.keyboard.press("p");
    await expect(page.getByTestId("hunk-position")).toHaveText("Hunk 1 of 2");
    await page.keyboard.press("]");
    await expect(
      files.getByRole("button", { name: /moved\.txt/ }),
    ).toHaveAttribute("aria-current", "true");
    await expect(review.getByLabel("File change details")).toContainText(
      "Renamed from move-me.txt",
    );
    await page.keyboard.press("]");
    await expect(review.getByLabel("File change details")).toContainText(
      "File mode changed 100644 → 100755",
    );
    await page.keyboard.press("[");
    await page.keyboard.press("[");
    await expect(
      files.getByRole("button", { name: /code\.ts/ }),
    ).toHaveAttribute("aria-current", "true");

    // Comment from the new side of the split view; anchored to the compare scope.
    await review
      .getByRole("button", { name: "Comment on new line 3", exact: true })
      .click();
    await review
      .getByLabel("Review feedback", { exact: true })
      .fill("Why quote it?");
    await review
      .getByRole("button", { name: "Send feedback to agent" })
      .click();
    await expect(page.getByText(/Feedback queued for/)).toBeVisible();
    const summary = review.getByRole("region", { name: "Review summary" });
    await expect(summary).toContainText("1 unresolved");
    await expect(summary).toContainText("code.ts · new line 3");
    // Comments are scoped: the unstaged view does not list it.
    await review.getByRole("button", { name: "Unstaged", exact: true }).click();
    await expect(
      review.getByRole("region", { name: "Review summary" }),
    ).toContainText("0 unresolved");
    await review.getByRole("button", { name: "Compare branches" }).click();
    await review.getByRole("button", { name: "Compare", exact: true }).click();
    await expect(
      review.getByRole("region", { name: "Review summary" }),
    ).toContainText("1 unresolved");

    // Unified layout stays available on demand.
    await review.getByRole("button", { name: "Unified", exact: true }).click();
    await expect(
      review.getByRole("table", { name: "Unified diff" }),
    ).toBeVisible();
    await expect(split).toHaveCount(0);
    await review
      .getByRole("button", { name: "Side by side", exact: true })
      .click();
    await expect(split).toBeVisible();

    // Narrow window: side-by-side is disabled and unified is used.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setMinimumSize(300, 400);
      win.setSize(520, 900);
    });
    await expect
      .poll(() => review.evaluate((el) => el.clientWidth))
      .toBeLessThan(640);
    await expect(
      review.getByRole("table", { name: "Unified diff" }),
    ).toBeVisible();
    await expect(
      review.getByRole("button", { name: "Side by side", exact: true }),
    ).toBeDisabled();
    // Keyboard navigation still works in the narrow layout.
    await review.getByLabel("Diff content").focus();
    await page.keyboard.press("n");
    await expect(page.getByTestId("hunk-position")).toHaveText("Hunk 2 of 2");
    // No horizontal page overflow from the review pane.
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Diff lists and compares pending file changes without requiring Git", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-review-plain-"));
  const project = join(directory, "plain-folder");
  await mkdir(project);
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await page.evaluate(async (folder) => {
      const snapshot = await window.agentteam.request("GET", "/snapshot");
      const { id, createdAt, control, ...config } = snapshot.agents[0];
      await window.agentteam.request("PUT", "/agents/" + id, {
        ...config,
        workspaces: [{ path: folder, access: "write", active: true }],
      });
    }, project);
    await page.getByRole("tab", { name: "Diff", exact: true }).click();
    const review = page.getByRole("region", { name: "Code review" });
    await expect(
      review.getByRole("heading", { name: "Pending changes" }),
    ).toBeVisible();
    await expect(review).toContainText("no Git required");
    await expect(
      review.getByRole("button", { name: "Compare branches" }),
    ).toHaveCount(0);
    await writeFile(join(project, "draft.py"), "print('Pi')\n");
    await review.getByRole("button", { name: "Refresh" }).click();
    const files = review.getByRole("navigation", { name: "Changed files" });
    await expect(
      files.getByRole("button", { name: /draft\.py/ }),
    ).toBeVisible();
    await files.getByRole("button", { name: /draft\.py/ }).click();
    await expect(review.getByLabel("Diff content")).toContainText(
      "print('Pi')",
    );
    await review
      .getByRole("button", { name: "Set current files as baseline" })
      .click();
    await expect(review.getByText("No pending changes.")).toBeVisible();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
