import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Git expects core.hooksPath to be a directory. Null-device paths are not directories on
// Windows, so use an empty per-process directory to disable hooks portably.
export const NO_GIT_HOOKS_DIR = mkdtempSync(
  join(tmpdir(), "agentteam-no-git-hooks-"),
);
process.once("exit", () =>
  rmSync(NO_GIT_HOOKS_DIR, { recursive: true, force: true }),
);

/** Git options applied to every operation on an attached repository. */
export const SAFE_GIT_CONFIG = [
  "-c",
  "protocol.ext.allow=never",
  "-c",
  `core.hooksPath=${NO_GIT_HOOKS_DIR}`,
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.askPass=",
  "-c",
  "credential.interactive=never",
];

async function configuredHelpers(cwd: string, scope: "system" | "global") {
  try {
    const { stdout } = await exec(
      "git",
      [
        "-C",
        cwd,
        "config",
        `--${scope}`,
        "--null",
        "--get-all",
        "credential.helper",
      ],
      {
        encoding: "utf8",
        maxBuffer: 256_000,
        timeout: 10_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    const helpers = stdout.split("\0");
    if (helpers.at(-1) === "") helpers.pop();
    return helpers;
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === 1 || code === 128) return [];
    throw error;
  }
}

/**
 * Repo-local filter drivers are executable programs. Discover their keys without performing a
 * worktree operation, then override each driver command on the actual Git invocation.
 */
export async function repoFilterConfig(cwd: string) {
  try {
    const { stdout } = await exec(
      "git",
      [
        "-C",
        cwd,
        "config",
        "--local",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\..*\\.(clean|smudge|process)$",
      ],
      {
        encoding: "utf8",
        maxBuffer: 256_000,
        timeout: 10_000,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    return stdout
      .split("\0")
      .filter((key) => /^filter\..+\.(clean|smudge|process)$/i.test(key))
      .flatMap((key) => ["-c", `${key}=`]);
  } catch (error) {
    // Git config exits 1 when a repository has no filter keys (and may exit 128 for a plain
    // folder that is about to be initialized). The subsequent Git operation reports real errors.
    const code = (error as { code?: string | number }).code;
    if (code === 1 || code === 128) return [];
    throw error;
  }
}

/** Ignore repo-configured credential helpers while retaining machine/user helpers. */
export async function attachedRepoGitConfig(cwd: string) {
  const [systemHelpers, globalHelpers, filterConfig] = await Promise.all([
    configuredHelpers(cwd, "system"),
    configuredHelpers(cwd, "global"),
    repoFilterConfig(cwd),
  ]);
  const helpers = [...systemHelpers, ...globalHelpers];
  return [
    "-c",
    "credential.helper=",
    ...helpers.flatMap((helper) => ["-c", `credential.helper=${helper}`]),
    ...filterConfig,
  ];
}
