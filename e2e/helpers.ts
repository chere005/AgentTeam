import { expect, type Page } from "@playwright/test";

/**
 * Opens a view through the command palette (Ctrl/Cmd+K): type its name, pick the exact match.
 * Names are those of `ui/features.ts` ("Projects", "Files", "Git", "Review changes", ...) plus
 * the palette actions ("Canvas", "New agent", ...). The palette closes after choosing.
 */
export async function openFeature(page: Page, name: string) {
  const palette = page.getByRole("dialog", { name: "Command palette" });
  if (!(await palette.count())) {
    await page.getByRole("button", { name: "More", exact: true }).click();
  }
  await palette
    .getByRole("combobox", { name: "Search views, agents and actions" })
    .fill(name);
  await palette.getByRole("option", { name, exact: true }).click();
  await expect(palette).toHaveCount(0);
}

/** Shows the conversation of `agentName` in the side panel (via the chat's agent picker). */
export async function openChatWith(page: Page, agentName: string) {
  const side = page.getByRole("complementary", { name: "Side panel" });
  await side.getByRole("tab", { name: "Chat" }).click();
  await side
    .getByRole("combobox", { name: "Agent", exact: true })
    .selectOption({ label: agentName });
}

/** Selects an agent on the canvas, which opens its setup panel. */
export async function openAgentPanel(page: Page, agentName: string) {
  await openFeature(page, "Canvas");
  await page
    .locator(".react-flow__node", { hasText: agentName })
    .first()
    .click();
  const panel = page.getByTestId("agent-panel");
  await expect(panel.getByTestId("agent-panel-name")).toHaveText(agentName);
  return panel;
}
