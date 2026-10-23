// Scriptorium's wordmark comes through its theme, not through kit code: the
// page's sheet styles the kit's title slot (lowercase, the manuscript serif),
// outside every layer so it outranks the kit's utilities, and the kit's shell
// names no app's look for its title.
//
// It lives at src/scriptorium/, NOT inside surface/, for the reason
// sinks.test.ts gives: `@source "./"` scans the surface directory whole, and a
// test file there would add its strings to the page's stylesheet.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STYLES = join(import.meta.dir, "surface", "styles.css");
const SHELL = join(import.meta.dir, "..", "kit", "shell", "WorkspaceShell.tsx");

/** The sheet with its comments out, and each rule's selector with the layer it sits in. */
function rules(css: string): { selector: string; body: string; layered: boolean }[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string; layered: boolean }[] = [];
  const open: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      open.push(text.slice(start, i).trim());
      start = i + 1;
    } else if (c === "}") {
      const selector = open.pop() ?? "";
      out.push({
        selector,
        body: text.slice(start, i),
        layered: open.some((s) => s.startsWith("@layer")),
      });
      start = i + 1;
    } else if (c === ";" && open.length === 0) start = i + 1;
  }
  return out;
}

describe("Scriptorium's wordmark", () => {
  test("is the theme's: the title slot, lowercase in the manuscript serif, outside every layer", () => {
    const rule = rules(readFileSync(STYLES, "utf8")).find(
      (r) => r.selector === '[data-slot="app-title"]',
    );
    expect(rule).toBeDefined();
    expect(rule?.layered).toBe(false);
    expect(rule?.body).toContain("font-family: var(--font-manuscript)");
    expect(rule?.body).toContain("text-transform: lowercase");
  });

  test("the kit's shell draws its title in no app's face", () => {
    const shell = readFileSync(SHELL, "utf8");
    const title = /data-slot="app-title"[\s\S]*?className=\{([^\n]*)\}/.exec(shell)?.[1] ?? "";
    expect(title).not.toBe("");
    expect(title).not.toMatch(/manuscript|serif|lowercase/);
  });
});
