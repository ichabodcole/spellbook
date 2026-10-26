// The DOM half of the rendered view's selection. kit-lone-cr-line-endings: when
// the page's text runs could not be placed in the projection (a lone-CR file,
// before the projection read a lone `\r` as a break), a selection made wholly
// inside one of them borrowed its neighbours' places, crossed, and was turned
// round into everything between them: "alpha" became a note over the body.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installDom, removeDom } from "../lib/testDom.ts";
import { project } from "./projection.ts";
import { resolveRange } from "./renderedRange.ts";

beforeAll(() => installDom());
afterAll(async () => {
  await removeDom();
});

/** A body of three paragraphs, as the page would draw them. */
function body(paragraphs: string[]): HTMLElement {
  const root = document.createElement("div");
  for (const t of paragraphs) {
    const p = document.createElement("p");
    p.textContent = t;
    root.append(p);
  }
  document.body.append(root);
  return root;
}

/** A DOM range over characters `from`..`to` of paragraph `i`'s text node. */
function within(root: HTMLElement, i: number, from: number, to: number): Range {
  const node = root.children[i]?.firstChild as Text;
  const r = document.createRange();
  r.setStart(node, from);
  r.setEnd(node, to);
  return r;
}

describe("resolveRange", () => {
  test("a selection inside a run the projection placed resolves to its own source", () => {
    const text = "Intro\n\nFirst line alpha here\n\nEnd\n";
    const root = body(["Intro", "First line alpha here", "End"]);
    const at = "First line ".length;
    const r = resolveRange(root, project(text), within(root, 1, at, at + 5));
    expect(r && text.slice(r.from, r.to)).toBe("alpha");
    root.remove();
  });

  test("a selection wholly inside a run with no place is no range, never its neighbours' span", () => {
    // The page's middle paragraph is not in the projection's text, as a lone-CR
    // paragraph's was not: its run cannot be placed.
    const text = "Intro\n\nFirst line\rsecond alpha\n\nEnd\n";
    const root = body(["Intro", "unplaced run, alpha in it", "End"]);
    const at = "unplaced run, ".length;
    expect(resolveRange(root, project(text), within(root, 1, at, at + 5))).toBeNull();
    root.remove();
  });

  test("a selection from placed text into a run with no place stops where the placed text ends", () => {
    const text = "Intro words\n\nNot what the page shows\n\nEnd\n";
    const root = body(["Intro words", "unplaced run", "End"]);
    const range = document.createRange();
    range.setStart(root.children[0]?.firstChild as Text, "Intro ".length);
    range.setEnd(root.children[1]?.firstChild as Text, 4);
    const r = resolveRange(root, project(text), range);
    // Never wider than what was selected: the unplaced part is left out.
    expect(r && text.slice(r.from, r.to)).toBe("words");
    root.remove();
  });
});
