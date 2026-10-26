// Project-folder setup (reliable-execution plan item 2, "one setup card").
//
// A project or a chat conversation that needs files written or programs run is READY only when
// every participating role can do its part (src/launch-readiness.ts). When it is not, one
// `project-setup` record per workflow names the affected workers with one repair each and proposes
// the fix as data: the folder, the participants and the least access each role needs (writers
// write, reviewers read). The user approves it once; `apply` attaches the folder to exactly the
// approved roles through the same attach helper projects use (an existing attachment is never
// widened or narrowed implicitly, global denials are enforced), then every task that was waiting
// for this setup is requeued by the existing readiness path. Applying twice changes nothing.
//
// Existing projects with usable folders and grants pass with no new step: `view` is read-only and
// reports them ready without writing anything (migration rule).
import { z } from "zod";
import { completionCheckSchema } from "./limits-schema.ts";
import {
  assert,
  type Agent,
  type Message,
  type Task,
  type Workflow,
} from "./model.ts";
import type { TeamService } from "./service.ts";
import type { ReadinessDecision, ReadinessIssue } from "./launch-readiness.ts";
import type { ProjectWorkflow } from "./project-lifecycle.ts";
import {
  attachProjectWorkspaceInTx,
  resolveProjectWorkspace,
  teamProfile,
  type ProjectAttachment,
} from "./team-profiles.ts";
import type { RoleClass } from "./execution-contract.ts";

export const PROJECT_SETUP = "project-setup";

export type SetupBlocker = {
  agentId: string;
  agentName: string;
  roleClass: RoleClass;
  issues: ReadinessIssue[];
  taskIds: string[];
  at: string;
};
export type ProjectSetupRecord = {
  /** The workflow id (one record per project or conversation). */
  id: string;
  workflowId: string;
  state: "needed" | "ready";
  blockers: SetupBlocker[];
  /** Attachments setup added to a workflow that has no `setup.attachments` of its own (a chat). */
  attachments: ProjectAttachment[];
  applied: {
    folder: string;
    at: string;
    agentIds: string[];
    widened: string[];
  }[];
  /** Digest of the blockers: events are published only when it changes. */
  signature: string;
  /** A chat request sent again once its setup was ready (Start); never sent twice. */
  startedAt?: string;
  updatedAt: string;
};

const applySchema = z
  .object({
    folder: z.string().min(1).max(4096),
    /** Approved participants (default: everyone the proposal lists). */
    participants: z.array(z.string().min(1).max(200)).max(100).optional(),
    /** Agents whose EXISTING read-only attachment of the folder the user approves widening to write. */
    widen: z.array(z.string().min(1).max(200)).max(100).optional(),
  })
  .strict();

const signatureOf = (blockers: SetupBlocker[]) =>
  JSON.stringify(
    blockers.map((b) => [b.agentId, b.issues.map((i) => i.code).sort()]).sort(),
  );
const now = () => new Date().toISOString();

export class ProjectSetupService {
  service: TeamService;
  constructor(service: TeamService) {
    this.service = service;
  }
  private get store() {
    return this.service.store;
  }
  record(workflowId: string): ProjectSetupRecord | null {
    try {
      return this.store.get<ProjectSetupRecord>(PROJECT_SETUP, workflowId);
    } catch {
      return null;
    }
  }
  private fresh(workflowId: string): ProjectSetupRecord {
    return {
      id: workflowId,
      workflowId,
      state: "ready",
      blockers: [],
      attachments: [],
      applied: [],
      signature: signatureOf([]),
      updatedAt: now(),
    };
  }
  private save(record: ProjectSetupRecord) {
    const next = { ...record, updatedAt: now() };
    this.store.put(PROJECT_SETUP, next);
    return next;
  }
  private workflow(id: string) {
    return this.store.get<ProjectWorkflow>("workflow", id);
  }

