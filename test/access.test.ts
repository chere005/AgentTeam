import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { WorkspaceService } from "../src/workspaces.ts";
import { GitWorkflow } from "../src/git-workflow.ts";
import {
  accessReport,
  decide,
  filterDiff,
  normalizeRules,
  type AccessSubject,
} from "../src/access.ts";
import { accessAgentView } from "../src/access-routes.ts";
import { sharedResources } from "../src/sharing.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });

// ---- precedence (pure) ------------------------------------------------------------------------
const base = (over: Partial<AccessSubject> = {}): AccessSubject => ({
  path: "/w",
  access: "write",
  ...over,
});
test("precedence: exclusions beat inclusions, then most specific rule, then inherited access", () => {
  const ws = base({
    access: "read",
    rules: [
      { path: "src", access: "write" },
      { path: "src/generated", access: "none" },
      { path: "src/generated/keep.txt", access: "write" },
      { path: "src/vendor", access: "read" },
      { path: "docs", access: "read" },
    ],
  });
  assert.equal(decide(ws, "README.md").access, "read"); // inherited
  assert.equal(decide(ws, "README.md").source, "inherited");
  assert.equal(decide(ws, "src/a.ts").access, "write"); // folder rule upgrades
  assert.equal(decide(ws, "src/vendor/x.js").access, "read"); // more specific read downgrades
  assert.equal(decide(ws, "src/generated/out.js").access, "none");
  // an explicit allow below an exclusion never wins
  assert.equal(decide(ws, "src/generated/keep.txt").access, "none");
  assert.match(decide(ws, "src/generated/keep.txt").reason, /Exclusions beat/i);
  // exclusions are case-insensitive so a case-insensitive filesystem cannot slip past them
  assert.equal(decide(ws, "SRC/Generated/out.js").access, "none");
  // a sibling with the same prefix is not covered
  assert.equal(decide(ws, "src/generated2/out.js").access, "write");
});
test("precedence: equal specificity prefers read; explicit-only grants only listed paths", () => {
  const tie = base({
    access: "write",
    rules: [
      { path: "a", access: "read" },
      { path: "a", access: "write" },
    ],
  });
  // normalizeRules refuses the contradictory pair, so evaluate the raw tie directly
  assert.equal(decide(tie, "a/f").access, "read");
  assert.throws(() => normalizeRules(tie.rules), /Conflicting rules/);
  const only = base({
    access: "read",
    explicitOnly: true,
    rules: [
      { path: "notes.md", access: "write" },
      { path: "lib", access: "read" },
    ],
  });
  assert.equal(decide(only, "notes.md").access, "write");
  assert.equal(decide(only, "lib/x.ts").access, "read");
  assert.equal(decide(only, "other.txt").access, "none");
  assert.equal(decide(only, "other.txt").source, "unlisted");
});
test("rule paths are validated: relative, inside the folder, never .git", () => {
  for (const bad of [
    "/etc/passwd",
    "../x",
    "a/../../x",
    ".git",
    "a/.git/hooks",
    "C:\\x",
    "",
    ".",
  ])
    assert.throws(() => normalizeRules([{ path: bad, access: "none" }]), bad);
  assert.deepEqual(normalizeRules([{ path: "./a\\b//c/", access: "read" }]), [
    { path: "a/b/c", access: "read" },
  ]);
});
test("effective access report lists allowed and denied paths with reasons", () => {
  const r = accessReport(
    base({
      access: "write",
      rules: [
        { path: "secrets", access: "none" },
        { path: "secrets/ok.txt", access: "read" },
        { path: "docs", access: "read" },
      ],
    }),
  );
  assert.deepEqual(
    r.allowed.map((a) => [a.path, a.access]),
    [
      [".", "write"],
      ["docs", "read"],
    ],
  );
  const denied = r.denied.map((d) => d.path);
  assert.ok(denied.includes("secrets") && denied.includes(".git"));
  assert.match(
    r.denied.find((d) => d.path === "secrets/ok.txt")!.reason,
    /overridden/,
  );
  assert.ok(
    r.notes.some((n) => /outside this cooperative enforcement/.test(n)),
  );
});
test("diff filtering drops sections of excluded files", () => {
  const text =
    "diff --git a/ok.txt b/ok.txt\n+x\ndiff --git a/secret/key b/secret/key\n+hidden\n";
  const out = filterDiff(text, (p) => !p.startsWith("secret"));
  assert.match(out, /ok\.txt/);
  assert.doesNotMatch(out, /hidden|secret/);
});

