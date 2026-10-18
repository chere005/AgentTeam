import { open, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import { assert } from "./model.ts";
import { locate } from "./locate.ts";
import type { WorkspaceService } from "./workspaces.ts";

/**
 * Bounded, safe file previews by artifact type. The backend only reads at most MAX_READ bytes and
 * returns data; nothing is executed or rendered as HTML. The renderer shows text in <pre>,
 * Markdown through the app's sanitizing renderer, tables as plain cells, and images as data URLs
 * of verified raster formats (SVG is shown as source because it can carry script).
 */
export const TEXT_LIMIT = 256_000;
export const JSON_LIMIT = 1_000_000;
export const IMAGE_LIMIT = 4_000_000;
export const CSV_MAX_ROWS = 200;
export const CSV_MAX_COLUMNS = 30;
export const CSV_MAX_CELL = 200;

export type PreviewKind =
  "text" | "markdown" | "json" | "csv" | "image" | "pdf" | "binary";
export type RichPreview = {
  path: string;
  name: string;
  extension: string;
  size: number;
  kind: PreviewKind;
  truncated: boolean;
  /** Human sentence explaining a limit or why nothing is shown; absent when fully shown. */
  note?: string;
  /** True when the only useful way to view it is an external application. */
  externalOnly: boolean;
  content?: string;
  json?: { formatted: string; valid: boolean; error?: string };
  table?: {
    delimiter: "," | "\t";
    rows: string[][];
    columns: number;
    rowsTruncated: boolean;
    columnsTruncated: boolean;
  };
  image?: { mime: string; dataUrl: string; width?: number; height?: number };
};

const IMAGE_MAGIC: [string, (b: Buffer) => boolean][] = [
  [
    "image/png",
    (b) => b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  ],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => /^GIF8[79]a/.test(b.subarray(0, 6).toString("latin1"))],
  [
    "image/webp",
    (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" &&
      b.subarray(8, 12).toString("latin1") === "WEBP",
  ],
  ["image/bmp", (b) => b[0] === 0x42 && b[1] === 0x4d],
];
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
export const mimeOf = (head: Buffer) =>
  IMAGE_MAGIC.find(([, test]) => test(head))?.[0] ?? null;

function imageSize(mime: string, b: Buffer) {
  if (mime === "image/png" && b.length >= 24)
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (mime === "image/gif" && b.length >= 10)
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  return {};
}

/** RFC 4180-style parser: quoted fields, escaped quotes, CR/LF. Bounded by the caller. */
export function parseDelimited(
  text: string,
  delimiter: "," | "\t",
  maxRows: number,
) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    more = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length >= maxRows) {
        more = i < text.length - 1 && text.slice(i + 1).trim() !== "";
        return { rows, more };
      }
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, more };
}

const kindByExtension = (ext: string): PreviewKind | null => {
  const e = ext.toLowerCase();
  if (e === ".md" || e === ".markdown") return "markdown";
  if (e === ".json" || e === ".jsonc" || e === ".geojson") return "json";
  if (e === ".csv" || e === ".tsv") return "csv";
  if (e === ".pdf") return "pdf";
  if (IMAGE_EXT.has(e)) return "image";
  return null;
};
const mb = (n: number) => (n / 1_000_000).toFixed(1) + " MB";