  /** Every role that takes part in the workflow: owner, task agents, reachable workers, profile roles. */
  participants(workflowId: string): Agent[] {
    const wf = this.workflow(workflowId);
    const ids = new Set<string>([wf.ownerId]);
    for (const task of this.store.list<Task>("task"))
      if (task.workflowId === workflowId) ids.add(task.agentId);
    if (wf.kind === "conversation") {
      // A chat can hand work to everyone the owner reaches over delegation edges.
      const queue = [wf.ownerId];
      for (let depth = 0; queue.length && depth < 6; depth++) {
        const next: string[] = [];
        for (const from of queue)
          for (const other of this.store.list<Agent>("agent"))
            if (
              !ids.has(other.id) &&
              this.service.permitted(from, other.id, "delegate")
            ) {
              ids.add(other.id);
              next.push(other.id);
            }
        queue.splice(0, queue.length, ...next);
      }
      const owner = this.store.get<Agent>("agent", wf.ownerId);
      const teamId = this.service.teamSpaces.teamOfAgent(owner);
      const profile = teamId ? teamProfile(this.store, teamId) : null;
      for (const roleIds of Object.values(profile?.roles ?? {}))
        for (const id of roleIds) ids.add(id);
    }
    return [...ids].flatMap((id) => {
      try {
        const agent = this.store.get<Agent>("agent", id);
        return agent.kind === "team-assistant" ? [] : [agent];
      } catch {
        return [];
      }
    });
  }

  /**
   * Readiness of every participant against the project's contract (or, without one, their
   * grants). A participant with pending tasks is judged on each of them (a simple assignment
   * withholds the shell, a declared task folder can be detached); one without is judged on its role.
   */
  evaluate(workflowId: string) {
    const contract = this.service.contracts.project(workflowId);
    const pending = this.store
      .list<Task>("task")
      .filter(
        (t) =>
          t.workflowId === workflowId &&
          !["completed", "cancelled"].includes(t.status),
      );
    const decisions = this.participants(workflowId).map((agent) => {
      const own = pending.filter((t) => t.agentId === agent.id);
      return this.service.launchReadiness.mergeDecisions(
        agent,
        own.length
          ? own.map((task) =>
              this.service.launchReadiness.evaluateProspective(agent, {
                task,
                contract: this.service.contracts.effective(task) ?? contract,
                runtime: this.service.launchReadiness.runtime,
              }),
            )
          : [
              this.service.launchReadiness.evaluateProspective(agent, {
                contract,
                runtime: this.service.launchReadiness.runtime,
              }),
            ],
      );
    });
    return { contract, decisions };
  }
  private blockersOf(workflowId: string, decisions: ReadinessDecision[]) {
    const open = this.store
      .list<Task>("task")
      .filter(
        (t) =>
          t.workflowId === workflowId &&
          !["completed", "cancelled"].includes(t.status),
      );
    return decisions
      .filter((d) => !d.ready)
      .map((d): SetupBlocker => ({
        agentId: d.agentId,
        agentName: d.agentName,
        roleClass: d.roleClass,
        issues: d.issues,
        taskIds: open.filter((t) => t.agentId === d.agentId).map((t) => t.id),
        at: now(),
      }));
  }

  /**
   * Record that a worker of this workflow cannot do its part (a refused delegation or a blocked
   * task). One record per workflow and one blocker per worker: repeating the same refusal changes
   * nothing and publishes nothing.
   */
  noteBlocked(workflowId: string, decision: ReadinessDecision) {
    try {
      this.workflow(workflowId);
    } catch {
      return null;
    }
    const record = this.record(workflowId) ?? this.fresh(workflowId);
    const blocker: SetupBlocker = {
      agentId: decision.agentId,
      agentName: decision.agentName,
      roleClass: decision.roleClass,
      issues: decision.issues,
      taskIds:
        decision.taskId && decision.taskId !== "pending"
          ? [decision.taskId]
          : [],
      at: now(),
    };
    const blockers = [
      ...record.blockers.filter((b) => b.agentId !== blocker.agentId),
      blocker,
    ];
    const signature = signatureOf(blockers);
    const saved = this.save({
      ...record,
      state: "needed",
      blockers,
      signature,
    });
    if (signature !== record.signature || record.state !== "needed")
      this.store.emit("project.setup_required", workflowId, {
        workflowId,
        workers: blockers.map((b) => ({
          agentId: b.agentId,
          name: b.agentName,
          codes: b.issues.map((i) => i.code),
        })),
      });
    return saved;
  }