test("diff filtering handles quoted names, spaces and renames, and fails closed", () => {
  const hidden = (p: string) => !p.startsWith("secret");
  // A quoted (non-ASCII) excluded name must not slip through.
  const quoted =
    'diff --git "a/secret/caf\\303\\251.txt" "b/secret/caf\\303\\251.txt"\n+leak1\n' +
    "diff --git a/ok.txt b/ok.txt\n+fine\n";
  assert.doesNotMatch(filterDiff(quoted, hidden), /leak1/);
  assert.match(filterDiff(quoted, hidden), /fine/);
  // A name with spaces: the lazy "a/(.+?) b/" split used to see "a" and "c b/secret x b/c".
  const spaced = "diff --git a/secret x b/c b/secret x b/c\n+leak2\n";
  assert.doesNotMatch(filterDiff(spaced, hidden), /leak2/);
  assert.match(filterDiff("diff --git a/a b c b/a b c\n+ok\n", hidden), /ok/);
  // A rename out of an excluded folder.
  const renamed =
    "diff --git a/secret/k b/pub/k\nsimilarity index 90%\nrename from secret/k\nrename to pub/k\n+leak3\n";
  assert.doesNotMatch(filterDiff(renamed, hidden), /leak3/);
  // Undeterminable header: dropped under restrictions, kept without them.
  const odd = 'diff --git a/x y "b/z"\n+leak4\n';
  assert.doesNotMatch(
    filterDiff(odd, (p) => !p.includes("\0") && hidden(p)),
    /leak4/,
  );
  assert.match(
    filterDiff(odd, () => true),
    /leak4/,
  );
});

// ---- enforcement through the services ---------------------------------------------------------
async function fixture(t: any, workspace: Record<string, unknown> = {}) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-rules-")),
  );
  const root = join(base, "project");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "secrets"));
  await writeFile(join(root, "src", "a.ts"), "a");
  await writeFile(join(root, "README.md"), "readme");
  await writeFile(join(root, "secrets", "key.txt"), "TOPSECRET");
  await writeFile(join(base, "outside.txt"), "outside");
  await symlink(join(root, "secrets", "key.txt"), join(root, "link-to-secret"));
  await symlink(join(base, "outside.txt"), join(root, "link-outside"));
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([]));
  const agent = await team.saveAgent({
    name: "Ruled",
    environment: "codex",
    workspaces: [{ path: root, access: "write", active: true, ...workspace }],
  });
  t.after(async () => {
    store.close();
    await rm(base, { recursive: true, force: true });
  });
  return { base, root, store, team, agent, ws: new WorkspaceService(store) };
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => (e as { code?: string }).code,
  );

