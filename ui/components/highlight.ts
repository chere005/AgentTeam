/** Small dependency-free, per-line syntax tokenizer for review diffs. Best effort, never throws. */
export type Token = { text: string; cls?: "kw" | "str" | "com" | "num" };

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const JS = words(
  "as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while with yield",
);
const PY = words(
  "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield",
);
const RS = words(
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
);
const GO = words(
  "break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var",
);
const C = words(
  "auto bool break case catch char class const continue default delete do double else enum extern false float for goto if inline int long namespace new nullptr private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while import package final abstract interface implements extends synchronized throws boolean byte instanceof",
);
const SH = words(
  "case do done elif else esac fi for function if in local return select then until while export readonly set unset",
);
const CSS = words("important inherit initial unset auto none");
const WL = words(
  "True False Null Module Block With Function If Which Switch Do For While Table Map Select",
);

type Lang = {
  kw: Set<string>;
  line?: string[];
  block?: [string, string];
  quotes: string;
};
const LANGS: Record<string, Lang> = {};
const add = (exts: string, l: Lang) =>
  exts.split(" ").forEach((e) => (LANGS[e] = l));
add("js jsx mjs cjs ts tsx json jsonc", {
  kw: JS,
  line: ["//"],
  block: ["/*", "*/"],
  quotes: "\"'`",
});
add("py", { kw: PY, line: ["#"], quotes: "\"'" });
add("rs", { kw: RS, line: ["//"], block: ["/*", "*/"], quotes: '"' });
add("go", { kw: GO, line: ["//"], block: ["/*", "*/"], quotes: "\"'`" });
add("c h cc cpp hpp cs java kt swift", {
  kw: C,
  line: ["//"],
  block: ["/*", "*/"],
  quotes: "\"'",
});
add("sh bash zsh", { kw: SH, line: ["#"], quotes: "\"'" });
add("css scss", { kw: CSS, block: ["/*", "*/"], quotes: "\"'" });
add("html xml svg", { kw: new Set(), block: ["<!--", "-->"], quotes: "\"'" });
add("wl m wls", { kw: WL, block: ["(*", "*)"], quotes: '"' });
add("yml yaml toml ini", {
  kw: words("true false null"),
  line: ["#"],
  quotes: "\"'",
});
add("md txt", { kw: new Set(), quotes: "" });

export function languageFor(path: string): string | null {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext && LANGS[ext] ? ext : null;
}

/** Tokenize one source line (no diff prefix). Lines over 2000 chars are left plain. */
export function highlightLine(text: string, lang: string | null): Token[] {
  const l = lang ? LANGS[lang] : undefined;
  if (!l || !text || text.length > 2000) return [{ text }];
  const out: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ text: plain });
    plain = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const lc = l.line?.find((p) => rest.startsWith(p));
    if (lc) {
      flush();
      out.push({ text: rest, cls: "com" });
      break;
    }
    if (l.block && rest.startsWith(l.block[0])) {
      flush();
      const end = text.indexOf(l.block[1], i + l.block[0].length);
      const stop = end === -1 ? text.length : end + l.block[1].length;
      out.push({ text: text.slice(i, stop), cls: "com" });
      i = stop;
      continue;
    }
    const ch = text[i];
    if (l.quotes.includes(ch)) {
      flush();
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      out.push({
        text: text.slice(i, Math.min(j + 1, text.length)),
        cls: "str",
      });
      i = j + 1;
      continue;
    }
    const num = /^(?:0x[0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/.exec(
      rest,
    );
    if (num && !/[A-Za-z0-9_$]/.test(text[i - 1] ?? "")) {
      flush();
      out.push({ text: num[0], cls: "num" });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    if (word) {
      if (l.kw.has(word[0])) {
        flush();
        out.push({ text: word[0], cls: "kw" });
      } else plain += word[0];
      i += word[0].length;
      continue;
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}