  /**
   * Chat preparation: for an actionable request, record the workers that cannot do their part yet
   * as one setup state. Nothing is written when everything is already usable, and a response-only
   * conversation never gets a record.
   */
  prepareConversation(workflowId: string) {
    const contract = this.service.contracts.project(workflowId);
    if (!contract || contract.workKind === "response-only") return null;
    const { decisions } = this.evaluate(workflowId);
    const blockers = this.blockersOf(workflowId, decisions);
    if (!blockers.length) return null;
    const record = this.record(workflowId) ?? this.fresh(workflowId);
    const signature = signatureOf(blockers);
    const saved = this.save({
      ...record,
      state: "needed",
      blockers,
      signature,
    });
    this.store.emit("project.setup_required", workflowId, {
      workflowId,
      workers: blockers.map((b) => ({
        agentId: b.agentId,
        name: b.agentName,
        codes: b.issues.map((i) => i.code),
      })),
    });
    return saved;
  }

  /** Re-evaluate a recorded setup: ready once every participant can do its part. */
  refresh(workflowId: string) {
    const record = this.record(workflowId);
    if (!record) return null;
    const { decisions } = this.evaluate(workflowId);
    const blockers = this.blockersOf(workflowId, decisions);
    const signature = signatureOf(blockers);
    const state = blockers.length ? "needed" : "ready";
    if (signature === record.signature && state === record.state) return record;
    const saved = this.save({ ...record, state, blockers, signature });
    this.store.emit(
      state === "ready" ? "project.setup_ready" : "project.setup_required",
      workflowId,
      { workflowId, workers: blockers.map((b) => b.agentName) },
    );
    return saved;
  }
  /** Open setups that may have become ready (after an agent's folder or tools changed). */
  refreshOpen() {
    for (const record of this.store.list<ProjectSetupRecord>(PROJECT_SETUP))
      if (record.state === "needed")
        try {
          this.refresh(record.workflowId);
        } catch {
          // A deleted workflow or agent: the record stays for the history.
        }
  }

  private currentAccess(agent: Agent, folder: string | null) {
    return folder
      ? (agent.workspaces.find((w) => w.path === folder)?.access ?? null)
      : null;
  }
  /** The proposal: folder, participants and the least access each role needs (data, never applied implicitly). */
  proposal(workflowId: string) {
    const wf = this.workflow(workflowId);
    const { contract, decisions } = this.evaluate(workflowId);
    const needing = decisions.filter((d) => d.required.length);
    const attached = new Map<string, number>();
    for (const d of needing) {
      const agent = this.store.get<Agent>("agent", d.agentId);
      for (const w of agent.workspaces)
        attached.set(w.path, (attached.get(w.path) ?? 0) + 1);
    }
    const candidates = [...attached.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([path]) => path)
      .slice(0, 5);
    const folder =
      contract?.projectFolder ?? wf.setup?.workspace ?? candidates[0] ?? null;
    const participants = needing.map((d) => {
      const agent = this.store.get<Agent>("agent", d.agentId);
      const access: "read" | "write" = d.required.includes("write")
        ? "write"
        : "read";
      const current = this.currentAccess(agent, folder);
      // A writer with a declared task folder gets that narrower scope, not the whole folder.
      const declared = this.store
        .list<Task>("task")
        .find(
          (t) =>
            t.workflowId === workflowId &&
            t.agentId === agent.id &&
            !["completed", "cancelled"].includes(t.status) &&
            t.resourcePaths?.length,
        )?.resourcePaths?.[0];
      return {
        agentId: d.agentId,
        name: d.agentName,
        roleClass: d.roleClass,
        access,
        scope: (declared ?? null) as string | null,
        current,
        ready: d.ready,
        /** Already attached with less access than the role needs: widening needs its own approval. */
        needsWidening: current === "read" && access === "write",
      };
    });
    return { folder, candidates, participants };
  }

