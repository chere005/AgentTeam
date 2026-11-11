import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import preserveMacNotices from "../scripts/preserve-mac-notices.mjs";
import { validatePackageTarget } from "../scripts/package-target.mjs";
import {
  allInstallerFiles,
  installerFiles,
  requiredResources,
  unpackedApp,
  verify,
} from "../scripts/installer-gates.mjs";

// fileURLToPath: `URL.pathname` is "/C:/..." on Windows.
const repo = fileURLToPath(new URL("..", import.meta.url));
const text = (...p: string[]) => readFileSync(join(repo, ...p), "utf8");

test("installer file names match electron-builder's artifactName", () => {
  assert.deepEqual(installerFiles("mac", "arm64", "1.2.3"), [
    "AgentTeam-1.2.3-mac-arm64.dmg",
    "AgentTeam-1.2.3-mac-arm64.zip",
  ]);
  assert.throws(() => installerFiles("mac", "x64", "1.2.3"));
  assert.deepEqual(installerFiles("windows", "x64", "1.2.3"), [
    "AgentTeam-1.2.3-win-x64.exe",
  ]);
  assert.deepEqual(installerFiles("linux", "x64", "1.2.3"), [
    "AgentTeam-1.2.3-linux-x86_64.AppImage",
    "AgentTeam-1.2.3-linux-amd64.deb",
  ]);
  assert.throws(() => installerFiles("beos", "x64", "1"));
});

