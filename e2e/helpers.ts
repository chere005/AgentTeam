import { expect, type ElectronApplication, type Page } from "@playwright/test";

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
          if (++frames >= 600) return resolve(false);
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
    null,
    { timeout: 20000 },
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

/**
 * Installs a Node fixture script (test/fixtures/*.mjs) as an executable named `name` in `bin`
 * and returns the path to configure as the runtime's executable. POSIX: the script itself with
 * its `#!/usr/bin/env node` shebang, made executable. Windows: an npm-style `<name>.cmd` shim
 * next to the script, as npm installs Codex/Claude there, plus `node.exe` beside it (a hard
 * link, or a copy across volumes) so the shim runs even with an empty PATH; AgentTeam launches
 * the shim's script directly without a shell (src/runtime-spawn.ts).
 */
export async function installFixtureExecutable(
  bin: string,
  name: string,
  source: string,
): Promise<string> {
  const { chmod, constants, copyFile, link, writeFile } =
    await import("node:fs/promises");
  const { join } = await import("node:path");
  if (process.platform !== "win32") {
    const executable = join(bin, name);
    await copyFile(source, executable);
    await chmod(executable, 0o755);
    return executable;
  }
  await copyFile(source, join(bin, `${name}.mjs`));
  const node = join(bin, "node.exe");
  const alreadyExists = (error: unknown) =>
    (error as NodeJS.ErrnoException).code === "EEXIST";
  await link(process.execPath, node).catch(async (error) => {
    // Several shims can share the same bin. Never copy over an existing Node hardlink.
    if (alreadyExists(error)) return;
    await copyFile(process.execPath, node, constants.COPYFILE_EXCL).catch(
      (copyError) => {
        if (!alreadyExists(copyError)) throw copyError;
      },
    );
  });
  const shim = join(bin, `${name}.cmd`);
  await writeFile(shim, `@"%~dp0\\node.exe" "%~dp0\\${name}.mjs" %*\r\n`);
  return shim;
}

/**
 * Sets the window's content (page) size. On Windows at 200 % scaling a never-shown test window
 * gets a content size a few pixels smaller than asked (1095x585 for 1100x600: the frame insets
 * of a hidden window are miscomputed), so the difference is measured and added once. Only on
 * Windows: elsewhere (Linux/X11) the size can apply asynchronously, so reading it back at once
 * and correcting could overshoot; there it is the plain setContentSize call.
 */
export async function setContentSize(
  app: ElectronApplication,
  width: number,
  height: number,
) {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(w, h);
      if (process.platform !== "win32") return;
      const [cw, ch] = win.getContentSize();
      if (cw !== w || ch !== h) win.setContentSize(w + w - cw, h + h - ch);
    },
    [width, height] as const,
  );
}