  /** What the setup card renders. Read-only: it never creates or changes a record. */
  view(workflowId: string) {
    const wf = this.workflow(workflowId);
    const record = this.record(workflowId);
    const { contract, decisions } = this.evaluate(workflowId);
    const blockers = this.blockersOf(workflowId, decisions);
    const proposal = this.proposal(workflowId);
    return {
      workflowId,
      name: wf.name,
      kind: wf.kind,
      state: blockers.length ? ("needed" as const) : ("ready" as const),
      blockers,
      proposal,
      contract: contract
        ? {
            id: contract.id,
            workKind: contract.workKind,
            workKindSource: contract.workKindSource,
            signals: contract.signals,
            projectFolder: contract.projectFolder ?? null,
            expectedFiles: contract.expectedFiles,
            designatedReviewers: contract.designatedReviewers,
            maxCorrectionRounds: contract.maxCorrectionRounds,
          }
        : null,
      unresolvedChecks: this.service.contracts.view(workflowId).unresolved,
      applied: record?.applied ?? [],
      /**
       * Start for a chat request: once its setup is ready the original message is sent again, once.
       * (A saved project starts with its own Start; this is the same action for a conversation.)
       */
      start:
        wf.kind === "conversation" && contract?.origin
          ? {
              available: !blockers.length && !record?.startedAt,
              startedAt: record?.startedAt ?? null,
              sessionId: contract.origin.sessionId,
              reason: blockers.length
                ? "Finish the setup first"
                : record?.startedAt
                  ? "The request was already sent again"
                  : null,
            }
          : null,
      /** No contract and nothing to repair: an existing project that needs no new step. */
      migration: {
        existingProject: !contract && !record,
        needsNewStep: blockers.length > 0,
      },
    };
  }

  /**
   * Start for a chat request whose setup is ready: the user's original message goes to the same
   * conversation once. Repeating it sends nothing (409), so Start never duplicates work.
   */
  async startConversation(
    workflowId: string,
    execution: {
      enabled: () => boolean;
      start: (sessionId: string) => Promise<unknown>;
    },
  ) {
    const wf = this.workflow(workflowId);
    const contract = this.service.contracts.project(workflowId);
    assert(
      wf.kind === "conversation" && contract?.origin,
      "not_a_conversation",
      "Only a chat request can be started this way; start a saved project with its own Start",
      400,
    );
    assert(
      execution.enabled(),
      "execution_paused",
      "Execution is paused. Resume execution to send this request again; this also resumes other queued work.",
    );
    const record = this.record(workflowId) ?? this.fresh(workflowId);
    assert(
      !record.startedAt,
      "already_started",
      "This request was already sent again; nothing was duplicated",
    );
    const { decisions } = this.evaluate(workflowId);
    assert(
      !this.blockersOf(workflowId, decisions).length,
      "setup_not_ready",
      "The setup is not finished yet; apply it first",
    );
    const original = this.store.get<Message>(
      "message",
      contract.origin.messageId,
    );
    this.store.transaction(() => {
      this.service.message(contract.origin!.sessionId, { text: original.text });
      this.save({ ...record, startedAt: now() });
      this.store.emit("project.setup_started", workflowId, {
        workflowId,
        sessionId: contract.origin!.sessionId,
      });
    });
    await execution.start(contract.origin.sessionId);
    return this.view(workflowId);
  }

