import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFeature, openSetup } from "./helpers";
import { MIN_FIT_ZOOM } from "../ui/canvas-fit";

// Canvas fit, edge declutter, unsaved-changes guard and the light theme (docs/ui-design.md).
// Temp AGENTTEAM_DATA_DIR, AGENTTEAM_TEST=1, fixture data through the API; no provider runs.
const shots = join("test-results", "ui-polish");

async function launch(directory: string) {
  const app = await electron.launch({
    args: [".", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    env: { ...process.env, AGENTTEAM_DATA_DIR: directory, AGENTTEAM_TEST: "1" },
  });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.getByTestId("workspace-ready")).toBeVisible();
  return { app, page, errors };
}
async function withApp(
  fn: (ctx: { start: () => ReturnType<typeof launch> }) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "agentteam-e2e-polish-"));
  const apps: ElectronApplication[] = [];
  try {
    await fn({
      start: async () => {
        const ctx = await launch(join(directory, "data"));
        apps.push(ctx.app);
        return ctx;
      },
    });
  } finally {
    for (const a of apps) await a.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
const api = (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(
    ([m, p, b]) => window.agentteam.request(m as string, p as string, b),
    [method, path, body] as const,
  );
const side = (page: Page) =>
  page.getByRole("complementary", { name: "Side panel" });
const transform = (page: Page) =>
  page
    .locator(".react-flow__viewport")
    .evaluate((el) => (el as HTMLElement).style.transform);
const zoomOf = (t: string) => Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? NaN);
/** Waits until the viewport transform stops changing (fit animations are 200 ms). */
async function settled(page: Page) {
  let last = "";
  await expect
    .poll(
      async () => {
        const now = await transform(page);
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [250] },
    )
    .toBe(true);
  return last;
}
/** Every visible card lies inside the canvas. */
async function cardsInside(page: Page) {
  const canvas = (await page.locator(".react-flow").boundingBox())!;
  const cards = await page.locator(".react-flow__node:visible").all();
  for (const c of cards) {
    const b = (await c.boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(canvas.x - 1);
    expect(b.y).toBeGreaterThanOrEqual(canvas.y - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(canvas.x + canvas.width + 1);
    expect(b.y + b.height).toBeLessThanOrEqual(canvas.y + canvas.height + 1);
  }
  return cards.length;
}
async function smallTeam(page: Page) {
  const lead = await api(page, "POST", "/agents", {
    name: "Lead",
    environment: "codex",
  });
  const a = await api(page, "POST", "/agents", {
    name: "Writer",
    environment: "codex",
    parentId: lead.id,
  });
  const b = await api(page, "POST", "/agents", {
    name: "Checker",
    environment: "claude",
    parentId: lead.id,
  });
  const tree = await api(page, "POST", "/edges", {
    from: lead.id,
    to: a.id,
    kind: "delegate",
    bidirectional: false,
    enabled: true,
  });
  const link = await api(page, "POST", "/edges", {
    from: a.id,
    to: b.id,
    kind: "review",
    bidirectional: false,
    enabled: true,
  });
  return { lead, a, b, tree, link };
}

test("canvas fit: fits the team, re-fits when the side panel opens/closes, offers Fit after a manual zoom", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    await smallTeam(page);
    // A stale manual zoom from an older build used to reopen the canvas nearly unreadable.
    await page.evaluate(() => {
      localStorage.setItem(
        "agentteam.viewport",
        JSON.stringify({ x: 200, y: 200, zoom: 0.15, manual: true }),
      );
    });
    await page.reload();
    await expect(page.locator(".agent-card")).toHaveCount(4);
    const first = await settled(page);
    expect(zoomOf(first)).toBeGreaterThanOrEqual(MIN_FIT_ZOOM);
    expect(await cardsInside(page)).toBe(4);
    // Hiding the side panel widens the canvas: the view re-fits (debounced).
    await page.getByRole("button", { name: "Hide side panel" }).click();
    await expect.poll(() => transform(page)).not.toBe(first);
    const wide = await settled(page);
    await cardsInside(page);
    // Selecting an agent opens its panel: narrower canvas, fitted again.
    await page.locator(".react-flow__node", { hasText: "Writer" }).click();
    const side = page.getByRole("complementary", { name: "Side panel" });
    await expect(side).toBeVisible();
    await expect(side.getByRole("tab", { name: "Chat" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await side.getByRole("tab", { name: "Agent setup" }).click();
    await expect(page.getByTestId("agent-panel")).toBeVisible();
    await expect.poll(() => transform(page)).not.toBe(wide);
    await settled(page);
    await cardsInside(page);
    await expect(page.getByTestId("fit-hint")).toHaveCount(0);
    // A manual zoom stops auto-fitting: the panel toggle now only shows the Fit hint.
    const box = (await page.locator(".react-flow").boundingBox())!;
    await page.mouse.move(box.x + box.width - 60, box.y + 60);
    await page.mouse.wheel(0, -300);
    const manual = await settled(page);
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("agent-panel")).toHaveCount(0);
    await page.getByRole("button", { name: "Hide side panel" }).click();
    await expect(page.getByTestId("fit-hint")).toBeVisible();
    expect(await settled(page)).toBe(manual);
    await page.getByTestId("fit-hint").click();
    await expect(page.getByTestId("fit-hint")).toHaveCount(0);
    await expect.poll(() => transform(page)).not.toBe(manual);
    await settled(page);
    await cardsInside(page);
    expect(errors).toEqual([]);
  });
});

test("wide teams at 1100 px with the side panel open: the automatic org chart reflows wide leaf rows into lines, so every card stays on the canvas; a hand-placed arrangement is never reflowed", async () => {
  await withApp(async ({ start }) => {
    const { page, app, errors } = await start();
    const size = (w: number, h: number) =>
      app.evaluate(
        ({ BrowserWindow }, [a, b]) =>
          BrowserWindow.getAllWindows()[0].setContentSize(a, b),
        [w, h] as const,
      );
    await size(1440, 900);
    await api(page, "POST", "/teams/examples/product-feature-team/insert", {
      acceptUnverifiedModels: true,
    });
    await page.reload();
    await expect(page.locator(".agent-card")).toHaveCount(8);
    await settled(page);
    const ys = async () =>
      new Set(
        await page
          .locator(".react-flow__node")
          .evaluateAll((ns) =>
            ns.map((n) => (n as HTMLElement).style.transform.split(",")[1]),
          ),
      ).size;
    const wideRows = await ys();
    await openSetup(page, "Backend Engineer");
    await expect(page.getByTestId("agent-panel")).toBeVisible();
    await size(1100, 760);
    // Re-flowed into more rows (lines) and fitted: every card inside the canvas.
    await expect.poll(ys).toBeGreaterThan(wideRows);
    await settled(page);
    expect(await cardsInside(page)).toBe(8);
    // Back to a wide window: the regular one-row chart returns.
    await size(1440, 900);
    await expect.poll(ys).toBe(wideRows);
    await settled(page);
    // A card moved by hand: the arrangement is the user's now and is never re-flowed.
    const card = page.locator(".react-flow__node", {
      hasText: "QA/Test Engineer",
    });
    const b = (await card.boundingBox())!;
    await page.mouse.move(b.x + 20, b.y + 10);
    await page.mouse.down();
    await page.mouse.move(b.x + 20, b.y + 140, { steps: 5 });
    await page.mouse.up();
    const handRows = await ys();
    await size(1100, 760);
    await page.waitForTimeout(800);
    expect(await ys()).toBe(handRows);
    expect(errors).toEqual([]);
  });
});

test("edges: tree edges are step connectors, other links dashed; labels hidden until hover; click still opens details", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    const { tree, link } = await smallTeam(page);
    await page.reload();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await settled(page);
    const treeEdge = page.locator(`.react-flow__edge[data-id="${tree.id}"]`);
    const linkEdge = page.locator(`.react-flow__edge[data-id="${link.id}"]`);
    await expect(treeEdge.locator("path.edge-tree")).toHaveCount(1);
    await expect(linkEdge.locator("path.edge-link")).toHaveCount(1);
    // Orthogonal: the step path only has horizontal/vertical segments (plus small rounded corners).
    const d = await treeEdge.locator("path.edge-tree").getAttribute("d");
    expect(d).toMatch(/Q/);
    expect(
      await linkEdge
        .locator("path.edge-link")
        .evaluate((p) => getComputedStyle(p).strokeDasharray),
    ).not.toBe("none");
    // Labels: in the DOM (and the edge's accessible name) but hidden by default.
    const captions = page.getByTestId("edge-caption");
    await expect(captions).toHaveCount(2);
    for (const c of await captions.all()) await expect(c).toBeHidden();
    await expect(treeEdge).toHaveAttribute(
      "aria-label",
      "Lead to Writer: Tasks",
    );
    await treeEdge.locator(".react-flow__edge-interaction").hover();
    await expect(captions.filter({ hasText: "Tasks" })).toBeVisible();
    await expect(captions.filter({ hasText: "Review" })).toBeHidden();
    await page.mouse.move(5, 300);
    await expect(captions.filter({ hasText: "Tasks" })).toBeHidden();
    // Clicking an edge still opens the connection dialog with its kind.
    await linkEdge.dispatchEvent("click");
    const dialog = page.getByRole("dialog", { name: "Connection settings" });
    await expect(
      dialog.getByRole("radio", { name: /Request a review/ }),
    ).toHaveAttribute("aria-checked", "true");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    // Context menu on a card still works.
    await page
      .locator(".react-flow__node", { hasText: "Checker" })
      .click({ button: "right" });
    await expect(page.locator(".context-menu")).toContainText(
      "Configure agent",
    );
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });
});

