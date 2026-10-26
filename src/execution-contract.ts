// The application-owned execution contract (reliable-execution plan item 1).
//
// A contract is persisted per project (`project:<workflowId>`) and per participating task
// (`task:<taskId>`) as an `execution-contract` entity: the kind of work, the authorized project
// folder and narrower task scopes, the capabilities each role needs, expected files, the checks
// that are required, designated reviewers, approval conditions and the correction-round cap.
//
// A model may PROPOSE parts of it (the `contract` argument of invoke_teammate, the completion
// checks it supplies), but only the application decides what is retained:
//  - the work kind only ever rises unless the user says otherwise (`workKindSource: "user"`);
//  - a child task inherits the obligations of its parent and may narrow its scope, never drop a
//    required file, a required check or a reviewer, so omitting paths or checks on a retry keeps
//    them (`planChild`);
//  - a literal expectation a model invented (`output-matches` / `artifact-matches`) is advisory
//    and labelled unverified, not enforced as pass/fail, BUT it keeps its slot: until the user
//    confirms it or a validated replacement exists, the task cannot complete (finding 8).
// Existing projects have no contract entity; they keep running on the grant-based predicate in
// src/launch-readiness.ts and are never given inferred requirements (migration rule).
import { createHash } from "node:crypto";
import { z } from "zod";
import { assert, type Agent, type Task } from "./model.ts";
import {
  completionCheckSchema,
  type CompletionCheck,
} from "./limits-schema.ts";
import { contains } from "./resources.ts";
import { teamProfile } from "./team-profiles.ts";
import { CAPABILITIES } from "./launch-capability.ts";
import type { TeamService } from "./service.ts";

export const WORK_KINDS = [
  "response-only",
  "file-edit",
  "executable-implementation",
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];
const RANK: Record<WorkKind, number> = {
  "response-only": 0,
  "file-edit": 1,
  "executable-implementation": 2,
};
export const rankOf = (kind: WorkKind) => RANK[kind];
export const stricterKind = (a: WorkKind, b: WorkKind): WorkKind =>
  RANK[b] > RANK[a] ? b : a;

export const ROLE_CLASSES = [
  "implementer",
  "reviewer",
  "adjudicator",
  "coordinator",
  "reporter",
  "custom",
] as const;
export type RoleClass = (typeof ROLE_CLASSES)[number];

/** How the work kind was established; only "user" may lower it again. */
export const WORK_KIND_SOURCES = [
  "request",
  "assignment",
  "proposal",
  "user",
  "inherited",
] as const;

// ---- request classification ---------------------------------------------------------------------

export type Classification = { workKind: WorkKind; signals: string[] };
const VERBS =
  /\b(write|create|make|build|implement|develop|code|program|generate|compile|run|execute|test|debug|fix|refactor|port|translate|install|deploy|script|compute|calculate|produce)\b/g;
const CODE_NOUNS =
  /\b(program|programs|script|scripts|code|function|functions|class|classes|module|library|app|application|cli|binary|executable|compiler|algorithm|implementation|unit tests?|test suite|python|c\+\+|cpp|typescript|javascript|node\.?js|java|rust|golang|ruby|swift|kotlin|bash|sql)\b/g;
const EXECUTION_CUES =
  /\b(compile|run it|runs it|execute it|exit code|stdout|passes the tests|make test|runs? (?:the|your) (?:program|code|script))\b/g;
const FILE_VERBS =
  /\b(write|create|save|edit|update|modify|append|rename|delete|generate|add|put|make)\b/g;
const FILE_NOUNS =
  /\b(files?|documents?|readme|markdown|json|csv|yaml|toml|configs?|folders?|directory|directories)\b|\.[a-z0-9]{1,6}\b/g;
