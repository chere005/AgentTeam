import { spawnSync } from "node:child_process";
const env = { ...process.env };
// GitHub Actions passes unset secrets as empty strings. electron-builder treats
// an empty CSC_LINK as a path, which resolves to the repository directory and
// makes an intentionally unsigned macOS build fail with "not a file".
for (const key of [
  "CSC_LINK",
  "CSC_NAME",
  "CSC_KEY_PASSWORD",
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
]) {
  if (!env[key]?.trim()) delete env[key];
}
const signed =
  process.platform === "darwin" && (!!env.CSC_LINK || !!env.CSC_NAME);
const notarize =
  signed &&
  !!env.APPLE_ID &&
  !!env.APPLE_APP_SPECIFIC_PASSWORD &&
  !!env.APPLE_TEAM_ID;
if (process.platform === "darwin" && !signed)
  env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
if (signed) env.CSC_IDENTITY_AUTO_DISCOVERY = "true";
const args = [
  "node_modules/electron-builder/cli.js",
  "--publish",
  "never",
  ...process.argv.slice(2),
];
if (signed) args.push("-c.forceCodeSigning=true");
if (process.platform === "darwin")
  args.push("-c.mac.notarize=" + String(notarize));
console.log(
  process.platform === "darwin"
    ? `macOS package: ${signed ? "Developer ID signing enabled" : "no signing credentials configured"}; notarization ${notarize ? "enabled" : "off"}`
    : "Building " + process.platform + " package",
);
const result = spawnSync(process.execPath, args, { stdio: "inherit", env });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