/** Classify and bound one file. `head` holds up to `readLimit(kind)` bytes from the start. */
export function buildPreview(
  rel: string,
  name: string,
  size: number,
  head: Buffer,
): RichPreview {
  const extension = extname(name);
  const base = {
    path: rel,
    name,
    extension,
    size,
    truncated: false,
    externalOnly: false,
  };
  const declared = kindByExtension(extension);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-" || declared === "pdf")
    return {
      ...base,
      kind: "pdf",
      externalOnly: true,
      note: "PDF files open in an external application; AgentTeam does not render them.",
    };
  const sniffed = mimeOf(head);
  // "BM" is far too short a signature to claim a file without an image extension.
  const mime = sniffed === "image/bmp" && declared !== "image" ? null : sniffed;
  if (mime) {
    if (size > IMAGE_LIMIT)
      return {
        ...base,
        kind: "image",
        externalOnly: true,
        note: `Image is ${mb(size)}; previews are limited to ${mb(IMAGE_LIMIT)}. Open it externally.`,
      };
    if (head.length < size)
      return {
        ...base,
        kind: "image",
        externalOnly: true,
        note: "Image could not be read completely.",
      };
    return {
      ...base,
      kind: "image",
      image: {
        mime,
        dataUrl: `data:${mime};base64,${head.toString("base64")}`,
        ...imageSize(mime, head),
      },
    };
  }
  if (declared === "image")
    return {
      ...base,
      kind: "binary",
      externalOnly: true,
      note: "File does not look like a supported image (PNG, JPEG, GIF, WebP, BMP). Open it externally.",
    };
  if (head.subarray(0, 8192).includes(0))
    return {
      ...base,
      kind: "binary",
      externalOnly: true,
      note: "Binary file. Open it in an external application to view it.",
    };
  const limit = declared === "json" ? JSON_LIMIT : TEXT_LIMIT;
  const cut = size > head.length || head.length > limit;
  const slice = head.subarray(0, Math.min(head.length, limit));
  const text = slice.toString("utf8");
  const truncatedNote = (shown: number) =>
    `Large file (${mb(size)}): showing only the first ${Math.round(shown / 1000)} KB.`;
  if (declared === "json") {
    const out: RichPreview = { ...base, kind: "json" };
    if (!cut) {
      try {
        const formatted = JSON.stringify(JSON.parse(text), null, 2);
        const capped = formatted.length > TEXT_LIMIT;
        out.json = {
          valid: true,
          formatted: capped ? formatted.slice(0, TEXT_LIMIT) : formatted,
        };
        out.truncated = capped;
        if (capped) out.note = truncatedNote(TEXT_LIMIT);
        return out;
      } catch (e) {
        out.json = {
          valid: false,
          formatted: text.slice(0, TEXT_LIMIT),
          error: (e as Error).message,
        };
        out.note = "Not valid JSON; showing the raw text.";
        out.truncated = text.length > TEXT_LIMIT;
        return out;
      }
    }
    out.json = { valid: false, formatted: text.slice(0, TEXT_LIMIT) };
    out.truncated = true;
    out.note = `${truncatedNote(Math.min(TEXT_LIMIT, slice.length))} Too large to parse; raw text shown.`;
    return out;
  }
  if (declared === "csv") {
    const delimiter = extension.toLowerCase() === ".tsv" ? "\t" : ",";
    const textPart = text.slice(0, TEXT_LIMIT);
    const parsed = parseDelimited(textPart, delimiter, CSV_MAX_ROWS);
    let rows = parsed.rows;
    // The last row of a size-truncated read may be cut mid-line.
    if (cut && rows.length && !parsed.more) rows = rows.slice(0, -1);
    const columns = Math.max(0, ...rows.map((r) => r.length));
    const columnsTruncated = columns > CSV_MAX_COLUMNS;
    const bounded = rows.map((r) =>
      r
        .slice(0, CSV_MAX_COLUMNS)
        .map((c) =>
          c.length > CSV_MAX_CELL ? c.slice(0, CSV_MAX_CELL) + "…" : c,
        ),
    );
    const rowsTruncated = parsed.more || cut;
    return {
      ...base,
      kind: "csv",
      truncated: rowsTruncated || columnsTruncated,
      note: rowsTruncated
        ? `Showing the first ${bounded.length} rows${cut ? ` of a ${mb(size)} file` : ""}.`
        : columnsTruncated
          ? `Showing the first ${CSV_MAX_COLUMNS} of ${columns} columns.`
          : undefined,
      table: {
        delimiter,
        rows: bounded,
        columns: Math.min(columns, CSV_MAX_COLUMNS),
        rowsTruncated,
        columnsTruncated,
      },
    };
  }
  return {
    ...base,
    kind: declared === "markdown" ? "markdown" : "text",
    truncated: cut,
    note: cut ? truncatedNote(slice.length) : undefined,
    content: text,
  };
}

const input = z
  .object({ workspace: z.string(), path: z.string().default(".") })
  .strict();

/** Authorised, bounded preview of a regular file inside an attached folder. */
export async function inspectFile(
  ws: WorkspaceService,
  agentId: string,
  raw: unknown,
): Promise<RichPreview> {
  const data = input.parse(raw);
  const loc = await locate(ws, agentId, data);
  const info = await stat(loc.target);
  assert(info.isFile(), "not_file", "Path is not a regular file", 400);
  const wanted = Math.min(info.size, Math.max(IMAGE_LIMIT, JSON_LIMIT) + 1);
  const file = await open(loc.target, "r");
  try {
    // Read only what the detected kind can use: probe first, then the larger bound if needed.
    const probe = Buffer.alloc(Math.min(info.size, 16));
    await file.read(probe, 0, probe.length, 0);
    const ext = extname(loc.target).toLowerCase();
    const isImage =
      !!mimeOf(probe) && info.size <= IMAGE_LIMIT && info.size > 0;
    const length = isImage
      ? info.size
      : Math.min(
          wanted,
          ext === ".json" || ext === ".geojson" || ext === ".jsonc"
            ? JSON_LIMIT + 1
            : TEXT_LIMIT + 1,
        );
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    return buildPreview(
      loc.relative,
      basename(loc.target),
      info.size,
      buffer.subarray(0, bytesRead),
    );
  } finally {
    await file.close();
  }
}