const DISCUSSION =
  /^\s*(?:what|why|how (?:do|does|can|would|should|is|are)|can you explain|could you explain|explain|describe|summari[sz]e|compare|tell me|is it|are there|should i|what's|whats)\b/i;
const THEN_ACTION =
  /\b(?:and then|then|after that|afterwards)\s+(?:write|create|build|make|implement|run|execute|compile|generate|save)\b/i;

const matches = (re: RegExp, text: string) => [
  ...new Set((text.toLowerCase().match(re) ?? []).map((m) => m.trim())),
];

/**
 * The application's own, conservative reading of a request: what would have to exist for the
 * request to be done. It is a floor, never a ceiling: a model's proposal can raise it, only the
 * user can lower it, and every signal is recorded so the reading can be explained and corrected.
 */
export function classifyRequest(text: string): Classification {
  const body = text.slice(0, 8000);
  if (DISCUSSION.test(body) && !THEN_ACTION.test(body))
    return { workKind: "response-only", signals: ["discussion"] };
  const verbs = matches(VERBS, body);
  const nouns = matches(CODE_NOUNS, body);
  const cues = matches(EXECUTION_CUES, body);
  if ((verbs.length && nouns.length) || (cues.length && verbs.length))
    return {
      workKind: "executable-implementation",
      signals: [
        ...verbs.slice(0, 3).map((v) => `verb:${v}`),
        ...nouns.slice(0, 3).map((n) => `noun:${n}`),
        ...cues.slice(0, 2).map((c) => `cue:${c}`),
      ],
    };
  const fileVerbs = matches(FILE_VERBS, body);
  const fileNouns = matches(FILE_NOUNS, body);
  if (fileVerbs.length && fileNouns.length)
    return {
      workKind: "file-edit",
      signals: [
        ...fileVerbs.slice(0, 3).map((v) => `verb:${v}`),
        ...fileNouns.slice(0, 3).map((n) => `noun:${n}`),
      ],
    };
  return { workKind: "response-only", signals: [] };
}

// ---- checks -------------------------------------------------------------------------------------

export const isLiteralCheck = (check: CompletionCheck) =>
  check.type === "output-matches" || check.type === "artifact-matches";
const normalizeRel = (path: string) =>
  path.replace(/\\/g, "/").replace(/^\.\//, "");
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : v,
  );
/** One slot per kind and target: a retry cannot pile up duplicates or step around a slot. */
export function checkSlot(check: CompletionCheck): string {
  switch (check.type) {
    case "artifact-exists":
    case "artifact-matches":
      return `${check.type}:${normalizeRel(check.path)}`;
    case "output-fields":
      return `output-fields:${[...check.fields].sort().join(",")}`;
    default:
      return check.type;
  }
}
/** Literal runs (6+ characters) an `output-matches` / `artifact-matches` pattern insists on. */
export function literalRuns(pattern: string): string[] {
  const runs: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim().length >= 6) runs.push(current.trim());
    current = "";
  };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[++i];
      if (next !== undefined && /[.\-/\\^$*+?()[\]{}|]/.test(next))
        current += next;
      else flush();
      continue;
    }
    if (c === "[") {
      flush();
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "{") {
      flush();
      while (i < pattern.length && pattern[i] !== "}") i++;
      continue;
    }
    if ("^$()|*+?.".includes(c)) {
      flush();
      continue;
    }
    current += c;
  }
  flush();
  return runs;
}
const tokens = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
/**
 * Whether every word and number a literal insists on comes from `corpus` (the user's own words
 * and the team's agent names). Small numbers (up to three digits) are accepted as enumerators
 * ("Agent 1"); a long digit string, a hash or a made-up expected value is not.
 */
export function groundedLiteral(pattern: string, corpus: string): boolean {
  const known = new Set(tokens(corpus));
  return literalRuns(pattern).every((run) =>
    tokens(run).every((t) => /^\d{1,3}$/.test(t) || known.has(t)),
  );
}

export const contractCheckSchema = z
  .object({
    slot: z.string().min(1).max(400),
    check: completionCheckSchema,
    /** Encodes an expected value (a model can invent it, and be wrong). */
    literal: z.boolean(),
    origin: z.enum(["user", "request", "parent", "model", "app"]),
    confirmation: z.enum(["confirmed", "unconfirmed"]),
    /** advisory = recorded and shown as unverified, never enforced as pass/fail. */
    enforcement: z.enum(["enforced", "advisory"]),
    label: z.literal("unverified").optional(),
    note: z.string().max(500).optional(),
    proposedBy: z.string().max(200).optional(),
    at: z.string().max(40),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      c.enforcement === "advisory" &&
      !(c.literal && c.confirmation === "unconfirmed")
    )
      ctx.addIssue({
        code: "custom",
        message: "Only an unconfirmed literal check can be advisory",
      });
    if (
      c.enforcement === "enforced" &&
      c.literal &&
      c.confirmation !== "confirmed"
    )
      ctx.addIssue({
        code: "custom",
        message: "A literal check is enforced only once it is confirmed",
      });
  });
export type ContractCheck = z.infer<typeof contractCheckSchema>;

/** A relative path inside the project folder (no drive, no `..`, never Git internals). */
export const isRelativeFile = (p: string) =>
  p.length > 0 &&
  p.length <= 500 &&
  !p.includes("\0") &&
  !/^([A-Za-z]:)?[\\/]/.test(p) &&
  !p.split(/[\\/]/).includes("..") &&
  !p.split(/[\\/]/).some((s) => s.toLowerCase() === ".git");
