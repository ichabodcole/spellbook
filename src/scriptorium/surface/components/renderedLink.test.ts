// What a click on a rendered link does (E33), as cells. The rendered document
// and the chat log share this one rule, so it lives in one place and is tested
// here rather than eyeballed twice.
import { describe, expect, test } from "bun:test";
import type { MouseEvent } from "react";
import { linkAct, onRenderedLinkClick } from "./renderedLink";

describe("a click on a rendered link", () => {
  test("http, https and mailto open outward, in a new tab", () => {
    for (const href of ["https://x.dev/a", "http://x.dev", "mailto:a@b.c", "HTTPS://X.DEV"])
      expect(linkAct({ href, blocked: false })).toEqual({ kind: "outward", href });
  });
  test("anything else is a document reference, followed by the daemon", () => {
    for (const href of ["./other.md", "../up/doc.md", "notes.md", "other.md#section"])
      expect(linkAct({ href, blocked: false })).toEqual({ kind: "follow", href });
  });
  test("a link the renderer refused does nothing, whatever its href says", () => {
    expect(linkAct({ href: "https://x.dev", blocked: true })).toEqual({ kind: "none" });
    expect(linkAct({ href: null, blocked: true })).toEqual({ kind: "none" });
  });
  test("an anchor with no target does nothing", () => {
    expect(linkAct({ href: null, blocked: false })).toEqual({ kind: "none" });
    expect(linkAct({ href: "", blocked: false })).toEqual({ kind: "none" });
  });
});

// A footnote's `[^1]` renders as `href="#user-content-fn-1"`, and Cole clicked
// one in 5.0.0: it went to the daemon as a document, which answered "That link
// points at #user-content-fnref-1, which is not in this set." A fragment ALONE
// names a place on this page, not a document.
describe("a link that is only a fragment", () => {
  test("is a jump in place, never a document to follow", () => {
    expect(linkAct({ href: "#user-content-fn-1", blocked: false })).toEqual({
      kind: "jump",
      id: "user-content-fn-1",
    });
    expect(linkAct({ href: "#anchor", blocked: false })).toEqual({ kind: "jump", id: "anchor" });
  });
  test("its id is read decoded, the way the browser reads it", () => {
    expect(linkAct({ href: "#a%20b", blocked: false })).toEqual({ kind: "jump", id: "a b" });
    // ⛔ must not throw on a lone `%`
    expect(linkAct({ href: "#100%", blocked: false })).toEqual({ kind: "jump", id: "100%" });
  });
  test("a bare `#` goes nowhere", () => {
    expect(linkAct({ href: "#", blocked: false })).toEqual({ kind: "none" });
  });
});

/** A rendered container, minimally: the elements in it that carry an id. */
function container(ids: string[]) {
  const scrolled: string[] = [];
  const els = ids.map((id) => ({ id, scrollIntoView: () => scrolled.push(id) }));
  return { scrolled, els, node: { querySelectorAll: (_: string) => els } };
}
function click(href: string, within: ReturnType<typeof container>) {
  let prevented = false;
  const anchor = {
    getAttribute: (n: string) => (n === "href" ? href : null),
    hasAttribute: () => false,
  };
  const e = {
    target: { closest: () => anchor },
    currentTarget: within.node,
    preventDefault: () => {
      prevented = true;
    },
  } as unknown as MouseEvent;
  const sent: string[] = [];
  onRenderedLinkClick(e, (t) => sent.push(t));
  return { prevented, sent };
}

describe("the jump, in the container that was clicked", () => {
  test("scrolls to the target in THIS container and sends nothing to the daemon", () => {
    const first = container(["m-a1b2-fn-1", "m-a1b2-fnref-1"]);
    const second = container(["m-c3d4-fn-1", "m-c3d4-fnref-1"]);
    const r = click("#m-c3d4-fn-1", second);
    expect(r.prevented).toBe(true);
    expect(r.sent).toEqual([]);
    expect(second.scrolled).toEqual(["m-c3d4-fn-1"]);
    expect(first.scrolled).toEqual([]);
  });
  test("the back-ref goes back to the ref", () => {
    const one = container(["m-c3d4-fn-1", "m-c3d4-fnref-1"]);
    click("#m-c3d4-fnref-1", one);
    expect(one.scrolled).toEqual(["m-c3d4-fnref-1"]);
  });
  test("even if another container holds the same id, only the clicked one moves", () => {
    const first = container(["fn-1"]);
    const second = container(["fn-1"]);
    click("#fn-1", second);
    expect(second.scrolled).toEqual(["fn-1"]);
    expect(first.scrolled).toEqual([]);
  });
  test("a fragment with nothing to land on does nothing — no send, no navigation", () => {
    const one = container(["m-c3d4-fn-1"]);
    const r = click("#not-here", one);
    expect(r.prevented).toBe(true);
    expect(r.sent).toEqual([]);
    expect(one.scrolled).toEqual([]);
  });
  test("a document link still goes to the daemon", () => {
    const r = click("./other.md", container([]));
    expect(r.sent).toEqual(["./other.md"]);
  });
});
