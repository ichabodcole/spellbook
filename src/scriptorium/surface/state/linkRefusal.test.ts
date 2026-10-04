import { describe, expect, test } from "bun:test";
import { linkRefusal } from "./linkRefusal";

describe("linkRefusal — what the page says when a followed link does not open", () => {
  test("a missing file says it does not exist and names the path tried", () => {
    expect(
      linkRefusal({
        type: "link.target",
        target: "./nowhere.md",
        state: "missing",
        tried: "/w/world/nowhere.md",
      }),
    ).toBe(
      "That link points at ./nowhere.md, which does not exist: nothing at /w/world/nowhere.md.",
    );
  });

  test("a bare name nothing answers says no document has that name", () => {
    // `tried` for a wiki-style name is the name itself, not a path to show.
    expect(
      linkRefusal({ type: "link.target", target: "ghost", state: "missing", tried: "ghost" }),
    ).toBe("That link points at ghost, which does not exist: no document here is named ghost.");
    // An older daemon sent no `tried`: still never "not in this set".
    expect(linkRefusal({ type: "link.target", target: "ghost", state: "missing" })).toBe(
      "That link points at ghost, which does not exist.",
    );
  });

  test("a real file outside the context names it and the folder to add", () => {
    expect(
      linkRefusal({
        type: "link.target",
        target: "../other/t2.md?rel=x",
        state: "outside",
        path: "/w/other/t2.md",
      }),
    ).toBe(
      "../other/t2.md is outside this session's context. Add its folder, /w/other, to open it here.",
    );
  });

  test("a folder keeps its wording; an opened link says nothing", () => {
    expect(
      linkRefusal({ type: "link.target", target: "./part/", state: "folder", path: "/w/part" }),
    ).toBe("./part/ is a folder, not a document: /w/part.");
    expect(
      linkRefusal({ type: "link.target", target: "./a.md", state: "in-bundle", path: "/w/a.md" }),
    ).toBeNull();
  });
});
