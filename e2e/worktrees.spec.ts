import { execFileSync } from "node:child_process";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("worktree manager: create with setup, duplicate error, dirty remove refusal, archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-wt-ui-"));
  const project = join(directory, "project");
  await mkdir(project);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", project, ...args]);
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(join(project, "example.txt"), "before\n");
  git("add", ".");
  git("commit", "-qm", "Initial");
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
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await page.getByRole("button", { name: "Git", exact: true }).click();
    await page.getByText("Create isolated worktree", { exact: true }).click();
    await page
      .getByLabel("New branch", { exact: true })
      .fill("agentteam/ui-test");
    // Visible setup command, run only because the user entered it and pressed create.
    await page
      .getByLabel("Setup command (optional)")
      .fill(`"${process.execPath}" -e "console.log('setup-ran-ok')"`);
    await expect(
      page.getByText(/this will run in the new worktree/),
    ).toBeVisible();
    await page
      .getByLabel("Keep the original repository attached (inactive)")
      .check();
    await page.getByRole("button", { name: "Create and attach" }).click();
    await expect(page.getByLabel("Workspace folder")).toContainText(
      "AgentTeam-worktrees",
    );
    const card = page.getByLabel("Worktree agentteam/ui-test");
    await expect(card).toContainText("Setup: succeeded");
    await expect(card).toContainText("exit 0");
    await expect(card.getByLabel("Setup log")).toContainText("setup-ran-ok");
    await expect(card).toContainText("Team Assistant (active)");
    await expect(card).toContainText("Active tasks: none");
    // Original stays attached (inactive) because the option was chosen.
    await expect(page.getByLabel("Workspace folder")).toContainText("project");
    // Duplicate branch gives a clear error and creates nothing.
    await page.getByText("Create isolated worktree", { exact: true }).click();
    await page
      .getByLabel("New branch", { exact: true })
      .fill("agentteam/ui-test");
    await page.getByRole("button", { name: "Create and attach" }).click();
    await expect(page.getByRole("alert")).toContainText(/already exists/);
    // Dirty trees cannot be removed; the file survives.
    const path = (await card.locator("code").first().textContent())!;
    await writeFile(join(path, "wip.txt"), "uncommitted\n");
    await card.getByRole("button", { name: "Remove", exact: true }).click();
    await card.getByRole("button", { name: "Confirm remove" }).click();
    await expect(page.getByRole("alert")).toContainText(/Refusing to remove/);
    expect(await readFile(join(path, "wip.txt"), "utf8")).toBe("uncommitted\n");
    // Archive keeps everything, including the dirty file.
    await card.getByRole("button", { name: "Archive", exact: true }).click();
    await card.getByRole("button", { name: "Confirm archive" }).click();
    await expect(card).toContainText("archived");
    expect(await readFile(join(path, "wip.txt"), "utf8")).toBe("uncommitted\n");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
