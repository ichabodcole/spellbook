// E65: a note owed an answer, as the surface reads it.
import { describe, expect, test } from "bun:test";
import { askAboutNote, badgesOn, elsewhere, loudest, owedLabel, waitingOf } from "./notes";

const w = (doc: string, noteId: string, badge: "working" | "stalled") => ({
  doc,
  noteId,
  since: 0,
  badge,
});

describe("badgesOn", () => {
  test("only the open document's notes, by id", () => {
    const got = badgesOn([w("a", "n1", "working"), w("b", "n2", "stalled")], "a");
    expect([...got.keys()]).toEqual(["n1"]);
    expect(got.get("n1")?.badge).toBe("working");
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
  test("names the passage and the document, and quotes a short note whole", () => {
    expect(
      askAboutNote({ quote: "the old\n  mill", body: "is this still standing?" }, "maren.md"),
    ).toBe("About my note on “the old mill” in maren.md: “is this still standing?”");
  });
  test("a long passage and a long note are both EXCERPTS — the note travels by reference", () => {
    const got = askAboutNote({ quote: "q".repeat(100), body: "b".repeat(300) }, "x.md");
    expect(got).toBe(`About my note on “${"q".repeat(59)}…” in x.md: “${"b".repeat(119)}…”`);
  });
  test("the cut falls between CHARACTERS, never inside an emoji", () => {
    const got = askAboutNote({ quote: "mill", body: "🌊".repeat(130) }, "x.md");
    expect(got).toBe(`About my note on “mill” in x.md: “${"🌊".repeat(119)}…”`);
  });
});

describe("elsewhere — owed notes on documents other than the open one (verifier D3)", () => {
  test("grouped by document, oldest document first, stuck if any of its notes is", () => {
    const got = elsewhere(
      [
        // c arrives FIRST but is the younger document, so the order is the
        // sort's, not the input's.
        { ...w("c", "n3", "working"), since: 3 },
        { ...w("b", "n2", "working"), since: 5 },
        // b's OLDER note comes second in the list: b is still the older document.
        { ...w("b", "n4", "stalled"), since: 2 },
        { ...w("a", "n1", "stalled"), since: 0 },
      ],
      "a",
    );
    expect(got).toEqual([
      { doc: "b", count: 2, badge: "stalled" },
      { doc: "c", count: 1, badge: "working" },
    ]);
  });
  test("with no document open, every document is elsewhere", () => {
    expect(elsewhere([w("a", "n1", "working")], null)).toEqual([
      { doc: "a", count: 1, badge: "working" },
    ]);
  });
});

describe("waitingOf — which words a waiting note gets", () => {
  test("asked about in the conversation reads as asked; otherwise as a note", () => {
    expect(waitingOf({ ...w("a", "n1", "working"), askedIn: "m1" })).toBe("asked");
    expect(waitingOf(w("a", "n1", "working"))).toBe("note");
  });
});

describe("owedLabel — the tab dot's words", () => {
  test("counts the stuck ones rather than saying 'one'", () => {
    expect(
      owedLabel([w("a", "n1", "stalled"), w("b", "n2", "stalled"), w("a", "n3", "working")]),
    ).toBe("3 notes owed an answer — 2 may be stuck");
  });
  test("a single stuck note is 'it'", () => {
    expect(owedLabel([w("a", "n1", "stalled")])).toBe("1 note owed an answer — it may be stuck");
  });
  test("none stuck, no claim of it", () => {
    expect(owedLabel([w("a", "n1", "working"), w("a", "n2", "working")])).toBe(
      "2 notes owed an answer",
    );
  });
});
