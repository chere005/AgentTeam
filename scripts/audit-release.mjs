// Release consistency audit: lockfile vs package.json, dependency licenses, bundled-skill notices,
// team templates and workflow YAML. Offline and read-only; exits 1 on any failure.
// Usage: node scripts/audit-release.mjs   (or: npm run audit:release)
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

const root = new URL("..", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const at = (...p) => join(root, ...p);
const json = (...p) => JSON.parse(readFileSync(at(...p), "utf8"));
const failures = [];
const notes = [];
const fail = (m) => failures.push(m);

// Licenses acceptable for distributed production dependencies (SPDX ids, "OR" expressions allowed).
const allowed = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Python-2.0",
]);

// 1. Lockfile consistency
const pkg = json("package.json");
const lock = json("package-lock.json");
const rootEntry = lock.packages?.[""] ?? {};
if (lock.name !== pkg.name || rootEntry.name !== pkg.name)
  fail("package-lock name differs from package.json");
if (lock.version !== pkg.version || rootEntry.version !== pkg.version)
  fail(
    `package-lock version (${lock.version}) differs from package.json (${pkg.version})`,
  );
for (const key of ["dependencies", "devDependencies"]) {
  const a = JSON.stringify(Object.entries(pkg[key] ?? {}).sort());
  const b = JSON.stringify(Object.entries(rootEntry[key] ?? {}).sort());
  if (a !== b) fail(`package-lock root ${key} differ from package.json`);
}
for (const [name, dep] of Object.entries(pkg.dependencies ?? {})) {
  if (/^(latest|\*|git|http|file:|link:)/.test(dep))
    fail(`dependency ${name} uses unpinned/non-registry spec ${dep}`);
}
let missingIntegrity = 0;
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path || entry.link) continue;
  if (!entry.resolved || !entry.integrity) missingIntegrity++;
  else if (!entry.resolved.startsWith("https://"))
    fail(`lock entry ${path} is not resolved over https`);
}
if (missingIntegrity)
  fail(`${missingIntegrity} lock entries lack resolved/integrity`);

