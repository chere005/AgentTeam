import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { SkillCatalog } from "../src/skills.ts";
import { TeamService } from "../src/service.ts";
import { TeamTemplates, checkCompatibility } from "../src/teams.ts";

const dir = new URL("../assets/team-templates/", import.meta.url);

test("bundled starter templates validate, need mapping, and insert atomically", async (t) => {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 4);
  const workspace = await mkdtemp(join(tmpdir(), "agentteam-starter-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  for (const file of files) {
    const envelope = JSON.parse(await readFile(new URL(file, dir), "utf8"));
    const template = checkCompatibility(envelope);
    assert.equal(template.includesAbsolutePaths, false, file);
    for (const a of template.agents) {
      assert.equal(a.model, "default", `${file}: models stay mappable`);
      assert.deepEqual(a.skills, [], `${file}: no invented skill dependencies`);
      assert.ok(
        a.workspaces.every((w) => !w.path),
        `${file}: no paths`,
      );
    }
    const store = new Store(":memory:");
    t.after(() => store.close());
    const teams = new TeamTemplates(
      new TeamService(store, new SkillCatalog([])),
    );
    const slots = (await teams.preview({ envelope })).workspaceSlots;
    assert.ok(slots.length, file);
    assert.equal((await teams.preview({ envelope })).ok, false);
    await assert.rejects(
      teams.insert({ envelope }),
      /template_invalid|cannot be inserted/,
    );
    assert.equal(store.list("agent").length, 0);
    const workspaces = Object.fromEntries(
      slots.map((s) => [`${s.agentKey}/${s.slot}`, workspace]),
    );
    const result = await teams.insert({ envelope, workspaces });
    assert.equal(result.agents.length, template.agents.length, file);
  }
});
