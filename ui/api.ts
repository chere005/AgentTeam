import type { Agent, Edge, Rule, Session, Task, Workflow } from "../src/model";
export type { Agent, Edge, Rule, Session, Task, Workflow };
export type Activity = {
  agentId: string;
  state: string;
  runningTaskIds: string[];
  queuedTasks: { id: string; waitReason: string | null }[];
  failedTaskIds: string[];
  capacity: { running: number; queued: number; limit: number | null };
};
export type Snapshot = {
  agents: Agent[];
  edges: Edge[];
  rules: Rule[];
  workflows: (Workflow & { tasks: Task[]; status: string })[];
  sessions: Session[];
  activity: Activity[];
  liveExecution: boolean;
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
  localStorage.setItem("agentteam." + key, JSON.stringify(value));
}
