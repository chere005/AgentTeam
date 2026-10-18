/**
 * Pure helpers for remote-aware Git workflows: remote URL parsing, pull-request (compare) URL
 * construction, classification of Git network failures, commit-log parsing and conflict-marker
 * parsing. No I/O and no API calls: a PR link is only a URL that the user opens in a browser.
 */

export type Provider = "github" | "gitlab" | "bitbucket" | "unknown";
export type RemoteInfo = {
  /** Web host, e.g. github.com. */
  host: string;
  /** Repository path without .git, e.g. owner/repo or group/sub/repo. */
  path: string;
  provider: Provider;
  /** Original transport; credentials are never kept. */
  protocol: "https" | "http" | "ssh" | "git";
  /** Credential-free URL safe to display. */
  display: string;
};

export function providerForHost(host: string): Provider {
  const h = host.toLowerCase();
  if (h === "github.com" || h.startsWith("github.") || h.includes(".github."))
    return "github";
  if (h === "gitlab.com" || h.startsWith("gitlab.") || h.includes(".gitlab."))
    return "gitlab";
  if (
    h === "bitbucket.org" ||
    h.startsWith("bitbucket.") ||
    h.includes(".bitbucket.")
  )
    return "bitbucket";
  return "unknown";
}

const cleanPath = (p: string) =>
  p
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");

/** Parse https, ssh://, git:// and scp-like (git@host:owner/repo) remote URLs. Local paths give null. */
export function parseRemoteUrl(raw: string): RemoteInfo | null {
  const value = raw.trim();
  if (!value || /[\0\r\n]/.test(value)) return null;
  const scp = /^(?:[^@/\\\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)([^\\\s]+)$/.exec(
    value,
  );
  let host: string, path: string, protocol: RemoteInfo["protocol"];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const scheme = url.protocol.replace(":", "").toLowerCase();
    if (!["https", "http", "ssh", "git", "git+ssh", "ssh+git"].includes(scheme))
      return null;
    protocol = scheme.includes("ssh")
      ? "ssh"
      : (scheme as RemoteInfo["protocol"]);
    host = url.hostname;
    path = cleanPath(decodeURIComponent(url.pathname));
  } else if (scp && !/^[A-Za-z]:[\\/]/.test(value)) {
    host = scp[1];
    path = cleanPath(scp[2]);
    protocol = "ssh";
  } else return null;
  if (!host || !path || path.split("/").some((s) => !s || s === ".."))
    return null;
  host = host.toLowerCase();
  return {
    host,
    path,
    provider: providerForHost(host),
    protocol,
    display: `${protocol === "ssh" ? "ssh" : protocol}://${host}/${path}`,
  };
}

const segments = (value: string) =>
  value.split("/").map(encodeURIComponent).join("/");

/**
 * Compare / new-merge-request URL for the remote. Returns null for hosts whose web layout is not
 * known (the caller should then show the repository URL only).
 */
export function compareUrl(
  remote: RemoteInfo,
  head: string,
  base: string,
): string | null {
  // ssh/git remotes have no web scheme; every supported host serves its web UI over https.
  const origin = `${remote.protocol === "http" ? "http" : "https"}://${remote.host}`;
  const repo = segments(remote.path);
  if (remote.provider === "github")
    return `${origin}/${repo}/compare/${segments(base)}...${segments(head)}?expand=1`;
  if (remote.provider === "gitlab")
    return (
      `${origin}/${repo}/-/merge_requests/new?` +
      `merge_request%5Bsource_branch%5D=${encodeURIComponent(head)}&merge_request%5Btarget_branch%5D=${encodeURIComponent(base)}`
    );
  if (remote.provider === "bitbucket")
    return `${origin}/${repo}/pull-requests/new?source=${encodeURIComponent(head)}&dest=${encodeURIComponent(base)}`;
  return null;
}
export const repositoryUrl = (remote: RemoteInfo) =>
  `${remote.protocol === "http" ? "http" : "https"}://${remote.host}/${segments(remote.path)}`;

/** Only plain web URLs may be handed to the system browser. */
export function isBrowserUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password &&
      !/[\0\r\n]/.test(value)
    );
  } catch {
    return false;
  }
}

export type GitFailureKind =
  | "auth_failed"
  | "non_fast_forward"
  | "no_upstream"
  | "no_remote"
  | "diverged"
  | "network"
  | "conflict"
  | "local_changes"
  | "not_fast_forward_possible"
  | "rejected"
  | "unknown";
export type GitFailure = { kind: GitFailureKind; message: string };

