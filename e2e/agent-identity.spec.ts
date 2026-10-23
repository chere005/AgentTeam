import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentPanel } from "./helpers";

test("agent nickname and avatar edit in setup and persist across reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-identity-"));
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, AGENTTEAM_DATA_DIR: directory, AGENTTEAM_TEST: "1" },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const agent = await page.evaluate(() =>
      window.agentteam.request("POST", "/agents", {
        name: "Python Builder",
        environment: "claude",
        roleType: "implementer",
      }),
    );

    const panel = await openAgentPanel(page, agent.name);
    await panel.getByLabel("Agent nickname").fill("Pi Builder");
    await panel.getByLabel("Choose custom avatar").setInputFiles({
      name: "avatar.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4ryAAAANRATBQ0IpfAAAAAElFTkSuQmCC",
        "base64",
      ),
    });
    await expect(panel.locator(".agent-avatar-image")).toBeVisible();
    await panel.getByRole("button", { name: "Save changes" }).click();
    await expect(panel.getByTestId("agent-save")).toHaveCount(0);

    const saved = await page.evaluate(
      (id) => window.agentteam.request("GET", `/agents/${id}`),
      agent.id,
    );
    expect(saved.nickname).toBe("Pi Builder");
    expect(saved.avatar).toMatch(/^data:image\/webp;base64,/);

    await page.reload();
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const reloaded = await page.evaluate(
      (id) => window.agentteam.request("GET", `/agents/${id}`),
      agent.id,
    );
    expect(reloaded.nickname).toBe("Pi Builder");
    expect(reloaded.avatar).toBe(saved.avatar);
    await page
      .getByTestId("workspace-ready")
      .getByRole("tab", { name: "Chat", exact: true })
      .click();
    await page
      .getByRole("treeitem", { name: "Pi Builder (Python Builder)" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Talk to Pi Builder" }),
    ).toBeVisible();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
