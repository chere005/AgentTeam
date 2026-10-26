import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("an agent's Chat pane leads with its result and tucks full instructions behind a disclosure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-agent-work-"));
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, AGENTTEAM_DATA_DIR: directory, AGENTTEAM_TEST: "1" },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const work = await page.evaluate(async () => {
      const request = window.agentteam.request;
      const manager = await request("POST", "/agents", {
        name: "Manager",
        environment: "codex",
        roleType: "coordinator",
      });
      const builder = await request("POST", "/agents", {
        name: "Python Builder",
        environment: "claude",
        roleType: "implementer",
      });
      const reviewer = await request("POST", "/agents", {
        name: "Code Reviewer",
        environment: "codex",
        roleType: "reviewer",
      });
      await request("POST", "/edges", {
        from: manager.id,
        to: builder.id,
        kind: "delegate",
      });
      await request("POST", "/edges", {
        from: manager.id,
        to: reviewer.id,
        kind: "review",
      });
      const workflow = await request("POST", "/workflows", {
        name: "Pi demo",
        goal: "Build a Pi program",
        ownerId: manager.id,
        completionCriteria: "Reviewer approves",
      });
      const parent = await request("POST", "/tasks", {
        workflowId: workflow.id,
        agentId: manager.id,
        title: "Coordinate the Pi demo",
        completionCriteria: "Report the result",
      });
      await request("POST", `/tasks/${parent.id}/status`, {
        status: "running",
      });
      const handoff = await request("POST", "/orchestration/invoke", {
        fromAgentId: manager.id,
        taskId: parent.id,
        recipient: builder.id,
        title: "Write the Python Pi program",
        instructions:
          "Create python/pi.py. Produce 300 significant digits; leading 3 counts as digit one.",
        completionCriteria: "Return the file path and run instructions",
      });
      await request("POST", `/tasks/${handoff.childTaskId}/status`, {
        status: "running",
      });
      await request("POST", `/tasks/${handoff.childTaskId}/status`, {
        status: "completed",
        result: "Created python/pi.py and verified the 300 digit output.",
      });
      return { builderId: builder.id, reviewerId: reviewer.id };
    });
    await page
      .getByLabel("Agent", { exact: true })
      .selectOption(work.builderId);
    const panel = page.getByTestId("invocation-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Manager → Python Builder");
    await expect(panel).toContainText("Manager’s instructions");
    await expect(panel).toContainText("Create python/pi.py");
    await expect(panel).toContainText("completed");
    await expect(panel).toContainText(
      "Created python/pi.py and verified the 300 digit output.",
    );
    await expect(panel.getByTestId("manager-instructions")).not.toHaveAttribute(
      "open",
      "",
    );
    await panel.getByRole("button", { name: "Open group chat" }).click();
    const groupChat = page.getByRole("region", { name: "Agent group chat" });
    await expect(groupChat).toBeVisible();
    await groupChat
      .getByLabel("Group chat comment")
      .fill("Please explain the algorithm.");
    await groupChat.getByRole("button", { name: "Send to group" }).click();
    await expect(groupChat).toContainText("Please explain the algorithm.");
    await groupChat
      .getByLabel("Invite agent to group chat")
      .selectOption(work.reviewerId);
    await groupChat.getByRole("button", { name: "Invite" }).click();
    await expect(groupChat).toContainText("Code Reviewer");

    // A tall invocation section scrolls with the messages in one region at a short, narrow
    // window: nothing is cut off at the window edge and the composer stays in view.
    const size = (w: number, h: number) =>
      app.evaluate(
        ({ BrowserWindow }, [a, b]) =>
          BrowserWindow.getAllWindows()[0].setContentSize(a, b),
        [w, h] as const,
      );
    await size(1100, 600);
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBe(600);
    const scroller = () =>
      panel.evaluate((el) => {
        for (let node = el.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (!/auto|scroll/.test(style.overflowY)) continue;
          const box = node.getBoundingClientRect();
          return {
            overflowY: style.overflowY,
            minHeight: style.minHeight,
            overflows: node.scrollHeight > node.clientHeight,
            bottom: box.bottom,
            viewport: window.innerHeight,
            holdsComposer: !!node.querySelector(
              'textarea[aria-label="Message"]',
            ),
            chat: !!node.closest(".chat"),
          };
        }
        return null;
      });
    await expect.poll(async () => (await scroller())?.overflows).toBe(true);
    const region = (await scroller())!;
    expect(region.chat).toBe(true);
    expect(region.overflowY).toMatch(/auto|scroll/);
    expect(region.minHeight).toBe("0px");
    expect(region.holdsComposer).toBe(false);
    expect(region.bottom).toBeLessThanOrEqual(region.viewport);
    await expect(
      page.getByRole("textbox", { name: "Message" }),
    ).toBeInViewport();
    // The mouse wheel scrolls the region: from the top down to the group chat's button.
    const sendToGroup = groupChat.getByRole("button", {
      name: "Send to group",
    });
    await page.getByText("Team assignments & conversations").hover();
    await page.mouse.wheel(0, -5000);
    await expect(
      page.getByText("Team assignments & conversations"),
    ).toBeInViewport();
    await expect(async () => {
      await page.mouse.wheel(0, 150);
      await expect(sendToGroup).toBeInViewport({ timeout: 250 });
    }).toPass();
    await expect(
      page.getByRole("textbox", { name: "Message" }),
    ).toBeInViewport();
    await size(1500, 960);

    await page.locator("#tab-team-chat").click();
    await expect(
      page.getByRole("navigation", { name: "Team conversations" }),
    ).toBeVisible();
    const yourChats = page.getByRole("group", { name: "Your chats" });
    await expect(
      yourChats.getByRole("button", { name: /Write the Python Pi program/ }),
    ).toBeVisible();
    await expect(page.getByText("Your chats", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("treeitem", { name: "Manager", exact: true })
        .getByRole("treeitem", { name: /Write the Python Pi program/ }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("treeitem", { name: "Python Builder", exact: true })
        .getByRole("treeitem", { name: /Write the Python Pi program/ }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("treeitem", { name: "Code Reviewer", exact: true })
        .getByRole("treeitem", { name: /Write the Python Pi program/ }),
    ).toBeVisible();
    await page
      .getByRole("treeitem", { name: "Python Builder", exact: true })
      .getByRole("treeitem", { name: /Write the Python Pi program/ })
      .click();
    const conversationPicker = page.getByLabel(
      "Conversation for Python Builder",
    );
    await expect(conversationPicker).toBeVisible();
    await conversationPicker.selectOption({
      label: "Write the Python Pi program",
    });
    await expect(
      page.getByRole("region", { name: "Agent group chat" }),
    ).toContainText("Code Reviewer");
    await expect(
      page.getByRole("region", { name: "Agent group chat" }),
    ).toContainText("Please explain the algorithm.");

    await page.getByRole("button", { name: "Help and feature guide" }).click();
    const help = page.getByRole("dialog", { name: "Help and feature guide" });
    await expect(help).toContainText("Project trace");
    await help.getByTestId("help-open-usage").click();
    const usage = page.getByTestId("usage-dashboard");
    await expect(usage).toBeVisible();
    await expect(usage).toContainText("By agent");
    await expect(usage).toContainText("Subscription quotas");

    await page.getByRole("button", { name: "Help and feature guide" }).click();
    await page
      .getByRole("dialog", { name: "Help and feature guide" })
      .getByTestId("help-open-trace")
      .click();
    const trace = page.getByTestId("project-trace");
    await expect(trace).toBeVisible();
    await expect(trace.getByLabel("Project timeline")).toBeVisible();
    const eventSummary = trace.locator(".trace-event-info").first();
    await eventSummary.click();
    await expect(
      page.getByRole("dialog", { name: "Quick Look summary" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Quick Look summary" }),
    ).toHaveCount(0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
