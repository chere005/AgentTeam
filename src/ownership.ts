import { z } from "zod";
import { AppError, assert, type Agent, type Session } from "./model.ts";
import type { TeamService } from "./service.ts";

/**
 * Who is driving an agent's session: the team (background tasks, the default), the embedded chat,
 * an interactive CLI the user runs in their own terminal, or a native app.
 *
 * State machine (one record per agent, entity `ownership`):
 *
 *   team ──take(embedded|cli|native)──▶ embedded | cli | native
 *   embedded|cli|native ──release──▶ team
 *   embedded ◀─▶ embedded   (take is idempotent for the same mode)
 *   cli ─✗─▶ native, native ─✗─▶ cli, embedded ─✗─▶ cli ...  (another driver holds it: `session_driven`)
 *
 * Taking control also sets `Agent.control = "human"` through TeamService.control, so the scheduler
 * keeps team tasks queued and the "agent_busy" guard refuses to hand over a session that is still
 * running. While a CLI or native app holds the agent, the embedded chat refuses to run (duplicate
 * driving of one provider session). A native app starts its own provider conversation: that is
 * recorded (`separateSession`) and never merged with the embedded session id.
 */
export type Holder = "team" | "embedded" | "cli" | "native";
export const takeSchema = z
  .object({
    mode: z.enum(["embedded", "cli", "native"]),
    note: z.string().max(500).optional(),
  })
  .strict();
export type Ownership = {
  id: string;
  holder: Holder;
  since: string;
  sessionId: string | null;
  providerSessionId: string | null;
  /** True when the holder works in a different provider conversation than the embedded session. */
  separateSession: boolean;
  note?: string;
  history: {
    at: string;
    action: "take" | "return";
    from: Holder;
    to: Holder;
  }[];
};
const LABEL: Record<Holder, string> = {
  team: "the team (background tasks)",
  embedded: "the embedded chat",
  cli: "an interactive CLI",
  native: "a native app",
};

