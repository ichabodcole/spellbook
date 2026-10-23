// Scriptorium's warm themes carry no violet (item scriptorium-violet-brand-off-theme).
// The kit paints links, drop targets, the "agent listening" dot, backlink hovers,
// the compare gutter and the `stable` chip from `--color-brand`, whose kit default
// is violet; this page maps it onto its rubric in both modes, and sets a rendered
// link in the text's own ink with a rubric underline through the two hooks the
// kit's document.css reads.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_HOOKS } from "../../kit/theme/index.ts";

const HERE = import.meta.dir;
const REPO = join(HERE, "..", "..", "..");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const own = stripComments(readFileSync(join(HERE, "styles.css"), "utf8"));
const kitDocument = stripComments(
  readFileSync(join(REPO, "src", "kit", "theme", "document.css"), "utf8"),
);

/** The bodies of every block whose selector is exactly `selector`, in order. */
function blocks(css: string, selector: RegExp): string[] {
  const out: string[] = [];
  const re = new RegExp(`${selector.source}\\s*\\{([^{}]*)\\}`, "g");
  for (const m of css.matchAll(re)) out.push(m[1] ?? "");
  return out;
}
/** Every value `--<name>` is declared with in `body`, in order. */
function decls(body: string, name: string): string[] {
  return [...body.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, "g"))].map((m) =>
    (m[1] ?? "").trim(),
  );
}

// The kit's violet in both modes (src/kit/theme/base.css), spelled as the build writes it.
const VIOLET = ["#a78bfa", "#7c3aed"];

describe("Scriptorium's theme maps the kit's brand off violet", () => {
  test("its @theme maps brand onto the rubric and sets the link hooks", () => {
    const theme = /@theme\s*\{([\s\S]*?)\n\}/.exec(own)?.[1] ?? "";
    expect(decls(theme, "color-brand")).toEqual(["var(--color-rubric)"]);
    expect(decls(theme, "color-on-brand")).toEqual(["var(--color-on-rubric)"]);
    expect(decls(theme, "color-link")).toEqual(["var(--color-ink)"]);
    expect(decls(theme, "color-link-underline")).toEqual(["var(--color-rubric)"]);
  });

  test("its light block maps brand again, after base.css's unlayered violet", () => {
    const light = blocks(own, /\[data-theme="light"\]/).join("\n");
    expect(decls(light, "color-brand")).toEqual(["var(--color-rubric)"]);
    expect(decls(light, "color-on-brand")).toEqual(["var(--color-on-rubric)"]);
  });

  test("a hovered link thickens its underline", () => {
    const hover = blocks(own, /\.md-prose a:hover/).join("\n");
    expect(hover).toMatch(/text-decoration-thickness:\s*2px/);
  });

  test("the kit's link rule reads the hooks, falling back to what it always drew", () => {
    const link = blocks(kitDocument, /\.md-prose a/).join("\n");
    expect(link).toContain("color: var(--color-link, var(--color-brand));");
    expect(link).toContain("text-decoration-color: var(--color-link-underline, currentColor);");
  });

  test("the shipped stylesheet: no dark violet, and the last light brand is the rubric", () => {
    const css = shipped();
    // The dark palette is the :root default; nothing there may be violet.
    const root = blocks(css, /:root, :host/).join("\n");
    expect(decls(root, "color-brand")).toEqual(["var(--color-rubric)"]);
    expect(css).not.toContain("#a78bfa");
    // base.css's light block still names the light violet, and a later one of
    // this page's own must outrank it (same selector, so the later one wins).
    const light = blocks(css, /\[data-theme="light"\]/).flatMap((b) => decls(b, "color-brand"));
    expect(light.at(-1)).toBe("var(--color-rubric)");
    expect(light.filter((v) => VIOLET.includes(v))).toEqual(["#7c3aed"]);
  });
});

/** The one stylesheet the build ships, comments stripped. */
function shipped(): string {
  const dist = join(REPO, "plugins", "spellbook", "skills", "scriptorium", "dist");
  const file = readdirSync(dist).filter((f) => f.endsWith(".css"));
  expect(file).toHaveLength(1);
  return stripComments(readFileSync(join(dist, file[0] as string), "utf8"));
}

// The kit's fuchsia `pointed` hue in both modes (src/kit/theme/base.css).
const FUCHSIA = ["#e879f9", "#a21caf"];

