// Installer gates: the one script behind both the release (release.yml) and the preflight (ci.yml on preflight/**).
// It packages the app for this platform (scripts/package.mjs) and then inspects what came out, so a release cannot fail
// after the tag on something a preflight could have seen. Nothing is uploaded or published here.
//
//   node scripts/installer-gates.mjs --arm64|--x64 [--smoke] [--verify-only]   build, package, then verify release/
//   node scripts/installer-gates.mjs --files <platform> <arch> <version>      print the installer files a job uploads
//   node scripts/installer-gates.mjs --all-files <version>                    print every file a release needs
//
// Gates: the expected installer files exist and are not stubs; the unpacked app carries the right version, an asar with the
// compiled app, the license notices (ours, Electron's, Chromium's), node-pty's native files for the target and its
// spawn-helper (macOS); macOS: Info.plist version, executable architecture, codesign verification (required when signing
// credentials are set), the zip holds the app; --smoke launches the packaged app (test mode, temp profile) and waits for the
// workspace to render.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** The installer files one job uploads, in the names electron-builder gives them (artifactName in package.json). */
export function installerFiles(platform, arch, version) {
  const base = `AgentTeam-${version}-`;
  if (platform === "mac" && arch !== "arm64")
    throw new Error("macOS builds support Apple Silicon only");
  if (platform === "mac")
    return [`${base}mac-${arch}.dmg`, `${base}mac-${arch}.zip`];
  if (platform === "windows") return [`${base}win-x64.exe`];
  if (platform === "linux")
    return [`${base}linux-x86_64.AppImage`, `${base}linux-amd64.deb`];
  throw new Error(`unknown platform ${platform}`);
}
/** Everything a release must have on the draft before it is published. */
export function allInstallerFiles(version) {
  return [
    ...installerFiles("mac", "arm64", version),
    ...installerFiles("windows", "x64", version),
    ...installerFiles("linux", "x64", version),
  ];
}
/** The unpacked application electron-builder leaves next to the installers, and where its resources are. */
export function unpackedApp(platform, arch, dir = "release") {
  if (platform === "mac") {
    if (arch !== "arm64")
      throw new Error("macOS builds support Apple Silicon only");
    const folder = "mac-arm64";
    return {
      app: join(dir, folder, "AgentTeam.app"),
      resources: join(dir, folder, "AgentTeam.app", "Contents", "Resources"),
    };
  }
  const folder = platform === "windows" ? "win-unpacked" : "linux-unpacked";
  return { app: join(dir, folder), resources: join(dir, folder, "resources") };
}
/** Files the unpacked resources must contain (relative to the resources folder). */
export const requiredResources = [
  "app.asar",
  "assets/licenses/ACP-SDK-LICENSE.txt",
  "assets/licenses/EDITOR-LICENSES.txt",
  "assets/licenses/TERMINAL-LICENSES.txt",
  "assets/recommended-skills.json",
  "assets/skills",
  "assets/team-templates",
];
/** Run every check and return the list of failures (empty = pass). Pure of side effects except reading files / small probes. */
export function verify({
  platform,
  arch,
  version,
  dir = join(root, "release"),
  signingRequired = false,
  run = defaultRun,
}) {
  const failures = [];
  const fail = (m) => failures.push(m);
  const ok = [];
  for (const f of installerFiles(platform, arch, version)) {
    const p = join(dir, f);
    if (!existsSync(p)) fail(`missing installer ${f}`);
    else if (statSync(p).size < 5_000_000)
      fail(`installer ${f} is only ${statSync(p).size} bytes`);
    else ok.push(`${f} ${statSync(p).size} bytes`);
  }
  const { app, resources } = unpackedApp(platform, arch, dir);
  if (!existsSync(app)) {
    fail(`unpacked app missing: ${app}`);
    return { failures, ok };
  }
  for (const rel of requiredResources)
    if (!existsSync(join(resources, rel))) fail(`resources lack ${rel}`);
  const notices = platform === "mac" ? resources : app;
  if (!existsSync(join(notices, "LICENSES.chromium.html")))
    fail("Chromium notice LICENSES.chromium.html not in the package");
  if (
    !["LICENSE", "LICENSE.electron.txt"].some((n) =>
      existsSync(join(notices, n)),
    )
  )
    fail("Electron LICENSE not in the package");
  // asar: the compiled app and the right version.
  const asarPath = join(resources, "app.asar");
  if (existsSync(asarPath)) {
    try {
      const asar = run.asar();
      const files = asar
        .listPackage(asarPath, { isPack: false })
        .map((f) => f.replace(/\\/g, "/"));
      for (const need of ["/package.json", "/dist/desktop/main.js"])
        if (!files.includes(need)) fail(`app.asar lacks ${need}`);
      const inner = JSON.parse(
        asar.extractFile(asarPath, "package.json").toString("utf8"),
      );
      if (inner.version !== version)
        fail(
          `app.asar package.json says ${inner.version}, expected ${version}`,
        );
      if (!files.some((f) => f.startsWith("/dist/")))
        fail("app.asar has no dist/");
    } catch (error) {
      fail(`app.asar unreadable: ${error.message}`);
    }
  }
  const pty = join(resources, "app.asar.unpacked", "node_modules", "node-pty");
  if (!existsSync(pty))
    fail("node-pty is not unpacked next to the asar (asarUnpack)");
  else {
    const nodePlatform = { mac: "darwin", windows: "win32", linux: "linux" }[
      platform
    ];
    const prebuild = `prebuilds/${nodePlatform}-${arch}`;
    // node-pty currently compiles from source on Linux. Prefer its normal load order there.
    const locations =
      platform === "linux" ? ["build/Release", prebuild] : [prebuild];
    if (
      !locations.some((location) => existsSync(join(pty, location, "pty.node")))
    )
      fail(`node-pty lacks pty.node in ${locations.join(" or ")}`);
    if (platform === "mac") {
      if (existsSync(join(pty, "prebuilds", "darwin-x64")))
        fail("Mac package contains Intel node-pty prebuilds");
      const helper = join(pty, prebuild, "spawn-helper");
      if (!existsSync(helper)) fail("node-pty spawn-helper missing");
      else if ((statSync(helper).mode & 0o111) === 0)
        fail("node-pty spawn-helper is not executable");
    }
  }
  if (platform === "mac") {
    const plist = run.cmd("/usr/libexec/PlistBuddy", [
      "-c",
      "Print :CFBundleShortVersionString",
      join(app, "Contents", "Info.plist"),
    ]);
    if (plist.status !== 0 || plist.stdout.trim() !== version)
      fail(
        `Info.plist version is "${plist.stdout.trim()}", expected ${version}`,
      );
    const archs = run.cmd("lipo", [
      "-archs",
      join(app, "Contents", "MacOS", "AgentTeam"),
    ]);
    const want = "arm64";
    if (
      archs.status !== 0 ||
      archs.stdout.trim().split(/\s+/).join(" ") !== want
    )
      fail(
        `executable architecture is "${archs.stdout.trim()}", expected ${want}`,
      );
    const sign = run.cmd("codesign", ["--verify", "--deep", "--strict", app]);
    if (sign.status !== 0) {
      if (signingRequired)
        fail(
          `codesign --verify failed with signing credentials set: ${sign.stderr.trim()}`,
        );
      else
        ok.push(
          "unsigned build (no signing credentials): codesign verification skipped",
        );
    } else ok.push("codesign --verify --deep --strict passed");
    const zip = join(dir, installerFiles("mac", arch, version)[1]);
    if (existsSync(zip)) {
      const list = run.cmd("unzip", ["-Z1", zip]);
      if (
        list.status !== 0 ||
        !list.stdout
          .split("\n")
          .some((l) => /^AgentTeam\.app\/Contents\/Info\.plist$/.test(l))
      )
        fail("the zip does not contain AgentTeam.app");
    }
  }
  return { failures, ok };
}

