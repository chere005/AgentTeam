import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChatWith, openFeature, waitForStableCanvas } from "./helpers";
test("desktop connects, persists agents, configures limits and queues chat", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-"));
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
    await expect(
      page.getByRole("heading", { name: "What are we building?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await expect(page.locator(".form-grid label").first()).toContainText(
      "Role type",
    );
    // Priority and concurrency live under the agent form's collapsed "Advanced" section.
    await page.getByTestId("agent-advanced").locator("> summary").click();
    await page.getByLabel("Scheduling priority").selectOption("101");
    await page.getByLabel("Name", { exact: true }).fill("Database Architect");
    await page
      .getByLabel("Role / specialty")
      .fill("Design reliable schemas and migrations");
    await page.getByLabel("Max concurrent invoked agents").selectOption("3");
    await page
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // The new agent's setup panel opens; switch the side panel to its conversation.
    await expect(page.getByTestId("agent-panel-name")).toHaveText(
      "Database Architect",
    );
    await openChatWith(page, "Database Architect");
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Design a small database");
    const composer = page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.press("Shift+Enter");
    await expect(composer).toHaveValue("Design a small database\n");
    await composer.press("Enter");
    await expect(
      page.getByText("Design a small database", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("queued", { exact: true }).first(),
    ).toBeVisible();
    await openFeature(page, "Canvas");
    await expect(page.locator(".agent-card")).toHaveCount(2);
    // The invocation count is part of the detailed cards.
    await page.getByRole("button", { name: "Detailed cards" }).click();
    await expect(
      page.getByText("0 / 3 invoked", { exact: true }),
    ).toBeVisible();
    const source = page
      .locator(".react-flow__node")
      .filter({ hasText: "Team Assistant" })
      .locator(".react-flow__handle.source");
    const target = page
      .locator(".react-flow__node")
      .filter({ hasText: "Database Architect" })
      .locator(".react-flow__handle.target");
    await page.getByRole("button", { name: "Fit view" }).click();
    await waitForStableCanvas(page);
    await expect(source).toBeVisible();
    await expect(target).toBeVisible();
    const sourceBounds = await source.boundingBox();
    const targetBounds = await target.boundingBox();
    if (!sourceBounds || !targetBounds)
      throw new Error("Connection handles are missing");
    const sourcePoint = {
      x: sourceBounds.x + sourceBounds.width / 2,
      y: sourceBounds.y + sourceBounds.height / 2,
    };
    const targetPoint = {
      x: targetBounds.x + targetBounds.width / 2,
      y: targetBounds.y + targetBounds.height / 2,
    };
    // React Flow listens for a mouse-down on the source handle followed by a
    // sustained move and mouse-up on the target. locator.dragTo can compress
    // that gesture enough to lose the connection start in Electron CI.
    await page.mouse.move(sourcePoint.x, sourcePoint.y);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 32 });
    await page.waitForTimeout(80);
    // React Flow may auto-pan while the source starts near the canvas edge;
    // aim at the target's live position after that pan, then wait for its valid state.
    const liveTargetBounds = await target.boundingBox();
    if (!liveTargetBounds) throw new Error("Connection target disappeared");
    await page.mouse.move(
      liveTargetBounds.x + liveTargetBounds.width / 2,
      liveTargetBounds.y + liveTargetBounds.height / 2,
    );
    await expect(target).toHaveClass(/connectingto/);
    await page.mouse.up();
    await expect(
      page.getByRole("dialog", { name: "Connection settings" }),
    ).toBeVisible();
    await page.getByRole("radio", { name: /Ask for advice/ }).click();
    await page
      .getByRole("button", { name: "Either agent", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Connect agents", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".edge-caption")).toHaveText("Advice");
    await page.screenshot({ path: join("test-results", "desktop-canvas.png") });
    await page.reload();
    await expect(page.locator(".agent-card")).toHaveCount(2);

    await page.screenshot({ path: join("test-results", "desktop-chat.png") });
    await page.evaluate(async (folder) => {
      const snapshot = await window.agentteam.request("GET", "/snapshot");
      const agent = snapshot.agents.find(
        (a: any) => a.name === "Database Architect",
      );
      const { id, createdAt, control, ...input } = agent;
      await window.agentteam.request("PUT", "/agents/" + id, {
        ...input,
        workspaces: [{ path: folder, access: "write", active: true }],
      });
      await window.agentteam.request("POST", "/workflows", {
        name: "Parallel review",
        goal: "Review shared code",
        ownerId: id,
        completionCriteria: "Reviewed",
      });
    }, directory);
    // Access & resources: the agent's explicit folder access, then shared resources.
    await openFeature(page, "Access & resources");
    const main = page.getByRole("main", { name: "Main content" });
    await main
      .locator(".access-page")
      .getByRole("combobox", { name: "Agent", exact: true })
      .selectOption({ label: "Database Architect" });
    await expect(page.getByText("EXPLICIT FILE ACCESS")).toBeVisible();
    await expect(page.locator(".access-folder .full-path")).toContainText(
      process.platform === "darwin"
        ? directory.replace(/^\/var\//, "/private/var/")
        : directory,
    );
    await main.getByRole("button", { name: "Resource", exact: true }).click();
    await main.getByLabel("Name", { exact: true }).fill("Shared project");
    await page.getByLabel("Priority for Database Architect").selectOption("75");
    await page
      .getByRole("button", { name: "Save resource", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Priorities", exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Workflow", { exact: true })
      .selectOption({ label: "Parallel review" });
    await page.getByLabel("Allow parallel work in this workflow").check();
    await page.getByLabel("Shared project", { exact: true }).check();
    await page
      .getByRole("button", { name: "Apply workflow access", exact: true })
      .click();
    await expect(
      page
        .locator(".queue-row")
        .filter({ hasText: "Coordinate parallel work: Parallel review" }),
    ).toBeVisible();
    await page.screenshot({
      path: join("test-results", "desktop-resources.png"),
    });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("review feedback, local preview and isolated worktree flow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-review-"));
  const project = join(directory, "project");
  await mkdir(project);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", project, ...args]);
  git("init", "-q");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  await writeFile(join(project, "example.txt"), "before\n");
  await writeFile(
    join(project, "dev.cjs"),
    `require('node:http').createServer((req,res)=>res.end('<h1>Preview fixture</h1>')).listen(Number(process.env.PORT),'127.0.0.1');`,
  );
  git("add", ".");
  git("commit", "-qm", "Initial");
  await writeFile(join(project, "example.txt"), "after\n");
  const portProbe = createServer();
  await new Promise<void>((resolve) =>
    portProbe.listen(0, "127.0.0.1", resolve),
  );
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
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
    await expect(
      page.getByRole("table", { name: "Side-by-side diff" }),
    ).toContainText("after");
    await page
      .getByRole("button", { name: "Comment on new line 1", exact: true })
      .click();
    await page
      .getByLabel("Review feedback", { exact: true })
      .fill("Explain this change.");
    await page.getByRole("button", { name: "Send feedback to agent" }).click();
    await expect(
      page.getByText(/Feedback queued for Team Assistant/),
    ).toBeVisible();
    // The comment is persisted and listed as unresolved in the review summary.
    await expect(
      page.getByRole("region", { name: "Review summary" }),
    ).toContainText("1 unresolved");
    await openFeature(page, "Preview");
    await page
      .getByLabel("Server command")
      .fill(`"${process.execPath}" dev.cjs`);
    await page.getByLabel("Preview URL").fill(`http://127.0.0.1:${port}`);
    await page
      .getByRole("button", { name: "Start server", exact: true })
      .click();
    await expect(page.getByText(/Server: Ready/)).toBeVisible();
    await page.getByRole("button", { name: "Open / reload preview" }).click();
    await expect(
      page
        .frameLocator("iframe")
        .getByRole("heading", { name: "Preview fixture" }),
    ).toBeVisible();
    expect(
      await page
        .frameLocator("iframe")
        .locator("body")
        .evaluate(() => typeof window.agentteam),
    ).toBe("undefined");
    await page
      .getByRole("button", { name: "Stop server", exact: true })
      .click();
    await expect(page.getByText(/Server: Stopped/)).toBeVisible();
    await openFeature(page, "Git");
    await page.getByText("Create isolated worktree", { exact: true }).click();
    await page
      .getByLabel("New branch", { exact: true })
      .fill("agentteam/review-test");
    await page.getByRole("button", { name: "Create and attach" }).click();
    await expect(page.getByLabel("Workspace folder")).toContainText(
      "AgentTeam-worktrees",
    );
    await page.screenshot({
      path: join("test-results", "desktop-worktree.png"),
    });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("ACP settings, permissions and conversation delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-acp-ui-"));
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, AGENTTEAM_DATA_DIR: directory, AGENTTEAM_TEST: "1" },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Agent connections", exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("codex connection", { exact: true })
      .selectOption("acp");
    await page
      .getByLabel("codex ACP executable", { exact: true })
      .fill(process.execPath);
    await page
      .getByLabel("codex ACP arguments", { exact: true })
      .fill(
        join(process.cwd(), "test", "fixtures", "acp-agent.mjs") +
          "\npermission",
      );
    await page
      .getByRole("button", { name: "Save codex connection", exact: true })
      .click();
    await expect(
      page.getByText("codex connection saved", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      window.agentteam.request("PUT", "/execution", { enabled: true }),
    );
    await expect(
      page.getByRole("button", { name: "Pause execution", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Exercise ACP permissions");
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .press("Enter");
    const approval = page.getByRole("dialog", {
      name: "Agent permission request",
    });
    await expect(approval).toContainText("Write fixture");
    await approval
      .getByRole("button", { name: "Allow once", exact: true })
      .click();
    await expect(approval).toHaveCount(0);
    await expect(page.getByText("approved", { exact: true })).toBeVisible();
    const ids = await page.evaluate(async () =>
      (await window.agentteam.request("GET", "/sessions")).map(
        (s: any) => s.providerSessionId,
      ),
    );
    expect(
      ids.some((id: string) => /^acp:[a-f0-9]{16}:fixture$/.test(id)),
    ).toBe(true);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("team templates: save selection, library preview and mapped insert", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-teams-ui-"));
  const project = join(directory, "project");
  const target = join(directory, "target");
  await mkdir(project);
  await mkdir(target);
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
    await page.evaluate(async (folder) => {
      const call = (m: string, p: string, b?: unknown) =>
        window.agentteam.request(m, p, b);
      const make = (name: string, extra: object = {}) =>
        call("POST", "/agents", { name, environment: "codex", ...extra });
      const alpha = await make("Alpha Dev", {
        workspaces: [{ path: folder, access: "write", active: true }],
      });
      const beta = await make("Beta Review");
      const outside = await make("Outside Helper");
      await call("POST", "/edges", {
        from: alpha.id,
        to: beta.id,
        kind: "review",
      });
      await call("POST", "/edges", {
        from: outside.id,
        to: beta.id,
        kind: "consult",
      });
    }, project);
    await page.reload();
    await openFeature(page, "Canvas");
    await expect(page.locator(".agent-card")).toHaveCount(4);
    const saveButton = page.getByRole("button", {
      name: "Save as team",
      exact: true,
    });
    // Nothing selected: saving a team is not offered.
    await expect(saveButton).toHaveCount(0);
    await page
      .locator(".react-flow__node")
      .filter({ hasText: "Alpha Dev" })
      .click();
    await page
      .locator(".react-flow__node")
      .filter({ hasText: "Beta Review" })
      .click({ modifiers: ["ControlOrMeta"] });
    await saveButton.click();
    const save = page.getByRole("dialog", { name: "Save as team" });
    await expect(save).toContainText("Alpha Dev, Beta Review");
    await expect(
      save.getByLabel("Include absolute folder paths"),
    ).not.toBeChecked();
    await save.getByLabel("Team name").fill("Pair");
    await save.getByRole("button", { name: "Save team", exact: true }).click();
    await expect(save.getByTestId("external-dependencies")).toContainText(
      "Outside Helper",
    );
    await save.getByRole("button", { name: "Done", exact: true }).click();
    await openFeature(page, "Team library");
    await page
      .getByRole("list", { name: "Saved teams" })
      .getByRole("button", { name: /Pair/ })
      .click();
    await expect(page.getByTestId("preview-issues")).toContainText(
      "needs a directory mapping",
    );
    await expect(page.getByTestId("external-dependencies")).toContainText(
      "Outside Helper",
    );
    await page.getByRole("button", { name: "Insert…", exact: true }).click();
    const insert = page.getByRole("dialog", { name: /Insert/ });
    // Default destination is a new team of its own; here the copy joins the active team.
    await expect(
      insert.getByRole("button", { name: "Insert as new team", exact: true }),
    ).toBeDisabled();
    await expect(insert.getByLabel("New team name")).toHaveValue("Pair");
    await insert.getByLabel(/Add to the active team “Main team”/).check();
    await expect(
      insert.getByRole("button", { name: "Insert team", exact: true }),
    ).toBeDisabled();
    await expect(insert.getByTestId("insert-issues")).toContainText(
      "needs a directory mapping",
    );
    // Replacement models are dropdowns that default to keeping the template's model.
    const replacement = insert.getByLabel(/^Replacement model for /).first();
    await expect(replacement).toHaveValue("");
    await expect(replacement.locator("option").first()).toHaveText(
      /^Keep template model \(/,
    );
    await expect(replacement.locator("option").last()).toHaveText(
      "Custom model ID…",
    );
    await insert
      .getByLabel("Allow environments that are not installed")
      .check();
    await insert.getByLabel(/Folder for Alpha Dev/).fill(target);
    await expect(insert.getByText("No blocking issues.")).toBeVisible();
    await insert
      .getByRole("button", { name: "Insert team", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".agent-card")).toHaveCount(6);
    await expect(
      page.locator(".agent-card").filter({ hasText: "Alpha Dev" }),
    ).toHaveCount(2);
    const snapshot = await page.evaluate(() =>
      window.agentteam.request("GET", "/snapshot"),
    );
    const copies = snapshot.agents.filter((a: any) => a.name === "Alpha Dev");
    expect(copies).toHaveLength(2);
    expect(
      copies.some((a: any) => a.workspaces[0].path.endsWith("target")),
    ).toBe(true);
    const positions = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("agentteam.positions") ?? "{}"),
    );
    const inserted = copies.find((a: any) =>
      a.workspaces[0].path.endsWith("target"),
    );
    expect(positions[inserted.id].x).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
