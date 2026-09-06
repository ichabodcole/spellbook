import { describe, expect, test } from "bun:test";
import {
  aliasColor,
  appendMessage,
  closeConfirmText,
  emptyFeed,
  fromLabel,
  hashHue,
  isChannelArchived,
  mergeChannels,
  nearBottom,
  snippet,
  subLabel,
} from "./feed";
import type { Message } from "./types";

const msg = (id: number, extra: Partial<Message> = {}): Message => ({
  id,
  channel: "a",
  from: "agent",
  text: `m${id}`,
  ts: 0,
  kind: "message",
  ...extra,
});

describe("feed (inventory E2, F4, F9, N2)", () => {
  test("E2 — append pushes, indexes by id, and tracks the highest id", () => {
    let f = emptyFeed();
    f = appendMessage(f, msg(3)).feed;
    f = appendMessage(f, msg(1)).feed;
    expect(f.messages.map((m) => m.id)).toEqual([3, 1]);
    expect(f.byId.get(1)?.text).toBe("m1");
    expect(f.highest).toBe(3);
  });
  test("E2 — a topic message also yields the new topic; others do not", () => {
    const r = appendMessage(emptyFeed(), msg(1, { kind: "topic", text: "design review" }));
    expect(r.topic).toBe("design review");
    expect(appendMessage(emptyFeed(), msg(1)).topic).toBeUndefined();
  });
  test("E2 — a message without a numeric id is rendered but neither indexed nor counted", () => {
    const r = appendMessage(emptyFeed(), { ...msg(1), id: undefined as unknown as number });
    expect(r.feed.messages.length).toBe(1);
    expect(r.feed.byId.size).toBe(0);
    expect(r.feed.highest).toBe(0);
  });
  test("append is pure — the previous feed is untouched", () => {
    const a = emptyFeed();
    appendMessage(a, msg(1));
    expect(a.messages).toEqual([]);
    expect(a.byId.size).toBe(0);
  });
});

describe("presentation helpers (F2, F3, F7, F8, S2, C11)", () => {
  test("E3 — near-bottom is an 80 px band", () => {
    expect(nearBottom(0, 500, 500)).toBe(true);
    expect(nearBottom(0, 500, 580)).toBe(true);
    expect(nearBottom(0, 500, 581)).toBe(false);
  });
  test("F7 — same alias, same hue; hue is within [0, 360)", () => {
    expect(hashHue("cole")).toBe(hashHue("cole"));
    expect(aliasColor("cole")).toBe(aliasColor("cole"));
    expect(aliasColor("cole")).toMatch(/^hsl\(\d+ 70% 70%\)$/);
    expect(aliasColor(null)).toBe(aliasColor(""));
    for (const s of ["a", "prospero", "a very long alias indeed"]) {
      const h = hashHue(s);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });
  test("F8 — snippet cuts at 80", () => {
    expect(snippet("x".repeat(80))).toBe("x".repeat(80));
    expect(snippet("x".repeat(81))).toBe(`${"x".repeat(80)}…`);
  });
  test("F3 — a topic change reads `<from> set topic`", () => {
    expect(fromLabel(msg(1))).toBe("agent");
    expect(fromLabel(msg(1, { kind: "topic" }))).toBe("agent set topic");
  });
  test("S2 — you, human, agent", () => {
    expect(subLabel("cole", "cole", ["cole", "bob"])).toBe("cole (you)");
    expect(subLabel("bob", "cole", ["bob"])).toBe("bob (human)");
    expect(subLabel("agent", "cole", ["bob"])).toBe("agent");
  });
  test("C11 — the close confirmation text is the page's, verbatim", () => {
    expect(closeConfirmText("x")).toBe(
      'Close channel "x"? This deletes its message log and disconnects any subscribers. This cannot be undone.',
    );
  });
});

describe("channel rail (C6–C8, C12)", () => {
  test("C6 — the first poll never flags; a later arrival does; a known name does not", () => {
    const first = mergeChannels(new Set(), [{ name: "lobby" }], true);
    expect(first.rows).toEqual([{ name: "lobby", subscribers: 0, archived: false, isNew: false }]);
    const second = mergeChannels(first.seen, [{ name: "lobby" }, { name: "new" }], false);
    expect(second.rows.map((r) => [r.name, r.isNew])).toEqual([
      ["lobby", false],
      ["new", true],
    ]);
    const third = mergeChannels(second.seen, [{ name: "new" }], false);
    expect(third.rows[0]?.isNew).toBe(false);
  });
  test("C7/C8 — archived and subscriber count default", () => {
    const r = mergeChannels(new Set(), [{ name: "a", subscribers: 2, archived: true }], true);
    expect(r.rows[0]).toEqual({ name: "a", subscribers: 2, archived: true, isNew: false });
  });
  test("C12 — the viewed channel's archived flag; absent channel is not archived", () => {
    const rows = mergeChannels(new Set(), [{ name: "a", archived: true }], true).rows;
    expect(isChannelArchived(rows, "a")).toBe(true);
    expect(isChannelArchived(rows, "b")).toBe(false);
  });
});
