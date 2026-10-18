/**
 * Light theme, derived from the dark stylesheets at build time (pure; node tests import this file,
 * vite.config.ts runs `lightThemePlugin` as a PostCSS plugin).
 *
 * Every app CSS rule that sets a colour-bearing property gets a twin right after it:
 * `:where(:root[data-theme="light"]) <selector> { …same declarations, colours mapped… }`.
 * `:where()` adds no specificity and the twin follows its original, so the cascade between rules
 * is exactly the dark one; the light twin of the winning rule wins. Colours are mapped in OKLCH:
 * lightness is mirrored (dark background → near white, light text → dark text, so contrast pairs
 * survive), hue kept, chroma clipped into sRGB. Shadows and backdrops stay dark but lighter.
 * Hand-tuned exceptions live in `ui/theme-light.css` (skipped by the plugin, loaded last).
 */

type RGBA = { r: number; g: number; b: number; a: number };

const lin = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const gam = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

function toOklab({ r, g, b }: RGBA) {
  const R = lin(r / 255),
    G = lin(g / 255),
    B = lin(b / 255);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B),
    m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B),
    s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}
function fromOklab(L: number, a: number, b: number) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Dark-theme anchors (page background, body text) and where they land in the light theme. */
const DARK_BG = 0.18,
  DARK_TEXT = 0.915,
  LIGHT_BG = 0.985,
  LIGHT_TEXT = 0.27,
  /** Mirrored lightness above which a colour is a surface (lifted towards white). */
  SURFACE = 0.86;

export function mirrorLightness(L: number) {
  const k = (LIGHT_BG - LIGHT_TEXT) / (DARK_TEXT - DARK_BG);
  return Math.min(1, Math.max(0, LIGHT_BG - (L - DARK_BG) * k));
}

export function parseColor(text: string): RGBA | null {
  const t = text.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  m = /^rgba?\(([^)]*)\)$/.exec(t);
  if (m) {
    const parts = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.some((x) => !Number.isFinite(x))) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
  }
  if (t === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (t === "black") return { r: 0, g: 0, b: 0, a: 1 };
  return null;
}

const hex2 = (n: number) =>
  Math.round(Math.min(255, Math.max(0, n)))
    .toString(16)
    .padStart(2, "0");
export function formatColor({ r, g, b, a }: RGBA) {
  return "#" + hex2(r) + hex2(g) + hex2(b) + (a < 1 ? hex2(a * 255) : "");
}

/**
 * Light counterpart of one dark-theme colour. `shadow`: the colour draws a shadow or a backdrop
 * (kept dark, at about half the opacity).
 */
export function lightColor(color: RGBA, shadow = false): RGBA {
  const lab = toOklab(color);
  if (color.a < 1 && (shadow || lab.L < 0.3))
    return shadow || lab.L < 0.12
      ? { ...color, a: Math.max(0.04, color.a * 0.45) }
      : // A translucent dark tint (a panel over the canvas): light tint instead.
        { r: 255, g: 255, b: 255, a: Math.min(1, color.a * 0.9) };
  let L = mirrorLightness(lab.L);
  // Raised dark surfaces (buttons, cards, inputs) land just under white: lift them so light
  // surfaces read as sheets rather than grey slabs.
  if (L > SURFACE)
    L = 0.93 + (L - SURFACE) * ((1 - 0.93) / (LIGHT_BG - SURFACE));
  let C = Math.hypot(lab.a, lab.b);
  const h = Math.atan2(lab.b, lab.a);
  // The dark greys are slightly blue; mirrored to near white that tint shows. Mute it.
  if (C < 0.05) C *= 0.35;
  const scale = C / (Math.hypot(lab.a, lab.b) || 1);
  lab.a *= scale;
  lab.b *= scale;
  // Clip chroma into sRGB (binary search on chroma, hue and lightness fixed).
  let lo = 0,
    hi = C,
    rgb = fromOklab(L, 0, 0);
  for (let i = 0; i < 18; i++) {
    const c = (lo + hi) / 2;
    const test = fromOklab(L, c * Math.cos(h), c * Math.sin(h));
    if (test.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) {
      lo = c;
      rgb = test;
    } else hi = c;
  }
  if (C > 0 && lo === C) rgb = fromOklab(L, lab.a, lab.b);
  const [r, g, b] = rgb.map((v) => gam(Math.min(1, Math.max(0, v))) * 255) as [
    number,
    number,
    number,
  ];
  return { r, g, b, a: color.a };
}

