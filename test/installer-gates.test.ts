import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  allInstallerFiles,
  installerFiles,
  requiredResources,
  unpackedApp,
  verify,
} from "../scripts/installer-gates.mjs";

const repo = new URL("..", import.meta.url).pathname;
const text = (...p: string[]) => readFileSync(join(repo, ...p), "utf8");

test("installer file names match electron-builder's artifactName", () => {
  assert.deepEqual(installerFiles("mac", "arm64", "1.2.3"), [
    "AgentTeam-1.2.3-mac-arm64.dmg",
    "AgentTeam-1.2.3-mac-arm64.zip",
  ]);
  assert.deepEqual(installerFiles("windows", "x64", "1.2.3"), [
    "AgentTeam-1.2.3-win-x64.exe",
  ]);
  assert.deepEqual(installerFiles("linux", "x64", "1.2.3"), [
    "AgentTeam-1.2.3-linux-x86_64.AppImage",
    "AgentTeam-1.2.3-linux-amd64.deb",
  ]);
  assert.throws(() => installerFiles("beos", "x64", "1"));
});

test("release.yml publishes exactly the files the gates script lists, and both workflows call the script", () => {
  const release = text(".github", "workflows", "release.yml");
  const publish = parse(release).jobs.publish.steps[0].run as string;
  const listed = [...publish.matchAll(/"AgentTeam-\$\{VERSION\}-([^"]+)"/g)]
    .map((m) => `AgentTeam-9.9.9-${m[1]}`)
    .sort();
  assert.deepEqual(listed, allInstallerFiles("9.9.9").sort());
  assert.match(
    release,
    /node scripts\/installer-gates\.mjs --\$\{\{ matrix\.arch \}\} --smoke/,
  );
  assert.match(release, /node scripts\/installer-gates\.mjs --x64/);
  assert.doesNotMatch(release, /scripts\/package\.mjs/);
  const ci = parse(text(".github", "workflows", "ci.yml"));
  const steps = JSON.stringify(ci.jobs.installers.steps);
  assert.match(steps, /scripts\/installer-gates\.mjs/);
  assert.equal(ci.jobs.installers["continue-on-error"], true);
  assert.match(ci.jobs.installers.if, /preflight\//);
  assert.match(ci.jobs.installers.name, /optional/);
  // Nothing in the preflight job may publish.
  assert.doesNotMatch(JSON.stringify(ci.jobs.installers), /gh release|upload/);
});

function fixture(
  platform: "linux" | "mac",
  opts: { version?: string; drop?: string } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "gates-"));
  const version = "1.0.0";
  const arch = "x64";
  const big = Buffer.alloc(5_000_001);
  for (const f of installerFiles(platform, arch, version))
    writeFileSync(join(dir, f), big);
  const { app, resources } = unpackedApp(platform, arch, dir);
  const put = (p: string, body: string | Buffer = "x") => {
    if (opts.drop && p.endsWith(opts.drop)) return;
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  };
  for (const rel of requiredResources) put(join(resources, rel));
  if (platform === "linux") {
    put(join(app, "LICENSE"));
    put(join(app, "LICENSES.chromium.html"));
  }
  const pty = join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  put(join(pty, platform === "mac" ? "darwin-x64" : "linux-x64", "pty.node"));
  if (platform === "mac") {
    put(join(pty, "darwin-x64", "spawn-helper"));
    chmodSync(join(pty, "darwin-x64", "spawn-helper"), 0o755);
  }
  const files = ["/package.json", "/dist/desktop/main.js", "/dist/index.html"];
  const run = {
    asar: () => ({
      listPackage: () => files,
      extractFile: () =>
        Buffer.from(JSON.stringify({ version: opts.version ?? version })),
    }),
    cmd: (c: string, a: string[]) => {
      if (c === "lipo") return { status: 0, stdout: "x86_64\n", stderr: "" };
      if (c === "codesign")
        return { status: 1, stdout: "", stderr: "not signed" };
      if (c === "unzip")
        return {
          status: 0,
          stdout: "AgentTeam.app/Contents/Info.plist\n",
          stderr: "",
        };
      return { status: 0, stdout: version + "\n", stderr: a.join(" ") };
    },
  };
  return { dir, version, arch, run };
}

