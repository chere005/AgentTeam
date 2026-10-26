import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/model";

test("unknown run progress stays a single activity row as tools and text arrive", async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-progress-"));
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
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    const session = await page.evaluate(async () => {
      const agent = await window.agentteam.request("POST", "/agents", {
        name: "Progress reviewer",
        environment: "codex",
      });
      const session = await window.agentteam.request(
        "POST",
        `/agents/${agent.id}/session`,
      );
      return { agentId: agent.id as string, sessionId: session.id as string };
    });
    const db = new DatabaseSync(join(directory, "agentteam.sqlite"));
    const row = db
      .prepare("SELECT data FROM entities WHERE kind='session' AND id=?")
      .get(session.sessionId) as { data: string };
    const running: Session = JSON.parse(row.data);
    running.state = "running";
    running.startedAt = new Date(Date.now() - 65_000).toISOString();
    running.timeoutMs = 3_600_000;
    db.prepare("UPDATE entities SET data=? WHERE kind='session' AND id=?").run(
      JSON.stringify(running),
      running.id,
    );
    db.close();
    await page.reload();
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    const side = page.getByRole("complementary", { name: "Side panel" });
    await side.getByRole("tab", { name: "Chat", exact: true }).click();
    await side
      .getByRole("combobox", { name: "Agent", exact: true })
      .selectOption(session.agentId);
    const activity = page.getByTestId("run-progress");
    await expect(activity).toHaveCount(1);
    await expect(activity).toBeVisible();
    await expect(activity).toContainText("Waiting for response");
    await expect(activity).toContainText(/1m \d+s elapsed/);
    await expect(activity.getByRole("progressbar")).toHaveCount(0);
    await expect(activity).not.toContainText(/remaining|up to|%/);
    await expect(
      page.getByText("Progress reviewer is working", { exact: true }),
    ).toHaveCount(1);
    const elapsed = activity.locator("time");
    await expect(elapsed).toHaveAttribute("aria-live", "off");
    let seq = 1_000_000;
    const event = async (type: string, data: unknown) =>
      app.evaluate(
        ({ BrowserWindow }, payload) => {
          BrowserWindow.getAllWindows()[0].webContents.send(
            "team-event",
            payload,
          );
        },
        {
          seq: seq++,
          type,
          entityId: session.sessionId,
          data,
          createdAt: new Date().toISOString(),
        },
      );
    await event("session.started", {
      transport: "acp",
      agentId: session.agentId,
    });
    await event("runtime.tool", {
      toolCallId: "read-1",
      title: "Reading project files",
      kind: "read",
      status: "in_progress",
    });
    await expect(activity.locator("summary")).toContainText(
      "Reading project files",
    );
    await activity.locator("summary").click();
    await expect(activity.getByTestId("live-tools")).toContainText(
      "Reading project files",
    );
    await event("runtime.tool", {
      toolCallId: "read-1",
      title: "Reading project files",
      kind: "read",
      status: "completed",
    });
    await event(
      "runtime.text",
      "Reviewing the file structure before making changes.",
    );
    await expect(activity).toContainText("Writing response");
    await expect(activity.getByTestId("live-text")).toContainText(
      "Reviewing the file structure",
    );
    await expect(activity.getByRole("progressbar")).toHaveCount(0);
    await expect(
      page.getByText("Progress reviewer is working", { exact: true }),
    ).toHaveCount(1);
    await activity.screenshot({
      path: testInfo.outputPath("activity-indicator.png"),
    });

    // Ending the fixture updates the stored session and emits the ordinary event; no provider ran.
    const endedDb = new DatabaseSync(join(directory, "agentteam.sqlite"));
    endedDb
      .prepare("UPDATE entities SET data=? WHERE kind='session' AND id=?")
      .run(JSON.stringify({ ...running, state: "idle" }), running.id);
    endedDb.close();
    await event("session.idle", { agentId: session.agentId });
    await expect(activity).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
