import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openChatWith } from "./helpers";

test("assistant Start tasks creates real assignments and a paused retry reuses them", async ({}, info) => {
  const directory = await mkdtemp(
    join(tmpdir(), "agentteam-e2e-assistant-start-"),
  );
  const workspace = join(directory, "files");
  await mkdir(workspace);
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: directory,
      AGENTTEAM_TEST: "1",
      AGENTTEAM_ENABLE_LIVE: "0",
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    const seeded = await page.evaluate(async (workspace) => {
      const r = window.agentteam.request;
      for (const name of ["First writer", "Second writer"])
        await r("POST", "/agents", {
          name,
          environment: "claude",
          tools: ["read", "write"],
          workspaces: [{ path: workspace, access: "write", active: true }],
        });
      const snapshot = await r("GET", "/snapshot");
      const assistant = snapshot.agents.find(
        (a: { kind: string }) => a.kind === "team-assistant",
      );
      const session = await r("POST", `/agents/${assistant.id}/session`);
      return {
        sessionId: session.id,
        teamId: snapshot.activeTeamId,
        writers: snapshot.agents.filter(
          (a: { kind: string }) => a.kind !== "team-assistant",
        ),
      };
    }, workspace);
    const proposal = {
      title: "Each agent writes a duty file",
      ops: [
        {
          op: "project.start",
          teamId: seeded.teamId,
          name: "Duty files",
          goal: "Each agent writes its own duty file",
          workspace,
          tasks: seeded.writers.map((a: { id: string; name: string }) => ({
            agentId: a.id,
            title: `Write ${a.name}.txt`,
            instructions: `Write ${a.name}.txt containing reporting for duty`,
            completionChecks: [
              { type: "artifact-exists", path: `${a.name}.txt` },
            ],
          })),
        },
      ],
    };
    // Seed a fixture reply as data. No real assistant or provider is invoked.
    const db = new DatabaseSync(join(directory, "agentteam.sqlite"));
    const message = {
      id: crypto.randomUUID(),
      sessionId: seeded.sessionId,
      role: "assistant",
      status: "delivered",
      text:
        "Ready to write the files.\n\n```agentteam-proposal\n" +
        JSON.stringify(proposal) +
        "\n```",
      createdAt: new Date().toISOString(),
    };
    db.prepare("INSERT INTO entities(kind,id,data) VALUES('message',?,?)").run(
      message.id,
      JSON.stringify(message),
    );
    db.close();
    await page.reload();
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    await openChatWith(page, "Team Assistant");
    const card = page.getByTestId("proposal-card");
    await expect(card).toContainText("2 independent tasks");
    await expect(
      card.getByRole("button", { name: "Approve & apply" }),
    ).toHaveCount(0);
    await card
      .getByRole("button", { name: "Start tasks", exact: true })
      .click();
    await expect(card.getByTestId("proposal-status")).toHaveText(
      "Setup needed",
    );
    await expect(card).toContainText("Execution is paused");
    const snapshot = await page.evaluate(() =>
      window.agentteam.request("GET", "/snapshot"),
    );
    expect(snapshot.workflows).toHaveLength(1);
    expect(snapshot.workflows[0].tasks).toHaveLength(2);
    expect(snapshot.workflows[0].paused).toBe(true);
    await card
      .getByRole("button", { name: "Try starting saved tasks" })
      .click();
    expect(
      (await page.evaluate(() => window.agentteam.request("GET", "/snapshot")))
        .workflows,
    ).toHaveLength(1);
    await card.getByRole("button", { name: "View tasks" }).click();
    await expect(
      page.getByLabel("Current project", { exact: true }),
    ).toHaveValue(snapshot.workflows[0].id);
    await expect(page.locator(".projects-current-context")).toContainText(
      "Duty files",
    );
    await expect(page.locator(".project-detail")).toContainText("2 total");
    await page.screenshot({
      path: info.outputPath("assistant-start-tasks.png"),
    });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
