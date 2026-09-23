// E65: a note owed an answer, as the surface reads it.
import { describe, expect, test } from "bun:test";
import { askAboutNote, badgesOn, loudest } from "./notes";

const w = (doc: string, noteId: string, badge: "working" | "stalled") => ({
  doc,
  noteId,
  since: 0,
  badge,
});

describe("badgesOn", () => {
  test("only the open document's notes, by id", () => {
    const got = badgesOn([w("a", "n1", "working"), w("b", "n2", "stalled")], "a");
    expect([...got]).toEqual([["n1", "working"]]);
  });
  test("no open document, nothing", () => {
    expect(badgesOn([w("a", "n1", "working")], null).size).toBe(0);
  });
});

describe("loudest — one mark for many notes", () => {
  test("nothing waiting, no mark", () => {
    expect(loudest([])).toBeNull();
  });
  test("all pulsing, a pulse", () => {
    expect(loudest(["working", "working"])).toBe("working");
  });
  test("⛔ ANY stuck note makes the mark stuck — a pulse must not hide one", () => {
    expect(loudest(["working", "stalled", "working"])).toBe("stalled");
  });
});

describe("askAboutNote — the act that answers 'may be stuck'", () => {
  test("names the passage and the document, and carries the note whole", () => {
    expect(
      askAboutNote({ quote: "the old\n  mill", body: "is this still standing?" }, "maren.md"),
    ).toBe("About my note on “the old mill” in maren.md: is this still standing?");
  });
  test("a long passage is shortened to a label; the note itself never is", () => {
    const body = "b".repeat(300);
    const got = askAboutNote({ quote: "q".repeat(100), body }, "x.md");
    expect(got).toBe(`About my note on “${"q".repeat(59)}…” in x.md: ${body}`);
  });
});
