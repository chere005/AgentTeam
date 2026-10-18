import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

const skill = (body: string) =>
  `---\nname: e2e-style-guide\ndescription: House style guide for the capability test\nmetadata:\n  version: "1.0.0"\n---\n\n${body}\n`;

test("skills, tools and knowledge: validation, adapters, change acceptance, MCP test connection, knowledge citations, effective preview", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-cap-")),
  );
  const skillRoot = join(directory, "skills");
  const workspace = join(directory, "workspace");
  await mkdir(join(skillRoot, "style"), { recursive: true });
  await mkdir(join(workspace, "docs"), { recursive: true });
  await writeFile(join(skillRoot, "style", "SKILL.md"), skill("STYLE-ONE"));
  await writeFile(
    join(workspace, "docs", "guide.md"),
    "# Guide\nThe quasar flange needs calibration.\n",
  );
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
      AGENTTEAM_SKILL_ROOTS: JSON.stringify([
        { path: skillRoot, environment: "codex", label: "E2E skills" },
      ]),
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    await page.evaluate(
      async ({ workspace }) => {
        const r = window.agentteam.request;
        await r("POST", "/skills/refresh");
        const list = await r("GET", "/skills");
        const found = list.installed.groups.codex.find(
          (s: any) => s.name === "e2e-style-guide",
        );
        await r("POST", "/agents", {
          name: "Capable",
          environment: "codex",
          role: "Reference keeper",
          instructions: "Keep answers short.",
          workspaces: [{ path: workspace, access: "read", active: true }],
          skills: [{ id: found.id, mode: "always" }],
        });
      },
      { workspace },
    );
    await openFeature(page, "Skills, tools & knowledge");
    const root = page.getByTestId("capabilities");
    await expect(root).toBeVisible();
    await root
      .getByLabel("Agent", { exact: true })
      .selectOption({ label: "Capable" });
    // Three kinds are visibly distinct.
    await expect(page.getByTestId("cap-kinds")).toContainText("instructions");
    await expect(page.getByTestId("cap-kinds")).toContainText("actions");
    await expect(page.getByTestId("cap-kinds")).toContainText("reference");

    // ---- skills: per-adapter disclosure, validation report, change acceptance --------------
    await expect(page.getByTestId("adapter-claude-cli")).toContainText(
      "unsupported",
    );
    await expect(page.getByTestId("adapter-codex-cli")).toContainText(
      "possible, unverified",
    );
    await page
      .getByRole("button", { name: "Validate and record audit event" })
      .click();
    await expect(page.getByTestId("validation-report")).toContainText(
      "no errors",
    );
    await expect(page.getByTestId("validation-report")).toContainText(
      "28 bundled skills",
    );
    const row = page
      .getByTestId("skill-change-row")
      .filter({ hasText: "e2e-style-guide" });
    await expect(row).toContainText("unpinned");
    await row.getByRole("button", { name: "Accept and pin" }).click();
    await expect(row).toContainText("unchanged");
    await writeFile(join(skillRoot, "style", "SKILL.md"), skill("STYLE-TWO"));
    await page.getByRole("button", { name: "Recheck" }).click();
    await expect(row).toContainText("changed");
    await expect(row).toContainText("not loaded into runs until you accept");
    await row.getByRole("button", { name: "Accept update" }).click();
    await expect(row).toContainText("unchanged");

    // ---- tools: add a local stdio fixture, metadata-only test, grant ------------------------
    await page.getByRole("tab", { name: "Tools", exact: true }).click();
    const form = page.getByTestId("tool-form");
    await form.getByLabel("Name", { exact: true }).fill("Fixture MCP");
    await form.getByLabel("Command", { exact: true }).fill(process.execPath);
    await form
      .getByLabel("Arguments (one per line)")
      .fill(join(process.cwd(), "test/fixtures/mcp-fixture.mjs"));
    await form
      .getByLabel(/Environment references/)
      .fill("FIXTURE_TOKEN=E2E_NOT_SET_VARIABLE");
    await form.getByRole("button", { name: "Add tool server" }).click();
    const server = page.getByTestId("tool-server").first();
    await expect(server).toContainText("Fixture MCP");
    await expect(server).toContainText("E2E_NOT_SET_VARIABLE (not set)");
    await expect(server.getByTestId("connection-state")).toHaveText("untested");
    await server.getByRole("button", { name: "Test connection" }).click();
    await expect(server.getByTestId("connection-state")).toHaveText("failed");
    await expect(server).toContainText("not set in AgentTeam's environment");
    // Without the auth reference the fixture connects; recreate it without envRefs.
    await server.getByRole("button", { name: "Remove" }).click();
    await form.getByLabel("Name", { exact: true }).fill("Fixture MCP");
    await form.getByLabel("Command", { exact: true }).fill(process.execPath);
    await form
      .getByLabel("Arguments (one per line)")
      .fill(join(process.cwd(), "test/fixtures/mcp-fixture.mjs"));
    await form.getByLabel(/Environment references/).fill("");
    await form.getByRole("button", { name: "Add tool server" }).click();
    const fixture = page.getByTestId("tool-server").first();
    await fixture.getByRole("button", { name: "Test connection" }).click();
    await expect(fixture.getByTestId("connection-state")).toHaveText(
      "connected",
    );
    await expect(fixture).toContainText("advertises 2 tools: echo, read_file");
    await expect(page.getByTestId("grant-exposure")).toContainText(
      "not exposed",
    );
    await fixture.getByRole("button", { name: "Grant to Capable" }).click();
    await expect(fixture).toContainText("granted to Capable (all tools)");

    // ---- knowledge: attached folder only, status, citation ----------------------------------
    await page.getByRole("tab", { name: "Knowledge", exact: true }).click();
    const kform = page.getByTestId("knowledge-form");
    await kform.getByLabel("Name", { exact: true }).fill("Docs");
    await kform.getByLabel(/^Folder/).selectOption(workspace);
    await kform.getByRole("button", { name: "Add and index" }).click();
    const source = page.getByTestId("knowledge-source").first();
    await expect(source.getByTestId("index-status")).toHaveText("ready");
    await expect(source).toContainText("1 files");
    await page.getByLabel("Search knowledge").fill("quasar flange");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByTestId("citation").first()).toContainText(
      "Docs/docs/guide.md:1-3",
    );
    await source.getByRole("button", { name: "Refresh" }).click();
    await expect(source.getByTestId("index-status")).toHaveText("ready");
    await source.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByTestId("knowledge-sources")).toContainText(
      "No knowledge sources",
    );

    // ---- effective instructions -------------------------------------------------------------
    await page
      .getByRole("tab", { name: "Effective instructions", exact: true })
      .click();
    await expect(page.getByTestId("effective-sections")).toContainText("Role");
    await expect(page.getByTestId("effective-sections")).toContainText(
      "Persistent instructions",
    );
    await expect(page.getByTestId("effective-sections")).toContainText(
      "Skill: e2e-style-guide",
    );
    await expect(page.getByTestId("effective-skills")).toContainText(
      "always load",
    );
    await expect(page.getByTestId("effective-skills")).toContainText("loaded");
    await expect(page.getByTestId("effective-tools")).toContainText(
      "MCP grant: Fixture MCP",
    );
    // ---- context cost per run (run.context events) ---------------------------------------------
    await expect(page.getByTestId("context-cost-empty")).toContainText(
      "No runs recorded yet",
    );
    // No provider runs in tests: seed the events a run would have recorded.
    const agentId = await page.evaluate(async () => {
      const snapshot = await window.agentteam.request("GET", "/snapshot");
      return snapshot.agents.find((a: any) => a.name === "Capable")
        .id as string;
    });
    const db = new DatabaseSync(join(directory, "data", "agentteam.sqlite"));
    db.exec("PRAGMA busy_timeout=5000");
    for (const total of [300, 450, 400])
      db.prepare(
        "INSERT INTO events(type,entity_id,data,created_at) VALUES('run.context',?,?,?)",
      ).run(
        "session-" + total,
        JSON.stringify({
          agentId,
          skills: [{ state: "loaded" }, { state: "listed" }],
          approxTokens: {
            role: 20,
            instructions: 30,
            skills: 100,
            knowledge: 0,
            total,
          },
        }),
        new Date().toISOString(),
      );
    db.close();
    await page.getByRole("tab", { name: "Skills", exact: true }).click();
    await page
      .getByRole("tab", { name: "Effective instructions", exact: true })
      .click();
    const cost = page.getByTestId("context-cost");
    await expect(cost.getByTestId("context-cost-summary")).toContainText(
      "latest ~400 · average ~383 · max ~450 tokens over 3 run(s)",
    );
    await expect(
      cost.getByTestId("context-cost-runs").getByRole("listitem"),
    ).toHaveCount(3);
    await expect(cost.getByRole("img")).toBeVisible();
    await expect(cost).toContainText("1 loaded, 1 listed");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
