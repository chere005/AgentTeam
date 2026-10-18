import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveDiagnosticBundle,
  validateChosenPath,
  type SaveDeps,
  type SaveRecord,
} from "../src/diagnostic-save.ts";
import type { Bundle } from "../src/diagnostics.ts";

const redaction = {
  literalsRemoved: 1,
  patternsRemoved: 0,
  keysRemoved: 0,
  truncated: 0,
  secretEnvNames: [],
};
const bundle = (format: "zip" | "json", filename?: string): Bundle => ({
  filename: filename ?? `agentteam-diagnostics-x.${format}`,
  contentType: format === "zip" ? "application/zip" : "application/json",
  encoding: format === "zip" ? "base64" : "utf8",
  data:
    format === "zip"
      ? Buffer.from("PK\u0003\u0004fake zip bytes").toString("base64")
      : '{"kind":"agentteam-diagnostic-bundle"}',
  bytes: 10,
  files: ["manifest.json"],
  redaction,
});
async function setup(t: any) {
  const dir = await mkdtemp(join(tmpdir(), "agentteam-save-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dialogs: any[] = [];
  const records: SaveRecord[] = [];
  let pick: { canceled: boolean; filePath?: string } = { canceled: true };
  const deps = (over: Partial<SaveDeps> = {}): SaveDeps => ({
    fetchBundle: async (f) => bundle(f),
    showSaveDialog: async (o) => {
      dialogs.push(o);
      return pick;
    },
    defaultDirectory: dir,
    record: (r) => void records.push(r),
    ...over,
  });
  return {
    dir,
    dialogs,
    records,
    deps,
    choose: (p: typeof pick) => void (pick = p),
  };
}

test("test mode records the save and never opens a dialog or writes a file", async (t) => {
  const s = await setup(t);
  const r = await saveDiagnosticBundle(
    { format: "zip" },
    s.deps({ testMode: true }),
  );
  assert.equal(r.saved, true);
  assert.equal(s.dialogs.length, 0);
  assert.equal(s.records.length, 1);
  assert.equal(s.records[0].kind, "save-as");
  assert.match(s.records[0].filename, /\.zip$/);
  assert.match(s.records[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await readdir(s.dir), []);
});

test("the chosen file is the only thing written; only its base name goes back to the renderer", async (t) => {
  const s = await setup(t);
  s.choose({ canceled: false, filePath: join(s.dir, "mine.zip") });
  const r = await saveDiagnosticBundle({ format: "zip" }, s.deps());
  assert.equal(r.saved, true);
  assert.equal((r as any).filename, "mine.zip");
  assert.equal(
    JSON.stringify(r).includes(s.dir),
    false,
    "no directory is returned",
  );
  assert.deepEqual(await readdir(s.dir), ["mine.zip"]);
  assert.equal(
    (await readFile(join(s.dir, "mine.zip"))).subarray(0, 2).toString(),
    "PK",
  );
  assert.match(s.dialogs[0].defaultPath, /agentteam-diagnostics-x\.zip$/);
  assert.deepEqual(s.dialogs[0].filters, [
    { name: "Zip archive", extensions: ["zip"] },
  ]);
  // JSON: a missing extension is added.
  s.choose({ canceled: false, filePath: join(s.dir, "plain") });
  const j = await saveDiagnosticBundle({ format: "json" }, s.deps());
  assert.equal((j as any).filename, "plain.json");
  assert.equal(
    JSON.parse(await readFile(join(s.dir, "plain.json"), "utf8")).kind,
    "agentteam-diagnostic-bundle",
  );
});

test("cancel writes nothing; invalid formats and unsafe choices are refused", async (t) => {
  const s = await setup(t);
  const r = await saveDiagnosticBundle({ format: "zip" }, s.deps());
  assert.deepEqual(r, { saved: false, canceled: true });
  assert.deepEqual(await readdir(s.dir), []);
  await assert.rejects(
    saveDiagnosticBundle({ format: "exe" }, s.deps()),
    (e: any) => e.name === "ZodError",
  );
  await assert.rejects(
    saveDiagnosticBundle({ format: "zip", path: "/etc/passwd" }, s.deps()),
    (e: any) => e.name === "ZodError",
    "the renderer cannot pass a path or content",
  );
  // A compromised backend response cannot smuggle a path through the file name.
  await assert.rejects(
    saveDiagnosticBundle(
      { format: "zip" },
      s.deps({ fetchBundle: async () => bundle("zip", "../evil.zip") }),
    ),
    (e: any) => e.code === "invalid_bundle",
  );
  await assert.rejects(
    saveDiagnosticBundle(
      { format: "zip" },
      s.deps({ fetchBundle: async () => bundle("zip", "x.exe") }),
    ),
    (e: any) => e.code === "invalid_bundle",
  );
});

test("chosen paths must be absolute regular files with the bundle's extension", async (t) => {
  const s = await setup(t);
  const code = (c: string) => (e: any) => e.code === c;
  await assert.rejects(
    validateChosenPath("relative.zip", "zip"),
    code("invalid_path"),
  );
  await assert.rejects(validateChosenPath("", "zip"), code("invalid_path"));
  await assert.rejects(
    validateChosenPath(undefined, "zip"),
    code("invalid_path"),
  );
  await assert.rejects(
    validateChosenPath(join(s.dir, "a\0b.zip"), "zip"),
    code("invalid_path"),
  );
  await assert.rejects(
    validateChosenPath(join(s.dir, "x.sh"), "zip"),
    code("invalid_extension"),
  );
  await assert.rejects(
    validateChosenPath(join(s.dir, "x.json"), "zip"),
    code("invalid_extension"),
  );
  await assert.rejects(
    validateChosenPath(join(s.dir, "missing", "x.zip"), "zip"),
    code("invalid_path"),
  );
  await mkdir(join(s.dir, "folder.zip"));
  await assert.rejects(
    validateChosenPath(join(s.dir, "folder.zip"), "zip"),
    code("invalid_path"),
  );
  await writeFile(join(s.dir, "real.txt"), "keep");
  await symlink(join(s.dir, "real.txt"), join(s.dir, "link.zip"));
  await assert.rejects(
    validateChosenPath(join(s.dir, "link.zip"), "zip"),
    code("invalid_path"),
  );
  assert.equal(await readFile(join(s.dir, "real.txt"), "utf8"), "keep");
  assert.equal(
    await validateChosenPath(join(s.dir, "ok.ZIP"), "zip"),
    join(s.dir, "ok.ZIP"),
  );
});

test("names the user picks in the dialog may use ordinary characters; separators, control characters and dot-files are refused", async (t) => {
  const s = await setup(t);
  for (const name of [
    "diagnostics (2).zip",
    "Diagnose für Team.zip",
    "bundle_2026-10-18.zip",
  ])
    assert.equal(
      await validateChosenPath(join(s.dir, name), "zip"),
      join(s.dir, name),
      name,
    );
  for (const name of [".hidden.zip", "a\u0007b.zip", "tab\tname.zip"])
    await assert.rejects(
      validateChosenPath(join(s.dir, name), "zip"),
      (e: any) => e.code === "invalid_path",
      JSON.stringify(name),
    );
});