test("verify passes a complete linux package and a complete unsigned mac package", () => {
  for (const platform of ["linux", "mac"] as const) {
    const f = fixture(platform);
    try {
      const r = verify({
        platform,
        arch: f.arch,
        version: f.version,
        dir: f.dir,
        run: f.run,
      });
      assert.deepEqual(r.failures, []);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
});

test("verify names what is wrong", () => {
  const cases: [string, { version?: string; drop?: string }, RegExp][] = [
    [
      "wrong asar version",
      { version: "0.9.0" },
      /app\.asar package\.json says 0\.9\.0/,
    ],
    ["missing notice", { drop: "LICENSES.chromium.html" }, /Chromium notice/],
    ["missing own notice", { drop: "EDITOR-LICENSES.txt" }, /EDITOR-LICENSES/],
    ["missing pty", { drop: "pty.node" }, /node-pty/],
  ];
  for (const [, opts, re] of cases) {
    const f = fixture("linux", opts);
    try {
      const r = verify({
        platform: "linux",
        arch: f.arch,
        version: f.version,
        dir: f.dir,
        run: f.run,
      });
      assert.ok(
        r.failures.some((m: string) => re.test(m)),
        `${re}: ${r.failures.join("; ")}`,
      );
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
  const f = fixture("linux");
  try {
    rmSync(join(f.dir, installerFiles("linux", "x64", "1.0.0")[1]));
    const r = verify({
      platform: "linux",
      arch: "x64",
      version: "1.0.0",
      dir: f.dir,
      run: f.run,
    });
    assert.ok(
      r.failures.some((m: string) => /missing installer .*\.deb/.test(m)),
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a mac build with signing credentials fails when codesign does", () => {
  const f = fixture("mac");
  try {
    const r = verify({
      platform: "mac",
      arch: f.arch,
      version: f.version,
      dir: f.dir,
      run: f.run,
      signingRequired: true,
    });
    assert.ok(r.failures.some((m: string) => /codesign/.test(m)));
    const wrong = {
      ...f.run,
      cmd: (c: string) =>
        c === "lipo"
          ? { status: 0, stdout: "arm64\n", stderr: "" }
          : f.run.cmd(c, []),
    };
    const r2 = verify({
      platform: "mac",
      arch: f.arch,
      version: f.version,
      dir: f.dir,
      run: wrong,
    });
    assert.ok(r2.failures.some((m: string) => /architecture/.test(m)));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// scripts/preflight.sh with git and gh stubbed: nothing is pushed, no network.
function preflight(jobs: string) {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "jobs.tsv"), jobs);
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
case "$1 $2" in
  "rev-parse --abbrev-ref") echo work ;;
  "status --porcelain") ;;
  "rev-parse HEAD") echo 0123456789abcdef0123456789abcdef01234567 ;;
  "rev-parse --git-common-dir") echo "${dir}/.git" ;;
  *) echo "git $*" >> "${dir}/git.log" ;;
esac
`,
  );
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
case "$*" in
  api*) echo 4242 ;;
  *status,jobs*) printf 'completed\\t2\\t0\\n' ;;
  *--jq*"failure"*) ;;
  *) cat "${dir}/jobs.tsv" ;;
esac
`,
  );
  chmodSync(join(bin, "git"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  const r = spawnSync("bash", [join(repo, "scripts", "preflight.sh")], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    timeout: 30_000,
  });
  const marked =
    spawnSync("ls", [join(dir, ".git", "preflight")], { encoding: "utf8" })
      .status === 0;
  rmSync(dir, { recursive: true, force: true });
  return { ...r, marked };
}

test("preflight passes only when the installers jobs ran and succeeded", () => {
  const ok = preflight(
    "check (macos-latest)\tsuccess\ninstallers (macos-latest, arm64)\tsuccess\ninstallers (windows-latest, x64, optional)\tfailure\n",
  );
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.ok(ok.marked);
  const noInstallers = preflight("check (macos-latest)\tsuccess\n");
  assert.equal(noInstallers.status, 1);
  assert.match(noInstallers.stderr, /no installers job/);
  assert.ok(!noInstallers.marked);
  const bad = preflight(
    "check (macos-latest)\tsuccess\ninstallers (macos-latest, arm64)\tfailure\n",
  );
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL/);
  assert.ok(!bad.marked);
});
