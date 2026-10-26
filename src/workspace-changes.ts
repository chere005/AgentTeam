import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { decideBoth, normalizeRelPath, traversable } from "./access.ts";
import type { Agent } from "./model.ts";
import type { Store } from "./store.ts";
import { contains } from "./resources.ts";
import { canonicalPolicyPath, filesystemPolicy } from "./filesystem-policy.ts";

const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 256_000;
const MAX_TOTAL_BYTES = 12_000_000;
const MAX_DIFF_BYTES = 600_000;
const MAX_ENTRIES = 20_000;

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
  /** Older scanners silently stopped mid-tree and did not record incomplete coverage. */
  scanVersion?: 1;
  accessFingerprint?: string;
};
const baselineId = (agentId: string, root: string) => `${agentId}::${root}`;
const accessFingerprint = (agent: Agent) =>
  createHash("sha256").update(JSON.stringify(agent.workspaces)).digest("hex");

type Snapshot = {
  files: Baseline["files"];
  truncated: boolean;
  /** Only exact, currently allowed paths confirmed absent; omitted scan entries are not deletions. */
  missing: Set<string>;
};

async function snapshot(
  store: Store,
  agent: Agent,
  root: string,
  knownPaths: string[] = [],
): Promise<Snapshot> {
  filesystemPolicy(store).assertPath(root);
  const files: Baseline["files"] = {};
  const missing = new Set<string>();
  let truncated = false;
  let count = 0;
  let storedBytes = 0;
  const allowed = (absolute: string, directory = false) => {
    try {
      normalizeRelPath(relative(root, absolute), directory);
      const canonical = canonicalPolicyPath(absolute);
      if (!contains(root, canonical)) return false;
      normalizeRelPath(relative(root, canonical), directory);
      const attachment = (path: string) =>
        agent.workspaces
          .filter((candidate) => contains(candidate.path, path))
          .sort((a, b) => b.path.length - a.path.length)[0];
      const lexical = attachment(absolute);
      const real = attachment(canonical);
      if (!lexical || !real) return false;
      return [lexical, real].every((ws) => {
        const lexicalRel = relative(ws.path, absolute).split(sep).join("/");
        const realRel = relative(ws.path, canonical).split(sep).join("/");
        return (
          decideBoth(ws, lexicalRel, realRel).access !== "none" ||
          (directory && traversable(ws, lexicalRel))
        );
      });
    } catch {
      return false;
    }
  };
  const capture = async (absolute: string, rel: string) => {
    if (!allowed(absolute)) return;
    try {
      const info = await lstat(absolute);
      if (info.isSymbolicLink() || !info.isFile()) return;
      const digest = createHash("sha256");
      let size = 0;
      let binary = false;
      let chunks: Buffer[] | null =
        info.size <= MAX_FILE_BYTES &&
        storedBytes + info.size <= MAX_TOTAL_BYTES
          ? []
          : null;
      for await (const value of createReadStream(absolute)) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        digest.update(bytes);
        size += bytes.length;
        binary ||= bytes.includes(0);
        if (
          binary ||
          size > MAX_FILE_BYTES ||
          storedBytes + size > MAX_TOTAL_BYTES
        )
          chunks = null;
        chunks?.push(bytes);
      }
      let content: string | null = null;
      if (chunks) {
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          );
          storedBytes += size;
        } catch {
          // Keep the hash so binary or non-UTF-8 changes remain visible in the file list.
          binary = true;
        }
      }
      files[rel] = { hash: digest.digest("hex"), content, binary, size };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing.add(rel);
      else truncated = true;
    }
  };
  // Inspect sibling files before descending: one large repository must not hide duty files
  // beside it. The queue also keeps shallow folders ahead of deep generated trees.
  const directories = [{ path: root, depth: 0 }];
  let entriesSeen = 0;
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index];
    if (
      directory.depth > 12 ||
      count >= MAX_FILES ||
      entriesSeen >= MAX_ENTRIES
    ) {
      truncated = true;
      continue;
    }
    if (!allowed(directory.path, true)) continue;
    let entries;
    try {
      entries = await readdir(directory.path, { withFileTypes: true });
    } catch {
      truncated = true;
      continue;
    }
    entries.sort(
      (a, b) =>
        Number(a.isDirectory()) - Number(b.isDirectory()) ||
        a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if ([".git", "node_modules"].includes(entry.name.toLowerCase())) continue;
      if (count >= MAX_FILES || entriesSeen++ >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const absolute = resolve(directory.path, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (allowed(absolute, true))
          directories.push({ path: absolute, depth: directory.depth + 1 });
      } else if (entry.isFile() && allowed(absolute)) {
        count++;
        await capture(absolute, rel);
      }
    }
  }
  // A different set of 2,000 paths may be visited after files are added. Probe the saved paths
  // individually so a budget omission cannot invent a deletion or hide a known modification.
  for (const path of knownPaths.slice(0, MAX_FILES + 1)) {
    if (files[path]) continue;
    try {
      const rel = normalizeRelPath(path);
      await capture(resolve(root, rel), rel);
    } catch {
      // A stored or selected path never widens the current attachment or denial policy.
    }
  }
  return { files, truncated, missing };
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
  const captured = await snapshot(store, agent, root);
  const baseline: Baseline = {
    id,
    agentId: agent.id,
    workspace: root,
    capturedAt: new Date().toISOString(),
    files: captured.files,
    truncated: captured.truncated,
    scanVersion: 1,
    accessFingerprint: accessFingerprint(agent),
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
  const captured = await snapshot(store, agent, root, [
    ...(selectedPath ? [selectedPath] : []),
    ...Object.keys(baseline.files),
  ]);
  const current = captured.files;
  const baselineIncomplete =
    baseline.scanVersion !== 1 ||
    baseline.truncated ||
    baseline.accessFingerprint !== accessFingerprint(agent);
  const paths = [
    ...new Set([...Object.keys(baseline.files), ...Object.keys(current)]),
  ].sort();
  const files = paths.flatMap((path) => {
    const before = baseline.files[path];
    const after = current[path];
    if (before?.hash === after?.hash) return [];
    // Omitted, denied and unreadable paths are not proof that a saved file was deleted.
    if (!after && !captured.missing.has(path)) return [];
    const unknown = !before && !!after && baselineIncomplete;
    return [
      {
        path,
        status: unknown ? "??" : before ? (after ? "M " : "D ") : "A ",
        before,
        after,
        unknown,
      },
    ];
  });
  const selected = selectedPath
    ? files.find((file) => file.path === selectedPath)
    : undefined;
  let diff = "";
  let unreadable: string | undefined;
  let binary = false;
  let comparisonNote: string | undefined;
  let currentContent: string | undefined;
  if (selected) {
    const oldFile = selected.before;
    const newFile = selected.after;
    binary = !!(oldFile?.binary || newFile?.binary);
    if (selected.unknown) {
      comparisonNote =
        "This file was not captured in the saved folder baseline. Its earlier contents are unavailable, so these are current contents rather than a verified change.";
      if (newFile?.content !== null && newFile?.content !== undefined)
        currentContent = newFile.content;
      else
        unreadable = binary
          ? "Binary or non-UTF-8 file; current contents cannot be shown as text."
          : `Files over ${MAX_FILE_BYTES / 1000} KB or the snapshot text budget are listed but not expanded.`;
    } else if (binary)
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
    filesTruncated: captured.truncated,
    scanIncomplete: captured.truncated,
    baselineIncomplete,
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
    meta:
      selected && !selected.unknown
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
    ...(comparisonNote ? { comparisonNote } : {}),
    ...(currentContent !== undefined ? { currentContent } : {}),
    baselineAt: baseline.capturedAt,
  };
}

export async function resetWorkspaceBaseline(
  store: Store,
  agent: Agent,
  root: string,
) {
  const id = baselineId(agent.id, root);
  const captured = await snapshot(store, agent, root);
  const baseline: Baseline = {
    id,
    agentId: agent.id,
    workspace: root,
    capturedAt: new Date().toISOString(),
    files: captured.files,
    truncated: captured.truncated,
    scanVersion: 1,
    accessFingerprint: accessFingerprint(agent),
  };
  store.put("workspace-baseline", baseline);
  store.emit("workspace.baseline_reset", agent.id, { workspace: root });
  return { status: "ok", capturedAt: baseline.capturedAt };
}