const defaultRun = {
  cmd: (c, a) => {
    const r = spawnSync(c, a, { encoding: "utf8" });
    return {
      status: r.status ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? r.error?.message ?? "",
    };
  },
  asar: () => asarModule,
};
let asarModule;

/** Launch the packaged app in test mode with a temp profile and wait for the workspace to render. */
async function smoke({ platform, arch, dir }) {
  const { _electron: electron } = await import("@playwright/test");
  const { app } = unpackedApp(platform, arch, dir);
  const executablePath =
    platform === "mac"
      ? join(app, "Contents", "MacOS", "AgentTeam")
      : join(app, platform === "windows" ? "AgentTeam.exe" : "agentteam");
  const exe = existsSync(executablePath)
    ? executablePath
    : join(
        app,
        readdirSync(app).find((n) => /^agent-?team$/i.test(n)) ?? "AgentTeam",
      );
  const data = mkdtempSync(join(tmpdir(), "agentteam-smoke-"));
  let launched;
  try {
    launched = await electron.launch({
      executablePath: exe,
      args: process.platform === "linux" ? ["--no-sandbox"] : [],
      env: { ...process.env, AGENTTEAM_DATA_DIR: data, AGENTTEAM_TEST: "1" },
      timeout: 60_000,
    });
    const packaged = await launched.evaluate(({ app }) => app.isPackaged);
    if (!packaged)
      throw new Error("the launched app is not the packaged build");
    const page = await launched.firstWindow();
    await page.getByTestId("workspace-ready").waitFor({ timeout: 60_000 });
  } finally {
    await launched?.close().catch(() => {});
    rmSync(data, { recursive: true, force: true });
  }
}

