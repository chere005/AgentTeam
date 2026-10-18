import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import {
  TeamTemplates,
  SECRET_PATTERN,
  TEAM_TEMPLATE_SCHEMA_VERSION,
} from "../src/teams.ts";
import { TeamPacks, type PackInstall } from "../src/team-packs.ts";
import { parseManifest } from "../src/team-pack-manifest.ts";
import { auditTeamPacks } from "../src/team-pack-audit.ts";
import { threeWay } from "../src/team-pack-diff.ts";
import type { Agent } from "../src/model.ts";

const assets = new URL("../assets/", import.meta.url).pathname;
const swiftFile = join(assets, "team-packs/swift-development/pack.json");
const readSwift = async () => JSON.parse(await readFile(swiftFile, "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

async function setup(t: any) {
  const store = new Store(":memory:");
  const catalog = new SkillCatalog([
    { path: join(assets, "skills"), origin: "bundled", label: "bundled" },
  ]);
  await catalog.scan();
  const service = new TeamService(store, catalog);
  const teams = new TeamTemplates(service);
  const packs = new TeamPacks(service, teams, () => assets);
  const dir = await mkdtemp(join(tmpdir(), "agentteam-packs-"));
  const project = join(dir, "project");
  await mkdir(project);
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const mapping = Object.fromEntries(
    ["lead", "implementer", "tester", "reviewer", "concurrency"].map((k) => [
      `${k}/project`,
      project,
    ]),
  );
  return { store, service, teams, packs, dir, project, mapping };
}
const counts = (store: Store) => ({
  agents: store.list("agent").length,
  edges: store.list("edge").length,
  rules: store.list("rule").length,
  installs: store.list("team-pack-install").length,
});
const installOpts = (mapping: Record<string, string>) => ({
  workspaces: mapping,
  allowUninstalledEnvironments: true,
  acknowledgeGrants: true,
});

test("bundled Swift pack validates, is a skeleton and does not claim missing skills", async () => {
  const m = parseManifest(await readSwift());
  assert.equal(m.pack.status, "skeleton");
  assert.ok(m.pack.limitations.length >= 3);
  const bundled = m.skills.filter((s) => s.bundled);
  assert.deepEqual(
    bundled.map((s) => (s as any).id),
    ["curated:jeffallan--swift-expert"],
  );
  const missing = m.skills.filter((s) => !s.bundled);
  assert.ok(missing.length >= 3);
  for (const s of missing) {
    assert.deepEqual(Object.keys(s).sort(), [
      "bundled",
      "name",
      "note",
      "purpose",
    ]);
    assert.equal((s as any).note, "not bundled — install separately");
  }
  // Every skill an agent loads is a bundled reference.
  const used = new Set(
    m.template.agents.flatMap((a) => a.skills.map((s) => s.id)),
  );
  assert.deepEqual([...used], ["curated:jeffallan--swift-expert"]);
  assert.ok(m.template.rules.some((r) => r.mode === "mandatory"));
  assert.equal(m.template.groups[0].agentKeys.length, 5);
});

test("manifest validation rejects malformed, credentialed, path-bearing and fabricated-metadata packs", async () => {
  const good = await readSwift();
  const bad = (mutate: (m: any) => void, re: RegExp) => {
    const m = clone(good);
    mutate(m);
    assert.throws(() => parseManifest(m), re);
  };
  bad((m) => (m.extra = 1), /invalid_pack|Invalid team-pack/);
  bad((m) => (m.format = "other"), /Not an AgentTeam team-pack/);
  bad((m) => (m.manifestVersion = 9), /newer than this AgentTeam/);
  bad((m) => (m.pack.version = "1.0"), /Invalid team-pack/);
  bad(
    (m) =>
      (m.template.agents[0].skills = [
        { id: "curated:nope", mode: "always", allowUnverified: false },
      ]),
    /does not declare as bundled/,
  );
  bad(
    (m) =>
      (m.template.agents[0].skills = [
        {
          id: "curated:jeffallan--swift-expert",
          mode: "always",
          allowUnverified: true,
        },
      ]),
    /must not pre-approve unverified/,
  );
  bad((m) => (m.template.agents[0].tools = ["shell"]), /undeclared tool/);
  bad((m) => (m.template.agents[0].environment = "wolfram"), /does not list/);
  bad((m) => {
    m.template.includesAbsolutePaths = true;
    m.template.agents[0].workspaces[0].path = "/Users/x/project";
  }, /absolute paths/);
  bad((m) => (m.pack.limitations = []), /skeleton pack must list/);
  // Credentials: secret-named keys and secret-looking values are refused anywhere.
  bad((m) => (m.apiKey = "x"), /credential/);
  bad((m) => (m.pack.source.token = "x"), /credential/);
  bad(
    (m) =>
      (m.template.agents[0].instructions =
        "use sk-abcdefghijklmnopqrstuvwxyz0123"),
    /credential/,
  );
  // Not-bundled references cannot carry license/revision/hash/id metadata.
  for (const extra of [
    { license: "MIT" },
    { revision: "a".repeat(40) },
    { sha256: "b".repeat(64) },
    { id: "curated:x" },
  ])
    bad(
      (m) =>
        (m.skills[m.skills.length - 1] = {
          ...m.skills[m.skills.length - 1],
          ...extra,
        }),
      /Invalid team-pack/,
    );
});

test("audit fails a pack whose skill lacks license text, notice or matching pins", async (t) => {
  assert.deepEqual(auditTeamPacks(assets).failures, []);
  const dir = await mkdtemp(join(tmpdir(), "agentteam-audit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const copy = join(dir, "assets");
  await mkdir(copy);
  await cp(join(assets, "team-packs"), join(copy, "team-packs"), {
    recursive: true,
  });
  await cp(
    join(assets, "skills", "jeffallan--swift-expert"),
    join(copy, "skills/jeffallan--swift-expert"),
    { recursive: true },
  );
  await cp(
    join(assets, "recommended-skills.json"),
    join(copy, "recommended-skills.json"),
  );
  assert.deepEqual(auditTeamPacks(copy).failures, []);
  // 1. missing skill license text
  const lic = join(copy, "skills/jeffallan--swift-expert/UPSTREAM-LICENSE.txt");
  const text = await readFile(lic, "utf8");
  await rm(lic);
  let r = auditTeamPacks(copy);
  assert.ok(
    r.failures.some((f) => /license\/notice text .* missing/.test(f)),
    r.failures.join("\n"),
  );
  // The release audit script fails on it (exit 1) while the rest of the repo is fine.
  const run = spawnSync(process.execPath, ["scripts/audit-release.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, AGENTTEAM_AUDIT_ASSETS: copy },
    encoding: "utf8",
  });
  assert.equal(run.status, 1, run.stdout);
  assert.match(
    run.stdout,
    /FAIL team pack swift-development: skill curated:jeffallan--swift-expert/,
  );
  await writeFile(lic, text);
  // 2. the pack's own license is separate: removing it fails the pack, not the skill
  const packLic = join(copy, "team-packs/swift-development/LICENSE.txt");
  const packText = await readFile(packLic, "utf8");
  await rm(packLic);
  r = auditTeamPacks(copy);
  assert.ok(r.failures.some((f) => /pack license\/notice text/.test(f)));
  assert.ok(!r.failures.some((f) => /skill /.test(f)));
  await writeFile(packLic, packText);
  // 3. a pin that disagrees with the catalog
  const file = join(copy, "team-packs/swift-development/pack.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.skills[0].revision = "0".repeat(40);
  await writeFile(file, JSON.stringify(manifest));
  r = auditTeamPacks(copy);
  assert.ok(r.failures.some((f) => /pinned revision differs/.test(f)));
  // 4. a skill that is not in assets/skills at all
  manifest.skills[0].revision = "36f3fe8052da7c57083783268c6ea3265d075265";
  manifest.skills[0].id = "curated:ghost--skill";
  manifest.template.agents.forEach((a: any) =>
    a.skills.forEach((s: any) => (s.id = "curated:ghost--skill")),
  );
  await writeFile(file, JSON.stringify(manifest));
  r = auditTeamPacks(copy);
  assert.ok(
    r.failures.some((f) =>
      /not under assets\/skills|license\/notice text/.test(f),
    ),
  );
});

test("preview shows compatibility, skills, grants and changes; install is gated and atomic", async (t) => {
  const { store, packs, mapping, teams } = await setup(t);
  const library = packs.library() as any[];
  assert.equal(library[0].packId, "swift-development");
  assert.equal(library[0].status, "skeleton");

  const p = await packs.preview({ packId: "swift-development" });
  assert.equal(p.ok, false); // unmapped workspace slots
  assert.ok(p.issues.some((i) => i.code === "workspace_unmapped"));
  assert.equal(p.requiresGrantAcknowledgement, true);
  assert.ok(p.grants.some((g) => g.kind === "workspace-write"));
  assert.ok(p.grants.some((g) => g.kind === "required-review"));
  assert.ok(p.grants.some((g) => g.kind === "skill"));
  const swift = p.skills.find(
    (s: any) => s.id === "curated:jeffallan--swift-expert",
  ) as any;
  assert.equal(swift.status, "ok");
  assert.equal(swift.installedHere, true);
  assert.equal(swift.license, "MIT");
  const missing = p.skills.filter((s: any) => !s.bundled) as any[];
  assert.ok(missing.length >= 3);
  assert.ok(
    missing.every(
      (s) =>
        s.note === "not bundled — install separately" &&
        !s.license &&
        !s.revision,
    ),
  );
  assert.equal(p.changes.agents.length, 5);
  assert.equal(p.changes.edges, 7);
  assert.equal(p.changes.rules, 2);
  assert.deepEqual(p.changes.groups, ["Swift team"]);
  assert.deepEqual(counts(store), {
    agents: 0,
    edges: 0,
    rules: 0,
    installs: 0,
  });

  // Missing mapping: nothing is written.
  await assert.rejects(
    packs.install({
      packId: "swift-development",
      acknowledgeGrants: true,
      allowUninstalledEnvironments: true,
    }),
    (e: any) => e.code === "pack_invalid",
  );
  assert.deepEqual(counts(store), {
    agents: 0,
    edges: 0,
    rules: 0,
    installs: 0,
  });
  // Grants must be acknowledged.
  await assert.rejects(
    packs.install({
      packId: "swift-development",
      workspaces: mapping,
      allowUninstalledEnvironments: true,
    }),
    (e: any) => e.code === "grants_not_acknowledged",
  );
  assert.deepEqual(counts(store), {
    agents: 0,
    edges: 0,
    rules: 0,
    installs: 0,
  });
  // A bad mapped directory aborts the whole insert, record included.
  await assert.rejects(
    packs.install({
      packId: "swift-development",
      ...installOpts({ ...mapping, "lead/project": "/definitely/not/a/dir" }),
    }),
  );
  assert.deepEqual(counts(store), {
    agents: 0,
    edges: 0,
    rules: 0,
    installs: 0,
  });

  const result = await packs.install({
    packId: "swift-development",
    ...installOpts(mapping),
  });
  assert.equal(result.agents.length, 5);
  assert.equal(result.edges.length, 7);
  assert.equal(result.rules.length, 2);
  assert.equal(result.groups[0].agentIds.length, 5);
  assert.deepEqual(counts(store), {
    agents: 5,
    edges: 7,
    rules: 2,
    installs: 1,
  });
  // Required review rule was inserted as mandatory; nothing was pre-approved.
  assert.ok(
    store
      .list<any>("rule")
      .some((r) => r.mode === "mandatory" && r.specialty === "swift-review"),
  );
  assert.ok(
    store
      .list<Agent>("agent")
      .every((a) => a.skills.every((s) => !s.allowUnverified)),
  );
  // Duplicate installs are refused unless explicit.
  const again = await packs.preview({
    packId: "swift-development",
    ...installOpts(mapping),
  });
  assert.ok(again.issues.some((i) => i.code === "pack_already_installed"));
  // The install record carries attribution but no credentials or paths.
  const record = store.list<PackInstall>("team-pack-install")[0];
  assert.equal(record.version, "0.1.0");
  const dump = JSON.stringify(record);
  assert.ok(!SECRET_PATTERN.test(dump));
  assert.ok(!dump.includes(mapping["lead/project"]));
  assert.equal(
    packs.attribution(record.id).skills.length,
    record.manifest.skills.length,
  );
  void teams;
});

test("pack from file with credentials or a missing/modified skill pin is refused", async (t) => {
  const { store, packs, mapping } = await setup(t);
  const m = await readSwift();
  const leaky = clone(m);
  leaky.template.agents[0].instructions = "token = abcdefghijklmnop";
  await assert.rejects(
    packs.install({ manifest: leaky, ...installOpts(mapping) }),
    (e: any) => e.code === "pack_contains_credentials",
  );
  const drift = clone(m);
  drift.skills[0].sha256 = "f".repeat(64);
  const p = await packs.preview({ manifest: drift, ...installOpts(mapping) });
  assert.ok(p.issues.some((i) => i.code === "skill_license"));
  await assert.rejects(
    packs.install({ manifest: drift, ...installOpts(mapping) }),
    (e: any) => e.code === "pack_invalid",
  );
  assert.equal(counts(store).agents, 0);
});

test("threeWay classifies pack-only, local-only, identical and conflicting changes", () => {
  assert.equal(threeWay("a", "a", "a"), "none");
  assert.equal(threeWay("a", "b", "a"), "apply");
  assert.equal(threeWay("a", "a", "c"), "keep-local");
  assert.equal(threeWay("a", "b", "b"), "none");
  assert.equal(threeWay("a", "b", "c"), "conflict");
  assert.equal(threeWay(undefined, "b", undefined), "apply");
  assert.equal(
    threeWay({ x: 1, y: 2 }, { y: 2, x: 1 }, { x: 1, y: 2 }),
    "none",
  );
  assert.equal(threeWay("a", undefined, "a"), "apply");
  assert.equal(threeWay("a", undefined, "c"), "conflict");
});

async function installed(t: any) {
  const ctx = await setup(t);
  const base = await readSwift();
  const result = await ctx.packs.install({
    manifest: base,
    ...installOpts(ctx.mapping),
  });
  const record = ctx.store.list<PackInstall>("team-pack-install")[0];
  const agent = (key: string) =>
    ctx.store.get<Agent>("agent", record.ids.agents[key]);
  return { ...ctx, base, result, record, agent };
}
const next = (base: any, mutate: (m: any) => void, version = "0.2.0") => {
  const m = clone(base);
  m.pack.version = version;
  mutate(m);
  return m;
};
const byKey = (m: any, key: string) =>
  m.template.agents.find((a: any) => a.key === key);

test("update diff is three-way: local edits survive, conflicts need explicit resolution", async (t) => {
  const { store, packs, base, record, agent, project } = await installed(t);
  // Local customizations.
  const impl = agent("implementer");
  store.put("agent", {
    ...impl,
    instructions: "LOCAL implementer instructions",
  });
  const lead = agent("lead");
  store.put("agent", { ...lead, role: "Locally renamed lead role" });
  const before = counts(store);

  const m2 = next(base, (m) => {
    byKey(m, "implementer").instructions = "PACK v2 implementer instructions"; // conflict with local
    byKey(m, "tester").instructions = "PACK v2 tester instructions"; // pack-only
    byKey(m, "reviewer").schedulingPriority = 70; // pack-only
    m.template.rules.find((r: any) => r.agentKey === "concurrency").priority =
      25; // whole-entity
    m.template.agents.push({
      ...clone(byKey(m, "tester")),
      key: "docs",
      name: "Swift Docs Writer",
      skills: [],
      parentKey: "lead",
      workspaces: [
        {
          slot: "project",
          label: "Swift project",
          access: "write",
          active: true,
        },
      ],
    });
    m.template.edges.push({
      from: "lead",
      to: "docs",
      kind: "delegate",
      bidirectional: false,
      enabled: true,
    });
  });
  const prev = await packs.updatePreview(record.id, { manifest: m2 });
  assert.equal(prev.ok, true, JSON.stringify(prev.issues));
  const find = (id: string) => prev.changes.find((c) => c.id === id)!;
  assert.equal(find("agent:implementer:instructions").status, "conflict");
  assert.equal(find("agent:tester:instructions").status, "apply");
  assert.equal(find("agent:reviewer:schedulingPriority").status, "apply");
  assert.equal(find("agent:docs").status, "apply");
  assert.equal(find("edge:lead>docs:delegate").status, "apply");
  assert.equal(
    find("rule:concurrency||intake|consult|swift-concurrency").status,
    "apply",
  );
  // The lead role was only changed locally: listed as kept local, never proposed for overwrite.
  assert.equal(find("agent:lead:role").status, "keep-local");
  assert.equal(prev.conflicts, 1);
  assert.deepEqual(counts(store), before); // preview wrote nothing

  // Unresolved conflict: refused and nothing changed.
  await assert.rejects(
    packs.update(record.id, { manifest: m2, diffHash: prev.diffHash }),
    (e: any) => e.code === "unresolved_conflicts",
  );
  assert.equal(
    agent("tester").instructions,
    byKey(base, "tester").instructions,
  );
  assert.equal(
    store.get<PackInstall>("team-pack-install", record.id).version,
    "0.1.0",
  );
  // Stale diff hash is refused.
  await assert.rejects(
    packs.update(record.id, {
      manifest: m2,
      diffHash: "stale",
      resolutions: { "agent:implementer:instructions": "keep-local" },
    }),
    (e: any) => e.code === "diff_stale",
  );
  // Resolutions only for real conflicts.
  await assert.rejects(
    packs.update(record.id, {
      manifest: m2,
      diffHash: prev.diffHash,
      resolutions: {
        "agent:implementer:instructions": "keep-local",
        "agent:tester:instructions": "take-pack",
      },
    }),
    (e: any) => e.code === "unknown_resolution",
  );

  const done = await packs.update(record.id, {
    manifest: m2,
    diffHash: prev.diffHash,
    resolutions: { "agent:implementer:instructions": "keep-local" },
  });
  assert.equal(done.to, "0.2.0");
  assert.equal(
    agent("implementer").instructions,
    "LOCAL implementer instructions",
  );
  assert.equal(agent("lead").role, "Locally renamed lead role");
  assert.equal(agent("tester").instructions, "PACK v2 tester instructions");
  assert.equal(agent("reviewer").schedulingPriority, 70);
  const after = counts(store);
  assert.deepEqual(after, {
    ...before,
    agents: before.agents + 1,
    edges: before.edges + 1,
  });
  // New agent is added without folders (nothing silently granted).
  const docs = store
    .list<Agent>("agent")
    .find((a) => a.name === "Swift Docs Writer")!;
  assert.deepEqual(docs.workspaces, []);
  assert.ok(done.addedAgents.includes(docs.id));
  assert.equal(
    store.list<any>("rule").find((r) => r.specialty === "swift-concurrency")
      .priority,
    25,
  );
  const rec = store.get<PackInstall>("team-pack-install", record.id);
  assert.equal(rec.version, "0.2.0");
  assert.equal(rec.history.length, 2);
  // Re-previewing the same version is not an update.
  const again = await packs.updatePreview(record.id, { manifest: m2 });
  assert.ok(again.issues.some((i) => i.code === "not_newer"));
  // A later update treats the kept-local value as a local customization, not a conflict.
  const m3 = next(m2, () => {}, "0.3.0");
  byKey(m3, "implementer").instructions = "PACK v2 implementer instructions";
  const p3 = await packs.updatePreview(record.id, { manifest: m3 });
  assert.equal(
    p3.changes.find((c) => c.id === "agent:implementer:instructions")?.status,
    "keep-local",
  );
  assert.equal(p3.conflicts, 0);
  void project;
});

test("take-pack resolution overwrites only that field; locally deleted agents are not recreated; busy agents block", async (t) => {
  const { store, packs, base, record, agent } = await installed(t);
  const impl = agent("implementer");
  store.put("agent", { ...impl, instructions: "LOCAL", role: "LOCAL ROLE" });
  const tester = agent("tester");
  // The user deleted the Concurrency Specialist locally.
  store.remove("agent", record.ids.agents.concurrency);
  const m2 = next(base, (m) => {
    byKey(m, "implementer").instructions = "PACK v2";
    byKey(m, "concurrency").instructions = "PACK v2 concurrency";
  });
  const prev = await packs.updatePreview(record.id, { manifest: m2 });
  assert.equal(
    prev.changes.find((c) => c.id === "agent:concurrency")?.reason,
    "deleted-locally",
  );
  // A running session on an agent that would change blocks the update, writing nothing.
  store.put("session", {
    id: "s1",
    agentId: impl.id,
    providerSessionId: null,
    state: "running",
  });
  await assert.rejects(
    packs.update(record.id, {
      manifest: m2,
      diffHash: prev.diffHash,
      resolutions: { "agent:implementer:instructions": "take-pack" },
    }),
    (e: any) => e.code === "agent_busy",
  );
  assert.equal(agent("implementer").instructions, "LOCAL");
  store.put("session", {
    id: "s1",
    agentId: impl.id,
    providerSessionId: null,
    state: "idle",
  });
  await packs.update(record.id, {
    manifest: m2,
    diffHash: prev.diffHash,
    resolutions: { "agent:implementer:instructions": "take-pack" },
  });
  assert.equal(agent("implementer").instructions, "PACK v2");
  assert.equal(agent("implementer").role, "LOCAL ROLE");
  assert.ok(
    !store
      .list<Agent>("agent")
      .some((a) => a.name === "Swift Concurrency Specialist"),
  );
  assert.equal(agent("tester").instructions, tester.instructions);
});

test("update retains notices and requires acknowledging license or revision changes", async (t) => {
  const { packs, base, record, store } = await installed(t);
  const m2 = next(base, (m) => {
    m.pack.notices.push("Added upstream notice.");
    m.pack.source.license = "Apache-2.0";
  });
  const prev = await packs.updatePreview(record.id, { manifest: m2 });
  assert.equal(prev.requiresLicenseAcceptance, true);
  assert.ok(
    prev.licenseChanges.some(
      (c) => c.change === "license-changed" && c.subject.startsWith("pack"),
    ),
  );
  await assert.rejects(
    packs.update(record.id, { manifest: m2, diffHash: prev.diffHash }),
    (e: any) => e.code === "license_change_unacknowledged",
  );
  await packs.update(record.id, {
    manifest: m2,
    diffHash: prev.diffHash,
    acceptLicenseChanges: true,
  });
  // A later version that drops a notice keeps it in the install record.
  const m3 = next(m2, (m) => (m.pack.notices = []), "0.3.0");
  const p3 = await packs.updatePreview(record.id, { manifest: m3 });
  await packs.update(record.id, { manifest: m3, diffHash: p3.diffHash });
  const rec = store.get<PackInstall>("team-pack-install", record.id);
  assert.equal(rec.notices.length, 2);
  assert.ok(rec.notices.includes("Added upstream notice."));
  // A different pack cannot update this install.
  const other = next(base, (m) => (m.pack.id = "other-pack"), "9.0.0");
  await assert.rejects(
    packs.updatePreview(record.id, { manifest: other }),
    (e: any) => e.code === "pack_mismatch",
  );
  // An update whose companion skill lacks license/pin data fails separately from the pack license.
  const bad = next(m3, (m) => (m.skills[0].sha256 = "e".repeat(64)), "0.4.0");
  const pb = await packs.updatePreview(record.id, { manifest: bad });
  assert.equal(pb.ok, false);
  assert.ok(
    pb.issues.every(
      (i) => i.code === "skill_license" || i.code === "skill_pin_mismatch",
    ),
  );
  await assert.rejects(
    packs.update(record.id, { manifest: bad, diffHash: pb.diffHash }),
    (e: any) => e.code === "pack_update_invalid",
  );
});

test("team templates persist group membership additively (schema v2) and v1 files still import", async (t) => {
  const { service, teams, store, project } = await setup(t);
  assert.equal(TEAM_TEMPLATE_SCHEMA_VERSION, 2);
  const a = await service.saveAgent({
    name: "A",
    environment: "codex",
    workspaces: [{ path: project, access: "write", active: true }],
  });
  const b = await service.saveAgent({ name: "B", environment: "claude" });
  const c = await service.saveAgent({ name: "C", environment: "claude" });
  const saved = teams.create({
    name: "Grouped",
    agentIds: [a.id, b.id],
    groups: [
      { name: "Core", agentIds: [a.id, b.id, c.id] }, // c is outside the selection and dropped
      { name: "Gone", agentIds: [c.id] }, // emptied group disappears
    ],
  });
  assert.deepEqual(saved.groups, [{ name: "Core", agentKeys: ["a1", "a2"] }]);
  const env = JSON.parse(JSON.stringify(teams.export(saved.id)));
  assert.equal(env.schemaVersion, 2);
  const result = await teams.insert({
    envelope: env,
    workspaces: { "a1/w1": project },
  });
  assert.equal(result.groups.length, 1);
  assert.deepEqual(
    result.groups[0].agentIds.sort(),
    result.agents.map((x) => x.id).sort(),
  );
  // A v1 file (no groups) is read with an empty group list.
  const v1 = clone(env);
  v1.schemaVersion = 1;
  delete v1.template.groups;
  const imported = teams.import(v1);
  assert.deepEqual(teams.get(imported.id).groups ?? [], []);
  // Bad group data is rejected by the schema.
  const broken = clone(env);
  broken.template.groups = [{ name: "X", agentKeys: ["nope"] }];
  assert.throws(() => teams.import(broken), /unknown agent/);
  broken.template.groups = [
    { name: "X", agentKeys: ["a1"] },
    { name: "Y", agentKeys: ["a1"] },
  ];
  assert.throws(() => teams.import(broken), /more than one group/);
  void store;
});
