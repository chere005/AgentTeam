import { createHash } from "node:crypto";
import { z } from "zod";
import { TeamService } from "./service.ts";
import { WorkspaceService } from "./workspaces.ts";
import { WorktreeService } from "./worktrees.ts";
import { assert, type Agent } from "./model.ts";
export const localPreviewUrl = (value: string) => {
  const url = new URL(value);
  assert(
    url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      Number(url.port) >= 1024,
    "invalid_preview",
    "Use a local HTTP URL with a port between 1024 and 65535",
    400,
  );
  return url.toString();
};
export class DevelopmentService {
  team: TeamService;
  ws: WorkspaceService;
  worktrees: WorktreeService;
  constructor(team: TeamService) {
    this.team = team;
    this.ws = new WorkspaceService(team.store);
    this.worktrees = new WorktreeService(team, this.ws);
  }
  /** Creates (and by default attaches) a worktree; logic lives in worktrees.ts. */
  async worktree(agentId: string, input: unknown) {
    return this.worktrees.create(agentId, input);
  }
  async feedback(sourceId: string, input: unknown) {
    const data = z
      .object({
        workspace: z.string(),
        path: z.string(),
        staged: z.boolean(),
        diffHash: z.string(),
        targetId: z.string(),
        text: z.string().trim().min(1).max(10000),
        row: z.number().int().min(0),
        requestId: z.string().uuid(),
      })
      .strict()
      .parse(input);
    const existing = this.team.store
      .list<any>("review-feedback")
      .find((f) => f.id === data.requestId);
    if (existing) return existing;
    this.team.store.get<Agent>("agent", data.targetId);
    const review = await this.ws.review(sourceId, {
      workspace: data.workspace,
      path: data.path,
      staged: data.staged,
    });
    assert(
      createHash("sha256").update(review.diff).digest("hex") === data.diffHash,
      "review_changed",
      "This diff changed. Refresh and review it before sending feedback",
      409,
    );
    const lines = review.diff.split("\n");
    assert(
      data.row < lines.length,
      "invalid_line",
      "Choose a line from this diff",
      400,
    );
    let old = 0,
      next = 0,
      anchor = "diff metadata";
    for (let i = 0; i <= data.row; i++) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[i]);
      if (h) {
        old = +h[1];
        next = +h[2];
        continue;
      }
      if (lines[i].startsWith("+") && !lines[i].startsWith("+++"))
        anchor = "new line " + next++;
      else if (lines[i].startsWith("-") && !lines[i].startsWith("---"))
        anchor = "old line " + old++;
      else if (lines[i].startsWith(" ")) {
        anchor = "new line " + next++;
        old++;
      }
    }
    return this.team.store.transaction(() => {
      const session = this.team.session(data.targetId);
      const message = this.team.message(session.id, {
        text: `Code review feedback\nWorkspace: ${data.workspace}\nFile: ${data.path} (${data.staged ? "staged" : "unstaged"}, ${anchor})\nDiff snapshot: ${data.diffHash}\n\n${data.text}\n\nQuoted diff context:\n${lines.slice(Math.max(0, data.row - 3), data.row + 4).join("\n")}\n\nInspect the current file before applying changes; the quoted context is a snapshot.`,
      });
      const record = {
        ...data,
        id: data.requestId,
        sourceId,
        sessionId: session.id,
        messageId: message.id,
        createdAt: new Date().toISOString(),
      };
      this.team.store.put("review-feedback", record);
      this.team.store.emit("review.feedback_sent", data.targetId, {
        path: data.path,
        messageId: message.id,
      });
      return record;
    });
  }
  async close() {
    await this.worktrees.close();
  }
}