// Cole's picks where the rubric read wrongly (polish cycle, ruling 7, from
// theme-colours.html): each kit hook this page sets, and its value.
const PICKS: Record<string, string> = {
  "status-stable": "var(--color-added)",
  "status-stable-tint": "color-mix(in srgb, var(--color-added) 15%, transparent)",
  "ref-row": "color-mix(in srgb, var(--color-selected) 7%, transparent)",
  "ref-row-bar": "color-mix(in srgb, var(--color-selected) 70%, transparent)",
  "change-tick": "color-mix(in srgb, var(--color-ink-dim) 70%, transparent)",
  "change-tick-hover": "var(--color-ink-dim)",
  "find-current": "color-mix(in srgb, var(--color-attention) 55%, transparent)",
  "find-current-mark": "var(--color-ink)",
  "flash-mark": "var(--color-attention)",
  "human-bubble": "var(--color-surface)",
  "human-bubble-edge": "var(--color-edge)",
};

describe("where the rubric reads wrongly, Scriptorium sets the kit's hooks to Cole's picks", () => {
  const roots = () => blocks(own, /:root/);

  test("each pick, set once on :root", () => {
    const all = roots().join("\n");
    for (const [hook, value] of Object.entries(PICKS))
      expect(decls(all, `color-${hook}`), hook).toEqual([value]);
  });

  test("every hook it sets is one the kit reads (a misspelt hook is silently unset)", () => {
    const set = roots().flatMap((b) =>
      [...b.matchAll(/--color-([\w-]+):/g)].map((m) => m[1] ?? ""),
    );
    const declared = [
      ...set,
      ...["link", "link-underline"].filter((h) => own.includes(`--color-${h}:`)),
    ];
    for (const h of declared) expect(THEME_HOOKS as readonly string[], h).toContain(h);
    expect([...THEME_HOOKS].filter((h) => !declared.includes(h))).toEqual([]);
  });

  test("the stable chip, ref rows and change marks never take the rubric; selection never the accent (E40)", () => {
    for (const hook of [
      "status-stable",
      "ref-row",
      "ref-row-bar",
      "change-tick",
      "change-tick-hover",
    ])
      expect(PICKS[hook], hook).not.toContain("rubric");
    expect(PICKS["ref-row"]).toContain("--color-selected");
    // Lighter than the open row's tint (bg-selected/15), and a different shape.
    expect(Number(/(\d+)%/.exec(PICKS["ref-row"] ?? "")?.[1])).toBeLessThan(15);
  });

  test("find's current match is louder than the other matches (26% amber), in the same amber", () => {
    expect(PICKS["find-current"]).toContain("--color-attention");
    expect(Number(/(\d+)%/.exec(PICKS["find-current"] ?? "")?.[1])).toBeGreaterThan(26);
  });

  test("the pointed hue is amber in both modes, so no fuchsia is reachable", () => {
    const theme = /@theme\s*\{([\s\S]*?)\n\}/.exec(own)?.[1] ?? "";
    expect(decls(theme, "color-pointed")).toEqual(["var(--color-attention)"]);
    const light = blocks(own, /\[data-theme="light"\]/).join("\n");
    expect(decls(light, "color-pointed")).toEqual(["var(--color-attention)"]);
  });

  test("one color-mix() per rule: the build keeps the @supports copy of only the first", () => {
    for (const body of roots())
      expect((body.match(/color-mix\(/g) ?? []).length, body).toBeLessThanOrEqual(1);
  });

  test("the shipped stylesheet: every mixed pick keeps its var() copy, and no fuchsia outranks the amber", () => {
    const css = shipped();
    const supported = [
      ...css.matchAll(/@supports \(color: color-mix\(in lab, red, red\)\) \{([\s\S]*?)\n\}/g),
    ]
      .map((m) => m[1] ?? "")
      .join("\n");
    for (const [hook, value] of Object.entries(PICKS))
      if (value.startsWith("color-mix("))
        expect(decls(supported, `color-${hook}`), hook).toEqual([value]);
    const root = blocks(css, /:root, :host/).join("\n");
    expect(decls(root, "color-pointed")).toEqual(["var(--color-attention)"]);
    expect(css).not.toContain("#e879f9");
    const light = blocks(css, /\[data-theme="light"\]/).flatMap((b) => decls(b, "color-pointed"));
    expect(light.at(-1)).toBe("var(--color-attention)");
    expect(light.filter((v) => FUCHSIA.includes(v))).toEqual(["#a21caf"]);
  });
});