test("exclusions block browse, preview, symlink and traversal paths; .git rules unchanged", async (t) => {
  const { root, agent, ws } = await fixture(t, {
    rules: [{ path: "secrets", access: "none" }],
  });
  const names = (await ws.browse(agent.id, { workspace: root })).entries.map(
    (e) => e.name,
  );
  assert.ok(!names.includes("secrets"), "excluded folder is hidden");
  assert.ok(names.includes("src"));
  const at = (path: string) => ws.preview(agent.id, { workspace: root, path });
  assert.equal(await code(at("secrets/key.txt")), "access_denied");
  assert.equal(
    await code(ws.browse(agent.id, { workspace: root, path: "secrets" })),
    "access_denied",
  );
  assert.equal(await code(at("SECRETS/key.txt")), "access_denied");
  assert.equal(await code(at("src/../secrets/key.txt")), "access_denied");
  assert.equal(await code(at("link-to-secret")), "access_denied"); // symlink into an excluded path
  assert.equal(await code(at("link-outside")), "path_escape"); // symlink escape unchanged
  assert.equal(await code(at("../outside.txt")), "path_escape");
  assert.equal(await code(at(".git/config")), "git_internal");
  assert.equal(await code(at("src/a.ts")), "ok");
});
test("explicit-only attachments grant just the listed files; read rules cap writes; write rules lift a read folder", async (t) => {
  const { root, agent, ws } = await fixture(t, {
    access: "read",
    explicitOnly: true,
    rules: [
      { path: "README.md", access: "write" },
      { path: "src", access: "read" },
    ],
  });
  const at = (path: string, write = false) =>
    ws.location(agent.id, { workspace: root, path }, write);
  assert.equal((await at("README.md", true)).access, "write");
  assert.equal(await code(at("src/a.ts")), "ok");
  assert.equal(await code(at("src/a.ts", true)), "read_only");
  assert.equal(await code(at("secrets/key.txt")), "access_denied");
  assert.equal(await code(at(".")), "access_denied"); // the root itself is not granted...
  const root_listing = await ws.browse(agent.id, { workspace: root }); // ...but can be walked to reach listed paths
  assert.deepEqual(root_listing.entries.map((e) => e.name).sort(), [
    "README.md",
    "src",
  ]);
});
test("saving an agent normalizes rules and rejects unsafe or empty explicit-only rules", async (t) => {
  const { team, root } = await fixture(t);
  await assert.rejects(
    team.saveAgent({
      name: "X",
      environment: "codex",
      workspaces: [
        {
          path: root,
          access: "write",
          rules: [{ path: "../x", access: "none" }],
        },
      ],
    }),
    /inside the attached folder/,
  );
  await assert.rejects(
    team.saveAgent({
      name: "X",
      environment: "codex",
      workspaces: [
        { path: root, access: "write", explicitOnly: true, rules: [] },
      ],
    }),
    /at least one file or folder rule/,
  );
});
test("artifact registration obeys exclusions and explicit-only rules", async (t) => {
  const { team, agent, store } = await fixture(t, {
    rules: [{ path: "secrets", access: "none" }],
  });
  const wf = team.workflow({
    name: "W",
    goal: "G",
    ownerId: agent.id,
    completionCriteria: "D",
  });
  const task = team.task({
    workflowId: wf.id,
    agentId: agent.id,
    title: "T",
    completionCriteria: "D",
  });
  team.transitionTask(task.id, { status: "running" });
  const reg = (path: string) =>
    team.artifacts.register(wf.id, {
      taskId: task.id,
      agentId: agent.id,
      kind: "file",
      title: "t",
      path,
    });
  assert.equal(await code(reg("secrets/key.txt")), "access_denied");
  assert.equal(await code(reg("link-to-secret")), "access_denied");
  assert.equal(await code(reg("src/a.ts")), "ok");
  // An exclusion added after registration hides the file's current content in previews.
  const art = store
    .list<any>("artifact")
    .find((a) => a.source?.path === "src/a.ts")!;
  assert.equal(
    await code(team.artifacts.preview(art.id, { type: "user" })),
    "ok",
  );
  const current = store.get<any>("agent", agent.id);
  store.put("agent", {
    ...current,
    workspaces: [
      {
        ...current.workspaces[0],
        rules: [
          ...current.workspaces[0].rules,
          { path: "src", access: "none" },
        ],
      },
    ],
  });
  assert.equal(
    await code(team.artifacts.preview(art.id, { type: "user" })),
    "access_denied",
  );
});

