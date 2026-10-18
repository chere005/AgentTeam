import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("team packs: preview, gated install with groups, and three-way update that keeps local edits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-packs-ui-"));
  const project = join(directory, "project");
  await mkdir(project);
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, AGENTTEAM_DATA_DIR: directory, AGENTTEAM_TEST: "1" },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Saved teams", exact: true })
      .first()
      .click();
    const library = page.getByRole("list", { name: "Bundled packs" });
    await expect(library).toContainText("Swift development");
    await expect(library).toContainText("skeleton");

    // Preview: compatibility, skills/licenses, what is missing, grants; nothing written yet.
    await library.getByRole("button", { name: "Preview…" }).click();
    const dialog = page.getByRole("dialog", { name: /Pack/ });
    await expect(dialog.getByTestId("pack-limitations")).toContainText(
      "No Xcode",
    );
    await expect(dialog.getByTestId("pack-skills")).toContainText(
      "swift-expert · MIT",
    );
    await expect(dialog.getByTestId("pack-skills")).toContainText(
      "not bundled — install separately",
    );
    await expect(dialog.getByTestId("pack-harnesses")).toContainText("claude");
    await expect(dialog.getByTestId("pack-issues")).toContainText(
      "needs a directory mapping",
    );
    const install = dialog.getByRole("button", {
      name: "Install pack",
      exact: true,
    });
    await expect(install).toBeDisabled();
    const folders = dialog.getByLabel(/^Folder for /);
    await expect(folders).toHaveCount(5);
    for (let i = 0; i < 5; i++) await folders.nth(i).fill(project);
    await expect(dialog.getByTestId("pack-issues")).toContainText(
      "not installed or detected",
    );
    await dialog
      .getByLabel("Allow environments that are not installed")
      .check();
    await expect(dialog.getByText("No blocking issues.")).toBeVisible();
    // Grants must be accepted explicitly.
    await expect(dialog.getByTestId("pack-grants")).toContainText(
      "read & write access",
    );
    await expect(install).toBeDisabled();
    await dialog.getByLabel("I have reviewed and accept these grants").check();
    await expect(install).toBeEnabled();
    await install.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".agent-card")).toHaveCount(6); // 5 + Team Assistant

    const snapshot = () =>
      page.evaluate(() => window.agentteam.request("GET", "/snapshot"));
    let snap = await snapshot();
    const byName = (name: string) =>
      snap.agents.find((a: any) => a.name === name);
    expect(byName("Swift Implementer").skills[0].id).toBe(
      "curated:jeffallan--swift-expert",
    );
    expect(byName("Swift Implementer").skills[0].allowUnverified).toBe(false);
    // The pack got its own team, which is now active.
    expect(snap.teams.find((t: any) => t.id === snap.activeTeamId).name).toBe(
      "Swift development",
    );
    await expect(page.getByTestId("active-team-name")).toHaveText(
      "Swift development",
    );
    // Group membership came with the pack (canvas groups are stored per team).
    const groups = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
      "agentteam.groups.team-" + snap.activeTeamId,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Swift team");
    expect(groups[0].agentIds).toHaveLength(5);

    // The user customizes the implementer locally.
    await page.evaluate(async (id) => {
      const call = (m: string, p: string, b?: unknown) =>
        window.agentteam.request(m, p, b);
      const {
        id: _i,
        createdAt,
        control,
        ...input
      } = await call("GET", "/agents/" + id);
      await call("PUT", "/agents/" + id, {
        ...input,
        instructions: "My own implementer instructions",
      });
    }, byName("Swift Implementer").id);

    // A newer pack version arrives as a file.
    const manifest = JSON.parse(
      await readFile("assets/team-packs/swift-development/pack.json", "utf8"),
    );
    manifest.pack.version = "0.2.0";
    for (const a of manifest.template.agents) {
      if (a.key === "implementer") a.instructions = "Pack v2 implementer";
      if (a.key === "tester") a.instructions = "Pack v2 tester";
    }
    const next = join(directory, "swift-0.2.0.json");
    await writeFile(next, JSON.stringify(manifest));
    await page
      .getByRole("button", { name: "Saved teams", exact: true })
      .first()
      .click();
    const installed = page.getByRole("list", { name: "Installed packs" });
    await expect(installed).toContainText("Swift development");
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      installed.getByRole("button", { name: "Update from file…" }).click(),
    ]);
    await chooser.setFiles(next);
    const update = page.getByRole("dialog", { name: /Update/ });
    await expect(update.getByTestId("update-conflicts")).toContainText(
      "Swift Implementer",
    );
    await expect(update.getByTestId("update-applied")).toContainText(
      "Swift Test Engineer",
    );
    const apply = update.getByRole("button", {
      name: "Apply update",
      exact: true,
    });
    await expect(apply).toBeDisabled(); // unresolved conflict
    await update.getByLabel(/Keep my version/).check();
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("status")).toContainText("Updated to 0.2.0");
    snap = await snapshot();
    expect(byName("Swift Implementer").instructions).toBe(
      "My own implementer instructions",
    );
    expect(byName("Swift Test Engineer").instructions).toBe("Pack v2 tester");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
