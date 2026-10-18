import type {
  Agent as ModelAgent,
  Edge,
  Rule,
  Session,
  Task,
  Workflow,
} from "../src/model";
import type { WorkflowSetup } from "../src/samples";
import type { TeamSummary } from "../src/team-spaces";
import type { CrossTeamLink } from "./team-view";
export type { Edge, Rule, Session, Task, Workflow, WorkflowSetup, TeamSummary };
/** Snapshot agents carry their resolved team; null = the global Team Assistant. */
export type Agent = Omit<ModelAgent, "teamId"> & { teamId?: string | null };
export type Activity = {
  agentId: string;
  state: string;
  runningTaskIds: string[];
  queuedTasks: { id: string; waitReason: string | null }[];
  failedTaskIds: string[];
  /** Interrupted or blocked tasks awaiting resume or a decision (Recovery panel). */
  interruptedTaskIds: string[];
  capacity: { running: number; queued: number; limit: number | null };
};
export type Snapshot = {
  agents: Agent[];
  edges: Edge[];
  rules: Rule[];
  workflows: (Workflow & {
    tasks: Task[];
    status: string;
    /** Present on sample workflows (src/samples.ts). */
    setup?: WorkflowSetup;
  })[];
  sessions: Session[];
  activity: Activity[];
  liveExecution: boolean;
  /** Every team with counts (src/team-spaces.ts); the snapshot itself is unfiltered. */
  teams: TeamSummary[];
  activeTeamId: string;
  /** Set by the UI on the filtered view of the active team (ui/team-view.ts). */
  teamView?: {
    team: TeamSummary;
    teams: TeamSummary[];
    allAgents: Agent[];
    crossTeam: CrossTeamLink<Edge>[];
    otherAgents: Agent[];
    index: Map<string, string | null>;
  };
};
export type TeamEvent = {
  seq: number;
  type: string;
  entityId: string;
  data: any;
  createdAt: string;
};
declare global {
  interface Window {
    agentteam: {
      request: (method: string, path: string, body?: unknown) => Promise<any>;
      chooseFolder: () => Promise<string | null>;
      chooseExecutable: () => Promise<string | null>;
      openAgent: (id: string, mode: string) => Promise<any>;
      /** Main-process Save as… for the redacted diagnostic bundle (absent outside the desktop app). */
      saveDiagnostics?: (format: "zip" | "json") => Promise<any>;
      /** Mirrors Settings -> Appearance to the main process (window background, first paint). */
      setTheme?: (setting: "system" | "light" | "dark") => Promise<unknown>;
      onEvent: (callback: (event: TeamEvent) => void) => () => void;
      platform: string;
    };
  }
}
export const api = (path: string, method = "GET", body?: unknown) =>
  window.agentteam.request(method, path, body);
export const empty: Snapshot = {
  agents: [],
  edges: [],
  rules: [],
  workflows: [],
  sessions: [],
  activity: [],
  liveExecution: false,
  teams: [],
  activeTeamId: "main",
};
export function agentInput(agent: Agent) {
  const { id, createdAt, control, ...input } = agent;
  return input;
}
export function saved<T>(key: string, fallback: T): T {
  try {
    return (
      JSON.parse(localStorage.getItem("agentteam." + key) ?? "null") ?? fallback
    );
  } catch {
    return fallback;
  }
}
export function persist(key: string, value: unknown) {
  try {
    localStorage.setItem("agentteam." + key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full: the UI keeps working with in-memory state */
  }
}
