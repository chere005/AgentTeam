import {
  test,
  expect,
  _electron as electron,
  type Page,
} from "@playwright/test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openFeature } from "./helpers";

const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    ([m, p, b]) => window.agentteam.request(m as string, p as string, b),
    [method, path, body] as const,
  );

test("simple tasks start directly on a pipeline team and a setup blocker never duplicates the saved task", async ({}, info) => {
  test.setTimeout(90_000);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-simple-")),
  );
  const workspace = join(directory, "work");
  const bin = join(directory, "bin");
  await mkdir(workspace);
  await mkdir(bin);
  const source = join(process.cwd(), "test", "fixtures", "codex-fixture.mjs");
  let codex: string;
  if (process.platform === "win32") {
    await copyFile(source, join(bin, "codex-fixture.mjs"));
    codex = join(bin, "codex.cmd");
    await writeFile(codex, '@node "%~dp0\\codex-fixture.mjs" %*\r\n');
  } else {
    codex = join(bin, "codex-fixture");
    await copyFile(source, codex);
    await chmod(codex, 0o755);
  }
  const claudeScript = join(bin, "claude-fixture.mjs");
  const signedOutFlag = join(bin, "claude-signed-out");
  await writeFile(
    claudeScript,
    `#!/usr/bin/env node\nimport {existsSync} from "node:fs";\nif(process.argv.includes("--version")){console.log("2.1.41 (Claude Code)");process.exit(0)} if(process.argv[2]==="auth"){console.log(JSON.stringify({loggedIn:!existsSync(${JSON.stringify(signedOutFlag)})}));process.exit(0)} process.exit(1);\n`,
  );
  const claude =
    process.platform === "win32" ? join(bin, "claude.cmd") : claudeScript;
  if (process.platform === "win32")
    await writeFile(claude, '@node "%~dp0\\claude-fixture.mjs" %*\r\n');
  else await chmod(claude, 0o755);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !/^path$/i.test(key)) env[key] = value;
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...env,
      PATH: dirname(process.execPath),
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
      AGENTTEAM_DISCOVERY_PATH_ONLY: "1",
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    await api(page, "PUT", "/runtimes/codex", { path: codex });
    await api(page, "PUT", "/runtimes/claude", { path: claude });
    const team = await api(
      page,
      "POST",
      "/teams/examples/pipeline-review-team/insert",
      {
        options: { implementationWorkers: 1, fixWorkers: 1 },
        acceptUnverifiedModels: true,
      },
    );
    const writer = await api(page, "POST", "/agents", {
      name: "Simple: Writer",
      teamId: team.teamId,
      environment: "claude",
      model: "default",
      tools: ["read", "write", "shell"],
      workspaces: [{ path: workspace, access: "write", active: true }],
    });
    const unavailable = await api(page, "POST", "/agents", {
      name: "Unavailable Writer",
      teamId: team.teamId,
      environment: "claude",
      model: "unavailable-model",
      tools: ["read", "write"],
      workspaces: [{ path: workspace, access: "write", active: true }],
    });
    await api(page, "POST", "/agents", {
      name: "Simple? Writer",
      teamId: team.teamId,
      environment: "claude",
      model: "default",
      tools: ["read", "write"],
      workspaces: [{ path: workspace, access: "write", active: true }],
    });
    await openFeature(page, "Projects");
    const open = async () => {
      await page
        .getByRole("button", { name: "Run a task", exact: true })
        .first()
        .click();
      const form = page.getByRole("form", { name: "Assign project" });
      await expect(form.getByLabel("Work type")).toHaveValue("simple");
      return form;
    };
    const form = await open();
    await expect(form.getByLabel("Project isolation")).toHaveCount(0);
    await form.getByLabel("Work type").selectOption("project");
    await expect(form.getByLabel("Project isolation")).toBeVisible();
    await form.getByLabel("Work type").selectOption("simple");
    await form
      .getByRole("button", { name: "Report for duty", exact: true })
      .click();
    await expect(form.getByLabel("Expected file", { exact: true })).toHaveValue(
      "{agent}.txt",
    );
    await expect(form.getByLabel("Required file text")).toHaveValue(
      "I am {agent}, reporting for duty.",
    );
    await expect(form.getByTestId("simple-file-summary")).toContainText(
      "{agent}.txt",
    );
    await expect(form.locator(".assign-simple-selection")).not.toHaveAttribute(
      "open",
      "",
    );
    await expect(
      form.getByRole("button", { name: "Start tasks", exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: info.outputPath("simple-quick-start.png") });
    await form.locator(".assign-simple-selection > summary").click();
    await form
      .getByLabel("Project goal")
      .fill("Write a short reporting-for-duty text file.");
    await form.getByLabel("Project workspace").fill(workspace);
    for (const checkbox of await form
      .locator(".assign-simple-agent-list input")
      .all())
      if (await checkbox.isChecked()) await checkbox.uncheck();
    await form.getByLabel("Assign to Simple: Writer", { exact: true }).check();
    await form.getByText("Verify a file (optional)", { exact: true }).click();
    await form.getByLabel("Expected file", { exact: true }).fill("{agent}.txt");
    await form.getByLabel("Required file text").fill("Reporting for duty.");
    await form.getByLabel("Assign to Simple? Writer", { exact: true }).check();
    await form
      .getByRole("button", { name: "Start tasks", exact: true })
      .click();
    await expect(form.getByRole("alert")).toContainText("same file");
    expect((await api(page, "GET", "/snapshot")).workflows).toHaveLength(0);
    await form
      .getByLabel("Assign to Simple? Writer", { exact: true })
      .uncheck();
    await page.screenshot({ path: info.outputPath("simple-task-form.png") });
    await form.getByRole("button", { name: "Start task", exact: true }).click();
    await expect(form.getByTestId("simple-execution-paused")).toContainText(
      "tasks are ready",
    );
    await expect(
      form.getByRole("button", {
        name: "Resume execution and start",
        exact: true,
      }),
    ).toBeVisible();
    // Test mode intentionally disables execution. Saving must not pretend the tasks ran or
    // silently resume other queued work; the user has a clear, explicit global Resume action.
    await form
      .getByRole("button", { name: "View saved task", exact: true })
      .click();
    await expect(form).toHaveCount(0);
    let snapshot = await api(page, "GET", "/snapshot");
    expect(snapshot.workflows).toHaveLength(1);
    const simple = snapshot.workflows[0];
    expect(simple.paused).toBe(false);
    expect(simple.tasks).toHaveLength(1);
    expect(simple.tasks[0].agentId).toBe(writer.id);
    expect(simple.tasks[0].executionMode).toBe("file-only");
    expect(simple.tasks[0].dependsOn).toEqual([]);
    expect(simple.tasks[0].completionChecks).toEqual([
      {
        type: "artifact-matches",
        path: "Simple_ Writer.txt",
        pattern: "^Reporting for duty\\.(?:\\r?\\n)?$",
        flags: "",
      },
    ]);
    expect(simple.setup.requiresPreflight).not.toBe(true);
    expect(snapshot.liveExecution).toBe(false); // Metadata-only fixture: never execute a provider.
    await expect(page.locator(".projects-current-context")).toContainText(
      simple.name,
    );
    await expect(
      page.locator(".project-card .task-title").first(),
    ).toContainText("Simple: Writer");
    await expect(
      page.locator(".project-card .task-title").first(),
    ).toContainText("Simple_ Writer.txt");

    await writeFile(signedOutFlag, "signed out");
    await api(page, "POST", "/runtimes/refresh");
    const blockedForm = await open();
    await blockedForm.locator(".assign-simple-selection > summary").click();
    await blockedForm
      .getByLabel("Project goal")
      .fill("Write a short text file with the unavailable runtime.");
    await blockedForm.getByLabel("Project workspace").fill(workspace);
    for (const checkbox of await blockedForm
      .locator(".assign-simple-agent-list input")
      .all())
      if (await checkbox.isChecked()) await checkbox.uncheck();
    await blockedForm
      .getByLabel("Assign to Unavailable Writer", { exact: true })
      .check();
    await blockedForm
      .getByRole("button", { name: "Start task", exact: true })
      .click();
    await expect(blockedForm.getByRole("alert")).toContainText(
      "saved but has not started",
    );
    await expect(blockedForm.getByLabel("Project goal")).toBeDisabled();
    snapshot = await api(page, "GET", "/snapshot");
    expect(snapshot.workflows).toHaveLength(2);
    const savedId = snapshot.workflows.find(
      (workflow: { id: string }) => workflow.id !== simple.id,
    ).id;
    await blockedForm
      .getByRole("button", { name: "Try starting again" })
      .click();
    await expect(blockedForm.getByRole("alert")).toBeVisible();
    snapshot = await api(page, "GET", "/snapshot");
    expect(snapshot.workflows).toHaveLength(2);
    expect(
      snapshot.workflows.find(
        (workflow: { id: string }) => workflow.id === savedId,
      ).paused,
    ).toBe(true);
    await expect(
      blockedForm.getByRole("button", { name: "View saved task" }),
    ).toBeVisible();
    await blockedForm.getByRole("button", { name: "View saved task" }).click();
    const empty = await api(page, "POST", "/workflows", {
      name: "Empty project does not run",
      goal: "A goal alone does not give agents executable work.",
      ownerId: writer.id,
      completionCriteria: "Actual work must be assigned first.",
      teamId: team.teamId,
    });
    await page
      .locator(".project-nav-item")
      .filter({ hasText: empty.name })
      .click();
    await expect(page.getByTestId("project-no-tasks")).toContainText(
      "No agents are working",
    );
    await expect(
      page.locator(".project-card").getByRole("progressbar"),
    ).toHaveCount(0);
    await expect(
      page
        .locator(".project-card")
        .getByRole("button", { name: "Pause project", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator(".project-card").getByText("0 of 0", { exact: false }),
    ).toHaveCount(0);
    await expect(
      page.locator(".project-nav-item").filter({ hasText: empty.name }),
    ).toContainText("No tasks assigned");
    await expect(
      page.getByRole("button", { name: "Run a simple task", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
});
