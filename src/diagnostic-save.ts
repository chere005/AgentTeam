import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { AppError, assert } from "./model.ts";
import type { Bundle } from "./diagnostics.ts";

/**
 * Main-process "Save as…" for the diagnostic bundle (desktop IPC `save-diagnostics`).
 * The renderer only names the format. The main process fetches the redacted bundle from the
 * backend itself, asks the user where to save it and writes exactly that one file, so the renderer
 * never supplies content or a path. Test mode records the save instead of opening a dialog.
 */
export const saveRequestSchema = z
  .object({ format: z.enum(["zip", "json"]).default("zip") })
  .strict();

export type SaveDialog = (options: {
  title: string;
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
}) => Promise<{ canceled: boolean; filePath?: string }>;

export type SaveRecord = {
  kind: "save-as";
  filename: string;
  format: "zip" | "json";
  bytes: number;
  sha256: string;
};

export type SaveDeps = {
  fetchBundle: (format: "zip" | "json") => Promise<Bundle>;
  showSaveDialog: SaveDialog;
  /** Where the dialog starts (e.g. the Downloads folder). */
  defaultDirectory: string;
  testMode?: boolean;
  record?: (record: SaveRecord) => void;
};

export type SaveResult =
  | { saved: false; canceled: true }
  | {
      saved: true;
      /** Base name only; the chosen directory is never returned to the renderer. */
      filename: string;
      bytes: number;
      files: string[];
      redaction: Bundle["redaction"];
      testMode?: true;
    };

/** Names the backend may suggest (strict: it is not the user's choice). */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/;
/**
 * Names the user may pick in the native dialog: anything but control characters, path
 * separators and a leading dot (e.g. "diagnostics (2).zip" or non-Latin names are fine).
 */
const CHOSEN_NAME = /^[^.\x00-\x1f\x7f/\\][^\x00-\x1f\x7f/\\]{0,199}$/u;

/**
 * Validate the path the user picked. Exported for tests: it must be absolute, end in the bundle's
 * extension (added when the dialog left it out), and not be a symbolic link or a directory.
 */
export async function validateChosenPath(
  chosen: unknown,
  format: "zip" | "json",
) {
  assert(
    typeof chosen === "string" && chosen.length > 0 && chosen.length < 4096,
    "invalid_path",
    "No file was chosen",
    400,
  );
  assert(!chosen.includes("\0"), "invalid_path", "Invalid file path", 400);
  assert(
    isAbsolute(chosen),
    "invalid_path",
    "Choose an absolute file path",
    400,
  );
  const wanted = "." + format;
  let path = chosen;
  const ext = extname(path).toLowerCase();
  if (!ext) path += wanted;
  else
    assert(
      ext === wanted,
      "invalid_extension",
      `A ${format} bundle must be saved with the ${wanted} extension`,
      400,
    );
  assert(
    CHOSEN_NAME.test(basename(path)),
    "invalid_path",
    "The file name contains characters that are not allowed",
    400,
  );
  try {
    const parent = await lstat(dirname(path));
    assert(
      parent.isDirectory(),
      "invalid_path",
      "The folder does not exist",
      400,
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(400, "invalid_path", "The folder does not exist");
  }
  try {
    const existing = await lstat(path);
    assert(
      existing.isFile(),
      "invalid_path",
      "Choose a regular file, not a folder or link",
      400,
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  return path;
}

export async function saveDiagnosticBundle(
  input: unknown,
  deps: SaveDeps,
): Promise<SaveResult> {
  const { format } = saveRequestSchema.parse(
    input && typeof input === "object" ? input : { format: input },
  );
  const bundle = await deps.fetchBundle(format);
  const bytes = Buffer.from(
    bundle.data,
    bundle.encoding === "base64" ? "base64" : "utf8",
  );
  const meta = {
    filename: bundle.filename,
    bytes: bytes.length,
    files: bundle.files,
    redaction: bundle.redaction,
  };
  assert(
    SAFE_NAME.test(bundle.filename) && bundle.filename.endsWith("." + format),
    "invalid_bundle",
    "The backend returned an unexpected file name",
    500,
  );
  if (deps.testMode) {
    deps.record?.({
      kind: "save-as",
      filename: bundle.filename,
      format,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    return { saved: true, ...meta, testMode: true };
  }
  const picked = await deps.showSaveDialog({
    title: "Save diagnostic bundle",
    defaultPath: join(deps.defaultDirectory, bundle.filename),
    filters: [
      format === "zip"
        ? { name: "Zip archive", extensions: ["zip"] }
        : { name: "JSON", extensions: ["json"] },
    ],
  });
  if (picked.canceled || !picked.filePath)
    return { saved: false, canceled: true };
  const path = await validateChosenPath(picked.filePath, format);
  // O_NOFOLLOW: a link planted at the path after validation is not followed (POSIX).
  await writeFile(path, bytes, {
    mode: 0o600,
    flag:
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      (constants.O_NOFOLLOW ?? 0),
  });
  return { saved: true, ...meta, filename: basename(path) };
}
