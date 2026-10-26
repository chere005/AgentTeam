import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChatWith } from "./helpers";

test("a chat draft can become direct team assignments without a manager handoff", async ({}, info) => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-chat-team-")),
  );
  const workspace = join(directory, "work");
  await mkdir(workspace);
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    const context = await page.evaluate(async (workspace) => {
      const r = window.agentteam.request;
      const agents = [];
      for (const name of ["Planner", "Writer"])
        agents.push(
          await r("POST", "/agents", {
            name,
            environment: "claude",
            tools: ["read", "write"],
            workspaces: [{ path: workspace, access: "write", active: true }],
          }),
        );
      const old = await r("POST", "/team-spaces/main/projects", {
        mode: "simple",
        name: "Existing work",
        goal: "An earlier task",
        workspace,
        tasks: [
          {
            agentId: agents[0].id,
            title: "Earlier task",
            instructions: "Keep this earlier task paused",
          },
        ],
      });
      return {
        projectId: old.id,
        agents: agents.map((a) => ({ id: a.id, name: a.name })),
      };
    }, workspace);
    await page
      .getByLabel("Current project", { exact: true })
      .selectOption(context.projectId);
    await openChatWith(page, "Planner");
    const side = page.getByRole("complementary", { name: "Side panel" });
    const composer = side.getByLabel("Message", { exact: true });
    const request = "Each agent should write its own reporting-for-duty file";
    await composer.fill(request);
    await expect(side.locator(".composer-scope")).toContainText(
      "Chat with Planner",
    );
    await side
      .getByRole("button", { name: "Assign to team", exact: true })
      .click();
    const form = page.getByRole("form", { name: "Assign project" });
    await expect(form.getByLabel("Project goal")).toHaveValue(request);
    await expect(form.getByLabel("Project workspace")).toHaveValue(workspace);
    await expect(form).toContainText("2 agents selected");
    await expect(
      form.getByRole("button", { name: "Start tasks", exact: true }),
    ).toBeFocused();
    expect(
      (await page.evaluate(() => window.agentteam.request("GET", "/snapshot")))
        .workflows,
    ).toHaveLength(1);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(composer).toHaveValue(request);
    await composer.fill("A different request for the whole team");
    await side
      .getByRole("button", { name: "Assign to team", exact: true })
      .click();
    await expect(form.getByLabel("Project goal")).toHaveValue(
      "A different request for the whole team",
    );
    await form
      .getByRole("button", { name: "Report for duty", exact: true })
      .click();
    await expect(form.getByTestId("simple-file-summary")).toContainText(
      "I am {agent}, reporting for duty.",
    );
    await form
      .getByRole("button", { name: "Start tasks", exact: true })
      .click();
    await expect(form).toContainText("The task is saved but has not started.");
    const snapshot = await page.evaluate(() =>
      window.agentteam.request("GET", "/snapshot"),
    );
    expect(snapshot.execution.active).toBe(0);
    expect(snapshot.workflows).toHaveLength(2);
    const created = snapshot.workflows.find(
      (workflow: { id: string }) => workflow.id !== context.projectId,
    );
    expect(created.paused).toBe(true);
    expect(created.tasks).toHaveLength(2);
    for (const agent of context.agents) {
      const task = created.tasks.find(
        (task: { agentId: string }) => task.agentId === agent.id,
      );
      expect(task.dependsOn).toEqual([]);
      expect(task.executionMode).toBe("file-only");
      expect(task.instructions).toContain(
        `I am ${agent.name}, reporting for duty.`,
      );
      expect(task.completionChecks[0].type).toBe("artifact-matches");
      expect(task.completionChecks[0].pattern).toContain(
        `I am ${agent.name}, reporting for duty`,
      );
    }
    await page.screenshot({
      path: info.outputPath("chat-team-assignment.png"),
    });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
