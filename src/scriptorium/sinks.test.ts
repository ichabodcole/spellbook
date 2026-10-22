// ⛔ DOES HTML REACH SCRIPTORIUM'S PAGE ONLY THROUGH THE KIT'S RENDERER?
//
// The page renders a document and a chat message as HTML, and what makes that
// safe is entirely upstream of the sink: micromark encodes raw HTML in the
// source, so every tag came from the renderer, and the renderer refuses a link
// target that is not http, https, mailto or relative. Feed a sink anything
// else (a document's text, a chat message, a daemon field) and the page
// executes it at a localhost origin that is also driving a daemon with
// filesystem verbs. Losing that would be SILENT: every document that is not an
// attack renders identically either way.
//
// ⚠ RE-AIMED AT THE CUTOVER (scriptorium-delete-shipped). This file declared
// the shipped surface's two sinks (its MarkdownView and ChatMessageView).
// Those were deleted with it. The page now renders through the kit's document
// pane and chat, whose two sinks the kit declares and holds
// (`src/kit/chat/chat.test.tsx`, "the kit's HTML sinks are the chat body and
// the rendered document"). What stays Scriptorium's is that its own surface
// adds NO sink beside them, and that the renderer those sinks are fed by still
// refuses raw HTML.
//
// It lives at src/scriptorium/, NOT inside surface/, because `@source "./"` in
// styles.css scans the surface directory whole: a test file there contributes
// its own strings to Tailwind's candidate set and changes the page's
// stylesheet.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SURFACE = join(import.meta.dir, "surface");
const RENDERER = join(import.meta.dir, "..", "kit", "lib", "markdown.ts");

/** ⛔ COMMENTS STRIPPED, AND THE STRIP IS PART OF THE ASSERTION: the files read
 *  here describe their subject in prose, and unstripped a sentence that names
 *  the setting reads as the setting. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every source file of the page, tests included (a test can render too). */
function surfaceFiles(dir: string = SURFACE, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) surfaceFiles(join(dir, e.name), out);
    else if (/\.tsx?$/.test(e.name)) out.push(join(dir, e.name));
  }
  return out;
}

describe("Scriptorium's page and its HTML sinks", () => {
  test("its own surface writes no HTML sink and no `__html` key", () => {
    const files = surfaceFiles();
    // A zero-guard: an empty scan and a clean surface look identical otherwise.
    expect(files.length).toBeGreaterThan(5);
    const found: string[] = [];
    for (const file of files) {
      const src = code(readFileSync(file, "utf8"));
      const rel = file.slice(SURFACE.length + 1);
      if (/dangerouslySetInnerHTML/.test(src)) found.push(`${rel}: dangerouslySetInnerHTML`);
      if (/__html\s*:/.test(src)) found.push(`${rel}: __html`);
    }
    expect(found).toEqual([]);
  });

  test("the kit's renderer, which feeds the kit's sinks, never turns on raw HTML and checks every link target", () => {
    const md = code(readFileSync(RENDERER, "utf8"));
    // micromark's ONE dangerous option, which would void the whole claim.
    expect(md).not.toContain("allowDangerousHtml");
    // The href pass is the other half; `src/kit/lib/markdown.test.ts` exercises it.
    expect(md).toContain("safeHref");
  });
});
