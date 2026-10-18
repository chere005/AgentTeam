import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("assistant changes: reviewable diff, approval, stale proposals, audit log, coordination, ownership and message search", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-assistant-"));
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
    // Fixture data only: AGENTTEAM_TEST keeps live execution off; no provider is ever invoked.
    const ids = await page.evaluate(async () => {
      const r = window.agentteam.request;
      const lead = await r("POST", "/agents", {
        name: "Lead",
        environment: "codex",
      });
      const other = await r("POST", "/agents", {
        name: "Other",
        environment: "codex",
      });
      const wf = await r("POST", "/workflows", {
        name: "Background run",
        goal: "Ship it",
        ownerId: lead.id,
        completionCriteria: "done",
      });
      await r("PUT", `/workflows/${wf.id}/limits`, { maxAgentTurns: 3 });
      const session = await r("POST", `/agents/${lead.id}/session`);
      for (let i = 0; i < 40; i++)
        await r("POST", `/sessions/${session.id}/messages`, {
          text:
            `Filler message ${i} ` +
            "padding ".repeat(30) +
            (i === 3 ? "needle" : ""),
        });
      await r("POST", "/assistant/proposals", {
        title: "Add a Builder",
        rationale: "The team needs an implementer",
        ops: [
          {
            op: "agent.create",
            ref: "builder",
            agent: { name: "Builder", environment: "codex", tools: ["shell"] },
          },
          {
            op: "edge.create",
            edge: { from: lead.id, to: "@builder", kind: "delegate" },
          },
        ],
      });
      await r("POST", "/assistant/proposals", {
        title: "Describe the lead",
        ops: [
          {
            op: "agent.update",
            id: lead.id,
            changes: { role: "Coordinates the team" },
          },
        ],
      });
      return { lead: lead.id, other: other.id, wf: wf.id };
    });

    // ---- proposals: diff, approval before apply, audit ------------------------------------
    await page.getByRole("button", { name: /^Assistant changes/ }).click();
    const list = page.getByTestId("proposal-list");
    await list.getByRole("button", { name: /Add a Builder/ }).click();
    const diff = page.getByTestId("proposal-diff");
    await expect(diff).toContainText("Create agent Builder");
    await expect(diff).toContainText("Connect");
    await expect(page.getByTestId("proposal-reasons")).toContainText(
      "communicate",
    );
    await expect(page.getByTestId("apply")).toBeDisabled();
    await page.getByTestId("approve").click();
    await expect(page.getByTestId("apply")).toBeEnabled();
    await page.getByTestId("apply").click();
    await expect(
      list.locator("li", { hasText: "Add a Builder" }),
    ).toContainText("applied");
    const agents = await page.evaluate(() =>
      window.agentteam.request("GET", "/agents"),
    );
    expect(agents.map((a: { name: string }) => a.name)).toContain("Builder");
    await page.locator("details.audit > summary").click();
    await expect(page.getByTestId("audit-log")).toContainText("applied");
    await expect(page.getByTestId("audit-log")).toContainText(
      "proposed by user",
    );

    // ---- stale: the form changed the same agent after the proposal was written ------------
    await page.evaluate(async (id) => {
      const r = window.agentteam.request;
      const a = await r("GET", `/agents/${id}`);
      const { id: _id, createdAt: _c, control: _k, ...input } = a;
      await r("PUT", `/agents/${id}`, { ...input, role: "Edited in the form" });
    }, ids.lead);
    await list.getByRole("button", { name: /Describe the lead/ }).click();
    await expect(page.getByTestId("proposal-reason")).toContainText(
      "changed since",
    );
    await expect(page.getByTestId("apply")).toBeDisabled();
    await expect(
      list.locator("li", { hasText: "Describe the lead" }),
    ).toContainText("stale");

    // ---- coordination controls -------------------------------------------------------------
    const card = page.getByTestId("coord-card").first();
    await expect(card).toContainText("maxAgentTurns: 0 / 3");
    await card.getByLabel("Current goal").fill("Fix the failing build");
    await card.getByRole("button", { name: "Save goal" }).click();
    await card.getByRole("button", { name: "Pause" }).click();
    await expect(card.getByTestId("coord-status")).toHaveText("paused");
    await card.getByRole("button", { name: "Resume" }).click();
    await expect(card.getByTestId("coord-status")).not.toHaveText("paused");
    await expect(card.getByLabel("Current goal")).toHaveValue(
      "Fix the failing build",
    );

    // ---- inspection block ------------------------------------------------------------------
    await page.getByText("What the assistant can inspect").click();
    await expect(page.getByTestId("assistant-context")).toContainText(
      "untrusted-data",
    );
    await expect(page.getByTestId("assistant-context")).toContainText(
      "Background run",
    );

    // ---- conversation: ownership, duplicate-driving guard, search ---------------------------
    await page.getByLabel("Agent", { exact: true }).selectOption(ids.lead);
    const holder = page.getByTestId("ownership-holder");
    await expect(holder).toContainText("Team");
    await page.getByRole("button", { name: "Take control" }).click();
    await expect(holder).toContainText("embedded chat");
    await page.getByRole("button", { name: "Return ownership" }).click();
    await expect(holder).toContainText("Team");
    await page.getByRole("button", { name: "CLI", exact: true }).click();
    await expect(holder).toContainText("Interactive CLI");
    await expect(page.getByTestId("ownership-warning")).toContainText(
      "CLI is driving",
    );
    const blocked = await page.evaluate(() =>
      window.agentteam
        .request(
          "POST",
          "/ownership/" +
            (
              document.querySelector(
                "select[aria-label=Agent]",
              ) as HTMLSelectElement
            ).value +
            "/take",
          { mode: "native" },
        )
        .then(
          () => "allowed",
          (e: Error) => e.message,
        ),
    );
    expect(blocked).toContain("already driven");
    await page.getByRole("button", { name: "Return ownership" }).click();
    await expect(holder).toContainText("Team");
    await page.getByRole("button", { name: "Chat", exact: true }).click();

    await page.getByRole("button", { name: "Search messages" }).click();
    await page.getByRole("textbox", { name: "Search messages" }).fill("needle");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const hits = page.getByTestId("search-hits");
    await expect(hits.locator("li")).toHaveCount(1);
    await hits.getByRole("button").click();
    await expect(page.locator(".message-focus")).toContainText("needle");

    // ---- scroll and draft are kept per agent -------------------------------------------------
    const box = page.locator(".messages");
    await box.evaluate((el) => (el.scrollTop = 300));
    await page
      .getByLabel("Message", { exact: true })
      .fill("unsent draft for lead");
    await page.waitForTimeout(400);
    await page.getByLabel("Agent", { exact: true }).selectOption(ids.other);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue("");
    await page.getByLabel("Agent", { exact: true }).selectOption(ids.lead);
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "unsent draft for lead",
    );
    await expect
      .poll(async () => box.evaluate((el) => Math.round(el.scrollTop / 10)))
      .toBe(30);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
