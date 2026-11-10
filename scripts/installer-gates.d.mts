export type Platform = "mac" | "windows" | "linux";
export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}
export interface Runner {
  cmd(command: string, args: string[]): CommandResult;
  asar(): {
    listPackage(path: string, options: { isPack: boolean }): string[];
    extractFile(path: string, name: string): Buffer;
  };
}
export function installerFiles(
  platform: string,
  arch: string,
  version: string,
): string[];
export function allInstallerFiles(version: string): string[];
export function unpackedApp(
  platform: string,
  arch: string,
  dir?: string,
): { app: string; resources: string };
export const requiredResources: string[];
export function nodePtyPrebuild(platform: string, arch: string): string;
export function verify(options: {
  platform: string;
  arch: string;
  version: string;
  dir?: string;
  signingRequired?: boolean;
  run?: Runner;
}): { failures: string[]; ok: string[] };