// 2. Production dependency licenses (lock metadata first, installed package.json as fallback)
const prod = new Set();
const walk = (name, from) => {
  let dir = from;
  for (;;) {
    const key = (dir ? dir + "/" : "") + "node_modules/" + name;
    if (lock.packages[key]) return void visit(key);
    if (!dir) return;
    dir = dir.includes("/node_modules/")
      ? dir.slice(0, dir.lastIndexOf("/node_modules/"))
      : "";
  }
};
const visit = (key) => {
  if (prod.has(key)) return;
  prod.add(key);
  const e = lock.packages[key];
  for (const d of Object.keys({ ...e.dependencies, ...e.optionalDependencies }))
    walk(d, key);
};
for (const d of Object.keys(pkg.dependencies ?? {})) walk(d, "");
const licenseOf = (key) => {
  const e = lock.packages[key];
  if (e.license) return e.license;
  try {
    const p = json(key, "package.json");
    return typeof p.license === "string"
      ? p.license
      : (p.license?.type ?? p.licenses?.[0]?.type ?? "");
  } catch {
    return "";
  }
};
const byLicense = {};
for (const key of [...prod].sort()) {
  const lic = licenseOf(key) || "UNKNOWN";
  (byLicense[lic] ??= []).push(key.replace(/^.*node_modules\//, ""));
  const ids = lic.replace(/[()]/g, "").split(/\s+(?:OR|AND)\s+/);
  if (!ids.some((i) => allowed.has(i)))
    fail(
      `production dependency ${key} has license "${lic}" not on the allow-list`,
    );
}
notes.push(
  `production dependencies: ${prod.size} (${Object.entries(byLicense)
    .map(([k, v]) => `${k} x${v.length}`)
    .join(", ")})`,
);
if (pkg.license !== "MIT" || !existsSync(at("LICENSE")))
  fail("root LICENSE missing or package.json license is not MIT");
// Direct dependencies with a notice that must ship: the ACP SDK is Apache-2.0.
if (
  pkg.dependencies?.["@agentclientprotocol/sdk"] &&
  !existsSync(at("assets", "licenses", "ACP-SDK-LICENSE.txt"))
)
  fail(
    "assets/licenses/ACP-SDK-LICENSE.txt missing for @agentclientprotocol/sdk",
  );

// 3. Bundled skills vs catalog
const catalog = json("assets", "recommended-skills.json");
const skillDirs = readdirSync(at("assets", "skills"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const bundled = catalog.skills.filter((s) => s.bundled);
const bundledIds = new Set(bundled.map((s) => s.id));
const seen = new Set();
for (const dir of skillDirs) {
  const base = at("assets", "skills", dir);
  for (const f of ["SKILL.md", "UPSTREAM-LICENSE.txt", "agentteam.json"])
    if (!existsSync(join(base, f))) fail(`assets/skills/${dir} lacks ${f}`);
  let manifest;
  try {
    manifest = json("assets", "skills", dir, "agentteam.json");
  } catch {
    continue;
  }
  const id = "curated:" + manifest.catalogId;
  if (manifest.catalogId !== dir)
    fail(
      `assets/skills/${dir}: catalogId "${manifest.catalogId}" differs from directory`,
    );
  const entry = bundled.find((s) => s.id === id);
  if (!entry) {
    fail(`assets/skills/${dir} has no bundled catalog entry`);
    continue;
  }
  seen.add(id);
  if (!entry.license || entry.license === "Not specified")
    fail(`${id}: catalog license missing`);
  if (!allowed.has(entry.license))
    fail(`${id}: license "${entry.license}" not on the allow-list`);
  if (!entry.commit || !entry.source) fail(`${id}: source/commit missing`);
  const lf = join(base, entry.licenseFile ?? "UPSTREAM-LICENSE.txt");
  if (!existsSync(lf) || readFileSync(lf, "utf8").trim().length < 100)
    fail(`${id}: license text missing or empty`);
  if (existsSync(join(base, "SKILL.md"))) {
    const hash = createHash("sha256")
      .update(readFileSync(join(base, "SKILL.md"), "utf8"))
      .digest("hex");
    if (entry.skillSha256 && entry.skillSha256 !== hash)
      fail(
        `${id}: SKILL.md differs from catalog skillSha256 (edited since curation?)`,
      );
  }
}
for (const id of bundledIds)
  if (!seen.has(id))
    fail(`${id}: catalog says bundled but no assets/skills directory`);
for (const s of catalog.skills.filter((s) => !s.bundled)) {
  if (existsSync(at("assets", "skills", s.id.replace(/^[^:]*:/, ""))))
    fail(
      `${s.id}: non-bundled recommendation has a directory under assets/skills`,
    );
}
notes.push(
  `bundled skills: ${skillDirs.length} directories, ${bundled.length} catalog entries, ${catalog.skills.length - bundled.length} metadata-only`,
);

// 3b. Skill catalog validation report (same checks the app shows under Skills, tools & knowledge)
{
  const { validateSkillCatalog } = await import("../src/skill-validation.ts");
  const report = await validateSkillCatalog({ assetsDir: at("assets") });
  for (const f of report.findings.filter((f) => f.severity === "error"))
    fail(`skill validation ${f.code}: ${f.message}`);
  notes.push(
    `skill validation: ${report.counts.skills} skills, ${report.counts.errors} errors, ${report.counts.warnings} warnings`,
  );
}

// 4. Team templates
const templates = readdirSync(at("assets", "team-templates")).filter((f) =>
  f.endsWith(".json"),
);
for (const f of templates) {
  try {
    const t = json("assets", "team-templates", f);
    if (
      !t.template?.name ||
      !Array.isArray(t.template.agents) ||
      !t.template.agents.length
    )
      fail(`team template ${f}: no name/agents`);
    if (
      /(api[_-]?key|secret|token|password)\s*"?\s*:/i.test(
        readFileSync(at("assets", "team-templates", f), "utf8"),
      )
    )
      fail(`team template ${f}: contains a secret-looking field`);
  } catch (e) {
    fail(`team template ${f}: ${e.message}`);
  }
}
notes.push(`team templates: ${templates.length}`);

// 5. Workflow YAML sanity
const wfDir = at(".github", "workflows");
for (const f of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
  const text = readFileSync(join(wfDir, f), "utf8");
  let doc;
  try {
    doc = parse(text, { uniqueKeys: true });
  } catch (e) {
    fail(`workflow ${f}: ${e.message}`);
    continue;
  }
  if (!doc.jobs || !Object.keys(doc.jobs).length)
    fail(`workflow ${f}: no jobs`);
  for (const [name, job] of Object.entries(doc.jobs ?? {}))
    for (const step of job.steps ?? [])
      if (step.uses && !/@(v?\d|[0-9a-f]{40})/.test(step.uses))
        fail(
          `workflow ${f} job ${name}: action ${step.uses} is not version-pinned`,
        );
  if (/\$\{\{\s*secrets\./.test(text) && f === "ci.yml")
    fail("ci.yml must not reference secrets");
}
notes.push("workflows: parsed");

for (const n of notes) console.log("ok   " + n);
for (const m of failures) console.log("FAIL " + m);
console.log(
  failures.length ? `\n${failures.length} problem(s)` : "\naudit passed",
);
process.exit(failures.length ? 1 : 0);
