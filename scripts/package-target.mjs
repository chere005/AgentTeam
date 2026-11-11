/** Refuse Intel or universal Mac packages while leaving Windows and Linux targets alone. */
export function validatePackageTarget(hostPlatform, args) {
  const explicitMac = args.some((arg) => /^(--mac|--macos|-m)(=|$)/.test(arg));
  const explicitOther = args.some((arg) =>
    /^(--win|--windows|-w|--linux|-l)(=|$)/.test(arg),
  );
  if (!explicitMac && (hostPlatform !== "darwin" || explicitOther)) return;
  const unsupported = args.some(
    (arg, i) =>
      /^(--x64|--ia32|--universal)(=true)?$/.test(arg) ||
      /^--arch=(x64|x86_64|ia32|universal|all)$/.test(arg) ||
      (arg === "--arch" &&
        /^(x64|x86_64|ia32|universal|all)$/.test(args[i + 1] ?? "")),
  );
  if (unsupported) throw new Error("macOS builds support Apple Silicon only");
}
