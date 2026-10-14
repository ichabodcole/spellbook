// The human is waiting, and how that reads.
import { describe, expect, test } from "bun:test";
import {
  attentionKey,
  DEFAULT_SNOOZE_MS,
  NOTE_TEXT_MAX,
  noteEventFacts,
  STALL_MS,
  waitingOn,
} from "./waiting";

type From = "human" | "agent" | "system";
let seq = 0;
/** A message at `ms` after the epoch, with its timestamp as the wire carries it: ISO. */
const msg = (from: From, ms: number) => ({
  id: `m${++seq}`,
  from,
  ts: new Date(ms).toISOString(),
});
const iso = (ms: number) => new Date(ms).toISOString();

describe("waitingOn", () => {
  test("nothing said, nobody waiting", () => {
    expect(waitingOn([], 1000)).toBeNull();
  });

  test("an agent reply answers the human", () => {
    const chat = [msg("human", 0), msg("agent", 10)];
    expect(waitingOn(chat, 100_000)).toBeNull();
  });

  test("a human message with nothing after it is a wait", () => {
    const m = msg("human", 1000);
    const got = waitingOn([m], 1500);
    expect(got).toEqual({ messageId: m.id, since: iso(1000), badge: "working" });
  });

  test("under the threshold it is a pulse; at it, stalled", () => {
    const m = msg("human", 0);
    expect(waitingOn([m], STALL_MS - 1)?.badge).toBe("working");
    expect(waitingOn([m], STALL_MS)?.badge).toBe("stalled");
  });

  test("a system line is not a reply: narration must not silence the signal", () => {
    // The daemon writes these when the agent acts, so this is the exact case
    // the feature exists for: busy, and not a word to the person waiting.
    const m = msg("human", 0);
    const chat = [m, msg("system", 5), msg("system", 9)];
    const got = waitingOn(chat, STALL_MS + 1);
    expect(got?.messageId).toBe(m.id);
    expect(got?.badge).toBe("stalled");
  });

  test("a task the agent started is a reply, because it posts as the agent", () => {
    const chat = [msg("human", 0), msg("agent", 20)];
    expect(waitingOn(chat, STALL_MS * 10)).toBeNull();
  });

  test("the clock runs from the first unanswered message, not the latest", () => {
    // Three messages while waiting: they have been waiting since the first.
    const first = msg("human", 0);
    const chat = [first, msg("human", 8000), msg("human", 16_000)];
    const got = waitingOn(chat, 20_000);
    expect(got?.since).toBe(iso(0));
    expect(got?.messageId).toBe(first.id);
    // ...and that is already past the threshold, which resetting would have hidden.
    expect(waitingOn(chat, STALL_MS)?.badge).toBe("stalled");
  });

  test("an earlier answered exchange does not count as waiting", () => {
    const chat = [msg("human", 0), msg("agent", 10), msg("human", 20), msg("agent", 30)];
    expect(waitingOn(chat, 999_999)).toBeNull();
  });

  test("a snooze keeps it a pulse past the threshold: the agent said it is alive", () => {
    const m = msg("human", 0);
    const got = waitingOn([m], STALL_MS + 5000, { acknowledgedUntil: STALL_MS + 60_000 });
    expect(got?.badge).toBe("working");
    // Said, so the surface never overrules it with "no agent listening".
    expect(got?.acknowledged).toBe(true);
    expect(waitingOn([m], 10)?.acknowledged).toBeUndefined();
    // A snooze starting or ending re-broadcasts even when the badge is the same.
    expect(attentionKey(got)).not.toBe(attentionKey(waitingOn([m], 10)));
  });

  test("when the snooze expires the human is owed the truth", () => {
    const m = msg("human", 0);
    const until = STALL_MS + 10_000;
    expect(waitingOn([m], until - 1, { acknowledgedUntil: until })?.badge).toBe("working");
    expect(waitingOn([m], until, { acknowledgedUntil: until })?.badge).toBe("stalled");
  });

  test("a snooze cannot resurrect an answered exchange", () => {
    const chat = [msg("human", 0), msg("agent", 10)];
    expect(waitingOn(chat, 50_000, { acknowledgedUntil: 999_999 })).toBeNull();
  });

  test("the threshold is configurable, and the default snooze is longer than it", () => {
    const m = msg("human", 0);
    expect(waitingOn([m], 500, { stallMs: 100 })?.badge).toBe("stalled");
    // A snooze shorter than the stall would flap: stalled, working, stalled.
    expect(DEFAULT_SNOOZE_MS).toBeGreaterThan(STALL_MS);
  });

  test("an agent message before the human's does not answer it", () => {
    const chat = [msg("agent", 0), msg("human", 10)];
    expect(waitingOn(chat, 20)?.badge).toBe("working");
  });

  test("an unparseable timestamp never reads as stalled", () => {
    const m = { id: "mx", from: "human" as const, ts: "not a date" };
    expect(waitingOn([m], 10 * STALL_MS)?.badge).toBe("working");
  });
});

