import { homedir } from "node:os";
import { readFileSync } from "node:fs";

/**
 * Redaction for diagnostic exports. Three layers, applied to every string and object key:
 *  1. literal secrets (API token, token-file contents, values of env vars named like TOKEN/KEY/SECRET),
 *  2. well-known credential shapes (Bearer headers, provider key prefixes, JWTs, PEM private keys,
 *     `name=value` pairs whose name looks secret),
 *  3. object keys that name a secret (the whole string value/subtree is dropped).
 * File contents are never read here; callers only pass paths and metadata.
 */
export const REDACTED = "[REDACTED]";
const SECRET_ENV_NAME =
  /(token|key|secret|passw(or)?d|credential|auth|cookie|session)/i;
const SECRET_KEY_NAME =
  /(token|secret|passw(or)?d|passphrase|credential|api[-_]?key|private[-_]?key|access[-_]?key|authorization|cookie|bearer|(^|[^a-z])auth([^a-z]|$))/i;
const MIN_LITERAL = 6;
const PATTERNS: [RegExp, string][] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    REDACTED,
  ],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer " + REDACTED],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, "Basic " + REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, REDACTED],
  [
    /\b([A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[-_]?key|apikey|authorization|credential|private[-_]?key)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(?!\d+\b)("[^"]*"|'[^']*'|[^\s,;"'&}]+)/gi,
    "$1$2" + REDACTED,
  ],
];
export type RedactionOptions = {
  /** Exact secret strings (e.g. the live API token). */
  literals?: string[];
  /** Files whose entire contents (and each line) are treated as secrets, e.g. the api-token file. */
  secretFiles?: string[];
  /** Environment to scan for secret-named variables; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Longest string kept; longer text is cut and marked. */
  maxString?: number;
};
export class Redactor {
  literals = new Set<string>();
  maxString: number;
  stats = { literal: 0, pattern: 0, key: 0, truncated: 0 };
  home: string | null;
  constructor(options: RedactionOptions = {}) {
    this.maxString = options.maxString ?? 2000;
    for (const l of options.literals ?? []) this.addLiteral(l);
    for (const file of options.secretFiles ?? []) {
      try {
        const text = readFileSync(file, "utf8").slice(0, 65_536);
        this.addLiteral(text);
        for (const line of text.split(/\r?\n/)) this.addLiteral(line);
      } catch {
        /* a missing token file simply contributes nothing */
      }
    }
    for (const [name, value] of Object.entries(options.env ?? process.env))
      if (value && SECRET_ENV_NAME.test(name)) this.addLiteral(value);
    const home = homedir();
    this.home = home && home.length > 2 ? home : null;
  }
  addLiteral(value: string | undefined | null) {
    const v = (value ?? "").trim();
    if (v.length < MIN_LITERAL) return;
    this.literals.add(v);
    // Encoded copies of a secret leak just as well as the plain one.
    const variants = [
      JSON.stringify(v).slice(1, -1),
      encodeURIComponent(v),
      Buffer.from(v).toString("base64"),
      Buffer.from(v).toString("base64").replace(/=+$/, ""),
    ];
    for (const x of variants) if (x.length >= MIN_LITERAL) this.literals.add(x);
  }
  /** Final pass over serialized output: removes literal secrets only (no truncation, no reshaping). */
  scrubLiterals(text: string) {
    let s = text;
    for (const lit of [...this.literals].sort((a, b) => b.length - a.length))
      if (s.includes(lit)) {
        this.stats.literal += s.split(lit).length - 1;
        s = s.split(lit).join(REDACTED);
      }
    return s;
  }
  string(input: string): string {
    let s = input;
    // Longest literals first so a secret that contains another is fully removed.
    for (const lit of [...this.literals].sort((a, b) => b.length - a.length))
      if (s.includes(lit)) {
        this.stats.literal += s.split(lit).length - 1;
        s = s.split(lit).join(REDACTED);
      }
    for (const [re, to] of PATTERNS) {
      s = s.replace(re, (...m) => {
        this.stats.pattern++;
        return to.replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? "");
      });
    }
    if (this.home) s = s.split(this.home).join("~");
    if (s.length > this.maxString) {
      this.stats.truncated++;
      s =
        s.slice(0, this.maxString) +
        `… [truncated ${s.length - this.maxString} chars]`;
    }
    return s;
  }
  value(input: unknown, depth = 0): unknown {
    if (input === null || input === undefined) return input;
    if (typeof input === "string") return this.string(input);
    if (typeof input !== "object") return input;
    if (depth > 12) return "[depth limit]";
    if (Array.isArray(input))
      return input.slice(0, 500).map((v) => this.value(v, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const key = this.string(k);
      if (
        SECRET_KEY_NAME.test(k) &&
        v !== null &&
        typeof v !== "number" &&
        typeof v !== "boolean" &&
        !(typeof v === "string" && !v)
      ) {
        this.stats.key++;
        out[key] = REDACTED;
      } else out[key] = this.value(v, depth + 1);
    }
    return out;
  }
  /** Names (never values) of environment variables that look secret, for the diagnostic report. */
  static secretEnvNames(env: Record<string, string | undefined> = process.env) {
    return Object.keys(env)
      .filter((n) => SECRET_ENV_NAME.test(n) && env[n])
      .sort();
  }
  /** True when none of the literal secrets survive in the serialized text. */
  leaks(text: string) {
    return [...this.literals].filter((l) => text.includes(l)).length;
  }
}