test("unsaved agent edits: close, switching agent and switching team ask Save / Discard / Cancel", async () => {
  await withApp(async ({ start }) => {
    const { page, errors, app } = await start();
    await smallTeam(page);
    await api(page, "POST", "/team-spaces", { name: "Other team" });
    await page.reload();
    const card = (name: string) =>
      page.locator(".react-flow__node", { hasText: name }).first();
    const panel = await openSetup(page, "Writer");
    const name = panel.getByLabel("Name", { exact: true });
    await name.fill("Writer 2");
    await expect(panel.getByTestId("agent-save")).toBeVisible();
    const dialog = page.getByRole("dialog", { name: /Save changes to/ });

    // Close → Cancel: still open, edit kept, focus inside the dialog then back.
    await panel.getByRole("button", { name: "Close agent panel" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save" })).toBeFocused();
    await page.screenshot({ path: join(shots, "unsaved-dialog.png") });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(name).toHaveValue("Writer 2");
    // Esc in the dialog is Cancel too.
    await page.keyboard.press("Escape"); // Esc on the panel = close → asks
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(panel).toBeVisible();

    // Switch agent → Discard: the other agent opens, nothing saved.
    await card("Checker").click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Discard" }).click();
    await expect(panel.getByTestId("agent-panel-name")).toHaveText("Checker");
    const agents = await api(page, "GET", "/agents");
    expect(agents.some((a: any) => a.name === "Writer 2")).toBe(false);

    // Edit again, switch agent → Save: saved, then the other agent opens.
    await panel.getByLabel("Name", { exact: true }).fill("Checker 2");
    await card("Lead").click();
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(panel.getByTestId("agent-panel-name")).toHaveText("Lead");
    await expect
      .poll(async () =>
        (await api(page, "GET", "/agents")).some(
          (a: any) => a.name === "Checker 2",
        ),
      )
      .toBe(true);

    // Switching team with unsaved edits asks too; Cancel keeps the team.
    await panel.getByLabel("Name", { exact: true }).fill("Lead 2");
    await page.getByTestId("team-switcher").click();
    await page
      .getByRole("group", { name: "Teams" })
      .getByRole("button", { name: /^Other team/ })
      .click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("active-team-name")).toHaveText("Main team");
    await expect(panel.getByLabel("Name", { exact: true })).toHaveValue(
      "Lead 2",
    );
    // Saving then leaves nothing to ask about.
    await panel.getByRole("button", { name: "Save changes" }).click();
    await expect(panel.getByTestId("agent-save")).toHaveCount(0);
    await panel.getByRole("button", { name: "Close agent panel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    // Closing the window with unsaved edits: the page vetoes the unload (the desktop then asks
    // natively, Esc = keep editing); it is never a trap, and test mode lets the window close.
    await openSetup(page, "Writer");
    await panel.getByLabel("Name", { exact: true }).fill("Writer 3");
    await expect(panel.getByTestId("agent-save")).toBeVisible();
    expect(
      await page.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      }),
    ).toBe(true);
    expect(errors).toEqual([]);
    await app.close();
  });
});

/** The app's own page background colour (body/root), as rgb(). */
const background = (page: Page) =>
  page.evaluate(
    () => getComputedStyle(document.documentElement).backgroundColor,
  );
const isLight = (rgb: string) => {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 180;
};

test("theme: Settings → Appearance switches light/dark, persists across a relaunch, System follows the OS", async () => {
  await withApp(async ({ start }) => {
    let { page, app, errors } = await start();
    await openFeature(page, "Settings");
    const theme = page.getByRole("combobox", { name: "Theme" });
    await expect(theme).toHaveValue("system");
    await theme.selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(isLight(await background(page))).toBe(true);
    await app.close();

    ({ page, app, errors } = await start());
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(isLight(await background(page))).toBe(true);
    // The main process follows the stored setting from the first frame of the relaunch: light
    // window background (no dark flash before the page paints) and native theme.
    const shell = () =>
      app.evaluate(({ BrowserWindow, nativeTheme }) => ({
        bg: BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase(),
        source: nativeTheme.themeSource,
      }));
    expect(await shell()).toEqual({ bg: "#f4f6f9", source: "light" });
    await openFeature(page, "Settings");
    await expect(page.getByRole("combobox", { name: "Theme" })).toHaveValue(
      "light",
    );
    await page.getByRole("combobox", { name: "Theme" }).selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(isLight(await background(page))).toBe(false);
    await expect.poll(shell).toEqual({ bg: "#10141c", source: "dark" });
    // System: follows prefers-color-scheme.
    await page.getByRole("combobox", { name: "Theme" }).selectOption("system");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(errors).toEqual([]);
  });
});

test("screenshots: empty team, example team with an agent selected, More, a feature tab, Settings and 1100 px, in both themes", async () => {
  await mkdir(shots, { recursive: true });
  await withApp(async ({ start }) => {
    const { page, app, errors } = await start();
    const size = (width: number, height: number) =>
      app.evaluate(
        ({ BrowserWindow }, [w, h]) =>
          BrowserWindow.getAllWindows()[0].setContentSize(w, h),
        [width, height] as const,
      );
    await size(1440, 900);
    const shoot = async (themeName: string, name: string) => {
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(shots, `${themeName}-${name}.png`) });
    };
    for (const t of ["dark", "light"] as const) {
      await page.evaluate(
        (v) => localStorage.setItem("agentteam.theme", JSON.stringify(v)),
        t,
      );
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", t);
      if (t === "dark") {
        await shoot(t, "empty-team");
        await api(page, "POST", "/teams/examples/product-feature-team/insert", {
          acceptUnverifiedModels: true,
        });
        await page.reload();
      } else {
        // The empty Main team again for the light shot.
        const snap = await api(page, "GET", "/snapshot");
        const product = snap.activeTeamId;
        await api(page, "PUT", "/team-spaces/active", { teamId: "main" });
        await page.reload();
        await shoot(t, "empty-team");
        await api(page, "PUT", "/team-spaces/active", { teamId: product });
        await page.reload();
      }
      await expect(page.locator(".agent-card")).toHaveCount(8);
      await settled(page);
      await shoot(t, "example-team");
      await openSetup(page, "Backend Engineer");
      await settled(page);
      await shoot(t, "example-agent-selected");
      // Hover the Engineering Manager → Backend Engineer connector near its child end.
      const edge = page.locator(".react-flow__edge.selectable", {
        has: page.locator("path.edge-tree"),
      });
      const target = (await page
        .locator(".react-flow__node", { hasText: "Backend Engineer" })
        .boundingBox())!;
      await page.mouse.move(target.x + target.width / 2, target.y - 6);
      await expect(edge.first()).toBeVisible();
      await shoot(t, "edge-hover");
      await page.mouse.move(5, 400);
      await page.getByRole("button", { name: "More", exact: true }).click();
      await shoot(t, "more-menu");
      await page.keyboard.press("Escape");
      await openFeature(page, "Projects");
      await shoot(t, "feature-tab");
      await openFeature(page, "Settings");
      await shoot(t, "settings");
      await openFeature(page, "Canvas");
      await size(1100, 760);
      await settled(page);
      await shoot(t, "narrow-1100");
      await page.getByRole("button", { name: "Close agent panel" }).click();
      await settled(page);
      await shoot(t, "narrow-1100-chat");
      await size(1440, 900);
      for (const tab of ["Projects", "Settings"])
        await page.getByRole("button", { name: `Close ${tab}` }).click();
    }
    expect(errors).toEqual([]);
  });
});

