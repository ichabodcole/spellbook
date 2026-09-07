// ⛔ DOES THE SANITISER STILL RUN?
//
// `renderMd` is `DOMPurify.sanitize(marked.parse(md), { USE_PROFILES: { html:
// true } })` and its input is UNTRUSTED DOCUMENT TEXT — a `--reference` file
// the agent pointed at without reading, a user's own notes, a proposal pasted
// from anywhere. Losing it would be SILENT: every document that is not an
// attack renders identically with and without the sanitiser, and no other check
// in this repo would notice.
//
// Bun has no DOM, so the real DOMPurify cannot be exercised under `bun test` —
// outside a browser its default export is the FACTORY and `renderMd` throws
// (measured; see `state/markdown.ts`). So the guard is split three ways:
//
//   1. state/markdown.test.ts — the COMPOSITION, both dependencies injected
//   2. THIS FILE              — no second sink, ever, anywhere in the surface
//   3. the browser drive      — real attack payloads through both sinks, in
//                               Chrome (behaviour inventory M1)
//
// This file is the one that catches a FUTURE second sink: someone adding a
// third `dangerouslySetInnerHTML` fed by a raw string, six months from now,
// with every other check still green.
//
// It lives at src/digestify/, NOT inside surface/, for the reason bounty's
// equivalent does: `@source "./"` in styles.css scans the surface directory
// whole, so a test file living there contributes its own strings to Tailwind's
// candidate set and changes the SHIPPED stylesheet.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SURFACE = join(import.meta.dir, "surface");

/** Comments are where this file's own subject matter gets DESCRIBED — the old
 *  page's `docEl.innerHTML =` is quoted in `state/document.ts`'s header, and
 *  four files name DOMPurify in prose. Strip them, or every cell below reads
 *  its own documentation as a violation. */
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

/** Every `dangerouslySetInnerHTML={{ __html: <expr> }}` in the surface, with
 *  the expression it is fed and the file it is in. */
function sinks(): { file: string; expr: string }[] {
  const found: { file: string; expr: string }[] = [];
  for (const file of walk(SURFACE)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+?)\s*\}\}/g)) {
      const expr = m[1];
      if (expr !== undefined) found.push({ file: file.replace(`${SURFACE}/`, ""), expr });
    }
  }
  return found;
}

/** The complete, DECLARED set of HTML sinks this surface is allowed to have.
 *  A fourth entry must be argued for in review, not merged quietly. */
const ALLOWED: { file: string; expr: string; why: string }[] = [
  {
    file: "components/DocumentView.tsx",
    expr: "html",
    why: "HtmlSegment's only prop — a run of the sanitised document, or this surface's own literal marker div, both out of splitDocument(renderMd(payload.markdown))",
  },
  {
    file: "components/QuestionCard.tsx",
    expr: "renderMd(question.prompt)",
    why: "the question prompt, rendered as full block markdown",
  },
];