/** Turn Git stderr into a stable code and an actionable sentence. The raw text is kept by callers. */
export function classifyGitFailure(stderr: string): GitFailure {
  const text = stderr || "";
  const rules: [RegExp, GitFailureKind, string][] = [
    [
      /(Authentication failed|could not read Username|could not read Password|Permission denied \((publickey|keyboard)|terminal prompts disabled|HTTP Basic: Access denied|invalid credentials|Permission to .* denied|access denied)/i,
      "auth_failed",
      "Authentication failed. AgentTeam never asks for or stores Git credentials: configure a credential helper or SSH key outside the app, then retry.",
    ],
    [
      /(no upstream branch|has no upstream|There is no tracking information|no tracking information)/i,
      "no_upstream",
      "This branch has no upstream. Push with 'set upstream' to publish it first.",
    ],
    [
      /(does not appear to be a git repository|No such remote|no configured push destination|No remote repository specified|No remote|'[^']*' does not appear)/i,
      "no_remote",
      "The remote is missing or unreachable. Check the configured remotes.",
    ],
    [
      /(non-fast-forward|fetch first|tip of your current branch is behind|Updates were rejected because)/i,
      "non_fast_forward",
      "The remote has commits you do not have. Fetch and pull (or rebase) first; force push is not offered.",
    ],
    [
      /(Not possible to fast-forward|diverging branches|have diverged|cannot fast-forward)/i,
      "not_fast_forward_possible",
      "Local and remote branches have diverged, so a fast-forward pull is not possible. Choose merge or rebase deliberately.",
    ],
    [
      /(CONFLICT|Automatic merge failed|could not apply|fix conflicts)/i,
      "conflict",
      "The operation stopped with conflicts. Resolve them in the conflict view, then continue or abort.",
    ],
    [
      /(would be overwritten|Your local changes|commit your changes or stash|unstaged changes|cannot pull with rebase)/i,
      "local_changes",
      "Local uncommitted changes would be overwritten. Commit or stash them first.",
    ],
    [
      /(Could not resolve host|Connection (refused|timed out|reset)|unable to access|Network is unreachable|Could not read from remote|Operation timed out|early EOF)/i,
      "network",
      "The remote could not be reached. Check the network and the remote URL.",
    ],
    [
      /(\[remote rejected\]|\[rejected\]|pre-receive hook declined|protected branch)/i,
      "rejected",
      "The remote rejected the update (for example a protected branch or a server-side hook).",
    ],
  ];
  for (const [re, kind, message] of rules)
    if (re.test(text)) return { kind, message };
  return {
    kind: "unknown",
    message: text.trim().slice(0, 500) || "Git command failed",
  };
}

export type LogEntry = {
  sha: string;
  short: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
  subject: string;
  refs: string[];
};
export const LOG_FORMAT = "%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1f%D%x1e";
export function parseLog(raw: string): LogEntry[] {
  return raw
    .split("\x1e")
    .map((r) => r.replace(/^\n+/, ""))
    .filter((r) => r.trim())
    .map((r) => {
      const [sha, short, author, email, date, parents, subject, refs] =
        r.split("\x1f");
      return {
        sha,
        short,
        author,
        email,
        date,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        subject: subject ?? "",
        refs: refs
          ? refs
              .split(", ")
              .map((x) => x.replace(/^HEAD -> /, "").trim())
              .filter((x) => x && x !== "HEAD")
          : [],
      };
    });
}

export type ConflictSection = {
  /** 1-based line of the opening marker. */
  startLine: number;
  endLine: number;
  oursLabel: string;
  theirsLabel: string;
  ours: string[];
  base: string[] | null;
  theirs: string[];
  truncated: boolean;
};
export type ConflictMarkers = {
  sections: ConflictSection[];
  sectionCount: number;
  /** True when the file still has an unterminated or unmatched marker. */
  malformed: boolean;
  hasMarkers: boolean;
};
export const MAX_SECTION_LINES = 200;
export const MAX_SECTIONS = 50;

/** Find merge-conflict regions (<<<<<<<, optional |||||||, =======, >>>>>>>); read-only and bounded. */
export function parseConflictMarkers(text: string): ConflictMarkers {
  const lines = text.split(/\r?\n/);
  const sections: ConflictSection[] = [];
  let count = 0,
    malformed = false,
    current: (ConflictSection & { part: "ours" | "base" | "theirs" }) | null =
      null;
  const push = (arr: string[], line: string, cur: ConflictSection) => {
    if (arr.length < MAX_SECTION_LINES) arr.push(line);
    else cur.truncated = true;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^<{7}(?: |$)/.test(line)) {
      if (current) malformed = true;
      current = {
        startLine: i + 1,
        endLine: i + 1,
        oursLabel: line.slice(8).trim(),
        theirsLabel: "",
        ours: [],
        base: null,
        theirs: [],
        truncated: false,
        part: "ours",
      };
    } else if (current && /^\|{7}(?: |$)/.test(line)) {
      current.base = [];
      current.part = "base";
    } else if (current && /^={7}$/.test(line)) {
      current.part = "theirs";
    } else if (current && /^>{7}(?: |$)/.test(line)) {
      count++;
      const { part: _part, ...done } = current;
      done.theirsLabel = line.slice(8).trim();
      done.endLine = i + 1;
      if (sections.length < MAX_SECTIONS) sections.push(done);
      current = null;
    } else if (current) {
      push(
        current.part === "ours"
          ? current.ours
          : current.part === "base"
            ? current.base!
            : current.theirs,
        line,
        current,
      );
    }
  }
  if (current) malformed = true;
  return {
    sections,
    sectionCount: count,
    malformed,
    hasMarkers: count > 0 || malformed,
  };
}

export type ConflictCode = "UU" | "AA" | "DD" | "AU" | "UA" | "DU" | "UD";
const CONFLICT = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"]);
export const isConflictStatus = (status: string): status is ConflictCode =>
  CONFLICT.has(status);
export function describeConflict(code: ConflictCode) {
  return {
    UU: "Both sides modified",
    AA: "Both sides added",
    DD: "Both sides deleted",
    AU: "Added by us, modified by them",
    UA: "Modified by us, added by them",
    DU: "Deleted by us, modified by them",
    UD: "Modified by us, deleted by them",
  }[code];
}
