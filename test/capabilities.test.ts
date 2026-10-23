// Must stay the first import: points AGENTTEAM_DATA_DIR at a temp folder before config.ts loads.
import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectRoot } from "../src/config.ts";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { RunManager, commandFor } from "../src/runtime.ts";
import { createApi } from "../src/http.ts";
import { capabilitiesFor, prepareRunContext } from "../src/run-context.ts";
import { effectiveInstructions } from "../src/effective-instructions.ts";
import { skillChanges, acceptSkills } from "../src/skill-changes.ts";
import { validateSkillCatalog } from "../src/skill-validation.ts";
import { adapterFor } from "../src/skill-adapters.ts";
import {
  classifySkills,
  decideSkills,
  matchOnDemand,
} from "../src/skill-loading.ts";
import { buildIndex, LIMITS } from "../src/knowledge.ts";

const dirs: string[] = [];
test.after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tmp = async (name = "agentteam-cap-") => {
  const d = realpathSync(await mkdtemp(join(tmpdir(), name)));
  dirs.push(d);
  return d;
};
const skillText = (
  name: string,
  description: string,
  body = "Body of " + name,
) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  version: "1.0.0"\n  triggers: rust ownership, borrow checker\n---\n\n${body}\n`;
async function writeSkill(
  root: string,
  dir: string,
  name: string,
  description: string,
  body?: string,
  extra?: object,
) {
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(
    join(root, dir, "SKILL.md"),
    skillText(name, description, body),
  );
  if (extra)
    await writeFile(join(root, dir, "agentteam.json"), JSON.stringify(extra));
}
async function setup(environment: "codex" | "claude" = "codex") {
  const skillRoot = await tmp("agentteam-skills-");
  const catalog = new SkillCatalog([
    { path: skillRoot, environment, origin: "installed", label: "Test" },
  ]);
  const store = new Store(":memory:"),
    service = new TeamService(store, catalog);
  return { skillRoot, catalog, store, service };
}

test("matchOnDemand uses triggers, name words and description overlap, and reports why", () => {
  const skill = {
    name: "rust-engineer",
    description:
      "Systems programming with ownership, lifetimes, traits and cargo workspaces",
    triggers: ["borrow checker"],
  };
  assert.deepEqual(
    matchOnDemand(skill, "Fix the Borrow Checker error").matched,
    true,
  );
  assert.match(
    matchOnDemand(skill, "Rewrite this in Rust").terms.join(),
    /name word "rust"/,
  );
  assert.equal(
    matchOnDemand(skill, "Plan the quarterly marketing budget").matched,
    false,
  );
  assert.equal(
    matchOnDemand(skill, "ownership lifetimes traits everywhere").matched,
    true,
  );
});

test("on-demand skills are selected per request, recorded with version/hash/cost, and listed otherwise", async () => {
  const { skillRoot, service, store } = await setup();
  await writeSkill(
    skillRoot,
    "py",
    "python-helper",
    "Python typing and pytest guidance",
    "PY-BODY-MARKER",
  );
  await writeSkill(
    skillRoot,
    "always",
    "house-style",
    "House style rules",
    "ALWAYS-MARKER",
  );
  await service.skills.scan();
  const [py, always] = ["python-helper", "house-style"].map((n) =>
    [...service.skills.items.values()].find((s) => s.name === n)!,
  );
  const agent = await service.saveAgent({
    name: "A",
    environment: "codex",
    role: "Dev",
    instructions: "Be brief.",
    skills: [
      { id: always.id, mode: "always" },
      { id: py.id, mode: "on-demand" },
    ],
  });
  const plan = await service.launchPlan(agent.id);
  assert.match(plan.instructions, /ALWAYS-MARKER/);
  assert.doesNotMatch(plan.instructions, /PY-BODY-MARKER/);
  assert.match(plan.instructions, /Available skill: python-helper/);
  const quiet = await prepareRunContext(
    service,
    plan,
    "Summarize the budget",
    "run-1",
  );
  assert.equal(
    quiet!.skills.find((s) => s.name === "python-helper")!.state,
    "listed",
  );
  assert.doesNotMatch(plan.instructions, /PY-BODY-MARKER/);
  const hit = await service.launchPlan(agent.id);
  const rec = await prepareRunContext(
    service,
    hit,
    "Add python typing to the module",
    "run-2",
  );
  assert.match(hit.instructions, /PY-BODY-MARKER/);
  assert.match(hit.instructions, /loaded on demand/);
  const row = rec!.skills.find((s) => s.name === "python-helper")!;
  assert.equal(row.state, "loaded");
  assert.match(row.reason, /request matched/);
  assert.equal(row.hash, py.hash);
  assert.equal(row.version, "1.0.0");
  assert.ok(row.approxTokens > 0);
  assert.ok(rec!.approxTokens.total >= rec!.approxTokens.skills);
  const events = store.history().filter((e) => e.type === "run.context");
  assert.equal(events.length, 2);
  assert.ok(
    !JSON.stringify(events[1].data).includes("PY-BODY-MARKER"),
    "event holds no skill text",
  );
});

test("Claude adapter: model-initiated loading is unsupported and disclosed; no file-read hint is emitted", async () => {
  const { skillRoot, service } = await setup("claude");
  await writeSkill(
    skillRoot,
    "s",
    "docs-writer",
    "Technical documentation style",
    "DOC-BODY",
  );
  await service.skills.scan();
  const skill = [...service.skills.items.values()][0];
  const agent = await service.saveAgent({
    name: "C",
    environment: "claude",
    skills: [{ id: skill.id, mode: "on-demand" }],
  });
  const plan = await service.launchPlan(agent.id);
  assert.equal(adapterFor("claude").modelRead, "unsupported");
  assert.match(plan.instructions, /not loaded for this request/);
  assert.doesNotMatch(plan.instructions, /Read .*SKILL\.md/);
  // The old hard rejection is gone: on-demand now works through AgentTeam-side selection.
  const command = commandFor(plan, null, "write docs", process.cwd());
  assert.ok(command.args.includes("--append-system-prompt"));
  const preview = await effectiveInstructions(service, agent.id, {
    prompt: "documentation",
  });
  assert.equal(preview.adapter.modelRead, "unsupported");
  assert.match(preview.adapter.modelReadNote, /cannot load skill files/);
});

test("changed skills are not loaded until the user accepts the update; first use pins", async () => {
  const { skillRoot, service, store } = await setup();
  await writeSkill(skillRoot, "s", "style-guide", "Style", "VERSION-ONE");
  await service.skills.scan();
  const skill = [...service.skills.items.values()][0];
  const agent = await service.saveAgent({
    name: "P",
    environment: "codex",
    skills: [{ id: skill.id, mode: "always" }],
  });
  assert.equal((await skillChanges(service)).rows[0].status, "unpinned");
  assert.match(
    (await service.launchPlan(agent.id)).instructions,
    /VERSION-ONE/,
  );
  assert.ok(store.history().some((e) => e.type === "skill.pinned"));
  assert.equal((await skillChanges(service)).rows[0].status, "unchanged");

  await writeSkill(
    skillRoot,
    "s",
    "style-guide",
    "Style",
    "VERSION-TWO\nextra line",
  );
  const changes = await skillChanges(service);
  const row = changes.rows[0];
  assert.equal(row.status, "changed");
  assert.equal(changes.pending, 1);
  assert.ok(row.change!.added >= 1 && row.change!.removed >= 1);
  assert.ok(row.change!.preview.some((l) => l.includes("VERSION-TWO")));
  const blocked = await service.launchPlan(agent.id);
  assert.doesNotMatch(blocked.instructions, /VERSION-TWO/);
  assert.doesNotMatch(blocked.instructions, /VERSION-ONE/);
  assert.equal(blocked.skills[0].state, "skipped");
  assert.ok(blocked.warnings.some((w) => /accept the update/.test(w)));
  const preview = await effectiveInstructions(service, agent.id);
  assert.equal(preview.skills[0].state, "skipped");

  await acceptSkills(service, [skill.id]);
  assert.match(
    (await service.launchPlan(agent.id)).instructions,
    /VERSION-TWO/,
  );
  assert.equal((await skillChanges(service)).pending, 0);
  assert.ok(store.history().some((e) => e.type === "skill.update_accepted"));
  await rm(join(skillRoot, "s"), { recursive: true });
  assert.equal((await skillChanges(service)).rows[0].status, "missing");
  await assert.rejects(acceptSkills(service, ["nope"]), /not in the catalog/);
});

test("a bundled skill that differs from the curated hash is never loaded or accepted", async () => {
  const { store, service } = await setup();
  const base = {
    id: "curated:jeffallan--python-pro",
    name: "python-pro",
    description: "d",
    path: "/x/SKILL.md",
    baseDir: "/x",
    hash: "0".repeat(64),
    environments: ["codex" as const],
    origin: "bundled" as const,
    harness: "x",
    compatibility: "declared" as const,
    requiresTools: [],
    compatibilityNotes: "",
    body: "tampered",
  };
  const [entry] = await classifySkills(
    store,
    [{ mode: "always", skill: base }],
    { persist: true },
  );
  assert.equal(entry.catalogDrift, true);
  assert.equal(decideSkills([entry], undefined)[0].state, "skipped");
  assert.match(decideSkills([entry], undefined)[0].reason, /hash drift/);
  service.skills.items.set(base.id, base);
  service.skills.scan = async () => ({}) as never; // keep the synthetic entry
  await assert.rejects(acceptSkills(service, [base.id]), /cannot be accepted/);
});

test("assigning a skill never grants tools, folders or MCP servers", async () => {
  const { skillRoot, service } = await setup();
  await writeSkill(
    skillRoot,
    "t",
    "needs-tools",
    "Needs tools",
    "I REQUIRE shell and full disk access",
    {
      environments: ["codex"],
      requiresTools: ["shell"],
    },
  );
  await service.skills.scan();
  const skill = [...service.skills.items.values()][0];
  await assert.rejects(
    service.saveAgent({
      name: "NoTool",
      environment: "codex",
      skills: [{ id: skill.id, mode: "always" }],
    }),
    /requires shell/,
  );
  const ws = await tmp();
  const agent = await service.saveAgent({
    name: "Tooled",
    environment: "codex",
    tools: ["shell"],
    workspaces: [{ path: ws, access: "read", active: true }],
    skills: [{ id: skill.id, mode: "always" }],
  });
  const before = JSON.stringify({
    tools: agent.tools,
    workspaces: agent.workspaces,
  });
  await service.launchPlan(agent.id);
  const after = service.store.get<any>("agent", agent.id);
  assert.equal(
    JSON.stringify({ tools: after.tools, workspaces: after.workspaces }),
    before,
  );
  assert.deepEqual(capabilitiesFor(service).tools.agentView(agent.id), []);
  const preview = await effectiveInstructions(service, agent.id);
  assert.equal(preview.tools.requirements[0].tool, "shell");
  assert.equal(preview.tools.requirements[0].listedByAgent, true);
  assert.match(preview.adapter.toolExposure, /read-only|does not pass tools/);
});

test("effective-instructions preview lists role, persistent text, skills, tool requirements and problems", async () => {
  const { skillRoot, service } = await setup();
  await writeSkill(skillRoot, "a", "alpha-skill", "Alpha", "ALPHA");
  await service.skills.scan();
  const skill = [...service.skills.items.values()][0];
  const agent = await service
    .saveAgent({
      name: "Previewed",
      environment: "codex",
      role: "Reviewer of things",
      instructions: "Persistent text here.",
      skills: [
        { id: skill.id, mode: "always" },
        { id: "installed-but-gone", mode: "on-demand" },
      ],
    })
    .catch(() => null);
  // Unknown skills are rejected at save time; assign the real one and break the catalog afterwards.
  assert.equal(agent, null);
  const saved = await service.saveAgent({
    name: "Previewed",
    environment: "codex",
    role: "Reviewer of things",
    instructions: "Persistent text here.",
    skills: [{ id: skill.id, mode: "always" }],
  });
  await rm(join(skillRoot, "a"), { recursive: true });
  const gone = await effectiveInstructions(service, saved.id);
  assert.ok(gone.problems.some((p) => p.kind === "missing"));
  await writeSkill(skillRoot, "a", "alpha-skill", "Alpha", "ALPHA");
  const ok = await effectiveInstructions(service, saved.id);
  assert.deepEqual(
    ok.sections.map((s) => s.kind),
    ["role", "persistent", "skill"],
  );
  assert.match(ok.text, /Role: Reviewer of things/);
  assert.match(ok.text, /Persistent text here\./);
  assert.match(ok.text, /ALPHA/);
  assert.ok(ok.totals.approxTokens >= ok.totals.skillTokens);
  // The preview text equals what a real run assembles.
  const plan = await service.launchPlan(saved.id);
  assert.equal(ok.text, plan.instructions);
});

test("catalog validation passes for the shipped assets and detects every defect class", async () => {
  const real = await validateSkillCatalog({
    assetsDir: join(projectRoot, "assets"),
  });
  assert.equal(
    real.ok,
    true,
    JSON.stringify(real.findings.filter((f) => f.severity === "error")),
  );
  assert.ok(real.counts.skills >= 28);
  assert.deepEqual(
    real.environments.map((e) => e.environment),
    ["codex", "claude", "wolfram"],
  );

  const assets = await tmp("agentteam-assets-");
  await mkdir(join(assets, "skills"), { recursive: true });
  const license = "L".repeat(200);
  const entry = (id: string, extra: object = {}) => ({
    id: "curated:" + id,
    name: id,
    bundled: true,
    source: "https://example.invalid/x",
    commit: "a".repeat(40),
    license: "MIT",
    licenseFile: "UPSTREAM-LICENSE.txt",
    environmentSupport: {
      codex: "format-compatible",
      claude: "native",
      wolfram: "not validated",
    },
    skillSha256: "f".repeat(64),
    ...extra,
  });
  const good = async (
    id: string,
    manifest: object = { catalogId: id, environments: ["codex", "claude"] },
  ) => {
    await mkdir(join(assets, "skills", id), { recursive: true });
    await writeFile(join(assets, "skills", id, "SKILL.md"), skillText(id, "d"));
    await writeFile(
      join(assets, "skills", id, "UPSTREAM-LICENSE.txt"),
      license,
    );
    await writeFile(
      join(assets, "skills", id, "agentteam.json"),
      JSON.stringify(manifest),
    );
  };
  await good("drifted");
  await good("envmismatch", {
    catalogId: "envmismatch",
    environments: ["codex", "wolfram"],
  });
  await good("badmanifest", { environments: ["cobol"] });
  await good("needstool", {
    catalogId: "needstool",
    environments: ["claude"],
    requiresTools: ["shell"],
  });
  await good("orphan");
  await mkdir(join(assets, "skills", "nofiles"), { recursive: true });
  await writeFile(
    join(assets, "recommended-skills.json"),
    JSON.stringify({
      curatedOn: "2026-01-01",
      skills: [
        entry("drifted"),
        entry("drifted"),
        entry("envmismatch", { skillSha256: undefined }),
        entry("badmanifest", { commit: "main" }),
        entry("needstool", { skillSha256: undefined }),
        entry("nofiles", { skillSha256: undefined }),
        entry("ghost", { skillSha256: undefined }),
      ],
    }),
  );
  const report = await validateSkillCatalog({
    assetsDir: assets,
    scanned: [
      {
        id: "a",
        name: "same",
        version: "1.0.0",
        hash: "1",
        origin: "bundled",
        path: "/a",
      },
      {
        id: "b",
        name: "same",
        version: "2.0.0",
        hash: "2",
        origin: "installed",
        path: "/b",
      },
    ],
    scanWarnings: [
      { path: "/x/SKILL.md", message: "Missing YAML front matter" },
    ],
  });
  const codes = new Set(report.findings.map((f) => f.code));
  for (const code of [
    "duplicate_id",
    "hash_drift",
    "orphan_directory",
    "missing_file",
    "missing_directory",
    "environment_mismatch",
    "manifest_invalid",
    "revision_invalid",
    "tool_unavailable",
    "version_conflict",
    "scan_warning",
  ])
    assert.ok(codes.has(code), `expected ${code} in ${[...codes]}`);
  assert.equal(report.ok, false);
  assert.ok(
    report.skills.find((s) => s.id === "curated:drifted" && s.hashOk === false),
  );
});

test("tool registry: no secrets stored or logged, metadata-only test against a stdio fixture, grants and removal", async () => {
  const { service, store } = await setup();
  const { tools } = capabilitiesFor(service);
  const dir = await tmp();
  const logFile = join(dir, "calls.log");
  const fixture = join(projectRoot, "test/fixtures/mcp-fixture.mjs");
  const SECRET = "sup3r-secret-value-" + "x".repeat(10);
  assert.throws(
    () =>
      tools.save({
        name: "bad",
        command: "node",
        args: ["--api-key", "sk-abcdefghijklmnopqrstuv"],
      }),
    /secrets/,
  );
  assert.throws(
    () =>
      tools.save({ name: "bad", command: "node", args: ["--token=abc123456"] }),
    /secrets/,
  );
  assert.throws(() =>
    tools.save({
      name: "bad",
      command: "node",
      envRefs: [{ name: "A B", fromEnv: "X" }],
    }),
  );
  const server = tools.save({
    name: "Fixture",
    command: process.execPath,
    args: [fixture],
    envRefs: [
      { name: "MCP_FIXTURE_LOG", fromEnv: "TEST_FIXTURE_LOG" },
      { name: "FIXTURE_TOKEN", fromEnv: "TEST_FIXTURE_SECRET" },
    ],
  });
  const env = {
    PATH: process.env.PATH,
    TEST_FIXTURE_LOG: logFile,
    TEST_FIXTURE_SECRET: SECRET,
  };
  assert.equal(
    tools.view(server, {}).envRefs.every((r) => r.set === false),
    true,
  );
  assert.equal(
    tools.view(server, env).envRefs.every((r) => r.set),
    true,
  );
  assert.equal(tools.connection(server.id).state, "untested");
  const ok = await tools.test(server.id, { env, timeoutMs: 8000 });
  assert.equal(ok.state, "connected", ok.error ?? "");
  assert.deepEqual(
    ok.tools.map((t) => t.name),
    ["echo", "read_file"],
  );
  assert.equal(ok.serverInfo?.name, "fixture-server");
  const methods = (await readFile(logFile, "utf8")).trim().split("\n");
  assert.deepEqual(methods, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/list",
  ]);
  assert.ok(!methods.includes("tools/call"));

  // Failure modes: missing env var, server error echoing the secret (redacted), exit, hang.
  const missing = await tools.test(server.id, {
    env: { PATH: process.env.PATH },
  });
  assert.equal(missing.state, "failed");
  assert.match(missing.error!, /TEST_FIXTURE_LOG/);
  const leaky = tools.save({
    name: "Leaky",
    command: process.execPath,
    args: [fixture],
    envRefs: [
      { name: "FIXTURE_MODE", fromEnv: "TEST_MODE" },
      { name: "FIXTURE_TOKEN", fromEnv: "TEST_FIXTURE_SECRET" },
    ],
  });
  const leak = await tools.test(leaky.id, {
    env: { ...env, TEST_MODE: "leak-error" },
  });
  assert.equal(leak.state, "failed");
  assert.ok(!leak.error!.includes(SECRET));
  assert.match(leak.error!, /REDACTED/);
  assert.equal(
    (await tools.test(leaky.id, { env: { ...env, TEST_MODE: "exit" } })).state,
    "failed",
  );
  const slow = await tools.test(leaky.id, {
    env: { ...env, TEST_MODE: "hang" },
    timeoutMs: 400,
  });
  assert.equal(slow.state, "failed");
  assert.match(slow.error!, /Timed out/);

  // The secret value is in no entity and no event.
  const dump = JSON.stringify([
    store.history(0, 5000),
    store.list("tool-server"),
    store.list("tool-connection"),
  ]);
  assert.ok(!dump.includes(SECRET), "secret value must not be persisted");
  assert.ok(!dump.includes(logFile), "env values must not be persisted");
  assert.ok(dump.includes("TEST_FIXTURE_SECRET"), "the reference name is kept");

  // Per-agent grants.
  const agent = await service.saveAgent({ name: "G", environment: "codex" });
  await tools.test(server.id, { env, timeoutMs: 8000 });
  tools.grant(agent.id, { serverId: server.id, allowedTools: ["echo"] });
  const view = tools.agentView(agent.id);
  assert.equal(view.length, 1);
  assert.equal(view[0].state, "connected");
  assert.deepEqual(
    view[0].tools.map((t) => t.name),
    ["echo"],
  );
  assert.throws(
    () => tools.grant(agent.id, { serverId: "missing" }),
    /not found/,
  );
  tools.revoke(agent.id, server.id);
  assert.deepEqual(tools.agentView(agent.id), []);
  tools.grant(agent.id, { serverId: server.id });
  tools.remove(server.id);
  assert.deepEqual(tools.agentView(agent.id), []);
  assert.equal(tools.servers().length, 1);
});

test("knowledge: confined to attached folders, bounded index, citations, staleness, refresh and removal", async () => {
  const { service, store } = await setup();
  const { knowledge } = capabilitiesFor(service);
  const ws = await tmp("agentteam-know-"),
    outside = await tmp("agentteam-outside-");
  await mkdir(join(ws, "docs"));
  await mkdir(join(ws, "docs", "allowed"));
  await mkdir(join(ws, "docs", "other"));
  await writeFile(
    join(ws, "docs", "guide.md"),
    "# Guide\nThe flux capacitor requires plutonium.\nSecond line.\n",
  );
  await writeFile(
    join(ws, "docs", "other.txt"),
    "Unrelated notes about lunch.\n",
  );
  await writeFile(
    join(ws, "docs", "allowed", "notes.md"),
    "taskscope comet ALLOWED-MARKER\n",
  );
  await writeFile(
    join(ws, "docs", "other", "notes.md"),
    "taskscope comet FORBIDDEN-MARKER\n",
  );
  await writeFile(join(ws, ".env"), "API_KEY=zzz-hidden-marker\n");
  await writeFile(
    join(ws, "docs", "secrets.md"),
    "flux password hidden-marker\n",
  );
  await writeFile(join(ws, "docs", "bin.md"), Buffer.from([65, 0, 66, 10]));
  await writeFile(
    join(outside, "leak.md"),
    "flux capacitor outside OUTSIDE-MARKER\n",
  );
  await symlink(
    outside,
    join(ws, "docs", "link"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const agent = await service.saveAgent({
    name: "K",
    environment: "codex",
    workspaces: [{ path: ws, access: "read", active: true }],
  });
  const other = await service.saveAgent({
    name: "Other",
    environment: "codex",
  });
  await assert.rejects(
    knowledge.create(agent.id, { name: "bad", folder: outside }),
    /inside a folder attached/,
  );
  await assert.rejects(
    knowledge.create(agent.id, { name: "bad", folder: "relative/path" }),
    /absolute/,
  );
  const created = await knowledge.create(agent.id, {
    name: "Docs",
    folder: join(ws, "docs"),
    include: true,
  });
  assert.equal(created.status, "ready");
  assert.equal(created.files, 4, JSON.stringify(created.skipped));
  assert.ok(
    created.skipped.symlink >= 1 &&
      created.skipped["secret-looking name"] >= 1 &&
      created.skipped.binary >= 1,
  );

  const hits = await knowledge.search(agent.id, "flux capacitor plutonium");
  assert.equal(hits[0].file, "guide.md");
  assert.equal(hits[0].label, "Docs/guide.md:1-4");
  assert.equal(hits[0].stale, false);
  assert.ok(
    !JSON.stringify(hits).includes("OUTSIDE-MARKER") &&
      !JSON.stringify(hits).includes("hidden-marker"),
  );
  assert.deepEqual(
    await knowledge.search(agent.id, "flux capacitor", {
      allowedPaths: [join(ws, "docs", "other.txt")],
    }),
    [],
    "task context omits matching knowledge outside its declared resources",
  );
  const scopedHits = await knowledge.search(agent.id, "unrelated lunch", {
    allowedPaths: [join(ws, "docs", "other.txt")],
  });
  assert.equal(scopedHits[0].file, "other.txt");
  assert.deepEqual(await knowledge.search(other.id, "flux capacitor"), []);

  // Cited, untrusted context reaches a run only for sources flagged include.
  const plan = await service.launchPlan(agent.id);
  const record = await prepareRunContext(
    service,
    plan,
    "How does the flux capacitor work?",
    "run-k",
  );
  assert.match(plan.instructions, /untrusted DATA/);
  assert.match(plan.instructions, /\[K1\] Docs\/guide\.md:1-4/);
  assert.ok(record!.approxTokens.knowledge > 0);
  assert.equal(record!.knowledge[0].label, "Docs/guide.md:1-4");

  const workflow = service.workflow({
    name: "Scoped knowledge",
    goal: "Use only the declared resource folder",
    ownerId: agent.id,
    completionCriteria: "done",
  });
  const scopedTask = service.task({
    workflowId: workflow.id,
    agentId: agent.id,
    title: "Use task-specific notes",
    completionCriteria: "done",
    resourcePaths: [join(ws, "docs", "allowed")],
  });
  const scopedPlan = await service.launchPlan(agent.id, scopedTask.id);
  await prepareRunContext(
    service,
    scopedPlan,
    "taskscope comet",
    scopedTask.id,
  );
  assert.match(scopedPlan.instructions, /ALLOWED-MARKER/);
  assert.doesNotMatch(scopedPlan.instructions, /FORBIDDEN-MARKER/);

  // Staleness, refresh.
  await writeFile(
    join(ws, "docs", "guide.md"),
    "# Guide\nThe flux capacitor now uses banana peels.\nA new line.\nAnother.\n",
  );
  await utimes(
    join(ws, "docs", "guide.md"),
    new Date(),
    new Date(Date.now() + 5000),
  );
  assert.equal((await knowledge.search(agent.id, "plutonium"))[0].stale, true);
  await knowledge.refresh(created.id);
  const after = await knowledge.search(agent.id, "banana");
  assert.equal(after[0].stale, false);
  assert.equal((await knowledge.search(agent.id, "plutonium")).length, 0);

  // Detaching the folder revokes access without deleting the source.
  const detached = { ...store.get<any>("agent", agent.id), workspaces: [] };
  store.put("agent", detached);
  assert.deepEqual(await knowledge.search(agent.id, "banana"), []);
  const listed = (await knowledge.listFor(agent.id))[0];
  assert.equal(listed.access.ok, false);
  await assert.rejects(
    knowledge.refresh(created.id),
    /not inside a folder attached/,
  );
  store.put("agent", {
    ...detached,
    workspaces: [{ path: ws, access: "read", active: true }],
  });

  knowledge.remove(created.id);
  assert.equal(knowledge.sources().length, 0);
  assert.equal(store.list("knowledge-index").length, 0);
  assert.deepEqual(await knowledge.search(agent.id, "banana"), []);
});

test("knowledge obeys attachment exclusions when indexing and on every query", async () => {
  const { service, store } = await setup();
  const { knowledge } = capabilitiesFor(service);
  const ws = await tmp("agentteam-know-rules-");
  await mkdir(join(ws, "docs", "private"), { recursive: true });
  await mkdir(join(ws, "hidden"));
  await writeFile(join(ws, "docs", "guide.md"), "zebra public guide\n");
  await writeFile(
    join(ws, "docs", "private", "plan.md"),
    "zebra EXCLUDED-MARKER\n",
  );
  await writeFile(join(ws, "hidden", "x.md"), "zebra\n");
  const agent = await service.saveAgent({
    name: "R",
    environment: "codex",
    workspaces: [
      {
        path: ws,
        access: "read",
        rules: [
          { path: "docs/private", access: "none" },
          { path: "hidden", access: "none" },
        ],
      },
    ],
  });
  // An excluded folder cannot become a source.
  await assert.rejects(
    knowledge.create(agent.id, { name: "H", folder: join(ws, "hidden") }),
    /excluded/,
  );
  const src = await knowledge.create(agent.id, {
    name: "Docs",
    folder: join(ws, "docs"),
  });
  assert.equal(src.files, 1);
  assert.equal(src.skipped["access rules"], 1);
  const index = JSON.stringify(store.list("knowledge-index"));
  assert.ok(!index.includes("EXCLUDED-MARKER"));
  // A rule added after indexing hides already indexed text on the next query.
  const current = store.get<any>("agent", agent.id);
  store.put("agent", {
    ...current,
    workspaces: [
      {
        ...current.workspaces[0],
        rules: [
          ...current.workspaces[0].rules,
          { path: "docs/guide.md", access: "none" },
        ],
      },
    ],
  });
  assert.deepEqual(await knowledge.search(agent.id, "zebra"), []);
});

test("knowledge index is bounded", async () => {
  const dir = await tmp("agentteam-big-");
  for (let i = 0; i < LIMITS.files + 20; i++)
    await writeFile(join(dir, `f${i}.md`), `note ${i}\n`);
  const idx = await buildIndex(dir);
  assert.equal(idx.files.length, LIMITS.files);
  assert.equal(idx.truncated, true);
  await writeFile(join(dir, "huge.txt"), "x".repeat(LIMITS.fileBytes + 1));
  const small = await tmp("agentteam-big-");
  await writeFile(join(small, "huge.txt"), "x".repeat(LIMITS.fileBytes + 1));
  assert.equal((await buildIndex(small)).skipped["too large"], 1);
});

test("HTTP routes are authenticated and expose validation, changes, previews, tools and knowledge", async (t) => {
  const { service, store, skillRoot } = await setup();
  const server = createApi(
    service,
    "tok",
    new RunManager(service, false, process.cwd()),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  });
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = (path: string, method = "GET", body?: unknown, auth = true) =>
    fetch(base + path, {
      method,
      headers: {
        ...(auth ? { authorization: "Bearer tok" } : {}),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal(
    (await call("/capabilities/skills/validation", "GET", undefined, false))
      .status,
    401,
  );
  assert.equal(
    (await call("/tools/servers", "GET", undefined, false)).status,
    401,
  );
  const report = await (
    await call("/capabilities/skills/validation", "POST", {})
  ).json();
  assert.equal(report.ok, true);
  assert.ok(store.history().some((e) => e.type === "skills.validated"));
  const adapters = await (await call("/capabilities/skills/adapters")).json();
  assert.equal(
    adapters.adapters.find((a: any) => a.id === "claude-cli").modelRead,
    "unsupported",
  );

  await writeSkill(skillRoot, "h", "http-skill", "HTTP skill", "HTTP-BODY");
  await service.skills.scan();
  const skill = [...service.skills.items.values()][0];
  const ws = await tmp();
  const agent = await (
    await call("/agents", "POST", {
      name: "H",
      environment: "codex",
      workspaces: [{ path: ws, access: "read", active: true }],
      skills: [{ id: skill.id, mode: "always" }],
    })
  ).json();
  const preview = await (
    await call(`/agents/${agent.id}/effective-instructions?prompt=hello`)
  ).json();
  assert.match(preview.text, /HTTP-BODY/);
  const changes = await (await call("/capabilities/skills/changes")).json();
  assert.equal(changes.rows[0].status, "unpinned");
  assert.equal(
    (await call("/capabilities/skills/accept", "POST", { ids: [skill.id] }))
      .status,
    200,
  );
  assert.equal(
    (await call("/capabilities/skills/accept", "POST", { ids: [] })).status,
    400,
  );

  const created = await call("/tools/servers", "POST", {
    name: "Fx",
    command: process.execPath,
    args: [join(projectRoot, "test/fixtures/mcp-fixture.mjs")],
  });
  assert.equal(created.status, 201);
  const fx = await created.json();
  const tested = await (
    await call(`/tools/servers/${fx.id}/test`, "POST", {})
  ).json();
  assert.equal(tested.connection.state, "connected");
  assert.equal(
    (
      await call(`/agents/${agent.id}/tool-grants`, "PUT", {
        serverId: fx.id,
        allowedTools: null,
      })
    ).status,
    200,
  );
  const grants = await (await call(`/agents/${agent.id}/tool-grants`)).json();
  assert.equal(grants.grants[0].tools.length, 2);
  assert.match(grants.exposure, /not exposed/);
  assert.equal(
    (await call(`/agents/${agent.id}/tool-grants/${fx.id}`, "DELETE")).status,
    200,
  );

  await writeFile(join(ws, "a.md"), "alpha beta gamma unique-token-zeta\n");
  const src = await (
    await call(`/agents/${agent.id}/knowledge`, "POST", {
      name: "WS",
      folder: ws,
    })
  ).json();
  assert.equal(src.status, "ready");
  const found = await (
    await call(`/agents/${agent.id}/knowledge/search?q=zeta`)
  ).json();
  assert.equal(found.results[0].file, "a.md");
  assert.equal(
    (
      await call(`/agents/${agent.id}/knowledge`, "POST", {
        name: "x",
        folder: tmpdir(),
      })
    ).status,
    403,
  );
  assert.equal(
    (await call(`/knowledge/sources/${src.id}/refresh`, "POST", {})).status,
    200,
  );
  assert.equal(
    (await call(`/knowledge/sources/${src.id}`, "DELETE")).status,
    200,
  );
});
