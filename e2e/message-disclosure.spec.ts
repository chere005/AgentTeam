import { test, expect, _electron as electron } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("collapsed replies keep their label and preview on one readable row at every side-panel width", async ({}, info) => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-reply-layout-"));
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
    const seeded = await page.evaluate(async () => {
      const agent = await window.agentteam.request("POST", "/agents", {
        name: "Manager (Claude Opus 5.5)",
        environment: "claude",
      });
      const session = await window.agentteam.request(
        "POST",
        `/agents/${agent.id}/session`,
      );
      return { agentId: agent.id, sessionId: session.id };
    });
    const text =
      "The tool schema in this turn finally lists the exact roster — the names carry a model suffix.\n\n" +
      "Additional details belong in the expanded reply. ".repeat(60);
    const db = new DatabaseSync(join(directory, "agentteam.sqlite"));
    const message = {
      id: crypto.randomUUID(),
      sessionId: seeded.sessionId,
      role: "assistant",
      status: "delivered",
      text,
      createdAt: new Date().toISOString(),
    };
    db.prepare("INSERT INTO entities(kind,id,data) VALUES('message',?,?)").run(
      message.id,
      JSON.stringify(message),
    );
    db.close();
    await page.reload();
    await expect(page.getByTestId("workspace-ready")).toBeVisible();
    const side = page.getByRole("complementary", { name: "Side panel" });
    await side.getByRole("tab", { name: "Chat", exact: true }).click();
    await side
      .getByLabel("Agent", { exact: true })
      .selectOption(seeded.agentId);
    const disclosure = side.locator(".message-disclosure");
    const summary = disclosure.locator("summary");
    const separator = page.getByRole("separator", {
      name: "Resize side panel",
    });
    await expect(summary).toBeVisible();

    for (const width of [300, 440, 640]) {
      await separator.focus();
      let current = Number(await separator.getAttribute("aria-valuenow"));
      while (current !== width) {
        await page.keyboard.press(current < width ? "ArrowLeft" : "ArrowRight");
        current = Number(await separator.getAttribute("aria-valuenow"));
      }
      await page.screenshot({
        path: info.outputPath(`collapsed-${width}.png`),
      });
      const geometry = await summary.evaluate((element) => {
        const label = element.querySelector("span")!;
        const preview = element.querySelector(".message-disclosure-preview")!;
        const range = document.createRange();
        range.selectNodeContents(label);
        const labelBox = label.getBoundingClientRect();
        const previewBox = preview.getBoundingClientRect();
        const summaryBox = element.getBoundingClientRect();
        return {
          labelLines: range.getClientRects().length,
          height: element.parentElement!.getBoundingClientRect().height,
          sameRow: Math.abs(labelBox.y - previewBox.y) < 2,
          previewFits: previewBox.right <= summaryBox.right + 1,
          previewHasSpace: previewBox.width > 40,
          truncated: preview.scrollWidth > preview.clientWidth,
        };
      });
      expect(geometry.labelLines).toBe(1);
      expect(geometry.height).toBeLessThan(42);
      expect(geometry.sameRow).toBe(true);
      expect(geometry.previewFits).toBe(true);
      expect(geometry.previewHasSpace).toBe(true);
      expect(geometry.truncated).toBe(true);
    }

    await summary.focus();
    await summary.press("Enter");
    await expect(disclosure).toHaveAttribute("open", "");
    await expect(disclosure.locator(".markdown")).toBeVisible();
    await page.screenshot({ path: info.outputPath("expanded.png") });
    await summary.press(" ");
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(summary).toBeFocused();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
