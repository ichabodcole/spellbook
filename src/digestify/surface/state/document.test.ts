import { describe, expect, test } from "bun:test";
import { splitDocument } from "./document";

const marker = (id: string) => `<div data-qblock="${id}"></div>`;

describe("splitDocument (inventory Q1, Q2, M7)", () => {
  test("a document with no marker is one html segment", () => {
    expect(splitDocument("<p>hello</p>")).toEqual([{ kind: "html", html: "<p>hello</p>" }]);
  });

  test("the empty document is NO segments, not one empty one", () => {
    expect(splitDocument("")).toEqual([]);
  });

  test("a marker splits the html around it, in document order", () => {
    const html = `<p>before</p>${marker("scope")}<p>after</p>`;
    expect(splitDocument(html)).toEqual([
      { kind: "html", html: "<p>before</p>" },
      { kind: "question", id: "scope", marker: marker("scope") },
      { kind: "html", html: "<p>after</p>" },
    ]);
  });

  test("question order is the DOCUMENT's, never the questions array's", () => {
    const html = `${marker("second")}<p>x</p>${marker("first")}`;
    const ids = splitDocument(html)
      .filter((s) => s.kind === "question")
      .map((s) => (s.kind === "question" ? s.id : ""));
    expect(ids).toEqual(["second", "first"]);
  });

  test("a marker at the very start and at the very end emits no empty html segments", () => {
    expect(splitDocument(`${marker("a")}${marker("b")}`)).toEqual([
      { kind: "question", id: "a", marker: marker("a") },
      { kind: "question", id: "b", marker: marker("b") },
    ]);
  });

  test("⚠ a NESTED marker stays inside its html segment and is never split out", () => {
    // Splitting there would tear <blockquote> in half. Unreachable through
    // review.ts, which surrounds every marker it emits with blank lines so
    // marked emits it top level; a nested one can only come from a document
    // that literally contains such a div, whose id is therefore unknown — and
    // the old page left those in place too (template.html 1160-1161).
    const html = `<blockquote>${marker("nested")}</blockquote>${marker("top")}`;
    const segs = splitDocument(html);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ kind: "html", html: `<blockquote>${marker("nested")}</blockquote>` });
    expect(segs[1]?.kind).toBe("question");
  });

  test("a VOID tag does not open a depth that swallows the next marker", () => {
    // <img>, <br> and <hr> have no closing tag; a naive depth counter never
    // comes back to zero after one and every later marker is lost.
    const html = `<p>a<br>b</p><hr><img src="x">${marker("after")}`;
    expect(splitDocument(html).at(-1)?.kind).toBe("question");
  });

  test("a self-closing tag does not open a depth either", () => {
    expect(splitDocument(`<img src="x"/>${marker("a")}`).at(-1)?.kind).toBe("question");
  });

  test("depth returns to zero across nested elements", () => {
    const html = `<ul><li><code>x</code></li></ul>${marker("a")}<p>tail</p>`;
    expect(splitDocument(html).map((s) => s.kind)).toEqual(["html", "question", "html"]);
  });

  test("text containing a bare < is copied through, not read as a tag", () => {
    const html = `<p>1 &lt; 2</p>${marker("a")}`;
    expect(splitDocument(html)[0]).toEqual({ kind: "html", html: "<p>1 &lt; 2</p>" });
  });

  test("an unterminated tag at the end does not lose the tail", () => {
    expect(splitDocument("<p>x</p><div")).toEqual([{ kind: "html", html: "<p>x</p><div" }]);
  });

  test("an empty id is a question segment, not a skipped marker", () => {
    // review.ts rejects an empty id before the payload exists, but the split is
    // upstream of that knowledge and must not silently drop a marker.
    expect(splitDocument(marker(""))).toEqual([{ kind: "question", id: "", marker: marker("") }]);
  });
});