  /** Apply the approved grants. Idempotent; preserves existing attachments, rules and global denials. */
  async apply(workflowId: string, input: unknown) {
    const data = applySchema.parse(input);
    const wf = this.workflow(workflowId);
    assert(
      (wf as ProjectWorkflow).lifecycle?.state !== "archived",
      "project_archived",
      "This project is archived; reopen it before changing its setup",
    );
    const folder = await resolveProjectWorkspace(data.folder, this.store);
    const contract = this.service.contracts.project(workflowId);
    assert(
      !contract?.projectFolder || contract.projectFolder === folder,
      "folder_differs_from_contract",
      `This project's folder is already authorized as ${contract?.projectFolder}. Keep it, or start a new project for a different folder.`,
    );
    const { decisions } = this.evaluate(workflowId);
    const needing = decisions.filter((d) => d.required.length);
    for (const id of [...(data.participants ?? []), ...(data.widen ?? [])])
      assert(
        needing.some((d) => d.agentId === id),
        "participant_not_in_setup",
        "Grants can only go to roles this setup lists",
        400,
      );
    const approved = needing.filter(
      (d) => !data.participants || data.participants.includes(d.agentId),
    );
    const access = Object.fromEntries(
      approved.map((d) => [
        d.agentId,
        d.required.includes("write") ? ("write" as const) : ("read" as const),
      ]),
    );
    for (const id of data.widen ?? [])
      assert(
        access[id] === "write",
        "widen_not_needed",
        "Only an approved writer's read-only attachment can be widened",
        400,
      );
    const outcome = this.store.transaction(() => {
      const added = attachProjectWorkspaceInTx(this.store, access, folder);
      const widened: string[] = [];
      for (const id of data.widen ?? []) {
        const agent = this.store.get<Agent>("agent", id);
        const attachment = agent.workspaces.find((w) => w.path === folder);
        if (attachment?.access !== "read") continue;
        this.store.put("agent", {
          ...agent,
          workspaces: agent.workspaces.map((w) =>
            w.path === folder ? { ...w, access: "write" as const } : w,
          ),
        });
        this.store.emit("agent.updated", id, { workspaceWidened: folder });
        widened.push(id);
      }
      // Real projects record what they attached where detach looks for it; a chat keeps it here.
      const owned = (wf as ProjectWorkflow).setup;
      if (owned && added.length)
        this.store.put("workflow", {
          ...wf,
          setup: {
            ...owned,
            attachments: [...(owned.attachments ?? []), ...added],
          },
        });
      this.service.contracts.authorizeFolder(workflowId, folder);
      const record = this.record(workflowId) ?? this.fresh(workflowId);
      this.save({
        ...record,
        attachments: owned
          ? record.attachments
          : [...record.attachments, ...added],
        applied:
          added.length || widened.length || !record.applied.length
            ? [
                ...record.applied,
                {
                  folder,
                  at: now(),
                  agentIds: Object.keys(access),
                  widened,
                },
              ].slice(-20)
            : record.applied,
      });
      this.store.emit("project.setup_applied", workflowId, {
        workflowId,
        folder,
        agentIds: Object.keys(access),
        added: added.map((a) => a.agentId),
        widened,
      });
      return { added, widened };
    });
    this.refresh(workflowId);
    const requeued = this.service.launchReadiness.requeueWaiting();
    this.refreshOpen();
    return { ...this.view(workflowId), outcome: { ...outcome, requeued } };
  }
}

