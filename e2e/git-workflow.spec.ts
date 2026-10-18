import { execFileSync } from "node:child_process";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";

// Fixtures only: a local bare "origin" in a temp directory. Nothing touches a real remote, the
// network, a browser, or the user's AgentTeam data directory.
test("git workflow: fetch/pull/push feedback, branch safety, conflicts, PR link, previews, live refresh", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-gitwf-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_COMMITTER_NAME: "Test",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env });
  const bare = join(directory, "origin.git"),
    other = join(directory, "other"),
    project = join(directory, "project");
  git(directory, "init", "-q", "--bare", "-b", "main", bare);
  git(directory, "clone", "-q", bare, other);
  await writeFile(join(other, "a.txt"), "one\n");
  await writeFile(join(other, "c.txt"), "base\nshared\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "first");
  git(other, "push", "-q", "origin", "HEAD:main");
  git(directory, "clone", "-q", bare, project);
  // Upstream moves ahead so Fetch/Pull have something to do.
  await writeFile(join(other, "b.txt"), "remote\n");
  git(other, "add", ".");
  git(other, "commit", "-qm", "remote work");
  git(other, "push", "-q", "origin", "HEAD:main");

  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
    } as Record<string, string>,
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
    const panel = page.getByRole("region", { name: "Git workflow" });
    await expect(panel).toContainText("main");
    await expect(panel).toContainText("ahead 0 · behind 0");

    // Fetch reports what happened; pull is fast-forward only.
    await panel.getByRole("button", { name: "Fetch" }).click();
    await expect(panel.getByRole("status").first()).toContainText("Fetched");
    await expect(panel).toContainText("behind 1");
    await panel.getByRole("button", { name: "Pull (fast-forward)" }).click();
    await expect(panel.getByRole("status").first()).toContainText(
      "Updated main",
    );
    await expect(panel).toContainText("behind 0");

    // History is bounded and browsable.
    await panel.getByText("History", { exact: true }).click();
    const history = panel.getByRole("list", { name: "Commit history" });
    await expect(history).toContainText("remote work");
    await history.getByRole("button", { name: /remote work/ }).click();
    await expect(history).toContainText("b.txt");

    // Pull request link from the remote URL (no browser is launched, no API called).
    git(
      project,
      "remote",
      "set-url",
      "origin",
      "https://github.com/acme/widgets.git",
    );
    await panel.getByText("Pull request", { exact: true }).click();
    await page.getByRole("button", { name: "Refresh Git" }).click();

    // Branch safety: a dirty tree needs an explicit confirmation before switching.
    git(project, "branch", "topic");
    await writeFile(join(project, "a.txt"), "dirty\n");
    await page.getByRole("button", { name: "Refresh Git" }).click();
    await expect(panel.getByText("1 changed")).toBeVisible();
    const target = panel.getByLabel("Branch to switch to");
    await target.selectOption("topic");
    const switchButton = panel.getByRole("button", {
      name: "Switch",
      exact: true,
    });
    await expect(switchButton).toBeDisabled();
    await panel.getByLabel(/Carry 1 uncommitted/).check();
    await switchButton.click();
    await expect(panel.getByRole("status").first()).toContainText(
      "Switched to topic",
    );
    expect(git(project, "branch", "--show-current").trim()).toBe("topic");
    await expect(panel.getByRole("link")).toHaveCount(0);
    await expect(panel).toContainText(
      "https://github.com/acme/widgets/compare/main...topic?expand=1",
    );
    await expect(
      panel.getByRole("button", { name: "Open pull request page" }),
    ).toBeEnabled();
    // Test mode records launches instead of starting a browser.
    await panel.getByRole("button", { name: "Open pull request page" }).click();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const r = await window.agentteam.request("GET", "/test/launches");
          return r.launches.map((l: { kind: string; url?: string }) => l.url);
        }),
      )
      .toEqual([
        "https://github.com/acme/widgets/compare/main...topic?expand=1",
      ]);

    // Publish needs an explicit set-upstream action; failures are explained. The remote is
    // switched to a missing local path first so nothing can ever reach a real host.
    git(
      project,
      "remote",
      "set-url",
      "origin",
      "file://" + join(directory, "missing.git"),
    );
    await panel.getByRole("button", { name: "Push and set upstream" }).click();
    await expect(panel.getByRole("alert").first()).toContainText("Push failed");
    git(project, "remote", "set-url", "origin", bare);
    git(project, "checkout", "--", "a.txt");
    await panel.getByRole("button", { name: "Push and set upstream" }).click();
    await expect(panel.getByRole("status").first()).toContainText(
      "Pushed topic",
    );

    // A branch tracking a differently named remote branch: the target is shown and pushing there
    // needs an explicit tick naming it.
    git(project, "branch", "--set-upstream-to=origin/main", "topic");
    await panel.getByRole("button", { name: "Fetch" }).click();
    const pushTo = panel.getByRole("button", { name: /^Push to origin\/main/ });
    await expect(pushTo).toBeDisabled();
    await panel.getByLabel("Push topic onto origin/main").check();
    await expect(pushTo).toBeEnabled();
    git(project, "branch", "--set-upstream-to=origin/topic", "topic");

    // Conflict visibility and deliberate resolution.
    git(project, "switch", "-q", "main");
    await writeFile(join(project, "c.txt"), "base\nmain side\n");
    git(project, "commit", "-qam", "main edit");
    git(project, "switch", "-q", "-c", "side", "HEAD~2");
    await writeFile(join(project, "c.txt"), "base\nside edit\n");
    git(project, "commit", "-qam", "side edit");
    git(project, "switch", "-q", "main");
    try {
      git(project, "merge", "side");
    } catch {
      /* conflict expected */
    }
    await page.getByRole("button", { name: "Refresh Git" }).click();
    const conflicts = panel.getByRole("region", { name: "Conflicts" });
    await expect(conflicts).toContainText("A merge is in progress");
    await conflicts.getByRole("button", { name: /c\.txt/ }).click();
    const detail = conflicts.getByLabel("Conflict details");
    await expect(detail).toContainText("main side");
    await expect(detail).toContainText("side edit");
    await expect(
      detail.getByRole("button", { name: /Mark resolved/ }),
    ).toBeDisabled();
    await expect(
      conflicts.getByRole("button", { name: /Continue merge/ }),
    ).toBeDisabled();
    await conflicts.getByRole("button", { name: /Abort merge/ }).click();
    await conflicts
      .getByRole("button", { name: "Confirm abort merge" })
      .click();
    await expect(panel.getByRole("status").first()).toContainText(
      "Aborted the merge",
    );
    await expect(conflicts).toHaveCount(0);
    expect(git(project, "status", "--porcelain").trim()).toBe("");

    // Files: typed previews and live refresh after an external edit (no manual refresh).
    await page.getByRole("button", { name: "Files", exact: true }).click();
    await expect(page.getByRole("button", { name: /a\.txt/ })).toBeVisible();
    await writeFile(
      join(project, "table.csv"),
      'name,note\n"Smith, J","said ""hi"""\n',
    );
    const png = Buffer.concat([
      Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
      Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]),
      Buffer.alloc(30),
    ]);
    await writeFile(join(project, "pic.png"), png);
    await writeFile(join(project, "data.json"), '{"k":[1,2]}');
    await writeFile(join(project, "doc.pdf"), "%PDF-1.4\n");
    await expect(page.getByRole("button", { name: /table\.csv/ })).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole("button", { name: /table\.csv/ }).click();
    const table = page.getByRole("table", { name: "Table preview" });
    await expect(table).toContainText("Smith, J");
    await expect(table).toContainText('said "hi"');
    await page.getByRole("button", { name: /data\.json/ }).click();
    await expect(page.getByLabel("File preview")).toContainText('"k": [');
    await page.getByRole("button", { name: /pic\.png/ }).click();
    await expect(
      page.getByRole("img", { name: /Preview of pic\.png/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /doc\.pdf/ }).click();
    await expect(page.getByLabel("File preview")).toContainText(
      "open in an external application",
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