test("macOS packaging rejects Intel and universal targets without blocking other platforms", () => {
  assert.throws(() => validatePackageTarget("darwin", ["--x64"]));
  assert.throws(() => validatePackageTarget("linux", ["--mac", "--universal"]));
  assert.throws(() => validatePackageTarget("darwin", ["--arch=x64"]));
  assert.throws(() => validatePackageTarget("darwin", ["--arch", "x86_64"]));
  assert.throws(() => validatePackageTarget("darwin", ["--x64=true"]));
  assert.doesNotThrow(() => validatePackageTarget("darwin", ["--arm64"]));
  assert.doesNotThrow(() =>
    validatePackageTarget("darwin", ["--win", "--x64"]),
  );
  assert.doesNotThrow(() => validatePackageTarget("linux", ["--x64"]));
  const config = JSON.parse(text("package.json"));
  assert.ok(
    config.build.mac.target.every(
      (target: { arch: string[] }) =>
        JSON.stringify(target.arch) === JSON.stringify(["arm64"]),
    ),
  );
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
  assert.deepEqual(parse(release).jobs.mac.strategy.matrix.arch, ["arm64"]);
  assert.deepEqual(
    ci.jobs.installers.strategy.matrix.include
      .filter((job: { os: string }) => job.os === "macos-latest")
      .map((job: { arch: string }) => job.arch),
    ["arm64"],
  );
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
  const arch = platform === "mac" ? "arm64" : "x64";
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
  const notices = platform === "mac" ? resources : app;
  put(join(notices, "LICENSE.electron.txt"));
  put(join(notices, "LICENSES.chromium.html"));
  const pty = join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    platform === "mac" ? "prebuilds/darwin-arm64" : "build/Release",
  );
  put(join(pty, "pty.node"));
  if (platform === "mac") {
    put(join(pty, "spawn-helper"));
    chmodSync(join(pty, "spawn-helper"), 0o755);
  }
  const files = ["/package.json", "/dist/desktop/main.js", "/dist/index.html"];
  const run = {
    asar: () => ({
      listPackage: () => files,
      extractFile: () =>
        Buffer.from(JSON.stringify({ version: opts.version ?? version })),
    }),
    cmd: (c: string, a: string[]) => {
      if (c === "lipo") return { status: 0, stdout: "arm64\n", stderr: "" };
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
  // A Windows filesystem keeps no execute bit (chmod is a no-op there), so the mac package's
  // spawn-helper check can only be exercised where the package is built: macOS (and Linux).
  const platforms =
    process.platform === "win32"
      ? (["linux"] as const)
      : (["linux", "mac"] as const);
  for (const platform of platforms) {
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

test("a Mac package must not contain Intel node-pty prebuilds", () => {
  const f = fixture("mac");
  try {
    const { resources } = unpackedApp("mac", "arm64", f.dir);
    const intel = join(
      resources,
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
      "prebuilds",
      "darwin-x64",
    );
    mkdirSync(intel, { recursive: true });
    writeFileSync(join(intel, "pty.node"), "fixture");
    const result = verify({
      platform: "mac",
      arch: f.arch,
      version: f.version,
      dir: f.dir,
      run: f.run,
    });
    assert.ok(
      result.failures.some((failure: string) => /Intel node-pty/.test(failure)),
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("the mac packaging hook preserves the extracted Electron and Chromium notices inside the app", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gates-notices-"));
  try {
    const resources = join(dir, "Electron.app", "Contents", "Resources");
    mkdirSync(resources, { recursive: true });
    writeFileSync(join(dir, "LICENSE"), "Electron distribution notice");
    writeFileSync(
      join(dir, "LICENSES.chromium.html"),
      "Chromium distribution notice",
    );
    await preserveMacNotices({
      appOutDir: dir,
      electronPlatformName: "darwin",
    });
    rmSync(join(dir, "LICENSE"));
    rmSync(join(dir, "LICENSES.chromium.html"));
    assert.equal(
      readFileSync(join(resources, "LICENSE.electron.txt"), "utf8"),
      "Electron distribution notice",
    );
    assert.equal(
      readFileSync(join(resources, "LICENSES.chromium.html"), "utf8"),
      "Chromium distribution notice",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
          ? { status: 0, stdout: "x86_64\n", stderr: "" }
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

// The bash that runs scripts/preflight.sh. On Windows it is Git for Windows' bin/bash.exe, which is rarely on PATH
// (and a bare "bash" there can be WSL's, which cannot read Windows paths); found from `git --exec-path`
// (<git>/mingw64/libexec/git-core), a read-only query. That launcher puts Git's own folders (and the real git) first
// on PATH, so preflight() puts the stubs back in front inside the shell.
function findBash(): string | undefined {
  if (process.platform !== "win32") return "bash";
  const exec = spawnSync("git", ["--exec-path"], { encoding: "utf8" });
  if (exec.status !== 0) return undefined;
  const bash = join(
    dirname(dirname(dirname(exec.stdout.trim()))),
    "bin",
    "bash.exe",
  );
  return existsSync(bash) ? bash : undefined;
}
const bash = findBash();

// scripts/preflight.sh with git and gh stubbed: nothing is pushed, no network.
function preflight(jobs: string) {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "preflight.sh"), text("scripts", "preflight.sh"));
  writeFileSync(join(dir, "jobs.tsv"), jobs);
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
case "$1 $2" in
  "rev-parse --abbrev-ref") echo work ;;
  "status --porcelain") ;;
  "rev-parse HEAD") echo 0123456789abcdef0123456789abcdef01234567 ;;
  "rev-parse --git-common-dir") echo .git ;;
  *) echo "git $*" >> git.log ;;
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
  *) cat jobs.tsv ;;
esac
`,
  );
  // Git Bash on Windows can prepend its own binaries at startup. Use shell
  // functions in the same Bash process so neither command depends on PATH order.
  const r = spawnSync(
    bash!,
    [
      "-c",
      `git() { bash ./bin/git "$@"; }
gh() { bash ./bin/gh "$@"; }
source ./preflight.sh`,
    ],
    { cwd: dir, encoding: "utf8", timeout: 30_000 },
  );
  const marked = existsSync(join(dir, ".git", "preflight"));
  rmSync(dir, { recursive: true, force: true });
  return { ...r, marked };
}

test(
  "preflight passes only when the installers jobs ran and succeeded",
  {
    skip: bash ? false : "no Git Bash found (git --exec-path)",
  },
  () => {
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
  },
);
