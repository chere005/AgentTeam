import { test, expect, _electron as electron } from "@playwright/test";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAgentPanel, openChatWith } from "./helpers";

// A FIXTURE `codex` (test/fixtures/assistant-codex-fixture.mjs) plays the Team Assistant: it reads
// the prompt, checks the proposal protocol is in it and answers with a plan plus one
// agentteam-proposal block built from the team-state ids. Temp AGENTTEAM_DATA_DIR; no real CLI,
// no provider, no network.
test.skip(process.platform === "win32", "fixture executable is a POSIX script");

test("team assistant chat: proposal card, approve & apply adds skills, reject, invalid proposal fix request, processing vs queued", async () => {
  test.setTimeout(120_000);
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-assistant-chat-")),
  );
  const bin = join(directory, "bin");
  await mkdir(bin);
  const codex = join(bin, "codex-fixture");
  await copyFile(
    join(process.cwd(), "test", "fixtures", "assistant-codex-fixture.mjs"),
    codex,
  );
  await chmod(codex, 0o755);
  const shots = join("test-results", "assistant-chat");
  await mkdir(shots, { recursive: true });
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const request = (method: string, path: string, body?: unknown) =>
      page.evaluate(
        ([m, p, b]) => window.agentteam.request(m as string, p as string, b),
        [method, path, body] as const,
      );
    await request("PUT", "/runtimes/codex", { path: codex });
    await request("POST", "/runtimes/refresh");
    await request("POST", "/teams/examples/product-feature-team/insert", {
      acceptUnverifiedModels: true,
    });

    // Execution starts paused (test mode): a message sent now stays queued without a run. This is
    // how the live backlog started; every later reply then answered the previous message.
    await expect(
      page.getByRole("button", { name: /Product feature team/ }).first(),
    ).toBeVisible();
    await openChatWith(page, "Team Assistant");
    const side = page.getByRole("complementary", { name: "Side panel" });
    await expect(side.getByText("Execution is paused")).toBeVisible();
    const composer = side.getByLabel("Message", { exact: true });
    const statusOf = (text: string) =>
      side
        .locator("article.message.user", { hasText: text })
        .getByTestId("message-status");
    await composer.fill("who are you?");
    await composer.press("Enter");
    await expect(statusOf("who are you?")).toHaveText("queued");
    await request("PUT", "/execution", { enabled: true });
    // The UI follows backend changes through events; the composer requests a run only when live.
    await expect(side.getByText("Execution is paused")).toHaveCount(0);

    // ---- processing vs queued: a slow run, and a second message sent meanwhile ---------------
    await composer.fill("Slow invalid request: add a design skill");
    await composer.press("Enter");
    await expect(statusOf("Slow invalid request")).toHaveText("processing");
    // The backlog goes into the same run, so this reply answers the current request too.
    await expect(statusOf("who are you?")).toHaveText("processing");
    await composer.fill("Add appropriate skills to all the other agents");
    await composer.press("Enter");
    await expect(statusOf("Add appropriate skills")).toHaveText("queued");
    await expect(statusOf("Slow invalid request")).toHaveText("processing");

    // ---- invalid proposal: the backend's error and a one-click fix request -------------------
    const invalid = side.getByTestId("proposal-invalid");
    await expect(invalid).toBeVisible({ timeout: 20_000 });
    await expect(invalid.getByTestId("proposal-error")).toContainText(
      "curated:does-not-exist",
    );
    await expect(statusOf("Slow invalid request")).toHaveText("delivered");
    await expect(statusOf("who are you?")).toHaveText("delivered");
    await expect(
      side.locator("article.message.assistant", {
        has: page.getByTestId("proposal-invalid"),
      }),
    ).toContainText("Answering 2 messages");

    // ---- the user's request: plan + card, raw JSON hidden ------------------------------------
    const card = side.getByTestId("proposal-card").filter({
      hasText: "Add skills to the engineers",
    });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(statusOf("Add appropriate skills")).toHaveText("delivered");
    const reply = side.locator("article.message.assistant", {
      has: page
        .getByTestId("proposal-card")
        .filter({ hasText: "Add skills to the engineers" }),
    });
    await expect(reply).toContainText("Plan: the Frontend Engineer gets");
    const json = reply.locator("details.proposal-json");
    await expect(json.locator("pre")).toBeHidden();
    await expect(reply.getByText('"op": "agent.skills"').first()).toBeHidden();
    await expect(card.getByTestId("proposal-diff")).toContainText(
      "Frontend Engineer",
    );
    await expect(card.getByTestId("proposal-diff")).toContainText(
      "Backend Engineer",
    );
    await expect(card.getByTestId("proposal-reasons")).toContainText(
      "Changes skills",
    );
    await expect(card.getByTestId("proposal-status")).toHaveText("pending");
    // Nothing was applied by the reply itself.
    const before = await request("GET", "/agents");
    expect(
      before.find((a: { name: string }) => a.name === "Backend Engineer")
        .skills,
    ).toEqual([]);
    await card.scrollIntoViewIfNeeded();
    for (const theme of ["dark", "light"]) {
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.style.colorScheme = t;
      }, theme);
      await page.screenshot({
        path: join(shots, `proposal-card-${theme}.png`),
      });
    }
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
      document.documentElement.style.colorScheme = "dark";
    });
    await json.locator("summary").click();
    await expect(json.locator("pre")).toContainText('"op": "agent.skills"');

    // ---- Approve & apply: the user-only approve + apply path, then what changed --------------
    await card.getByRole("button", { name: "Approve & apply" }).click();
    await expect(card.getByTestId("proposal-status")).toHaveText("applied");
    const applied = card.getByTestId("proposal-applied");
    await expect(applied).toContainText(
      "Added 3 skills (frontend-design, typescript-pro, playwright-expert) to Frontend Engineer",
    );
    await expect(applied).toContainText(
      "Added 2 skills (typescript-pro, postgres-pro) to Backend Engineer",
    );
    await page.screenshot({ path: join(shots, "proposal-applied.png") });
    const after = await request("GET", "/agents");
    const fe = after.find(
      (a: { name: string }) => a.name === "Frontend Engineer",
    );
    expect(fe.skills.map((s: { id: string }) => s.id)).toEqual([
      "curated:anthropic--frontend-design",
      "curated:jeffallan--typescript-pro",
      "curated:jeffallan--playwright-expert",
    ]);
    const audit = await request("GET", "/assistant/audit");
    expect(audit.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(["created", "approved", "applied"]),
    );

    // ---- "Ask the assistant to fix this" sends the backend's error back; then Reject ---------
    await invalid
      .getByRole("button", { name: "Ask the assistant to fix this" })
      .click();
    await expect(
      side.locator("article.message.user", {
        hasText: "rejected by AgentTeam's validation",
      }),
    ).toContainText("curated:does-not-exist");
    const corrected = side.getByTestId("proposal-card").filter({
      hasText: "Add a JavaScript skill (corrected)",
    });
    await expect(corrected).toBeVisible({ timeout: 20_000 });
    await corrected.getByRole("button", { name: "Reject" }).click();
    await expect(corrected.getByTestId("proposal-status")).toHaveText(
      "rejected",
    );
    await expect(
      corrected.getByRole("button", { name: "Approve & apply" }),
    ).toHaveCount(0);
    expect(
      (await request("GET", "/agents"))
        .find((a: { name: string }) => a.name === "Frontend Engineer")
        .skills.map((s: { id: string }) => s.id),
    ).not.toContain("curated:jeffallan--javascript-pro");

    // ---- Open in Assistant changes selects the proposal there --------------------------------
    await card
      .getByRole("button", { name: "Open in Assistant changes" })
      .click();
    await expect(page.getByTestId("proposal-detail")).toContainText(
      "Add skills to the engineers",
    );

    // ---- the skills show in the agent panel ---------------------------------------------------
    const panel = await openAgentPanel(page, "Frontend Engineer");
    await panel
      .locator("details.setup-group")
      .filter({ hasText: "Skills" })
      .locator("summary")
      .click();
    const assigned = panel.getByRole("list", { name: "Assigned skills" });
    await expect(assigned.locator("li")).toHaveCount(3);
    await expect(assigned).toContainText(/frontend.design/i);
    await expect(assigned).toContainText(/typescript/i);
    await expect(assigned).toContainText(/playwright/i);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
