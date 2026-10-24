import { z } from "zod";
import { EditorService } from "./editors.ts";
import { WatchService } from "./fs-watch.ts";
import { GitWorkflow } from "./git-workflow.ts";
import { inspectFile } from "./previews.ts";
import { loadSublimeEditorConfig } from "./sublime-config.ts";
import type { Store } from "./store.ts";
import type { WorkspaceService } from "./workspaces.ts";

/**
 * Authenticated routes for Git workflows, rich previews, editors and file watching
 * (all sit behind the bearer-token check in http.ts):
 *   GET/PUT /editors/settings                       editor executable paths + detection
 *   POST /agents/:id/files/inspect                  bounded typed preview
 *   POST /agents/:id/files/read                     bounded UTF-8 editor read
 *   POST /agents/:id/files/save                     guarded UTF-8 editor save
 *   POST /agents/:id/files/create                   create a new UTF-8 file
 *   POST /agents/:id/files/activity                 overlapping active/queued work
 *   POST /agents/:id/files/{open,open-plan}         Open file / project / reveal / open with
 *   POST /agents/:id/editors/{open,plan,preferences} same, explicit names, or Sublime settings
 *   POST /agents/:id/git/{state,branches,switch,fetch,pull,push,log,commit-info,
 *        pr,pr/open,pr/record,conflicts,conflict-file,resolve,integrate,abort,continue,init}
 *   POST /agents/:id/watch/{start,stop}             debounced change events (`workspace.changed`)
 * Returns undefined when the path is not one of these routes.
 */
export class WorkspaceExtras {
  git: GitWorkflow;
  editors: EditorService;
  watch: WatchService;
  store: Store;
  ws: WorkspaceService;
  constructor(
    store: Store,
    ws: WorkspaceService,
    options: {
      git?: ConstructorParameters<typeof GitWorkflow>[2];
      editors?: ConstructorParameters<typeof EditorService>[2];
    } = {},
  ) {
    this.store = store;
    this.ws = ws;
    this.git = new GitWorkflow(store, ws, options.git);
    this.editors = new EditorService(store, ws, options.editors);
    this.watch = new WatchService(store, ws);
  }
  close() {
    this.watch.close();
  }
  async route(
    method: string | undefined,
    url: URL,
    readBody: () => Promise<unknown>,
  ): Promise<{ data: unknown; status?: number } | undefined> {
    const path = url.pathname;
    if (path === "/editors/settings") {
      if (method === "GET") return { data: await this.editors.settings() };
      if (method === "PUT")
        return { data: await this.editors.save(await readBody()) };
      return undefined;
    }
    if (path === "/editors/sublime-config" && method === "GET")
      return { data: await loadSublimeEditorConfig() };
    const m = path.match(
      /^\/agents\/([^/]+)\/(files\/(?:inspect|read|save|create|activity|search|changes|changes\/reset|open|open-plan)|editors\/(?:open|plan|preferences)|git\/(?:state|branches|switch|fetch|pull|push|log|commit-info|pr|pr\/open|pr\/record|conflicts|conflict-file|resolve|integrate|abort|continue|init)|watch\/(?:start|stop))$/,
    );
    if (!m || method !== "POST") return undefined;
    const agentId = decodeURIComponent(m[1]),
      action = m[2],
      body = await readBody();
    const g = this.git;
    switch (action) {
      case "files/inspect":
        return { data: await inspectFile(this.ws, agentId, body) };
      case "files/read":
        return { data: await this.ws.readText(agentId, body) };
      case "files/save":
        return { data: await this.ws.saveText(agentId, body) };
      case "files/create":
        return { data: await this.ws.createText(agentId, body), status: 201 };
      case "files/activity":
        return { data: await this.ws.fileActivity(agentId, body) };
      case "files/search":
        return { data: await this.ws.searchFiles(agentId, body) };
      case "files/changes":
        return {
          data: await this.ws.review(agentId, {
            ...(body as object),
            staged: false,
          }),
        };
      case "files/changes/reset":
        return { data: await this.ws.resetChanges(agentId, body) };
      case "files/open":
      case "editors/open":
        return { data: await this.editors.open(agentId, body, true) };
      case "files/open-plan":
      case "editors/plan":
        return { data: await this.editors.open(agentId, body, false) };
      case "editors/preferences":
        return { data: await this.ws.sublimeEditorConfig(agentId, body) };
      case "git/state":
        return { data: await g.state(agentId, body) };
      case "git/branches":
        return { data: await g.branches(agentId, body) };
      case "git/switch":
        return { data: await g.switchBranch(agentId, body) };
      case "git/fetch":
        return { data: await g.fetch(agentId, body) };
      case "git/pull":
        return { data: await g.pull(agentId, body) };
      case "git/push":
        return { data: await g.push(agentId, body) };
      case "git/log":
        return { data: await g.log(agentId, body) };
      case "git/commit-info":
        return { data: await g.commit(agentId, body) };
      case "git/pr":
        return { data: await g.pullRequest(agentId, body) };
      case "git/pr/open":
        return { data: await g.openPullRequest(agentId, body) };
      case "git/pr/record":
        return { data: await g.recordPullRequest(agentId, body), status: 201 };
      case "git/conflicts":
        return { data: await g.conflicts(agentId, body) };
      case "git/conflict-file":
        return { data: await g.conflictFile(agentId, body) };
      case "git/resolve":
        return { data: await g.resolveConflicts(agentId, body) };
      case "git/integrate":
        return { data: await g.integrate(agentId, body) };
      case "git/abort":
        return { data: await g.abort(agentId, body) };
      case "git/continue":
        return { data: await g.continue(agentId, body) };
      case "git/init":
        return { data: await g.init(agentId, body), status: 201 };
      case "watch/start":
        return { data: await this.watch.subscribe(agentId, body) };
      default:
        return {
          data: await this.watch.unsubscribe(agentId, z.any().parse(body)),
        };
    }
  }
}