export class OwnershipService {
  service: TeamService;
  platform: string;
  constructor(service: TeamService, platform = process.platform) {
    this.service = service;
    this.platform = platform;
  }
  private get store() {
    return this.service.store;
  }
  get(agentId: string): Ownership {
    this.store.get<Agent>("agent", agentId);
    try {
      return this.store.get<Ownership>("ownership", agentId);
    } catch {
      return {
        id: agentId,
        holder: "team",
        since: "",
        sessionId: null,
        providerSessionId: null,
        separateSession: false,
        history: [],
      };
    }
  }
  /** Current holder with what the user may do next, for the UI. */
  view(agentId: string) {
    const o = this.get(agentId);
    const agent = this.store.get<Agent>("agent", agentId);
    const running = this.busy(agentId);
    const can = (mode: Exclude<Holder, "team">) => {
      if (o.holder === mode) return { ok: true, reason: "Already held" };
      if (o.holder !== "team")
        return {
          ok: false,
          reason: `Driven by ${LABEL[o.holder]}; return ownership first`,
        };
      if (running) return { ok: false, reason: "Active work is running" };
      if (mode === "native" && this.platform !== "darwin")
        return {
          ok: false,
          reason: "Native app launch is only available on macOS",
        };
      return { ok: true, reason: "" };
    };
    return {
      ...o,
      control: agent.control,
      busy: running,
      label: LABEL[o.holder],
      nativeSupported: this.platform === "darwin",
      can: {
        embedded: can("embedded"),
        cli: can("cli"),
        native: can("native"),
      },
      warning:
        o.holder === "native" && o.separateSession
          ? "The native app works in its own conversation; its messages do not appear here and it does not share this session."
          : o.holder === "cli"
            ? "An interactive CLI is driving this session. Embedded chat and background tasks are paused until ownership is returned."
            : null,
    };
  }
  list() {
    return this.store.list<Agent>("agent").map((a) => this.view(a.id));
  }
  private busy(agentId: string) {
    return (
      this.store
        .list<Session>("session")
        .some((s) => s.agentId === agentId && s.state === "running") ||
      this.store
        .list<{ agentId: string; status: string }>("task")
        .some((t) => t.agentId === agentId && t.status === "running")
    );
  }
  take(agentId: string, input: unknown) {
    const data = takeSchema.parse(input);
    const agent = this.store.get<Agent>("agent", agentId);
    const current = this.get(agentId);
    if (current.holder === data.mode) return this.view(agentId);
    assert(
      current.holder === "team",
      "session_driven",
      `This agent is already driven by ${LABEL[current.holder]}. Return ownership before taking it over, so one session is never driven twice`,
    );
    if (data.mode === "native")
      assert(
        this.platform === "darwin",
        "native_unsupported",
        "Native app launch is only available on macOS; use the CLI mode instead",
        400,
      );
    return this.store.transaction(() => {
      // Refuses while the agent runs work and moves the scheduler off this agent.
      if (agent.control !== "human") this.service.control(agentId, "human");
      const session = this.store
        .list<Session>("session")
        .find((s) => s.agentId === agentId);
      const next: Ownership = {
        id: agentId,
        holder: data.mode,
        since: new Date().toISOString(),
        sessionId: session?.id ?? null,
        providerSessionId:
          data.mode === "native" ? null : (session?.providerSessionId ?? null),
        separateSession: data.mode === "native",
        note: data.note,
        history: [
          ...current.history,
          {
            at: new Date().toISOString(),
            action: "take" as const,
            from: "team" as Holder,
            to: data.mode,
          },
        ].slice(-50),
      };
      this.store.put("ownership", next);
      this.store.emit("ownership.taken", agentId, {
        holder: data.mode,
        separateSession: next.separateSession,
      });
      return this.view(agentId);
    });
  }
  /** Return ownership to the team (any holder). Refused while work is still running. */
  release(agentId: string) {
    const agent = this.store.get<Agent>("agent", agentId);
    const current = this.get(agentId);
    return this.store.transaction(() => {
      if (agent.control === "human") this.service.control(agentId, "team");
      if (current.holder !== "team")
        this.store.put("ownership", {
          ...current,
          holder: "team" as Holder,
          since: new Date().toISOString(),
          separateSession: false,
          providerSessionId: null,
          history: [
            ...current.history,
            {
              at: new Date().toISOString(),
              action: "return" as const,
              from: current.holder,
              to: "team" as Holder,
            },
          ].slice(-50),
        } satisfies Ownership);
      this.store.emit("ownership.returned", agentId, { from: current.holder });
      return this.view(agentId);
    });
  }
  /** Hook for TeamService.control: keeps the record in step with the legacy Take control button. */
  onControl(agentId: string, control: "team" | "human") {
    const current = this.get(agentId);
    if (control === "human") {
      if (current.holder !== "team") return;
      const session = this.store
        .list<Session>("session")
        .find((s) => s.agentId === agentId);
      this.store.put("ownership", {
        ...current,
        holder: "embedded" as Holder,
        since: new Date().toISOString(),
        sessionId: session?.id ?? null,
        providerSessionId: session?.providerSessionId ?? null,
        separateSession: false,
        history: [
          ...current.history,
          {
            at: new Date().toISOString(),
            action: "take" as const,
            from: "team" as Holder,
            to: "embedded" as Holder,
          },
        ].slice(-50),
      } satisfies Ownership);
    } else if (current.holder !== "team")
      this.store.put("ownership", {
        ...current,
        holder: "team" as Holder,
        since: new Date().toISOString(),
        separateSession: false,
        providerSessionId: null,
        history: [
          ...current.history,
          {
            at: new Date().toISOString(),
            action: "return" as const,
            from: current.holder,
            to: "team" as Holder,
          },
        ].slice(-50),
      } satisfies Ownership);
  }
  /** Embedded chat may only run when no CLI/native app drives the agent. */
  assertEmbeddedMayRun(agentId: string) {
    let holder: Holder = "team";
    try {
      holder = this.store.get<Ownership>("ownership", agentId).holder;
    } catch {}
    if (holder === "cli" || holder === "native")
      throw new AppError(
        409,
        "session_driven",
        `This agent is driven by ${LABEL[holder]}. Return ownership before running the embedded chat, so the session is not driven twice`,
      );
  }
}