describe("noteEventFacts: what `note.added` tells the agent", () => {
  const n = { id: "n1", quote: "the old mill", body: "is this still standing?" };
  const lines = { from: 3, to: 3 };

  test("a short note travels whole (quote, body and lines) and names resolving as the close", () => {
    const got = noteEventFacts("maren", n, lines, "s1");
    expect(got).toEqual({
      lines: { from: 3, to: 3 },
      quote: "the old mill",
      body: "is this still standing?",
      hint: "act on it, then `note-resolve n1 --session s1 --doc maren` when it is dealt with",
    });
  });

  test("at the cap it still travels whole", () => {
    const quote = "q".repeat(400);
    const body = "b".repeat(600);
    const got = noteEventFacts("maren", { id: "n1", quote, body }, lines, "s1");
    expect(got.body).toBe(body);
    expect(got.quote).toBe(quote);
  });

  test("one character over, it points at `notes` instead, and is never truncated", () => {
    const quote = "q".repeat(401);
    const body = "b".repeat(600);
    const got = noteEventFacts("maren", { id: "n1", quote, body }, lines, "s1");
    expect(got).toEqual({
      lines: { from: 3, to: 3 },
      hint: "too long to carry; read it with `notes --session s1 --doc maren`, act on it, then `note-resolve n1 --session s1 --doc maren`",
    });
  });

  test("the cap counts characters (code points), not UTF-16 units", () => {
    // 400 emoji are 800 UTF-16 units but 400 characters: 1000 in all, so whole.
    const quote = "😀".repeat(400);
    const got = noteEventFacts("maren", { id: "n1", quote, body: "b".repeat(600) }, lines, "s1");
    expect(got.quote).toBe(quote);
    const over = noteEventFacts("maren", { id: "n1", quote, body: "b".repeat(601) }, lines, "s1");
    expect(over.quote).toBeUndefined();
  });

  test("a note whose passage is gone says so, and points at `notes`", () => {
    expect(noteEventFacts("maren", n, null, "s1")).toEqual({
      quote: "the old mill",
      body: "is this still standing?",
      passage: "gone",
      hint: "its passage is no longer in the active version; see `notes --session s1 --doc maren`, then act on it and `note-resolve n1 --session s1 --doc maren` when it is dealt with",
    });
  });

  test("the cap is a paragraph's worth, not a page's", () => {
    expect(NOTE_TEXT_MAX).toBe(1000);
  });

  test("lines travel even when the text does not, and are absent for an orphan", () => {
    const long = { id: "n1", quote: "q".repeat(2000), body: "b" };
    expect(noteEventFacts("maren", long, { from: 5, to: 9 }, "s1").lines).toEqual({
      from: 5,
      to: 9,
    });
    expect("lines" in noteEventFacts("maren", n, null, "s1")).toBe(false);
  });

  test("a long orphan says both: gone, and too long to carry", () => {
    const long = { id: "n1", quote: "q".repeat(2000), body: "b" };
    expect(noteEventFacts("maren", long, null, "s1")).toEqual({
      passage: "gone",
      hint: "too long to carry, and its passage is no longer in the active version; read it with `notes --session s1 --doc maren`, act on it, then `note-resolve n1 --session s1 --doc maren`",
    });
  });
});

describe("attentionKey: what makes the tick re-broadcast", () => {
  const w = (badge: "working" | "stalled") => ({ messageId: "m1", since: iso(0), badge });

  test("a message's badge changing changes it", () => {
    expect(attentionKey(w("working"))).not.toBe(attentionKey(w("stalled")));
    expect(attentionKey(null)).not.toBe(attentionKey(w("working")));
  });

  test("the same state gives the same key, so nothing is re-sent", () => {
    expect(attentionKey(w("stalled"))).toBe(attentionKey(w("stalled")));
    expect(attentionKey(null)).toBe(attentionKey(null));
  });
});
