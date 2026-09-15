// E53: the human is waiting, and how that reads.
import { describe, expect, test } from "bun:test";
import { DEFAULT_SNOOZE_MS, STALL_MS, waitingOn } from "./waiting";

type W = "human" | "agent" | "system";
let seq = 0;
const msg = (who: W, ts: number) => ({ id: `m${++seq}`, who, ts });

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
    expect(got).toEqual({ messageId: m.id, since: 1000, badge: "working" });
  });

  test("under the threshold it is a pulse; at it, stalled", () => {
    const m = msg("human", 0);
    expect(waitingOn([m], STALL_MS - 1)?.badge).toBe("working");
    expect(waitingOn([m], STALL_MS)?.badge).toBe("stalled");
  });

  test("⛔ A SYSTEM LINE IS NOT A REPLY — narration must not silence the signal", () => {
    // `announce()` writes these when the AGENT acts, so this is the exact case
    // the feature exists for: busy, and not a word to the person waiting.
    const m = msg("human", 0);
    const chat = [m, msg("system", 5), msg("system", 9)];
    const got = waitingOn(chat, STALL_MS + 1);
    expect(got?.messageId).toBe(m.id);
    expect(got?.badge).toBe("stalled");
  });

  test("a task the agent started IS a reply, because it posts as the agent (E50)", () => {
    const chat = [msg("human", 0), msg("agent", 20)];
    expect(waitingOn(chat, STALL_MS * 10)).toBeNull();
  });

  test("the clock runs from the FIRST unanswered message, not the latest", () => {
    // Three messages while waiting: they have been waiting since the first.
    const first = msg("human", 0);
    const chat = [first, msg("human", 8000), msg("human", 16_000)];
    const got = waitingOn(chat, 20_000);
    expect(got?.since).toBe(0);
    expect(got?.messageId).toBe(first.id);
    // …and that is already past the threshold, which resetting would have hidden.
    expect(waitingOn(chat, STALL_MS)?.badge).toBe("stalled");
  });

  test("an earlier answered exchange does not count as waiting", () => {
    const chat = [msg("human", 0), msg("agent", 10), msg("human", 20), msg("agent", 30)];
    expect(waitingOn(chat, 999_999)).toBeNull();
  });

  test("a snooze keeps it a pulse past the threshold — the agent said it is alive", () => {
    const m = msg("human", 0);
    const got = waitingOn([m], STALL_MS + 5000, { acknowledgedUntil: STALL_MS + 60_000 });
    expect(got?.badge).toBe("working");
  });

  test("…and when the snooze expires the human is owed the truth", () => {
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

  test("an agent message BEFORE the human's does not answer it", () => {
    const chat = [msg("agent", 0), msg("human", 10)];
    expect(waitingOn(chat, 20)?.badge).toBe("working");
  });
});