describe("the surface's HTML sinks", () => {
  test("there are exactly two, and they are the declared two", () => {
    // A zero-guard: an empty scan and a clean surface look identical otherwise.
    const found = sinks();
    expect(found.length).toBeGreaterThan(0);
    expect(found.map((s) => `${s.file} <- ${s.expr}`).sort()).toEqual(
      ALLOWED.map((s) => `${s.file} <- ${s.expr}`).sort(),
    );
  });

  test("the document sink is fed by splitDocument over renderMd, never by a raw payload field", () => {
    const view = readFileSync(join(SURFACE, "components", "DocumentView.tsx"), "utf8");
    expect(view).toContain("splitDocument(renderMd(payload.markdown))");
    // The failure this catches: someone "simplifying" to payload.markdown.
    expect(view).not.toContain("__html: payload.markdown");
  });

  test("the document segment is MEMOISED — React 19 re-applies innerHTML on every update", () => {
    // Not a style rule. React 19 does not compare the previous `__html` and
    // skip: it rewrites the subtree on EVERY update of the element that carries
    // `dangerouslySetInnerHTML`. Measured on this surface — the countdown's
    // first one-second tick wiped the syntax highlighting, and would have
    // detached every comment chip's portal host with it. Dropping `memo` here
    // reintroduces both, and neither shows up on first paint.
    const view = readFileSync(join(SURFACE, "components", "DocumentView.tsx"), "utf8");
    expect(view).toContain("const HtmlSegment = memo(");
  });

  test("the ONLY module that imports dompurify is state/markdown.ts", () => {
    const callers = walk(SURFACE).filter((f) =>
      /from "dompurify"/.test(code(readFileSync(f, "utf8"))),
    );
    expect(callers.map((f) => f.replace(`${SURFACE}/`, ""))).toEqual(["state/markdown.ts"]);
  });

  test("the ONLY module that imports marked is state/markdown.ts — no unsanitised parse anywhere", () => {
    const callers = walk(SURFACE).filter((f) =>
      /from "marked"/.test(code(readFileSync(f, "utf8"))),
    );
    expect(callers.map((f) => f.replace(`${SURFACE}/`, ""))).toEqual(["state/markdown.ts"]);
  });

  test("renderMarkdown sanitises the parser's OUTPUT, in that order", () => {
    const md = readFileSync(join(SURFACE, "state", "markdown.ts"), "utf8");
    expect(md).toContain("deps.sanitize(deps.parse(md), SANITIZE_CONFIG)");
    expect(md).toContain("USE_PROFILES: { html: true }");
  });

  test("no other route from a string to the DOM: no innerHTML, no insertAdjacentHTML, no document.write", () => {
    for (const file of walk(SURFACE)) {
      const where = file.replace(`${SURFACE}/`, "");
      // `dangerouslySetInnerHTML` contains the word, so strip those too.
      const stripped = code(readFileSync(file, "utf8")).replace(/dangerouslySetInnerHTML/g, "");
      expect(`${where}:${/\.innerHTML\s*=/.test(stripped)}`).toBe(`${where}:false`);
      expect(`${where}:${/insertAdjacentHTML/.test(stripped)}`).toBe(`${where}:false`);
      expect(`${where}:${/document\.write/.test(stripped)}`).toBe(`${where}:false`);
    }
  });
});

describe("every payload field reaches the human", () => {
  // Digestify has no socket, so there is no `init` frame to guard the way
  // bounty's reaches-the-human.test.ts does. The equivalent question is the
  // same one: the daemon builds a payload with six fields (review.ts 27-34),
  // and a field the surface never renders is a field the agent thinks the human
  // saw. Add a row when review.ts adds a field.
  const FIELDS: { field: string; renderedBy: string }[] = [
    { field: "title", renderedBy: "components/Header.tsx" },
    { field: "markdown", renderedBy: "components/DocumentView.tsx" },
    { field: "questions", renderedBy: "components/QuestionCard.tsx" },
    { field: "theme", renderedBy: "state/themes.ts" },
    { field: "session_id", renderedBy: "components/SessionIdButton.tsx" },
    { field: "timeout_seconds", renderedBy: "components/TimerPill.tsx" },
  ];

  test("the payload type is exactly review.ts's six fields", () => {
    const types = readFileSync(join(SURFACE, "state", "types.ts"), "utf8");
    for (const { field } of FIELDS) expect(types).toContain(field);
  });

  test("every field is READ somewhere in the surface, and lands in a real component", () => {
    const wiring = walk(SURFACE)
      .map((f) => code(readFileSync(f, "utf8")))
      .join("\n");
    for (const { field, renderedBy } of FIELDS) {
      const read = wiring.includes(`payload.${field}`);
      expect(`${field}:${read}`).toBe(`${field}:true`);
      expect(readFileSync(join(SURFACE, renderedBy), "utf8").length).toBeGreaterThan(0);
    }
  });
});
