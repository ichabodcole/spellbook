// A note owed an answer, as the surface reads it.
import { describe, expect, test } from "bun:test";
import { badgesOn, elsewhere, loudest, owedLabel, owedSummary } from "./noteWaiting.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const w = (doc: string, noteId: string, badge: "working" | "stalled", since = 0) => ({
  doc,
  noteId,
  since: iso(since),
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

describe("loudest: one mark for many notes", () => {
  test("nothing waiting, no mark", () => {
    expect(loudest([])).toBeNull();
  });
  test("all pulsing, a pulse", () => {
    expect(loudest(["working", "working"])).toBe("working");
  });
  test("any stuck note makes the mark stuck: a pulse must not hide one", () => {
    expect(loudest(["working", "stalled", "working"])).toBe("stalled");
  });
});

describe("elsewhere: owed notes on documents other than the open one", () => {
  test("grouped by document, oldest document first, stuck if any of its notes is", () => {
    const got = elsewhere(
      [
        // c arrives first but is the younger document, so the order is the
        // sort's, not the input's.
        w("c", "n3", "working", 3),
        w("b", "n2", "working", 5),
        // b's older note comes second in the list: b is still the older document.
        w("b", "n4", "stalled", 2),
        w("a", "n1", "stalled", 0),
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

describe("owedLabel: the tab dot's words", () => {
  test("counts the stuck ones rather than saying 'one'", () => {
    expect(
      owedLabel([w("a", "n1", "stalled"), w("b", "n2", "stalled"), w("a", "n3", "working")]),
    ).toBe("3 notes owed an answer; 2 may be stuck");
  });
  test("a single stuck note is 'it'", () => {
    expect(owedLabel([w("a", "n1", "stalled")])).toBe("1 note owed an answer; it may be stuck");
  });
  test("none stuck, no claim of it", () => {
    expect(owedLabel([w("a", "n1", "working"), w("a", "n2", "working")])).toBe(
      "2 notes owed an answer",
    );
  });
});

describe("owedSummary: one mark for the session's owed notes", () => {
  test("nothing owed, nothing to draw", () => {
    expect(owedSummary([], true)).toBeNull();
  });
  test("stuck if any is, with the counted words", () => {
    expect(owedSummary([w("a", "n1", "working"), w("b", "n2", "stalled")], true)).toEqual({
      badge: "stalled",
      label: "2 notes owed an answer; 1 may be stuck",
    });
  });
  test("with no agent listening it says so, unless the agent's snooze holds", () => {
    expect(owedSummary([w("a", "n1", "working")], false)?.badge).toBe("unheard");
    expect(
      owedSummary([{ ...w("a", "n1", "working"), acknowledged: true as const }], false)?.badge,
    ).toBe("working");
  });
});