const COLOR_TOKEN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;

/** Maps every colour in a declaration value (keywords like `white-space` are untouched). */
export function lightValue(prop: string, value: string): string {
  if (prop === "color-scheme") return value.replace(/\bdark\b/, "light");
  const shadow = /shadow/.test(prop);
  return value.replace(COLOR_TOKEN, (token, offset: number, all: string) => {
    // `white`/`black` only as whole values-words (not inside an identifier like white-space).
    if (/^[a-z]/i.test(token) && /[-\w]/.test(all[offset - 1] ?? ""))
      return token;
    const c = parseColor(token);
    return c ? formatColor(lightColor(c, shadow)) : token;
  });
}

/** Properties whose cascade the light twin must reproduce (copied even without a colour). */
const COLOR_PROPS =
  /^(color|background(-color|-image)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?|color-scheme|--.*)$/;
const HAS_COLOR = new RegExp(COLOR_TOKEN.source);

export function lightSelector(selector: string): string | null {
  const s = selector.trim();
  if (!s || /^(from|to|\d+%)$/.test(s)) return null;
  if (s === ":root" || s === "html") return ':root[data-theme="light"]';
  if (/^(:root|html)\b/.test(s))
    return ':root[data-theme="light"]' + s.replace(/^(:root|html)/, "");
  return `:where(:root[data-theme="light"]) ${s}`;
}

type Decl = { prop: string; value: string; important?: boolean };
/**
 * Light twin of one rule's declarations: null when the rule sets no colour. Declarations of
 * colour-bearing properties are copied (mapped), others dropped.
 */
export function lightDeclarations(decls: Decl[]): Decl[] | null {
  if (!decls.some((d) => HAS_COLOR.test(d.value) || d.prop === "color-scheme"))
    return null;
  const out = decls
    .filter((d) => COLOR_PROPS.test(d.prop))
    .map((d) => ({ ...d, value: lightValue(d.prop, d.value) }));
  return out.length ? out : null;
}

/** Minimal PostCSS plugin (no postcss import needed; Vite supplies the runtime). */
export function lightThemePlugin() {
  return {
    postcssPlugin: "agentteam-light-theme",
    Once(root: any) {
      const file: string = root.source?.input?.file ?? "";
      if (/node_modules|theme-light\.css$/.test(file)) return;
      root.walkRules((rule: any) => {
        if (
          rule.parent?.type === "atrule" &&
          /keyframes$/i.test(rule.parent.name)
        )
          return;
        if (rule.__agentteamLight) return;
        const decls: Decl[] = [];
        rule.each((n: any) => {
          if (n.type === "decl")
            decls.push({
              prop: n.prop,
              value: n.value,
              important: n.important,
            });
        });
        const light = lightDeclarations(decls);
        const selectors = (rule.selectors as string[])
          .map(lightSelector)
          .filter((s): s is string => !!s);
        if (!light || !selectors.length) return;
        const twin = rule.clone({ selectors });
        twin.removeAll();
        for (const d of light)
          twin.append({
            prop: d.prop,
            value: d.value,
            important: d.important,
            // Keeps Vite's url() rewriting informed of the originating file.
            source: rule.source,
          });
        twin.__agentteamLight = true;
        rule.after(twin);
      });
    },
  };
}
lightThemePlugin.postcss = true;
