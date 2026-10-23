// Scriptorium's warm themes carry no violet (item scriptorium-violet-brand-off-theme).
// The kit paints links, drop targets, the "agent listening" dot, backlink hovers,
// the compare gutter and the `stable` chip from `--color-brand`, whose kit default
// is violet; this page maps it onto its rubric in both modes, and sets a rendered
// link in the text's own ink with a rubric underline through the two hooks the
// kit's document.css reads.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
    const dist = join(REPO, "plugins", "spellbook", "skills", "scriptorium", "dist");
    const file = readdirSync(dist).filter((f) => f.endsWith(".css"));
    expect(file).toHaveLength(1);
    const css = stripComments(readFileSync(join(dist, file[0] as string), "utf8"));
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