/**
 * Rendered text contrast (WCAG 2.x): every visible, enabled text node's computed colour against
 * the effective background behind it (translucent backgrounds composited up the ancestor chain).
 * Normal text needs 4.5:1, large text (24 px, or 18.66 px bold) 3:1. Returns the failures.
 */
async function contrastFailures(page: Page) {
  return page.evaluate(() => {
    type C = [number, number, number, number];
    const parse = (s: string): C => {
      const m = s.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
      return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1];
    };
    const over = (top: C, under: C): C => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (!a) return [0, 0, 0, 0];
      const mix = (i: number) =>
        (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    const lum = ([r, g, b]: C) => {
      const f = (v: number) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const background = (el: Element | null): C => {
      const chain: C[] = [];
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c[3] > 0) chain.push(c);
        if (c[3] >= 1) break;
      }
      let acc: C = [255, 255, 255, 1];
      for (const c of chain.reverse()) acc = over(c, acc);
      return acc;
    };
    const out: string[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim()) continue;
      seen.add(el);
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (
        !r.width ||
        !r.height ||
        r.bottom < 0 ||
        r.top > innerHeight ||
        cs.visibility === "hidden" ||
        el.closest(
          "[aria-hidden='true'], :disabled, [aria-disabled='true'], .sr-only, svg, .react-flow__minimap",
        )
      )
        continue;
      let opacity = 1;
      for (let e: Element | null = el; e; e = e.parentElement)
        opacity *= Number(getComputedStyle(e).opacity);
      if (opacity < 0.95) continue; // deliberately dimmed (e.g. disabled look)
      const bg = background(el);
      const fg = over(parse(cs.color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi + 0.05) / (lo + 0.05);
      const size = parseFloat(cs.fontSize),
        bold = Number(cs.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < need)
        out.push(
          `${ratio.toFixed(2)} "${n.textContent.trim().slice(0, 40)}" <${el.tagName.toLowerCase()}.${[...el.classList].join(".")}> ${cs.color} on rgb(${bg
            .slice(0, 3)
            .map(Math.round)
            .join(",")})`,
        );
    }
    return out;
  });
}

test("rendered text contrast meets WCAG AA in both themes (canvas, agent panel, Projects, Team settings, Settings)", async () => {
  await withApp(async ({ start }) => {
    const { page, errors } = await start();
    await api(page, "POST", "/teams/examples/product-feature-team/insert", {
      acceptUnverifiedModels: true,
    });
    const report: string[] = [];
    for (const t of ["dark", "light"] as const) {
      await page.evaluate(
        (v) => localStorage.setItem("agentteam.theme", JSON.stringify(v)),
        t,
      );
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", t);
      await expect(page.locator(".agent-card")).toHaveCount(8);
      await openSetup(page, "Backend Engineer");
      await page.waitForTimeout(400);
      for (const f of ["Canvas", "Projects", "Team settings", "Settings"]) {
        await openFeature(page, f);
        await page.waitForTimeout(300);
        for (const line of await contrastFailures(page))
          report.push(`${t} / ${f}: ${line}`);
      }
      for (const f of ["Projects", "Team settings", "Settings"])
        await page.getByRole("button", { name: `Close ${f}` }).click();
    }
    expect(report, report.join("\n")).toEqual([]);
    expect(errors).toEqual([]);
  });
});
