import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature } from "./helpers";

test("effective access, shared resources, queue reasons and external-editor labels are visible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-coop-ui-"));
  const project = join(directory, "project");
  await mkdir(join(project, "secrets"), { recursive: true });
  await writeFile(join(project, "secrets", "key.txt"), "hidden");
  await writeFile(join(project, "readme.md"), "visible");
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: {
      ...process.env,
      AGENTTEAM_DATA_DIR: join(directory, "data"),
      AGENTTEAM_TEST: "1",
    },
  });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByText("Workspace connected", { exact: true }),
    ).toBeVisible();
    const ids = await page.evaluate(async (folder) => {
      const req = window.agentteam.request;
      const snapshot = await req("GET", "/snapshot");
      const { id, createdAt, control, ...config } = snapshot.agents[0];
      await req("PUT", "/agents/" + id, {
        ...config,
        workspaces: [
          {
            path: folder,
            access: "write",
            active: true,
            rules: [{ path: "secrets", access: "none" }],
          },
        ],
      });
      const other = await req("POST", "/agents", {
        name: "Reviewer",
        environment: "codex",
        workspaces: [{ path: folder, access: "read", active: true }],
      });
      const wf = await req("POST", "/workflows", {
        name: "Shared work",
        goal: "G",
        ownerId: id,
        completionCriteria: "D",
      });
      const holder = await req("POST", "/tasks", {
        workflowId: wf.id,
        agentId: id,
        title: "Holder task",
        completionCriteria: "D",
      });
      const waiting = await req("POST", "/tasks", {
        workflowId: wf.id,
        agentId: other.id,
        title: "Waiting task",
        completionCriteria: "D",
      });
      await req("POST", `/tasks/${holder.id}/status`, { status: "running" });
      return { id, waiting: waiting.id };
    }, project);
    // Detailed cards: rules and exclusions are summarized next to the folder access.
    await page.getByRole("button", { name: "Detailed cards" }).click();
    await expect(page.locator(".card-access").first()).toContainText(
      "RW −1 excluded",
    );
    // Workspace > Access: exact allowed and denied paths with reasons, plus the external-editor label.
    await openFeature(page, "Access & resources");
    const effective = page.getByTestId("effective-access");
    await expect(effective).toContainText("Effective access");
    await expect(effective.getByLabel("Denied paths")).toContainText("secrets");
    await expect(effective.getByLabel("Denied paths")).toContainText(
      "Excluded by rule",
    );
    await expect(effective.getByLabel("Denied paths")).toContainText(".git");
    await expect(effective.getByLabel("Allowed paths")).toContainText(
      "Read & write",
    );
    await expect(effective.getByTestId("external-notice")).toContainText(
      "External editors, interactive CLI sessions and native apps are outside",
    );
    // Hidden folders do not show up when browsing.
    await openFeature(page, "Files");
    await expect(page.getByText("readme.md").first()).toBeVisible();
    await expect(page.getByText("secrets", { exact: true })).toHaveCount(0);
    // Resources: shared paths, owner, queue position and wait reason.
    await openFeature(page, "Access & resources");
    const coop = page.getByTestId("cooperation");
    await expect(coop.getByTestId("shared-resource").first()).toContainText(
      project,
    );
    await expect(coop.getByTestId("shared-resource").first()).toContainText(
      "Overlap causing lock conflicts",
    );
    await expect(coop.getByTestId("lease-owner").first()).toContainText(
      "all attached folders",
    );
    const entry = coop.getByTestId("queue-entry").first();
    await expect(entry).toContainText("Waiting task");
    await expect(entry).toContainText("Shared files or folders are leased");
    await expect(entry).toContainText("holds the lease");
    await expect(coop.getByTestId("external-notice").last()).toContainText(
      "outside this enforcement",
    );
    // Task launch review shows what the task would reserve and wait for.
    await openFeature(page, "Projects");
    const wf = page.locator(".workflow").first();
    await wf.getByRole("button", { name: "Add task" }).click();
    const review = wf.getByTestId("launch-review");
    await expect(review).toContainText("every attached folder is leased");
    await expect(review).toContainText("Would wait for");
    await expect(review).toContainText("denied secrets");
    expect(ids.id).toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