const relativeFile = z.string().refine(isRelativeFile, {
  message: "Expected files are relative paths inside the project folder",
});
const roleRequirementSchema = z
  .object({
    role: z.enum(ROLE_CLASSES),
    capabilities: z.array(z.enum(CAPABILITIES)).max(3),
  })
  .strict();
export type RoleRequirement = z.infer<typeof roleRequirementSchema>;

export const executionContractSchema = z
  .object({
    id: z.string().min(1).max(300),
    scope: z.enum(["project", "task"]),
    workflowId: z.string().min(1).max(200),
    taskId: z.string().min(1).max(200).optional(),
    /** The contract this one inherits from (children narrow it, never drop from it). */
    parent: z.string().max(300).optional(),
    workKind: z.enum(WORK_KINDS),
    workKindSource: z.enum(WORK_KIND_SOURCES),
    /** Words of the request that led to the reading (explains it; the user can correct it). */
    signals: z.array(z.string().max(80)).max(20).default([]),
    /** The original request, retained so later steps cannot reinterpret it. */
    userIntent: z.string().max(5000).default(""),
    /** A chat request: the conversation and message it came from, so "Start" can send it again once ready. */
    origin: z
      .object({
        sessionId: z.string().min(1).max(200),
        messageId: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    projectFolder: z.string().max(4096).optional(),
    scopes: z.array(z.string().max(4096)).max(50).default([]),
    roles: z.array(roleRequirementSchema).max(8).default([]),
    expectedFiles: z.array(relativeFile).max(50).default([]),
    requiredChecks: z.array(contractCheckSchema).max(60).default([]),
    designatedReviewers: z.array(z.string().max(200)).max(20).default([]),
    /**
     * What a model proposed for work handed to one recipient (keyed by recipient id), kept even
     * when the call was refused: a retry that omits the files or checks gets them back. Literal
     * proposals live here as unverified slots until the user confirms them.
     */
    retained: z
      .record(
        z.string().max(200),
        z
          .object({
            checks: z.array(contractCheckSchema).max(30),
            expectedFiles: z.array(relativeFile).max(30),
            workKind: z.enum(WORK_KINDS),
            at: z.string().max(40),
          })
          .strict(),
      )
      .default({}),
    approval: z
      .object({
        reviewerIds: z.array(z.string().max(200)).max(20),
        policy: z.literal("all-approve"),
      })
      .strict()
      .optional(),
    maxCorrectionRounds: z.number().int().min(0).max(10).default(2),
    createdAt: z.string().max(40),
    updatedAt: z.string().max(40),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.scope === "task" && !c.taskId)
      ctx.addIssue({
        code: "custom",
        message: "A task contract names its task",
      });
    if (
      c.workKind === "response-only" &&
      c.roles.some((r) => r.capabilities.length)
    )
      ctx.addIssue({
        code: "custom",
        message: "A response-only contract requires no capabilities",
      });
    for (const r of c.roles)
      if (
        (r.role === "reviewer" || r.role === "adjudicator") &&
        r.capabilities.some((cap) => cap !== "read")
      )
        ctx.addIssue({
          code: "custom",
          message: `A ${r.role} may only be required to read`,
        });
    if (c.projectFolder)
      for (const scope of c.scopes)
        if (!contains(c.projectFolder, scope))
          ctx.addIssue({
            code: "custom",
            message: `Scope ${scope} is outside the authorized project folder`,
          });
  });
export type ExecutionContract = z.infer<typeof executionContractSchema>;
/** The part of a contract the readiness evaluator reads (a transient draft satisfies it too). */
export type ContractLike = Pick<
  ExecutionContract,
  "scope" | "workKind" | "workKindSource" | "roles"
> & { projectFolder?: string };

/** What a model may propose for a delegated task (strict and bounded; never trusted as written). */
export const contractProposalSchema = z
  .object({
    workKind: z.enum(WORK_KINDS).optional(),
    expectedFiles: z.array(relativeFile).max(30).optional(),
    maxCorrectionRounds: z.number().int().min(0).max(10).optional(),
  })
  .strict();
export type ContractProposal = z.infer<typeof contractProposalSchema>;

/** Capabilities a work kind needs from the role that does the work. */
export function kindCapabilities(kind: WorkKind) {
  return kind === "executable-implementation"
    ? (["read", "write", "shell"] as const)
    : kind === "file-edit"
      ? (["read", "write"] as const)
      : ([] as const);
}
export function defaultRoles(kind: WorkKind): RoleRequirement[] {
  if (kind === "response-only") return [];
  return [
    { role: "implementer", capabilities: [...kindCapabilities(kind)] },
    { role: "reviewer", capabilities: ["read"] },
    { role: "adjudicator", capabilities: ["read"] },
  ];
}

const now = () => new Date().toISOString();
export const contractHash = (c: ExecutionContract) =>
  createHash("sha256")
    .update(canonical({ ...c, updatedAt: undefined }))
    .digest("hex");

export type ChildPlan = {
  /** False when no contract governs the delegation: the legacy grant-based predicate applies. */
  governed: boolean;
  workKind: WorkKind | null;
  /** Checks the child must satisfy: the model's structural and grounded checks plus the contract's enforced ones. */
  completionChecks: CompletionCheck[];
  /** Literal checks held back as unverified (kept as unresolved slots, never enforced as pass/fail). */
  advisory: ContractCheck[];
  /** Task contract to persist once the child exists (null for response-only children). */
  draft: Omit<ExecutionContract, "id" | "taskId"> | null;
  /** The contract the delegation inherits from (the nearest contract above the caller's task). */
  parent: ExecutionContract | null;
};

export class ContractService {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }
  get(id: string): ExecutionContract | null {
    try {
      return this.store.get<ExecutionContract>("execution-contract", id);
    } catch {
      return null;
    }
  }
  project(workflowId: string) {
    return this.get(`project:${workflowId}`);
  }
  task(taskId: string) {
    return this.get(`task:${taskId}`);
  }
  /** The contract that governs a task: its own, else the nearest ancestor's, else its project's. */
  effective(
    task: Pick<Task, "id" | "parentTaskId" | "workflowId">,
  ): ExecutionContract | null {
    const own = this.task(task.id);
    if (own) return own;
    const seen = new Set<string>([task.id]);
    let parentId = task.parentTaskId;
    while (parentId && !seen.has(parentId) && seen.size < 24) {
      seen.add(parentId);
      const inherited = this.task(parentId);
      if (inherited) return inherited;
      try {
        parentId = this.store.get<Task>("task", parentId).parentTaskId;
      } catch {
        break;
      }
    }
    return this.project(task.workflowId);
  }
  private save(contract: ExecutionContract) {
    const parsed = executionContractSchema.parse({
      ...contract,
      updatedAt: now(),
    });
    this.store.put("execution-contract", parsed);
    return parsed;
  }
  private reviewersOf(agent: Agent | undefined, teamId?: string) {
    const id =
      teamId ??
      (agent ? this.service.teamSpaces.teamOfAgent(agent) : undefined);
    const profile = id ? teamProfile(this.store, id) : null;
    if (!profile) return [];
    return [
      ...new Set(
        ["codexReview", "fableReview", "finalCodex", "finalFable"].flatMap(
          (role) => profile.roles?.[role] ?? [],
        ),
      ),
    ];
  }

  /**
   * Create or raise the project contract for a request or an assignment. Response-only requests
   * persist nothing (ordinary discussion needs no contract). The work kind only rises, except
   * when the user chose it.
   */
  seedProject(input: {
    workflowId: string;
    text: string;
    source: "request" | "assignment";
    workKind?: WorkKind;
    projectFolder?: string;
    owner?: Agent;
    teamId?: string;
    maxCorrectionRounds?: number;
    origin?: { sessionId: string; messageId: string };
  }): ExecutionContract | null {
    const classified = classifyRequest(input.text);
    const kind = stricterKind(
      classified.workKind,
      input.workKind ?? "response-only",
    );
    const existing = this.project(input.workflowId);
    if (!existing && kind === "response-only") return null;
    if (existing) {
      if (
        existing.workKindSource === "user" ||
        rankOf(kind) <= rankOf(existing.workKind)
      )
        return existing;
      return this.save({
        ...existing,
        workKind: kind,
        workKindSource: input.source,
        signals: classified.signals,
        roles: defaultRoles(kind),
      });
    }
    const reviewers = this.reviewersOf(input.owner, input.teamId);
    const created = now();
    return this.save({
      id: `project:${input.workflowId}`,
      scope: "project",
      workflowId: input.workflowId,
      workKind: kind,
      workKindSource: input.source,
      signals: classified.signals,
      userIntent: input.text.slice(0, 5000),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.projectFolder ? { projectFolder: input.projectFolder } : {}),
      scopes: [],
      roles: defaultRoles(kind),
      expectedFiles: [],
      requiredChecks: [],
      designatedReviewers: reviewers,
      retained: {},
      ...(reviewers.length
        ? {
            approval: {
              reviewerIds: reviewers,
              policy: "all-approve" as const,
            },
          }
        : {}),
      maxCorrectionRounds: input.maxCorrectionRounds ?? 2,
      createdAt: created,
      updatedAt: created,
    });
  }

  /** Chat preparation: classify the user's message and persist the contract before any child can start. */
  prepareConversation(input: {
    workflowId: string;
    agent: Agent;
    text: string;
    origin?: { sessionId: string; messageId: string };
  }): ExecutionContract | null {
    return this.seedProject({
      workflowId: input.workflowId,
      text: input.text,
      source: "request",
      owner: input.agent,
      ...(input.origin ? { origin: input.origin } : {}),
    });
  }

  /** The user's explicit reading of the work (the only way to lower it, or to waive the grant floor). */
  setUserWorkKind(workflowId: string, kind: WorkKind) {
    const existing = this.project(workflowId);
    const created = now();
    const base: ExecutionContract = existing ?? {
      id: `project:${workflowId}`,
      scope: "project",
      workflowId,
      workKind: kind,
      workKindSource: "user",
      signals: [],
      userIntent: "",
      scopes: [],
      roles: [],
      expectedFiles: [],
      requiredChecks: [],
      designatedReviewers: [],
      retained: {},
      maxCorrectionRounds: 2,
      createdAt: created,
      updatedAt: created,
    };
    const saved = this.save({
      ...base,
      workKind: kind,
      workKindSource: "user",
      roles: defaultRoles(kind),
    });
    this.store.emit("contract.updated", saved.id, {
      workflowId,
      workKind: kind,
      by: "user",
    });
    return saved;
  }

  /**
   * The user's own requirements for the project: files that must exist and checks that must pass.
   * They are confirmed by construction (the user wrote them, literals included), apply to every
   * deliverable child created from now on, and cannot be dropped by a delegation that omits them.
   */
  setRequirements(
    workflowId: string,
    input: {
      expectedFiles?: string[];
      checks?: unknown[];
      maxCorrectionRounds?: number;
    },
  ) {
    const contract = this.project(workflowId);
    assert(
      contract,
      "contract_not_found",
      "This project has no contract yet; set the kind of work first",
      404,
    );
    const files = input.expectedFiles
      ? [...new Set(input.expectedFiles.map(normalizeRel))]
      : contract.expectedFiles;
    for (const file of files)
      assert(
        isRelativeFile(file),
        "invalid_expected_file",
        `Expected file ${file} must be a relative path inside the project folder`,
        400,
      );
    const slots = new Map(contract.requiredChecks.map((c) => [c.slot, c]));
    for (const raw of input.checks ?? []) {
      const check = completionCheckSchema.parse(raw);
      const slot = checkSlot(check);
      slots.set(slot, {
        slot,
        check,
        literal: isLiteralCheck(check),
        origin: "user",
        confirmation: "confirmed",
        enforcement: "enforced",
        at: now(),
      });
    }
    const saved = this.save({
      ...contract,
      expectedFiles: files,
      requiredChecks: [...slots.values()],
      ...(input.maxCorrectionRounds !== undefined
        ? { maxCorrectionRounds: input.maxCorrectionRounds }
        : {}),
    });
    this.store.emit("contract.updated", saved.id, {
      workflowId,
      by: "user",
      requirements: true,
    });
    return saved;
  }

  /** Record the authorized project folder (setup step); never moves an already authorized one. */
  authorizeFolder(workflowId: string, folder: string) {
    const existing = this.project(workflowId);
    if (!existing || existing.projectFolder) return existing;
    return this.save({ ...existing, projectFolder: folder });
  }

  private corpusOf(contract: ExecutionContract | null) {
    const names = this.store
      .list<Agent>("agent")
      .map((a) => `${a.name} ${a.nickname}`)
      .join(" ");
    return `${contract?.userIntent ?? ""} ${names}`;
  }

  /**
   * Apply a model's checks to the ones already held for this assignment: structural checks join
   * the required set, a literal becomes an enforced check only when the user's own words (or an
   * earlier confirmation) back it, otherwise it stays an advisory, unverified slot. A held slot
   * is never removed or replaced by a model; an unconfirmed one may be re-proposed.
   */
  private mergeChecks(
    held: ContractCheck[],
    proposed: CompletionCheck[],
    context: { corpus: string; proposedBy: string },
  ) {
    const slots = new Map(held.map((c) => [c.slot, c]));
    for (const check of proposed) {
      const slot = checkSlot(check);
      const had = slots.get(slot);
      if (
        had &&
        (had.enforcement === "enforced" || had.confirmation === "confirmed")
      )
        continue; // a model never replaces an enforced or confirmed slot
      if (!isLiteralCheck(check)) {
        slots.set(slot, {
          slot,
          check,
          literal: false,
          origin: "model",
          confirmation: "confirmed",
          enforcement: "enforced",
          proposedBy: context.proposedBy,
          at: now(),
        });
        continue;
      }
      const grounded = groundedLiteral(
        (check as { pattern: string }).pattern,
        context.corpus,
      );
      slots.set(
        slot,
        grounded
          ? {
              slot,
              check,
              literal: true,
              origin: "request",
              confirmation: "confirmed",
              enforcement: "enforced",
              proposedBy: context.proposedBy,
              at: now(),
            }
          : {
              slot,
              check,
              literal: true,
              origin: "model",
              confirmation: "unconfirmed",
              enforcement: "advisory",
              label: "unverified",
              note: "A model proposed this expected value; it is not enforced as pass/fail until you confirm it or a validated replacement exists.",
              proposedBy: context.proposedBy,
              at: now(),
            },
      );
    }
    return [...slots.values()];
  }

  /**
   * Plan a delegated child BEFORE it exists. Retains what the model proposed for this recipient
   * on the governing contract even if the call is refused afterwards (a retry that omits it cannot
   * drop it) and returns what the child must satisfy. Delegations no contract governs (no
   * contract above the caller, no proposal that makes the work actionable) pass through untouched.
   */
  planChild(input: {
    parent: Task;
    caller: Agent;
    recipient: Agent;
    title: string;
    instructions: string;
    proposal?: ContractProposal;
    completionChecks: CompletionCheck[];
    resourcePaths: string[];
  }): ChildPlan {
    const ungoverned: ChildPlan = {
      governed: false,
      workKind: null,
      completionChecks: input.completionChecks,
      advisory: [],
      draft: null,
      parent: null,
    };
    const inherited = this.effective(input.parent);
    const own = classifyRequest(`${input.title}\n${input.instructions}`);
    const proposedKind = input.proposal?.workKind ?? "response-only";
    const askedKind = stricterKind(own.workKind, proposedKind);
    if (!inherited && (!input.proposal || askedKind === "response-only"))
      return ungoverned;
    // A model's proposal can make an unclassified conversation actionable: the contract is then
    // created from the user's retained words, so it can only rise from here on.
    const holder: ExecutionContract =
      inherited ??
      this.seedProject({
        workflowId: input.parent.workflowId,
        text: `${input.parent.title}\n${input.parent.instructions}`,
        source: "request",
        workKind: askedKind,
        owner: input.caller,
      })!;
    // What this recipient was already asked for cannot be lowered by rewording the next call; only
    // an explicit analysis request (the application's own reading of the child's words, agreed by
    // the proposal) is a response-only subtask next to an executable parent.
    const retainedKind =
      holder.retained[input.recipient.id]?.workKind ?? "response-only";
    const analysis =
      own.signals.includes("discussion") && proposedKind === "response-only";
    const kind = analysis ? askedKind : stricterKind(askedKind, retainedKind);
    const source: ExecutionContract["workKindSource"] =
      rankOf(proposedKind) > rankOf(own.workKind) ? "proposal" : "request";
    const folder = holder.projectFolder;
    if (folder)
      for (const scope of input.resourcePaths)
        assert(
          contains(folder, scope),
          "scope_outside_contract",
          `The task folder ${scope} is outside the authorized project folder ${folder}. A delegated task may narrow its folder but not leave it.`,
          403,
        );
    const retained = holder.retained[input.recipient.id];
    // What the user wrote for the project is not the model's to re-propose or replace.
    const fixed = holder.requiredChecks.filter(
      (c) => c.enforcement === "enforced",
    );
    const fixedSlots = new Set(fixed.map((c) => c.slot));
    const slots = this.mergeChecks(
      (retained?.checks ?? []).filter((c) => !fixedSlots.has(c.slot)),
      input.completionChecks.filter((c) => !fixedSlots.has(checkSlot(c))),
      {
        corpus: this.corpusOf(holder),
        proposedBy: input.caller.id,
      },
    );
    assert(
      slots.length <= 30,
      "too_many_requirements",
      "This recipient already has 30 required checks; confirm or remove some before adding more.",
      400,
    );
    // Only plain relative paths are retained; the delegation itself validates and normalizes the
    // paths it was given (an absolute path inside the task folder is converted there).
    const files = [
      ...new Set(
        [
          ...holder.expectedFiles,
          ...(retained?.expectedFiles ?? []),
          ...(input.proposal?.expectedFiles ?? []),
          ...input.completionChecks.flatMap((c) =>
            c.type === "artifact-exists" ? [normalizeRel(c.path)] : [],
          ),
        ].filter(isRelativeFile),
      ),
    ];
    assert(
      files.length <= 30,
      "too_many_requirements",
      "This recipient already has 30 expected files; remove some before adding more.",
      400,
    );
    // Retain before anything can refuse the call. Repeating the same call changes nothing.
    const sameAsHeld = (a: typeof retained, b: typeof retained) =>
      canonical({
        ...a,
        at: undefined,
        checks: a?.checks.map((c) => ({ ...c, at: undefined })),
      }) ===
      canonical({
        ...b,
        at: undefined,
        checks: b?.checks.map((c) => ({ ...c, at: undefined })),
      });
    const next = {
      checks: slots,
      expectedFiles: files,
      workKind: stricterKind(kind, retainedKind),
      at: now(),
    };
    const entries = Object.entries({
      ...holder.retained,
      [input.recipient.id]: next,
    });
    const keep = Object.fromEntries(
      entries.sort((a, b) => (a[1].at < b[1].at ? 1 : -1)).slice(0, 40),
    );
    const raise = rankOf(kind) > rankOf(holder.workKind);
    if (
      !sameAsHeld(next, retained) ||
      (raise && holder.workKindSource !== "user")
    )
      this.save({
        ...holder,
        retained: keep,
        ...(raise && holder.workKindSource !== "user"
          ? {
              workKind: kind,
              workKindSource: source,
              roles: defaultRoles(kind),
            }
          : {}),
      });
    const deliverable = kind !== "response-only";
    const effective = new Map<string, CompletionCheck>();
    for (const check of input.completionChecks) {
      const slot = checkSlot(check);
      const held = slots.find((c) => c.slot === slot);
      // A literal held back as unverified is not enforced; everything else the model sent stays.
      if (held?.enforcement === "advisory") continue;
      effective.set(slot, held?.check ?? check);
    }
    if (deliverable) {
      for (const c of [
        ...fixed,
        ...slots.filter((x) => x.enforcement === "enforced"),
      ])
        effective.set(c.slot, c.check);
      for (const file of files) {
        const slot = `artifact-exists:${file}`;
        if (!effective.has(slot))
          effective.set(slot, { type: "artifact-exists", path: file });
      }
    }
    const advisory = deliverable
      ? slots.filter((c) => c.enforcement === "advisory")
      : [];
    const draft = deliverable
      ? {
          scope: "task" as const,
          workflowId: input.parent.workflowId,
          parent: holder.id,
          workKind: kind,
          workKindSource: source,
          signals: own.signals,
          userIntent: holder.userIntent,
          ...(folder ? { projectFolder: folder } : {}),
          scopes: input.resourcePaths,
          roles: [],
          expectedFiles: files,
          requiredChecks: [...fixed, ...slots],
          designatedReviewers: holder.designatedReviewers,
          retained: {},
          ...(holder.approval ? { approval: holder.approval } : {}),
          maxCorrectionRounds:
            input.proposal?.maxCorrectionRounds ?? holder.maxCorrectionRounds,
          createdAt: now(),
          updatedAt: now(),
        }
      : null;
    return {
      governed: true,
      workKind: kind,
      completionChecks: [...effective.values()],
      advisory,
      draft,
      parent: holder,
    };
  }
  /** Persist the child's contract once the task exists. */
  commitChild(plan: ChildPlan, child: Task) {
    if (!plan.draft) return null;
    return this.save({
      ...plan.draft,
      id: `task:${child.id}`,
      taskId: child.id,
    });
  }
  /** Contract for a task created directly (task API, assignment): the app's reading plus any proposal. */
  seedTask(input: {
    task: Task;
    text: string;
    source: "request" | "assignment";
    proposal?: ContractProposal;
  }): ExecutionContract | null {
    const classified = classifyRequest(input.text);
    const kind = stricterKind(
      classified.workKind,
      input.proposal?.workKind ?? "response-only",
    );
    if (kind === "response-only") return null;
    const parent = this.effective(input.task);
    const created = now();
    return this.save({
      id: `task:${input.task.id}`,
      scope: "task",
      taskId: input.task.id,
      workflowId: input.task.workflowId,
      ...(parent ? { parent: parent.id } : {}),
      workKind: kind,
      workKindSource: input.source,
      signals: classified.signals,
      userIntent: input.text.slice(0, 5000),
      ...(parent?.projectFolder ? { projectFolder: parent.projectFolder } : {}),
      scopes: input.task.resourcePaths ?? [],
      roles: [],
      expectedFiles: [
        ...new Set([
          ...(input.proposal?.expectedFiles ?? []),
          ...(input.task.completionChecks ?? []).flatMap((c) =>
            c.type === "artifact-exists" ? [normalizeRel(c.path)] : [],
          ),
        ]),
      ].slice(0, 50),
      requiredChecks: [],
      designatedReviewers: parent?.designatedReviewers ?? [],
      retained: {},
      maxCorrectionRounds: input.proposal?.maxCorrectionRounds ?? 2,
      createdAt: created,
      updatedAt: created,
    });
  }

  /** Required checks on this task that are still unverified: completion stays blocked until resolved. */
  unresolved(task: Pick<Task, "id">): ContractCheck[] {
    return (this.task(task.id)?.requiredChecks ?? []).filter(
      (c) => c.enforcement === "advisory",
    );
  }
  assertCompletable(task: Pick<Task, "id">) {
    const open = this.unresolved(task);
    assert(
      !open.length,
      "required_check_unresolved",
      `A required check is unverified: ${open
        .map(
          (c) =>
            `${c.check.type}${"path" in c.check ? ` ${c.check.path}` : ""} (a model proposed it; it was not enforced)`,
        )
        .join(
          "; ",
        )}. Confirm it or replace it with a validated check before this task can complete.`,
    );
  }
  private contractsOf(workflowId: string) {
    return this.store
      .list<ExecutionContract>("execution-contract")
      .filter((c) => c.workflowId === workflowId);
  }
  /**
   * The user's decision on an unverified slot: keep the proposed literal or edit it. From then on
   * it is enforced and added to the completion checks of the tasks that carry it.
   */
  confirmCheck(
    contractId: string,
    slot: string,
    input: { pattern?: string; flags?: string; note?: string } = {},
  ) {
    const contract = this.get(contractId);
    assert(contract, "contract_not_found", "No such contract", 404);
    const pending = (c: ContractCheck) =>
      c.slot === slot && c.enforcement === "advisory";
    const held =
      contract.requiredChecks.find(pending) ??
      Object.values(contract.retained)
        .flatMap((r) => r.checks)
        .find(pending);
    assert(
      held,
      "check_not_pending",
      `No unverified check ${slot} to confirm`,
      409,
    );
    const next: CompletionCheck = completionCheckSchema.parse(
      input.pattern === undefined
        ? held.check
        : {
            ...held.check,
            pattern: input.pattern,
            ...(input.flags !== undefined ? { flags: input.flags } : {}),
          },
    );
    const confirmed: ContractCheck = {
      slot,
      check: next,
      literal: true,
      origin: "user",
      confirmation: "confirmed",
      enforcement: "enforced",
      ...(input.note ? { note: input.note.slice(0, 500) } : {}),
      at: now(),
    };
    const same = (c: ContractCheck) =>
      pending(c) && canonical(c.check) === canonical(held.check);
    const swap = (list: ContractCheck[]) =>
      list.map((c) => (same(c) ? confirmed : c));
    const carriers = this.contractsOf(contract.workflowId).filter(
      (c) =>
        c.requiredChecks.some(same) ||
        Object.values(c.retained).some((r) => r.checks.some(same)),
    );
    for (const carrier of carriers)
      if (carrier.taskId)
        assert(
          this.store.get<Task>("task", carrier.taskId).status !== "running",
          "task_running",
          "Wait for the running task to stop, then confirm the check",
          409,
        );
    return this.store.transaction(() => {
      for (const carrier of carriers) {
        this.save({
          ...carrier,
          requiredChecks: swap(carrier.requiredChecks),
          retained: Object.fromEntries(
            Object.entries(carrier.retained).map(([key, r]) => [
              key,
              { ...r, checks: swap(r.checks) },
            ]),
          ),
        });
        if (carrier.taskId) {
          const task = this.store.get<Task>("task", carrier.taskId);
          if (
            ["queued", "failed", "interrupted", "blocked"].includes(task.status)
          )
            this.service.limits.setChecks(task.id, [
              ...(task.completionChecks ?? []).filter(
                (c) => checkSlot(c) !== slot,
              ),
              next,
            ]);
        }
      }
      this.store.emit("contract.check_confirmed", contractId, {
        workflowId: contract.workflowId,
        slot,
      });
      return this.get(contractId)!;
    });
  }

  /** Everything a UI needs: the project contract, task contracts and what is still unverified. */
  view(workflowId: string) {
    const project = this.project(workflowId);
    const all = this.contractsOf(workflowId);
    const tasks = all.filter((c) => c.scope === "task");
    return {
      workflowId,
      project,
      tasks,
      unresolved: all.flatMap((c) =>
        [
          ...c.requiredChecks,
          ...Object.values(c.retained).flatMap((r) => r.checks),
        ]
          .filter((x) => x.enforcement === "advisory")
          .map((x) => ({ contractId: c.id, taskId: c.taskId ?? null, ...x })),
      ),
      hash: project ? contractHash(project) : null,
    };
  }
}