/** HTTP routes (behind the bearer-token check in http.ts). Returns undefined for other paths. */
export async function projectSetupRoute(
  service: TeamService,
  method: string | undefined,
  url: URL,
  readBody: () => Promise<unknown>,
  /** Whether execution is on and how to queue a conversation's run (RunManager); absent when not wired. */
  execution?: {
    enabled: () => boolean;
    start: (sessionId: string) => Promise<unknown>;
  },
): Promise<{ data: unknown; status?: number } | undefined> {
  const path = url.pathname;
  const id = (v: string) => decodeURIComponent(v);
  let m: RegExpMatchArray | null;
  if (method === "GET" && path === "/project-setups")
    return {
      data: service.store
        .list<ProjectSetupRecord>(PROJECT_SETUP)
        .filter((r) => r.state === "needed"),
    };
  if ((m = path.match(/^\/projects\/([^/]+)\/setup$/))) {
    const workflowId = id(m[1]);
    service.store.get<Workflow>("workflow", workflowId);
    if (method === "GET") return { data: service.setups.view(workflowId) };
    if (method === "POST")
      return { data: await service.setups.apply(workflowId, await readBody()) };
  }
  if (
    method === "POST" &&
    (m = path.match(/^\/projects\/([^/]+)\/setup\/start$/))
  ) {
    const workflowId = id(m[1]);
    service.store.get<Workflow>("workflow", workflowId);
    z.object({})
      .strict()
      .parse(await readBody());
    assert(
      execution,
      "execution_unavailable",
      "Execution is not available",
      409,
    );
    return {
      data: await service.setups.startConversation(workflowId, execution),
      status: 202,
    };
  }
  if ((m = path.match(/^\/projects\/([^/]+)\/contract$/))) {
    const workflowId = id(m[1]);
    service.store.get<Workflow>("workflow", workflowId);
    if (method === "GET") return { data: service.contracts.view(workflowId) };
    if (method === "POST") {
      const body = z
        .object({
          workKind: z.enum([
            "response-only",
            "file-edit",
            "executable-implementation",
          ]),
        })
        .strict()
        .parse(await readBody());
      service.contracts.setUserWorkKind(workflowId, body.workKind);
      service.setups.refresh(workflowId);
      return { data: service.contracts.view(workflowId) };
    }
  }
  if (
    method === "POST" &&
    (m = path.match(/^\/projects\/([^/]+)\/contract\/requirements$/))
  ) {
    const workflowId = id(m[1]);
    service.store.get<Workflow>("workflow", workflowId);
    const body = z
      .object({
        expectedFiles: z.array(z.string().min(1).max(500)).max(30).optional(),
        checks: z.array(completionCheckSchema).max(20).optional(),
        maxCorrectionRounds: z.number().int().min(0).max(10).optional(),
      })
      .strict()
      .parse(await readBody());
    service.contracts.setRequirements(workflowId, body);
    return { data: service.contracts.view(workflowId) };
  }
  if (
    method === "POST" &&
    (m = path.match(/^\/projects\/([^/]+)\/contract\/checks$/))
  ) {
    const workflowId = id(m[1]);
    service.store.get<Workflow>("workflow", workflowId);
    const body = z
      .object({
        contractId: z.string().min(1).max(300).optional(),
        slot: z.string().min(1).max(400),
        pattern: z.string().min(1).max(500).optional(),
        flags: z
          .string()
          .regex(/^[imsu]*$/)
          .optional(),
        note: z.string().max(500).optional(),
      })
      .strict()
      .parse(await readBody());
    const contractId = body.contractId ?? `project:${workflowId}`;
    const contract = service.contracts.get(contractId);
    assert(
      contract && contract.workflowId === workflowId,
      "contract_not_found",
      "No such contract in this project",
      404,
    );
    service.contracts.confirmCheck(contractId, body.slot, body);
    const requeued = service.launchReadiness.requeueWaiting();
    return {
      data: { ...service.contracts.view(workflowId), requeued },
    };
  }
  if (
    method === "GET" &&
    (m = path.match(/^\/agents\/([^/]+)\/delegation-readiness$/))
  )
    return {
      data: service.launchReadiness.delegationReadiness(
        service.store.get<Agent>("agent", id(m[1])).id,
      ),
    };
  if (method === "GET" && (m = path.match(/^\/tasks\/([^/]+)\/readiness$/))) {
    const task = service.store.get<Task>("task", id(m[1]));
    const agent = service.store.get<Agent>("agent", task.agentId);
    return {
      data: {
        taskId: task.id,
        contract: service.contracts.effective(task),
        unresolvedChecks: service.contracts.unresolved(task),
        decision: service.launchReadiness.evaluateProspective(agent, {
          task,
          runtime: service.launchReadiness.runtime,
        }),
      },
    };
  }
  return undefined;
}
