// What a click on a rendered link does (E33), as cells. The rendered document
// and the chat log share this one rule, so it lives in one place and is tested
// here rather than eyeballed twice.
import { describe, expect, test } from "bun:test";
import { linkAct } from "./renderedLink";

describe("a click on a rendered link", () => {
  test("http, https and mailto open outward, in a new tab", () => {
    for (const href of ["https://x.dev/a", "http://x.dev", "mailto:a@b.c", "HTTPS://X.DEV"])
      expect(linkAct({ href, blocked: false })).toEqual({ kind: "outward", href });
  });
  test("anything else is a document reference, followed by the daemon", () => {
    for (const href of ["./other.md", "../up/doc.md", "notes.md", "#anchor"])
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
