// Regenerate the bundled catalog from locally checked-out, pinned upstream sources.
// No upstream code is executed. Preserve each complete skill directory and license.
import { readFile, writeFile, mkdir, cp, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
const root = new URL("../", import.meta.url).pathname;
const selections = {
  Languages: [
    "python-pro",
    "typescript-pro",
    "javascript-pro",
    "rust-engineer",
    "golang-pro",
    "cpp-pro",
    "csharp-developer",
    "java-architect",
    "kotlin-specialist",
    "swift-expert",
    "php-pro",
  ],
  Databases: ["sql-pro", "postgres-pro", "database-optimizer"],
  Frameworks: [
    "fastapi-expert",
    "django-expert",
    "nextjs-developer",
    "react-expert",
    "vue-expert",
    "spring-boot-engineer",
  ],
  Quality: [
    "playwright-expert",
    "test-master",
    "code-reviewer",
    "security-reviewer",
    "code-documenter",
  ],
  Infrastructure: [
    "devops-engineer",
    "kubernetes-specialist",
    "terraform-engineer",
  ],
};
const catalog = [];
async function files(dir) {
  const list = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink())
      throw new Error("Symlink in bundled skill: " + join(dir, e.name));
    if (e.isDirectory()) list.push(...(await files(join(dir, e.name))));
    else list.push(join(dir, e.name));
  }
  return list;
}
async function add(
  source,
  repo,
  skill,
  category,
  license,
  licenseFile,
  publisher,
  sourcePath = "skills/" + skill,
) {
  const cache = join(root, ".agentteam/vendor-sources", source),
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: cache,
      encoding: "utf8",
    }).trim();
  const from = join(cache, sourcePath),
    destination = join(root, "assets/skills", source + "--" + skill);
  await files(from);
  const raw = await readFile(join(from, "SKILL.md"), "utf8"),
    meta = parse(raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  await cp(from, destination, { recursive: true });
  await cp(join(cache, licenseFile), join(destination, "UPSTREAM-LICENSE.txt"));
  const catalogId = source + "--" + skill;
  await writeFile(
    join(destination, "agentteam.json"),
    JSON.stringify(
      {
        catalogId,
        environments: ["codex", "claude"],
        requiresTools: [],
        compatibilityEvidence: "format-only",
      },
      null,
      2,
    ) + "\n",
  );
  catalog.push({
    id: "curated:" + catalogId,
    name: meta.name,
    title: skill
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" "),
    description: meta.description,
    category,
    publisher,
    source: "https://github.com/" + repo,
    sourcePath,
    commit,
    license,
    licenseFile: "UPSTREAM-LICENSE.txt",
    bundled: true,
    environmentSupport: {
      codex: "format-compatible; execution not validated",
      claude: "native skill format; execution not validated",
      wolfram: "not validated",
    },
    skillSha256: createHash("sha256").update(raw).digest("hex"),
  });
}
for (const [category, skills] of Object.entries(selections))
  for (const skill of skills)
    await add(
      "jeffallan",
      "Jeffallan/claude-skills",
      skill,
      category,
      "MIT",
      "LICENSE",
      "Jeff Allan · Community",
    );
await add(
  "supabase",
  "supabase/agent-skills",
  "supabase-postgres-best-practices",
  "Databases",
  "MIT",
  "LICENSE",
  "Supabase · First party",
);
await add(
  "anthropic",
  "anthropics/skills",
  "frontend-design",
  "Design",
  "Apache-2.0",
  "skills/frontend-design/LICENSE.txt",
  "Anthropic · First party",
);
await add(
  "anthropic",
  "anthropics/skills",
  "webapp-testing",
  "Quality",
  "Apache-2.0",
  "skills/webapp-testing/LICENSE.txt",
  "Anthropic · First party",
);
await add(
  "nextlevelbuilder",
  "nextlevelbuilder/ui-ux-pro-max-skill",
  "ui-ux-pro-max",
  "Design",
  "MIT",
  "LICENSE",
  "Next Level Builder · Community",
  ".claude/skills/ui-ux-pro-max",
);
await add(
  "wshobson",
  "wshobson/agents",
  "bash-defensive-patterns",
  "Languages",
  "MIT",
  "LICENSE",
  "Seth Hobson · Community",
  "plugins/shell-scripting/skills/bash-defensive-patterns",
);
// First-party: AgentTeam's own Electron skill (no well-rated public one exists). Its maintained
// copy lives in the sibling AgentSuite checkout; it ships under AgentTeam's MIT license.
{
  const from = join(root, "../AgentSuite/skills/electron-desktop"),
    destination = join(root, "assets/skills/agentteam--electron-desktop");
  await files(from);
  const raw = await readFile(join(from, "SKILL.md"), "utf8"),
    meta = parse(raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  await cp(from, destination, { recursive: true });
  await cp(join(root, "LICENSE"), join(destination, "UPSTREAM-LICENSE.txt"));
  await writeFile(
    join(destination, "agentteam.json"),
    JSON.stringify(
      {
        catalogId: "agentteam--electron-desktop",
        environments: ["codex", "claude"],
        requiresTools: [],
        compatibilityEvidence: "format-only",
      },
      null,
      2,
    ) + "\n",
  );
  catalog.push({
    id: "curated:agentteam--electron-desktop",
    name: meta.name,
    title: "Electron Desktop",
    description: meta.description,
    category: "Frameworks",
    publisher: "AgentTeam · First party",
    source: "https://github.com/chere005/AgentTeam",
    sourcePath: "assets/skills/agentteam--electron-desktop",
    // The AgentTeam revision the skill was curated at (the audit requires a full revision).
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    license: "MIT",
    licenseFile: "UPSTREAM-LICENSE.txt",
    bundled: true,
    environmentSupport: {
      codex: "format-compatible; execution not validated",
      claude: "native skill format; execution not validated",
      wolfram: "not validated",
    },
    skillSha256: createHash("sha256").update(raw).digest("hex"),
  });
}
const vercel = join(root, ".agentteam/vendor-sources/vercel"),
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: vercel,
    encoding: "utf8",
  }).trim();
for (const skill of [
  "react-best-practices",
  "composition-patterns",
  "web-design-guidelines",
]) {
  const raw = await readFile(join(vercel, "skills", skill, "SKILL.md"), "utf8");
  const meta = parse(raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
  catalog.push({
    id: "recommended:vercel--" + skill,
    name: meta.name,
    title: skill
      .split("-")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" "),
    description: meta.description,
    category: "Frontend",
    publisher: "Vercel · First party",
    source: "https://github.com/vercel-labs/agent-skills",
    sourcePath: "skills/" + skill,
    commit,
    license: meta.license ?? "Not specified",
    bundled: false,
    reason:
      "Source recommendation only; no license text was supplied with this upstream snapshot. Review redistribution notices before bundling.",
    environmentSupport: {
      codex: "Agent Skills format; not validated",
      claude: "Agent Skills format; not validated",
      wolfram: "not validated",
    },
  });
}
await writeFile(
  join(root, "assets/recommended-skills.json"),
  JSON.stringify(
    {
      curatedOn: "2026-10-23",
      selectionPolicy:
        "First-party guidance where available; focused, established community language specialists. This is an editorial starter set, not an objective ranking. Bundled content is pinned and not executed during curation.",
      skills: catalog,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Catalog: ${catalog.length} recommendations; ${catalog.filter((s) => s.bundled).length} bundled with upstream licenses.`,
);
