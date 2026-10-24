import { expect, type Page } from "@playwright/test";

/**
 * Opens a view through the command palette (Ctrl/Cmd+K): type its name, pick the exact match.
 * Names are those of `ui/features.ts` ("Projects", "Files", "Git", "Diff", ...) plus
 * the palette actions ("Layout", "New agent", ...). The palette closes after choosing.
 */
export async function openFeature(page: Page, name: string) {
  const paletteName =
    name === "Canvas" ? "Layout" : name === "Review changes" ? "Diff" : name;
  const palette = page.getByRole("dialog", { name: "Command palette" });
  if (!(await palette.count())) {
    await page.getByRole("button", { name: "More", exact: true }).click();
  }
  await palette
    .getByRole("combobox", { name: "Search views, agents and actions" })
    .fill(paletteName);
  await palette
    .getByRole("option", { name: paletteName, exact: true })
    .first()
    .click();
  await expect(palette).toHaveCount(0);
}

/** Waits for React Flow's animated fit/zoom transform to stop moving. */
export async function waitForStableCanvas(page: Page) {
  await page.waitForFunction(
    () =>
      new Promise<boolean>((resolve) => {
        const viewport = document.querySelector<HTMLElement>(
          ".react-flow__viewport",
        );
        if (!viewport) return resolve(false);
        const signature = () => {
          const bounds = (selector: string) =>
            Array.from(document.querySelectorAll<HTMLElement>(selector)).map(
              (element) => {
                const rect = element.getBoundingClientRect();
                return [rect.x, rect.y, rect.width, rect.height];
              },
            );
          return JSON.stringify({
            transform: getComputedStyle(viewport).transform,
            cards: bounds(".agent-card"),
            handles: bounds(".react-flow__handle"),
          });
        };
        let previous = signature();
        let stableFrames = 0;
        let frames = 0;
        const sample = () => {
          const current = signature();
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 3) return resolve(true);
          if (++frames >= 120) return resolve(false);
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    null,
    { timeout: 5000 },
  );
}

/** Opens an agent's setup explicitly; selecting the card itself follows the active pane. */
export async function openSetup(page: Page, agentName: string) {
  const card = page
    .locator(".react-flow__node", { hasText: agentName })
    .first();
  await card.click();
  const panel = page.getByTestId("agent-panel");
  if (!(await panel.isVisible())) {
    await page
      .getByRole("complementary", { name: "Side panel" })
      .getByRole("tab", { name: "Agent setup" })
      .click();
  }
  await expect(panel.getByTestId("agent-panel-name")).toHaveText(agentName);
  return panel;
}

/** Shows the conversation of `agentName` in the side panel (via the chat's agent picker). */
export async function openChatWith(page: Page, agentName: string) {
  const side = page.getByRole("complementary", { name: "Side panel" });
  await side.getByRole("tab", { name: "Chat" }).click();
  await side
    .getByRole("combobox", { name: "Agent", exact: true })
    .selectOption({ label: agentName });
}

/** Selects an agent on the canvas and opens setup explicitly if Chat is active. */
export async function openAgentPanel(page: Page, agentName: string) {
  await openFeature(page, "Canvas");
  return openSetup(page, agentName);
}
