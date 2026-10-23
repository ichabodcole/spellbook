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

/** The DOM's own string-to-HTML routes, each matched on the comment-stripped code. */
const RAW_SINKS: readonly (readonly [string, RegExp])[] = [
  ["innerHTML write", /\.innerHTML\s*\+?=(?!=)/],
  ["outerHTML write", /\.outerHTML\s*\+?=(?!=)/],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["document.write", /\bdocument\.write(?:ln)?\b/],
  ["createContextualFragment", /\bcreateContextualFragment\b/],
];

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

  test("…and no raw DOM route from a string to HTML: no innerHTML/outerHTML write, insertAdjacentHTML, document.write or createContextualFragment", () => {
    // The cell above sees React's sink only. A raw `el.innerHTML = text` in a
    // ref callback or an effect is the same hole by another door, and it passed
    // here until 2026-10-22 (scriptorium-ward-blind-spots-after-deletion).
    // READING `innerHTML` (a test's `expect(el.innerHTML)`) is not a sink, so
    // only a write is matched: `=` or `+=`, never `==`.
    const files = surfaceFiles();
    expect(files.length).toBeGreaterThan(5);
    const found: string[] = [];
    for (const file of files) {
      const src = code(readFileSync(file, "utf8"));
      const rel = file.slice(SURFACE.length + 1);
      for (const [name, re] of RAW_SINKS) if (re.test(src)) found.push(`${rel}: ${name}`);
    }
    expect(found).toEqual([]);
  });

  test("CALIBRATION: the raw-sink patterns catch a write and not a read", () => {
    const hits = (src: string) => RAW_SINKS.filter(([, re]) => re.test(src)).map(([n]) => n);
    expect(hits("el.innerHTML = text;")).toEqual(["innerHTML write"]);
    expect(hits("ref.current!.innerHTML += more")).toEqual(["innerHTML write"]);
    expect(hits("node.outerHTML = s")).toEqual(["outerHTML write"]);
    expect(hits('el.insertAdjacentHTML("beforeend", s)')).toEqual(["insertAdjacentHTML"]);
    expect(hits("document.writeln(s)")).toEqual(["document.write"]);
    expect(hits("range.createContextualFragment(s)")).toEqual(["createContextualFragment"]);
    expect(hits('expect(map()?.innerHTML).not.toContain("x")')).toEqual([]);
    expect(hits("if (el.innerHTML === prev) return;")).toEqual([]);
  });

  test("the kit's renderer, which feeds the kit's sinks, never turns on raw HTML and checks every link target", () => {
    const md = code(readFileSync(RENDERER, "utf8"));
    // micromark's ONE dangerous option, which would void the whole claim.
    expect(md).not.toContain("allowDangerousHtml");
    // The href pass is the other half; `src/kit/lib/markdown.test.ts` exercises it.
    expect(md).toContain("safeHref");
  });
});
