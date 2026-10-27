// Shared fixture for the reliable-execution tests (Milestone A): a service with a controlled
// runtime (no provider, no network), the pipeline team inserted with NO folders, and helpers to
// drive the scheduler and a chat run with scripted "models". Temporary stores and folders only.
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/store.ts";
import { SkillCatalog } from "../../src/skills.ts";
import { TeamService } from "../../src/service.ts";
import { RunManager } from "../../src/runtime.ts";
import { Scheduler } from "../../src/scheduler.ts";
import { TeamTemplates } from "../../src/teams.ts";
import { ExampleTeams } from "../../src/example-teams.ts";
import { teamProfile } from "../../src/team-profiles.ts";
import type { Command, RuntimeEvent } from "../../src/runtime.ts";
import type { Agent, Message, Task, Workflow } from "../../src/model.ts";

export type Provider = (
  command: Command,
  environment: string,
  emit: (event: RuntimeEvent) => void,
) => Promise<void>;

export async function world(
  t: { after: (fn: () => unknown) => void },
  options: {
    platform?: NodeJS.Platform;
    /** Reopen this database file (a restart); default: a fresh in-memory store. */
    storePath?: string;
    base?: string;
  } = {},
) {
  const base =
    options.base ??
    (await realpath(await mkdtemp(join(tmpdir(), "agentteam-execution-"))));
  const store = new Store(options.storePath ?? ":memory:");
  const service = new TeamService(store, new SkillCatalog([]));
  const runs = new RunManager(service, true, base);
  // A supported, sandboxed host: no native process ever runs here.
  runs.runtimePlatform = options.platform ?? "linux";
  // These fixtures explicitly exercise provider/delegation policy; app-owned pre-provider
  // preparation is covered separately with prepareExecutableChats enabled.
  runs.prepareExecutableChats = false;
  runs.readiness = () => ({ state: "ready" });
  // The fixture calls the policy service directly; nothing is listening.
  runs.teammateToolsUrl = () => "http://127.0.0.1:1/mcp";
  const calls: { agentId: string; taskId?: string; stdin: string }[] = [];
  let provider: Provider = async (_command, _environment, emit) => {
    emit({ type: "text", data: "done" });
  };
  const execute: RunManager["execute"] = async (command, environment, emit) => {
    await provider(command, environment, emit);
  };
  runs.execute = execute;
  const scheduler = new Scheduler(service, runs, execute);
  t.after(async () => {
    scheduler.stop();
    try {
      store.close();
    } catch {
      /* already closed by a simulated restart */
    }
    if (!options.base) await rm(base, { recursive: true, force: true });
  });
  /** Tick until nothing runs and `done()` holds (bounded). */
  const until = async (done: () => boolean, ticks = 400) => {
    for (let i = 0; i < ticks; i++) {
      await scheduler.tick();
      if (done() && runs.active.size === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(
      "fixture did not settle: " +
        JSON.stringify(
          store.list<Task>("task").map((x) => ({
            id: x.id.slice(0, 8),
            t: x.title.slice(0, 30),
            s: x.status,
          })),
        ),
    );
  };
  const settle = () => until(() => true, 40);
  const examples = new ExampleTeams(
    service,
    new TeamTemplates(service),
    () => undefined,
  );
  /** The pipeline team exactly as inserted: 14 agents, none with a folder, no project. */
  const insertPipeline = (
    workers = { implementationWorkers: 2, fixWorkers: 1 },
  ) => {
    const inserted = examples.insert("pipeline-review-team", {
      options: workers,
      acceptUnverifiedModels: true,
    }) as { teamId?: string; team?: { id: string } };
    const teamId =
      inserted.teamId ?? inserted.team?.id ?? service.teamSpaces.active();
    const profile = teamProfile(store, teamId)!;
    const agent = (id: string) => store.get<Agent>("agent", id);
    const roles = profile.roles;
    return {
      teamId,
      profile,
      planner: agent(roles.planner[0]),
      integrator: agent(roles.integrator[0]),
      workers: roles.implement.map(agent),
      fixers: roles.fix.map(agent),
      adjudicator: agent(roles.adjudicator[0]),
      reviewers: [roles.codexReview[0], roles.fableReview[0]].map(agent),
      reporter: agent(roles.reporter[0]),
    };
  };
  /** An empty, real folder. */
  const folder = async (name = "project") => {
    const path = join(base, name);
    await mkdir(path, { recursive: true });
    return realpath(path);
  };
  /** Send a chat message to an agent and start its run (the scheduler would). */
  const chat = async (agentId: string, text: string) => {
    const session = service.session(agentId);
    service.message(session.id, { text });
    await runs.start(session.id, true);
    for (let i = 0; i < 200 && runs.active.has(session.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return session;
  };
  const tasks = () => store.list<Task>("task");
  const waits = () =>
    store.list<{ id: string; reason?: string }>("runtime-wait");
  return {
    base,
    store,
    service,
    runs,
    scheduler,
    until,
    settle,
    insertPipeline,
    folder,
    chat,
    tasks,
    waits,
    calls,
    setProvider: (next: Provider) => {
      provider = next;
    },
    messages: (sessionId: string) =>
      store.list<Message>("message").filter((m) => m.sessionId === sessionId),
    workflows: () => store.list<Workflow>("workflow"),
    events: (type: string) =>
      store.history(0, 100_000).filter((e) => e.type === type),
  };
}
export type World = Awaited<ReturnType<typeof world>>;
