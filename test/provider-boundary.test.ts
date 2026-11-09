import "./fixtures/temp-data-dir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
  readFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  codexReadBoundaryIssue,
  codexScratchDenials,
  codexTaskPermissions,
  runtimeReadPaths,
} from "../src/provider-filesystem.ts";
import { findExecutable } from "../src/discovery.ts";

const ws = (path: string, access: "read" | "write" = "write") => ({
  path,
  access,
  active: true,
});
const table = (settings: string[]) => settings[1];

test("Codex profile denies shared scratch folders and names the runtime, never the home folder", () => {
  const mac = table(
    codexTaskPermissions([ws("/p/a")], ["read", "edit"], "darwin", [
      "/opt/homebrew",
    ]),
  );
  for (const denied of ["/private/tmp", "/private/var/tmp"])
    assert.ok(mac.includes(`${JSON.stringify(denied)}="deny"`), denied);
  assert.ok(mac.includes('"/opt/homebrew"="read"'));
  assert.ok(mac.includes('"/p/a"="write"'));
  assert.ok(mac.includes('"/p/a/.git"="deny"'));
  assert.ok(!mac.includes(JSON.stringify(homedir()) + "="));
  const linux = table(codexTaskPermissions([ws("/p/a")], ["read"], "linux"));
  assert.ok(
    linux.includes('"/tmp"="deny"') && linux.includes('"/var/tmp"="deny"'),
  );
  assert.ok(linux.includes('"/p/a"="read"'));
  assert.deepEqual(codexScratchDenials("win32"), []);
});

test("runtime read paths never expose the home folder or a filesystem root", async (t) => {
  const base = await realpath(await mkdtemp(join(homedir(), ".agentteam-rt-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bin = join(base, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "node"), "#!/bin/sh\n", { mode: 0o755 });
  // The install prefix under home is granted narrowly, the home folder itself never.
  assert.deepEqual(runtimeReadPaths("linux", bin, homedir()), [base]);
  assert.deepEqual(runtimeReadPaths("linux", bin, base), []);
  assert.deepEqual(runtimeReadPaths("win32", bin, homedir()), []);
  assert.deepEqual(
    runtimeReadPaths("linux", "/nonexistent-dir", homedir()),
    [],
  );
});

test("scoped Codex is refused where the read boundary was never verified", () => {
  assert.equal(codexReadBoundaryIssue("darwin", {}), null);
  assert.match(
    codexReadBoundaryIssue("linux", {}) ?? "",
    /verified only on macOS/,
  );
  assert.match(codexReadBoundaryIssue("win32", {}) ?? "", /win32/);
  assert.equal(
    codexReadBoundaryIssue("linux", { AGENTTEAM_UNVERIFIED_SANDBOX: "1" }),
    null,
  );
});

// Opt-in, model-free: AGENTTEAM_BOUNDARY_PROBE=1 runs the generated profile through the real
// installed Codex's seatbelt (`codex sandbox`, no model turn, no usage). macOS only.
test(
  "REAL CODEX SANDBOX PROBE (opt-in, AGENTTEAM_BOUNDARY_PROBE=1)",
  {
    skip:
      process.env.AGENTTEAM_BOUNDARY_PROBE !== "1" ||
      process.platform !== "darwin",
  },
  async (t) => {
    const codex = await findExecutable("codex");
    assert.ok(codex, "no Codex installation found");
    // Under the home folder (not /tmp): that is where a user's other projects live.
    const base = await realpath(
      await mkdtemp(join(homedir(), ".agentteam-probe-")),
    );
    const scratch = await realpath(await mkdtemp("/tmp/agentteam-probe-"));
    t.after(async () => {
      await rm(base, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    });
    const root = join(base, "root"),
      sib = join(base, "sibling"),
      ro = join(base, "ro");
    for (const d of [root, sib, ro]) await mkdir(d);
    await writeFile(join(root, "in.txt"), "IN");
    await writeFile(join(ro, "ro.txt"), "RO");
    await writeFile(join(sib, "secret.txt"), "SECRET");
    await writeFile(join(scratch, "secret.txt"), "SCRATCH");
    await symlink(join(sib, "secret.txt"), join(root, "escape-file"));
    await symlink(sib, join(root, "escape-dir"));
    const settings = codexTaskPermissions(
      [ws(root), ws(ro, "read")],
      ["read", "edit", "write"],
      "darwin",
      runtimeReadPaths(),
    );
    const run = (...cmd: string[]) =>
      spawnSync(
        codex,
        ["sandbox", ...settings.flatMap((s) => ["-c", s]), "--", ...cmd],
        { encoding: "utf8", timeout: 30_000 },
      );
    const ok = (...cmd: string[]) => run(...cmd).status === 0;
    assert.ok(ok("cat", join(root, "in.txt")), "read inside root");
    assert.ok(ok("cat", join(ro, "ro.txt")), "read inside read-only root");
    assert.ok(
      ok("sh", "-c", `echo x > ${join(root, "w.txt")}`),
      "write inside root",
    );
    assert.ok(
      !ok("sh", "-c", `echo x > ${join(ro, "w.txt")}`),
      "write to read-only root",
    );
    assert.ok(!ok("cat", join(sib, "secret.txt")), "sibling read");
    assert.ok(
      !ok("sh", "-c", `echo x > ${join(sib, "w.txt")}`),
      "sibling write",
    );
    assert.ok(
      !ok("cat", join(root, "escape-file")),
      "symlinked file escaping the root",
    );
    assert.ok(
      !ok("cat", join(root, "escape-dir", "secret.txt")),
      "symlinked dir escaping the root",
    );
    assert.ok(!ok("cat", join(homedir(), ".zshrc")), "home dotfile");
    assert.ok(!ok("cat", join(scratch, "secret.txt")), "/tmp read");
    assert.ok(
      !ok("sh", "-c", `echo x > ${join(scratch, "w.txt")}`),
      "/tmp write",
    );
    assert.ok(
      !ok("sh", "-c", "echo x > /private/var/tmp/agentteam-probe-w"),
      "/var/tmp write",
    );
    assert.ok(!ok("ls", "/Volumes"), "volumes listing");
    assert.ok(ok("cat", "/etc/hosts"), "system files stay readable");
    // Node execution (#99) keeps working under the read boundary.
    const node = spawnSync("which", ["node"], {
      encoding: "utf8",
    }).stdout.trim();
    if (node) {
      const r = run(node, "-e", "console.log(40+2)");
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), "42");
    }
    assert.equal(await readFile(join(root, "w.txt"), "utf8"), "x\n");
  },
);
