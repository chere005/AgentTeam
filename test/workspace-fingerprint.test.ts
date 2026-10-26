import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderFingerprint } from "../src/fs-watch.ts";

test("fallback watching detects top-level edits beside an oversized child project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentteam-watch-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = join(root, "a-large-project");
  await mkdir(child);
  for (let offset = 0; offset < 2001; offset += 50)
    await Promise.all(
      Array.from({ length: Math.min(50, 2001 - offset) }, (_, i) =>
        writeFile(join(child, `file-${offset + i}.txt`), "unchanged"),
      ),
    );
  const initial = await folderFingerprint(root);
  await writeFile(join(root, "z-duty.txt"), "reporting for duty");
  const added = await folderFingerprint(root);
  assert.notEqual(added, initial);
  assert.match(added, /z-duty\.txt/);
  await writeFile(
    join(root, "z-duty.txt"),
    "changed duty file with different length",
  );
  assert.notEqual(await folderFingerprint(root), added);
});