async function main(argv) {
  if (argv[0] === "--files") {
    console.log(installerFiles(argv[1], argv[2], argv[3]).join(" "));
    return 0;
  }
  if (argv[0] === "--all-files") {
    console.log(allInstallerFiles(argv[1]).join("\n"));
    return 0;
  }
  const arch = argv.includes("--arm64")
    ? "arm64"
    : argv.includes("--x64")
      ? "x64"
      : process.arch === "arm64"
        ? "arm64"
        : "x64";
  const platform = { darwin: "mac", win32: "windows", linux: "linux" }[
    process.platform
  ];
  if (!platform) throw new Error(`unsupported platform ${process.platform}`);
  if (platform === "mac" && arch !== "arm64")
    throw new Error("macOS builds support Apple Silicon only");
  const version = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ).version;
  const dir = join(root, "release");
  const step = (name) => console.log(`\n== installer gate: ${name}`);
  if (!argv.includes("--verify-only")) {
    step("build (vite + desktop bundle)");
    const compiled = spawnSync("npm", ["run", "build"], {
      stdio: "inherit",
      cwd: root,
      shell: process.platform === "win32",
    });
    if (compiled.status !== 0) {
      console.error("installer gates: FAIL: the build failed");
      return 1;
    }
    step(`package ${platform} ${arch}`);
    const built = spawnSync(
      process.execPath,
      [join(root, "scripts", "package.mjs"), `--${arch}`],
      { stdio: "inherit", cwd: root },
    );
    if (built.status !== 0) {
      console.error("installer gates: FAIL: packaging failed");
      return 1;
    }
  }
  asarModule = (await import("@electron/asar")).default;
  step("inspect the package");
  const signingRequired =
    platform === "mac" &&
    !!(process.env.CSC_LINK?.trim() || process.env.CSC_NAME?.trim());
  const { failures, ok } = verify({
    platform,
    arch,
    version,
    dir,
    signingRequired,
  });
  for (const line of ok) console.log(`  ok: ${line}`);
  let smokeFailure = "";
  if (argv.includes("--smoke")) {
    if (
      platform === "mac" &&
      arch !== (process.arch === "arm64" ? "arm64" : "x64")
    )
      console.log(
        "  smoke launch skipped: the package is for another architecture than this machine",
      );
    else {
      step("smoke launch of the packaged app");
      try {
        await smoke({ platform, arch, dir });
        console.log(
          "  ok: the packaged app started and rendered the workspace",
        );
      } catch (error) {
        smokeFailure = `smoke launch failed: ${error.message}`;
      }
    }
  }
  if (smokeFailure) failures.push(smokeFailure);
  if (failures.length) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`installer gates: FAIL (${failures.length})`);
    return 1;
  }
  console.log("installer gates: PASS");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
