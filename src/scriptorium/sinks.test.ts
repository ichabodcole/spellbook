// ⛔ IS THE RENDERED VIEW STILL THE ONLY WAY HTML REACHES THE PAGE?
//
// E29's rendered view has one `dangerouslySetInnerHTML`, and what makes it safe
// is entirely upstream of it: micromark encodes raw HTML in the source, so every
// tag came from the renderer, and `state/markdown.ts` refuses a link target that
// is not http, https, mailto or relative. Feed that sink anything else — a
// document's text, a chat message, a daemon field — and the page executes it at
// a localhost origin that is also driving a daemon with filesystem verbs.
//
// Losing it would be SILENT: every document that is not an attack renders
// identically either way. So, digestify's shape (its `sinks.test.ts`, which this
// follows): the sink set is DECLARED, and a second one has to be argued for
// rather than merged quietly.
//
// It lives at src/scriptorium/, NOT inside surface/, because `@source "./"` in
// styles.css scans the surface directory whole — a test file there contributes
// its own strings to Tailwind's candidate set and changes the SHIPPED stylesheet.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SURFACE = join(import.meta.dir, "surface");

/** ⛔ COMMENTS STRIPPED, AND THE STRIP IS PART OF THE ASSERTION. This file's
 *  subject is described in prose in the very files it reads: the renderer's own
 *  header explains why `allowDangerousHtml` must never be set, and unstripped
 *  the cell below reads that sentence as the setting. Caught on the first run
 *  (digestify's ward documents the same trap, and this is a second sighting). */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(join(dir, e.name), out);
    else if (/\.tsx?$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

/** Every `dangerouslySetInnerHTML={{ __html: <expr> }}` in the surface. */
function sinks(): { file: string; expr: string }[] {
  const found: { file: string; expr: string }[] = [];
  for (const file of walk(SURFACE)) {
    for (const m of readFileSync(file, "utf8").matchAll(
      /dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+?)\s*\}\}/g,
    )) {
      const expr = m[1];
      if (expr !== undefined) found.push({ file: file.replace(`${SURFACE}/`, ""), expr });
    }
  }
  return found;
}

/** The complete, DECLARED set of HTML sinks this surface may have. */
const ALLOWED = [
  {
    file: "components/MarkdownView.tsx",
    expr: "html",
    why: "the rendered view — `html` is `renderMarkdown(text)` and nothing else",
  },
] as const;

describe("the surface's HTML sinks", () => {
  test("there is exactly one, and it is the declared one", () => {
    const found = sinks();
    // A zero-guard: an empty scan and a clean surface look identical otherwise.
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((s) => `${s.file} <- ${s.expr}`).sort()).toEqual(
      ALLOWED.map((s) => `${s.file} <- ${s.expr}`).sort(),
    );
  });

  test("that sink is fed by renderMarkdown, in the same file, and by nothing else", () => {
    const view = code(readFileSync(join(SURFACE, "components", "MarkdownView.tsx"), "utf8"));
    expect(view).toContain("renderMarkdown(text)");
    // The failure this catches: someone "simplifying" to the raw document text.
    expect(view).not.toContain("__html: text");
  });

  test("the renderer never turns on raw HTML, and checks every link target", () => {
    const md = code(readFileSync(join(SURFACE, "state", "markdown.ts"), "utf8"));
    // micromark's ONE dangerous option, which would void the whole claim.
    expect(md).not.toContain("allowDangerousHtml");
    // The href pass is the other half, and it is what the cells in
    // state/markdown.test.ts exercise.
    expect(md).toContain("safeHref");
  });
});
