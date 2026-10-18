import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitStep,
  fitViewport,
  sameViewport,
  MIN_FIT_ZOOM,
} from "../ui/canvas-fit.ts";
import { resolveTheme, sanitizeTheme } from "../ui/theme.ts";
import {
  formatColor,
  lightColor,
  lightDeclarations,
  lightSelector,
  lightValue,
  parseColor,
} from "../ui/theme-light.ts";

test("fitViewport centres a small team at zoom 1 (never zooms in past maxZoom)", () => {
  const v = fitViewport(
    { x: 0, y: 0, width: 260, height: 150 },
    { width: 1000, height: 800 },
  );
  assert.equal(v.zoom, 1);
  assert.equal(v.x, 500 - 130);
  assert.equal(v.y, 400 - 75);
});

test("fitViewport fits a wide team with padding, down to the readable minimum zoom", () => {
  const view = { width: 1000, height: 700 };
  const fits = fitViewport({ x: 100, y: 50, width: 1840, height: 300 }, view, {
    padding: 40,
  });
  assert.equal(fits.zoom, 0.5); // 920 / 1840
  const tooWide = fitViewport({ x: 0, y: 0, width: 4000, height: 300 }, view, {
    padding: 40,
  });
  assert.equal(tooWide.zoom, MIN_FIT_ZOOM); // 920 / 4000 would be too small to read
  const mid = fitViewport({ x: 0, y: 0, width: 1000, height: 300 }, view, {
    padding: 40,
  });
  assert.ok(Math.abs(mid.zoom - 0.92) < 1e-9);
  // Too wide for the minimum zoom: clamped, centred horizontally, top-aligned when too tall.
  const huge = fitViewport({ x: 0, y: 0, width: 6000, height: 3000 }, view, {
    padding: 40,
  });
  assert.equal(huge.zoom, MIN_FIT_ZOOM);
  assert.equal(huge.x, 500 - 3000 * MIN_FIT_ZOOM);
  assert.equal(huge.y, 40);
  // Every card of a team that fits stays inside the padded view.
  const ok = fitViewport({ x: -300, y: 0, width: 900, height: 400 }, view);
  assert.ok(ok.x + -300 * ok.zoom >= 39.9);
  assert.ok(ok.x + 600 * ok.zoom <= 1000 - 39.9);
});

test("fitStep: auto re-fit until a manual pan/zoom; then only the hint; an explicit fit resumes", () => {
  let s = { manual: false, hint: false };
  let r = fitStep(s, "resize");
  assert.equal(r.fit, true);
  r = fitStep(r.state, "user-move");
  assert.deepEqual(r, { state: { manual: true, hint: false }, fit: false });
  r = fitStep(r.state, "resize");
  assert.deepEqual(r, { state: { manual: true, hint: true }, fit: false });
  r = fitStep(r.state, "nodes");
  assert.equal(r.fit, false);
  r = fitStep(r.state, "explicit");
  assert.deepEqual(r, { state: { manual: false, hint: false }, fit: true });
  s = r.state;
  assert.equal(fitStep(s, "nodes").fit, true);
  assert.equal(sameViewport(null, { x: 0, y: 0, zoom: 1 }), false);
  assert.equal(
    sameViewport({ x: 1, y: 2, zoom: 0.5 }, { x: 1.4, y: 2.2, zoom: 0.5004 }),
    true,
  );
});

test("theme: System follows the OS, Light/Dark override it, junk falls back to System", () => {
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(sanitizeTheme("light"), "light");
  assert.equal(sanitizeTheme("dark"), "dark");
  assert.equal(sanitizeTheme("purple"), "system");
  assert.equal(sanitizeTheme(null), "system");
});

/** WCAG relative luminance contrast ratio. */
function contrast(a: string, b: string) {
  const lum = (c: string) => {
    const { r, g, b } = parseColor(c)!;
    const f = (v: number) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const light = (c: string) => formatColor(lightColor(parseColor(c)!));

test("light theme mapping: dark background → near white, light text → dark text; contrast kept", () => {
  const bg = light("#10141c"),
    text = light("#dce4ef"),
    muted = light("#8c9aad"),
    faint = light("#7f8ea3"),
    accent = light("#8cddc2");
  assert.ok(contrast(bg, "#ffffff") < 1.1, bg);
  assert.ok(contrast(text, bg) >= 7, `text ${text} on ${bg}`);
  assert.ok(contrast(muted, bg) >= 4.5, `muted ${muted} on ${bg}`);
  assert.ok(contrast(faint, bg) >= 4.5, `faint ${faint} on ${bg}`);
  assert.ok(contrast(accent, bg) >= 4.5, `accent ${accent} on ${bg}`);
  // Primary button: accent background with dark text stays readable once mirrored.
  assert.ok(contrast(light("#12342d"), accent) >= 4.5);
  // Dark-theme contrast for reference (both themes must read well).
  assert.ok(contrast("#dce4ef", "#10141c") >= 7);
  assert.ok(contrast("#8c9aad", "#10141c") >= 4.5);
  assert.ok(
    contrast("#7f8ea3", "#1a222d") >= 4.5,
    "dark faint on a raised surface",
  );
  // Hand-tuned light tokens (ui/theme-light.css) on the light page and on white.
  for (const [fg, name] of [
    ["#556274", "muted"],
    ["#636f80", "faint"],
  ])
    for (const surface of ["#f4f6f9", "#ffffff", "#eef1f5"])
      assert.ok(contrast(fg, surface) >= 4.5, `${name} ${fg} on ${surface}`);
});

test("light theme mapping: values, shadows, selectors and declaration twins", () => {
  assert.equal(lightValue("white-space", "nowrap"), "nowrap");
  assert.equal(lightValue("color-scheme", "dark"), "light");
  assert.match(
    lightValue("border", "1px solid #303b4c"),
    /^1px solid #[0-9a-f]{6}$/,
  );
  // A shadow stays dark (lighter), never turns into a white glow.
  const shadow = lightValue("box-shadow", "0 8px 25px #0002");
  assert.match(shadow, /#00000[0-9a-f]$|#000000[0-9a-f]{2}$/);
  assert.equal(lightSelector(":root"), ':root[data-theme="light"]');
  assert.equal(
    lightSelector(".a > .b:hover"),
    ':where(:root[data-theme="light"]) .a > .b:hover',
  );
  assert.equal(lightSelector("50%"), null);
  assert.equal(lightDeclarations([{ prop: "padding", value: "4px" }]), null);
  const twin = lightDeclarations([
    { prop: "padding", value: "4px" },
    { prop: "background", value: "none" },
    { prop: "color", value: "#dce4ef" },
  ])!;
  // Colour-bearing properties are copied (even without a colour) so the cascade stays the same.
  assert.deepEqual(
    twin.map((d) => d.prop),
    ["background", "color"],
  );
  assert.equal(twin[0].value, "none");
});
