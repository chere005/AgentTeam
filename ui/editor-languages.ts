// File name -> editor language. Pure data (no CodeMirror import) so the map is unit-tested in Node
// (test/editor-languages.test.ts); ui/components/CodeEditor.tsx turns an id into a grammar.

export type LanguageId =
  | "typescript"
  | "javascript"
  | "json"
  | "python"
  | "html"
  | "css"
  | "sql"
  | "yaml"
  | "toml"
  | "rust"
  | "go"
  | "java"
  | "csharp"
  | "kotlin"
  | "scala"
  | "dart"
  | "objc"
  | "php"
  | "swift"
  | "ruby"
  | "lua"
  | "perl"
  | "r"
  | "julia"
  | "haskell"
  | "groovy"
  | "powershell"
  | "protobuf"
  | "properties"
  | "shell"
  | "diff"
  | "dockerfile"
  | "wolfram"
  | "verilog"
  | "cmake"
  | "xml"
  | "cpp"
  | "markdown"
  | "plain";

export interface LanguageInfo {
  id: LanguageId;
  /** The label shown in the editor's status bar. */
  name: string;
}

const info = (id: LanguageId, name: string): LanguageInfo => ({ id, name });
const PLAIN = info("plain", "Plain text");

/** Extensions per language; the first match wins, so an extension appears once. */
const byExtension: [LanguageId, string, string[]][] = [
  ["typescript", "TypeScript", ["ts", "tsx", "mts", "cts"]],
  ["javascript", "JavaScript", ["js", "jsx", "mjs", "cjs"]],
  ["json", "JSON", ["json", "jsonc", "json5", "webmanifest", "geojson"]],
  ["python", "Python", ["py", "pyi", "pyw"]],
  ["html", "HTML", ["html", "htm", "xhtml"]],
  ["css", "CSS", ["css"]],
  ["sql", "SQL", ["sql"]],
  ["yaml", "YAML", ["yaml", "yml"]],
  ["toml", "TOML", ["toml"]],
  ["rust", "Rust", ["rs"]],
  ["go", "Go", ["go"]],
  ["java", "Java", ["java"]],
  ["csharp", "C#", ["cs", "csx"]],
  ["kotlin", "Kotlin", ["kt", "kts"]],
  ["scala", "Scala", ["scala", "sc"]],
  ["dart", "Dart", ["dart"]],
  ["objc", "Objective-C", ["m", "mm"]],
  ["php", "PHP", ["php", "phtml", "php3", "php4", "php5", "phps"]],
  ["swift", "Swift", ["swift"]],
  ["ruby", "Ruby", ["rb", "rake", "gemspec", "ru"]],
  ["lua", "Lua", ["lua"]],
  ["perl", "Perl", ["pl", "pm"]],
  ["r", "R", ["r"]],
  ["julia", "Julia", ["jl"]],
  ["haskell", "Haskell", ["hs", "lhs"]],
  ["groovy", "Groovy", ["groovy", "gradle"]],
  ["powershell", "PowerShell", ["ps1", "psm1", "psd1"]],
  ["protobuf", "Protocol Buffers", ["proto"]],
  ["properties", "Properties", ["properties", "ini", "cfg", "conf", "env"]],
  ["shell", "Shell", ["sh", "bash", "zsh", "ksh"]],
  ["diff", "Diff", ["diff", "patch"]],
  ["wolfram", "Wolfram Language", ["wl", "wls", "nb", "m.wl"]],
  ["verilog", "Verilog", ["v", "sv", "svh"]],
  ["cmake", "CMake", ["cmake"]],
  ["xml", "XML", ["xml", "xsl", "xsd", "svg", "plist", "csproj"]],
  [
    "cpp",
    "C / C++",
    ["c", "h", "cc", "cpp", "hpp", "cxx", "hxx", "hh", "ipp", "inl", "cu"],
  ],
  ["markdown", "Markdown", ["md", "markdown", "mdx"]],
];
const extensionTable = new Map<string, LanguageInfo>();
for (const [id, name, exts] of byExtension)
  for (const ext of exts)
    if (!extensionTable.has(ext)) extensionTable.set(ext, info(id, name));

/** Whole file names (lower case) that carry a language without an extension. */
const byFilename = new Map<string, LanguageInfo>([
  ["pkgbuild", info("shell", "Shell")],
  [".bashrc", info("shell", "Shell")],
  [".zshrc", info("shell", "Shell")],
  [".profile", info("shell", "Shell")],
  ["cmakelists.txt", info("cmake", "CMake")],
  ["cmakelists.txt.in", info("cmake", "CMake")],
  ["gemfile", info("ruby", "Ruby")],
  ["rakefile", info("ruby", "Ruby")],
  ["podfile", info("ruby", "Ruby")],
  [".gitconfig", info("properties", "Properties")],
  [".editorconfig", info("properties", "Properties")],
]);

export function languageForPath(path: string): LanguageInfo {
  const filename = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const named = byFilename.get(filename);
  if (named) return named;
  if (filename === "dockerfile" || filename.startsWith("dockerfile."))
    return info("dockerfile", "Dockerfile");
  if (filename.endsWith(".cmake.in")) return info("cmake", "CMake");
  // A dotted double extension first ("foo.m.wl" is Wolfram, not Objective-C), then the last one.
  const parts = filename.split(".");
  if (parts.length > 2) {
    const double = extensionTable.get(parts.slice(-2).join("."));
    if (double) return double;
  }
  if (parts.length < 2) return PLAIN;
  return extensionTable.get(parts[parts.length - 1]) ?? PLAIN;
}
