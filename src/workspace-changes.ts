import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { decideBoth, traversable } from "./access.ts";
import type { Agent, Workspace } from "./model.ts";
import type { Store } from "./store.ts";

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 256_000;
const MAX_TOTAL_BYTES = 12_000_000;
const MAX_DIFF_BYTES = 600_000;

type SavedFile = {
  hash: string;
  content: string | null;
  binary: boolean;
  size: number;
};
type Baseline = {
  id: string;
  agentId: string;
  workspace: string;
  capturedAt: string;
  files: Record<string, SavedFile>;
  truncated: boolean;
};
const baselineId = (agentId: string, root: string) => `${agentId}::${root}`;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

async function snapshot(
  agent: Agent,
  root: string,
): Promise<Baseline["files"]> {
  const ws = agent.workspaces.find((candidate) => candidate.path === root);
  if (!ws) return {};
  const files: Baseline["files"] = {};
  let count = 0;
  let storedBytes = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > 12 || count >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        count >= MAX_FILES ||
        entry.name === ".git" ||
        entry.name === "node_modules"
      )
        continue;
      const absolute = resolve(directory, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      let info;
      try {
        info = await lstat(absolute);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        const decision = decideBoth(ws, rel, rel).access;
        if (decision !== "none" || traversable(ws, rel))
          await walk(absolute, depth + 1);
        continue;
      }
      if (!info.isFile() || decideBoth(ws, rel, rel).access === "none")
        continue;
      count++;
      let bytes: Buffer;
      try {
        bytes = await readFile(absolute);
      } catch {
        continue;
      }
      const binary = bytes.includes(0);
      let content: string | null = null;
      if (
        !binary &&
        bytes.length <= MAX_FILE_BYTES &&
        storedBytes + bytes.length <= MAX_TOTAL_BYTES
      ) {
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          storedBytes += bytes.length;
        } catch {
          // Keep the hash so binary or non-UTF-8 changes remain visible in the file list.
        }
      }
      files[rel] = { hash: hash(bytes), content, binary, size: bytes.length };
    }
  };
  await walk(root, 0);
  return files;
}

export async function ensureWorkspaceBaseline(
  store: Store,
  agent: Agent,
  root: string,
): Promise<void> {
  const id = baselineId(agent.id, root);
  try {
    store.get<Baseline>("workspace-baseline", id);
    return;
  } catch {
    // First attachment or first run: capture the existing files as the clean review point.
  }
  const canonical = await realpath(root);
  if (canonical !== root) return;
  const baseline: Baseline = {
    id,
    agentId: agent.id,
    workspace: root,
    capturedAt: new Date().toISOString(),
    files: await snapshot(agent, root),
    truncated: false,
  };
  store.put("workspace-baseline", baseline);
}

function unified(path: string, oldText: string, newText: string) {
  const oldLines =
    oldText === "" ? [] : oldText.replace(/\r\n/g, "\n").split("\n");
  const newLines =
    newText === "" ? [] : newText.replace(/\r\n/g, "\n").split("\n");
  if (oldText.endsWith("\n")) oldLines.pop();
  if (newText.endsWith("\n")) newLines.pop();
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  )
    suffix++;
  const beforeStart = Math.max(0, prefix - 3);
  const afterEnd = suffix
    ? Math.max(prefix, oldLines.length - suffix + 3)
    : oldLines.length;
  const oldBody = oldLines.slice(beforeStart, afterEnd);
  const newEnd = suffix
    ? Math.max(prefix, newLines.length - suffix + 3)
    : newLines.length;
  const newBody = newLines.slice(beforeStart, newEnd);
  const oldStart = oldBody.length ? beforeStart + 1 : 0;
  const newStart = newBody.length ? beforeStart + 1 : 0;
  const lines = [
    `diff --agentteam a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${oldStart},${oldBody.length} +${newStart},${newBody.length} @@`,
    ...oldBody.slice(0, prefix - beforeStart).map((line) => ` ${line}`),
    ...oldLines
      .slice(prefix, oldLines.length - suffix)
      .map((line) => `-${line}`),
    ...newLines
      .slice(prefix, newLines.length - suffix)
      .map((line) => `+${line}`),
    ...(suffix
      ? oldLines.slice(oldLines.length - suffix).map((line) => ` ${line}`)
      : []),
  ];
  return lines.join("\n").slice(0, MAX_DIFF_BYTES);
}

export async function workspaceChanges(
  store: Store,
  agent: Agent,
  root: string,
  selectedPath?: string,
) {
  await ensureWorkspaceBaseline(store, agent, root);
  const baseline = store.get<Baseline>(
    "workspace-baseline",
    baselineId(agent.id, root),
  );
  const current = await snapshot(agent, root);
  const paths = [
    ...new Set([...Object.keys(baseline.files), ...Object.keys(current)]),
  ].sort();
  const files = paths.flatMap((path) => {
    const before = baseline.files[path];
    const after = current[path];
    if (before?.hash === after?.hash) return [];
    return [
      { path, status: before ? (after ? "M " : "D ") : "A ", before, after },
    ];
  });
  const selected = selectedPath
    ? files.find((file) => file.path === selectedPath)
    : undefined;
  let diff = "";
  let unreadable: string | undefined;
  let binary = false;
  if (selected) {
    const oldFile = selected.before;
    const newFile = selected.after;
    binary = !!(oldFile?.binary || newFile?.binary);
    if (binary)
      unreadable =
        "Binary or non-UTF-8 file; its change is listed but cannot be shown as text.";
    else if (
      (oldFile && oldFile.content === null) ||
      (newFile && newFile.content === null)
    )
      unreadable = `Files over ${MAX_FILE_BYTES / 1000} KB are listed but not expanded in the diff.`;
    else
      diff = unified(
        selected.path,
        oldFile?.content ?? "",
        newFile?.content ?? "",
      );
  }
  return {
    source: "folder" as const,
    repository: null,
    branch: "Folder baseline",
    files: files.map(({ path, status }) => ({ path, status })),
    filesTruncated: paths.length >= MAX_FILES,
    compare: null,
    attribution: {
      kind: "shared" as const,
      linked: false,
      others: [],
      note: "Compared with the saved folder baseline. Changes may come from an agent, you, or another editor.",
    },
    staged: false,
    diff,
    diffHash: createHash("sha256").update(diff).digest("hex"),
    meta: selected
      ? {
          kind: selected.before
            ? selected.after
              ? "modified"
              : "deleted"
            : "added",
          binary,
          submodule: false,
          noHunks: !diff,
        }
      : null,
    binary,
    truncated: false,
    ...(unreadable ? { unreadable } : {}),
    baselineAt: baseline.capturedAt,
  };
}

export async function resetWorkspaceBaseline(
  store: Store,
  agent: Agent,
  root: string,
) {
  const id = baselineId(agent.id, root);
  const baseline: Baseline = {
    id,
    agentId: agent.id,
    workspace: root,
    capturedAt: new Date().toISOString(),
    files: await snapshot(agent, root),
    truncated: false,
  };
  store.put("workspace-baseline", baseline);
  store.emit("workspace.baseline_reset", agent.id, { workspace: root });
  return { status: "ok", capturedAt: baseline.capturedAt };
}
