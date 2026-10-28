// `node src/cli.ts` lists the skill catalog (npm run skills).
// `node src/cli.ts folder-probe <path> [--write]` prints what the system lets a program started
// from THIS terminal do in a folder, as JSON, with the exact check the app runs
// (src/folder-access.ts): run it from a terminal and compare with the app's Setup card or
// Recovery to see whether the denial is macOS folder privacy for AgentTeam (the app refuses,
// the terminal does not). Exit status 0: usable, 1: the system refuses it, 2: bad usage.
import { resolve } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (command === "folder-probe") {
  const flags = args.filter((arg) => arg.startsWith("--"));
  const paths = args.filter((arg) => !arg.startsWith("--"));
  if (paths.length !== 1 || flags.some((flag) => flag !== "--write")) {
    console.error("Usage: node src/cli.ts folder-probe <path> [--write]");
    process.exit(2);
  }
  const { probeFolderAccess } = await import("./folder-access.ts");
  const result = await probeFolderAccess(resolve(paths[0]), {
    write: flags.includes("--write"),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
const { SkillCatalog } = await import("./skills.ts");
const { roots, recommendations } = await import("./config.ts");
const catalog = new SkillCatalog(roots());
await catalog.scan();
const recommended = await recommendations();
console.log(
  JSON.stringify(
    { recommended, installed: catalog.grouped("installed") },
    null,
    2,
  ),
);
