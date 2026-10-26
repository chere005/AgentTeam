import { test, expect, _electron as electron } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

// Fixture installations only (a scripted `claude` and the shared `codex` fixture): the real CLIs are
// never started and no provider is invoked. Task states are driven through the API.
const CLAUDE_FIXTURE = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("claude-fixture 9.9.9"); process.exit(0); }
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
`;
test.skip(
  process.platform === "win32",
  "fixture executables are POSIX scripts",
);

test("pipeline team then project: configure the team, assign a project, verify before resume, handoff history across a retry", async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-e2e-pipe-")),
  );
  const bin = join(directory, "bin");
  await mkdir(bin);
  const codex = join(bin, "codex-fixture");
  await copyFile(
    join(process.cwd(), "test", "fixtures", "codex-fixture.mjs"),
    codex,
  );
  const claude = join(bin, "claude-fixture");
  await writeFile(claude, CLAUDE_FIXTURE);
  await chmod(codex, 0o755);
  await chmod(claude, 0o755);
  const repo = join(directory, "repo");
  await mkdir(join(repo, "a"), { recursive: true });
  await mkdir(join(repo, "b"), { recursive: true });
  await writeFile(join(repo, "a", "x.txt"), "x");
  const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a]);
  git("init", "-q");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.invalid");
  git("add", ".");
  git("commit", "-qm", "init");
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
        ([m, p, b]) =>
          window.agentteam
            .request(m as string, p as string, b)
            .catch((e: Error) => ({ __error: String(e.message ?? e) })),
        [method, path, body] as const,
      );
    await request("PUT", "/runtimes/codex", { path: codex });
    await request("PUT", "/runtimes/claude", { path: claude });
    await request("POST", "/runtimes/refresh");

    // 1) The pipeline TEAM comes from the Saved teams library (worker caps and models are team
    //    settings); 2) a PROJECT (goal + workspace) is assigned to it from the Projects pane.
    const insertTeam = async (codexEffort?: string) => {
      await openFeature(page, "Team library");
      await page
        .getByRole("list", { name: "Example teams" })
        .getByRole("button", {
          name: /Plan → implement → review pipeline team/,
        })
        .click();
      await page.getByRole("button", { name: "Insert…", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: /Insert “/ });
      await dialog.getByLabel("Implementation workers").selectOption("2");
      await dialog.getByLabel("Fix workers").selectOption("2");
      // Hard cap: the selects offer 1-5 only.
      await expect(
        dialog.getByLabel("Implementation workers").locator("option"),
      ).toHaveCount(5);
      await expect(dialog.getByLabel("Planner model (Opus 5.5)")).toHaveValue(
        "claude-opus-5-5",
      );
      if (codexEffort)
        await dialog.getByLabel("Codex reviewer effort").fill(codexEffort);
      await expect(dialog.getByTestId("example-model-check")).toBeVisible();
      const unverified = dialog.getByLabel("Insert with unverified models");
      if (await unverified.count()) await unverified.check();
      await dialog
        .getByRole("button", { name: "Insert as new team", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    };
    const assign = async (goal: string) => {
      await openFeature(page, "Projects");
      await page
        .getByRole("button", { name: "Run a task", exact: true })
        .first()
        .click();
      const form = page.getByRole("form", { name: "Assign project" });
      await form.getByLabel("Work type").selectOption("project");
      await expect(form.getByTestId("assign-project-type")).toContainText(
        "Plan → implement",
      );
      await form.getByLabel("Project goal").fill(goal);
      await form.getByLabel("Project workspace").fill(repo);
      await form.getByLabel("Project isolation").selectOption("paths");
      await form
        .getByLabel("Worker paths")
        .fill(`${join(repo, "a")}\n${join(repo, "b")}`);
      await expect(
        form.getByLabel("Implementation workers").locator("option"),
      ).toHaveCount(2);
      await form.getByRole("button", { name: "Create paused project" }).click();
      await expect(form).toHaveCount(0);
    };
    await insertTeam();
    // The team alone has no project yet.
    expect((await request("GET", "/snapshot")).workflows).toHaveLength(0);
    await assign("Add a greeting feature");

    const wf = page.locator(".workflow").first();
    await expect(wf).toContainText("Add a greeting feature");
    await expect(wf.locator(".badge").first()).toHaveText("paused");
    await wf.locator("details.project-more > summary").click();
    const pipeline = wf.getByLabel("Pipeline", { exact: true });
    await expect(pipeline).toContainText("not verified");
    await expect(
      pipeline.getByLabel("Pipeline stages").locator("li"),
    ).toHaveCount(1 + 2 + 2 + 1 + 2 + 2 + 1);

    // Resume prepares first and is refused while a check fails; the default Codex effort "max"
    // is not advertised by the fixture. The card's control says so and shows the failed check.
    const workflowId = (await request("GET", "/snapshot")).workflows[0].id;
    const resume = wf.getByRole("button", { name: "Prepare and resume" });
    await expect(resume).toBeVisible();
    await resume.click();
    await expect(wf.getByTestId("resume-error")).toContainText(
      'does not advertise effort "max"',
    );
    const refused = await request("POST", `/workflows/${workflowId}/pause`, {
      paused: false,
    });
    expect(refused.__error).toContain('does not advertise effort "max"');
    await pipeline.getByRole("button", { name: "Prepare and verify" }).click();
    await expect(pipeline.getByLabel("Preflight checks")).toContainText(
      'does not advertise effort "max"',
    );
    await expect(pipeline).toContainText("not verified");
    expect(
      (
        await request("POST", `/workflows/${workflowId}/pause`, {
          paused: false,
        })
      ).__error,
    ).toBeTruthy();
    // No worktree/assignment is made while a check fails.
    expect(
      (await request("GET", `/workflows/${workflowId}/parallel`)).plan,
    ).toBeNull();

    // Second pipeline team with an advertised Codex effort (a team setting): its project verifies
    // and resumes. Each inserted team is its own team; the second one is now the active team.
    await insertTeam("high");
    await expect(page.getByTestId("active-team-name")).toHaveText(/ 2$/);
    await assign("Add a farewell feature");
    await expect(page.locator(".workflow")).toHaveCount(1);
    await page
      .locator(".workflow")
      .first()
      .locator("details.project-more > summary")
      .click();
    const pipeline2 = page
      .locator(".workflow")
      .first()
      .getByLabel("Pipeline", { exact: true });
    await expect(pipeline2).toBeVisible();
    await pipeline2.getByRole("button", { name: "Prepare and verify" }).click();
    await expect(pipeline2.getByLabel("Preflight checks")).toContainText(
      "Parallel resource access",
    );
    await expect(pipeline2.locator(".gate-badge").first()).toHaveText(
      "verified",
    );
    const second = (await request("GET", "/snapshot")).workflows[1].id;
    expect(
      (await request("POST", `/workflows/${second}/pause`, { paused: false }))
        .paused,
    ).toBe(false);

    // Drive the stages through the API (no provider): every attempt appends an immutable note.
    const ids = (
      await request("GET", `/pipelines/${second}/history`)
    ).stages.map((x: { taskId: string }) => x.taskId) as string[];
    const [plan, w1, w2, rc, rf, adj, f1, f2, fc, ff, report] = ids;
    const status = (id: string, body: object) =>
      request("POST", `/tasks/${id}/status`, body);
    const done = async (id: string, result: string) => {
      expect((await status(id, { status: "running" })).__error).toBeUndefined();
      const r = await status(id, { status: "completed", result });
      expect(r.__error, JSON.stringify(r)).toBeUndefined();
    };
    const review = (v: string) =>
      JSON.stringify({ verdict: v, findings: ["f"], evidence: "read a/x.txt" });
    await done(plan, "plan: two slices");
    // first attempt of worker 1 fails, the retry completes: two notes, none replaced
    await status(w1, { status: "running" });
    await status(w1, { status: "failed", result: "provider error: boom" });
    await status(w1, { status: "queued" });
    await done(w1, "worker one finished");
    await done(w2, "worker two finished");
    const integration = (await request("GET", `/workflows/${second}/parallel`))
      .plan.integrationTaskId;
    await done(integration, "integrated");
    await status(rc, { status: "running" });
    await status(rf, { status: "running" }); // reviews run concurrently
    await status(rc, {
      status: "completed",
      result: review("request-changes"),
    });
    await status(rf, { status: "completed", result: review("approve") });
    // the fix workers cannot start before the separate adjudication completed
    expect((await status(f1, { status: "running" })).__error).toBeTruthy();
    // Completing the adjudication by hand replaces the adjudicator: refused without an explicit,
    // attributed override, which the immutable note then records.
    const decision = JSON.stringify({
      decision: "fix 1",
      rationale: "r",
      considered: [rc, rf],
    });
    expect((await status(adj, { status: "running" })).__error).toBeUndefined();
    expect(
      (await status(adj, { status: "completed", result: decision })).__error,
    ).toBeTruthy();
    const decided = await status(adj, {
      status: "completed",
      result: decision,
      humanOverride: { reason: "Fixture run: no live adjudicator", by: "e2e" },
    });
    expect(decided.__error, JSON.stringify(decided)).toBeUndefined();
    expect(
      (await request("POST", `/pipelines/${second}/stage2`)).stage2.state,
    ).toBe("assigned");
    await done(f1, "fix one");
    await done(f2, "fix two");
    const hist = await request("GET", `/pipelines/${second}/history`);
    await done(hist.stage2.integrationTaskId, "integrated fixes");
    await done(fc, review("approve"));
    await done(ff, review("approve"));
    await done(report, "concise report");

    const log = pipeline2.getByRole("log", { name: "Workflow history" });
    await expect(log.getByTestId("handoff-note")).toHaveCount(
      // plan + 2 workers (3 attempts) + integration + 2 reviews + adjudication + 2 fixes +
      // integration + 2 final reviews + report
      1 + 3 + 1 + 2 + 1 + 2 + 1 + 2 + 1,
    );
    const notes = log.getByTestId("handoff-note");
    await expect(notes.filter({ hasText: "attempt 1: failed" })).toHaveCount(1);
    await expect(notes.filter({ hasText: "attempt 2: completed" })).toHaveCount(
      1,
    );
    // scrollable history, untrusted label, and a link to the inputs a note consumed
    expect(
      await log.evaluate(
        (el) =>
          getComputedStyle(el).overflowY === "auto" &&
          el.scrollHeight > el.clientHeight,
      ),
    ).toBe(true);
    const adjNote = notes.filter({
      has: page.locator("summary", {
        hasText: /^Stage 4: Fable adjudication, attempt 1/,
      }),
    });
    await adjNote.locator("summary").click();
    await expect(adjNote).toContainText("UNTRUSTED DATA");
    await expect(adjNote).toContainText("Recorded by: user");
    const link = adjNote
      .getByLabel("Inputs consumed")
      .getByRole("button")
      .first();
    await link.click();
    await expect(log.locator(".pipeline-note.focus")).toHaveCount(1);
    await expect(log.locator(".pipeline-note.focus")).toContainText("Stage 3");
    // the retry never replaced the failed attempt (immutable at the API too)
    const after = await request("GET", `/pipelines/${second}/history`);
    const w1notes = after.notes.filter(
      (n: { taskId: string }) => n.taskId === w1,
    );
    expect(w1notes.map((n: { outcome: string }) => n.outcome)).toEqual([
      "failed",
      "completed",
    ]);
    expect(w1notes[0].markdown).toContain("provider error: boom");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});