test("git: status/diff hide excluded files and whole-tree mutations are refused under rules", async (t) => {
  const { root, agent, ws, store } = await fixture(t, {
    rules: [
      { path: "secrets", access: "none" },
      { path: "README.md", access: "read" },
    ],
  });
  git(root, "init", "-q", "-b", "main");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".");
  git(
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "init",
  );
  await writeFile(join(root, "secrets", "key.txt"), "CHANGED-SECRET");
  await writeFile(join(root, "secrets", "new.txt"), "new secret");
  await writeFile(join(root, "src", "a.ts"), "changed a");
  const info = await ws.gitInfo(agent.id, { workspace: root });
  assert.deepEqual(
    info.status.map((s) => s.path),
    ["src/a.ts"],
  );
  assert.equal(info.canMutate, false);
  const diff = await ws.diff(agent.id, { workspace: root });
  assert.match(diff.diff, /src\/a\.ts/);
  assert.doesNotMatch(diff.diff, /secret/i);
  // staging checks each path against the rules
  const stage = (paths: string[]) =>
    ws.mutateGit(agent.id, { workspace: root, action: "stage", paths });
  assert.equal(await code(stage(["secrets/key.txt"])), "access_denied");
  assert.equal(await code(stage(["README.md"])), "read_only");
  assert.equal(await code(stage(["src/a.ts"])), "ok");
  assert.equal(
    await code(
      ws.mutateGit(agent.id, {
        workspace: root,
        action: "commit",
        message: "m",
      }),
    ),
    "access_rules_git",
  );
  // the Git workflow layer: counts exclude hidden files, whole-tree writes are refused
  const flow = new GitWorkflow(store, ws);
  const state = await flow.state(agent.id, { workspace: root });
  assert.equal((state as any).tracked + (state as any).untracked, 1);
  assert.equal(
    await code(
      flow.switchBranch(agent.id, { workspace: root, branch: "main" }),
    ),
    "access_rules_git",
  );
});

test("git diff of a subfolder attachment matches rules against repository-relative paths", async (t) => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "agentteam-rules-sub-")),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const sub = join(base, "pkg");
  await mkdir(join(sub, "secrets"), { recursive: true });
  await writeFile(join(sub, "secrets", "key.txt"), "v1");
  await writeFile(join(sub, "open.txt"), "v1");
  git(base, "init", "-q", "-b", "main");
  git(base, "add", ".");
  git(
    base,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "init",
  );
  await writeFile(join(sub, "secrets", "key.txt"), "SUBSECRET-CHANGED");
  await writeFile(join(sub, "open.txt"), "visible change");
  const store = new Store(":memory:"),
    team = new TeamService(store, new SkillCatalog([]));
  t.after(() => store.close());
  const agent = await team.saveAgent({
    name: "Sub",
    environment: "codex",
    workspaces: [
      {
        path: sub,
        access: "read",
        rules: [{ path: "secrets", access: "none" }],
      },
    ],
  });
  const diff = await new WorkspaceService(store).diff(agent.id, {
    workspace: sub,
  });
  assert.match(diff.diff, /visible change/);
  assert.doesNotMatch(diff.diff, /SUBSECRET/);
});

test("effective-access view and shared resources name exact paths, owners and why", async (t) => {
  const { root, agent, team } = await fixture(t, {
    rules: [{ path: "secrets", access: "none" }],
  });
  const other = await team.saveAgent({
    name: "Reader",
    environment: "claude",
    workspaces: [{ path: join(root, "src"), access: "read" }],
  });
  const hidden = await team.saveAgent({
    name: "NoSrc",
    environment: "claude",
    workspaces: [{ path: join(root, "secrets"), access: "read" }],
  });
  const view = accessAgentView(team, agent.id);
  assert.equal(view.workspaces[0].restricted, true);
  assert.ok(view.workspaces[0].denied.some((d) => d.path === "secrets"));
  assert.match(view.external.notice, /External editors/);
  const shared = sharedResources(team);
  const src = shared.find((s) => s.path === join(root, "src"))!;
  assert.deepEqual(src.agents.map((a) => a.name).sort(), ["Reader", "Ruled"]);
  assert.equal(src.kind, "read-write");
  assert.equal(src.pairs[0].a, root);
  // the excluded folder is not "shared" with the agent that cannot see it
  assert.ok(
    !shared.some(
      (s) =>
        s.path === join(root, "secrets") &&
        s.agents.some((a) => a.agentId === agent.id),
    ),
  );
  void other;
  void hidden;
});
