import { describe, expect, test } from "bun:test";
import {
  fmtRemaining,
  HEARTBEAT_MIN_GAP_MS,
  shouldHeartbeat,
  timerLabel,
  timerState,
  WARN_MS,
} from "./timer";

describe("fmtRemaining (inventory S8)", () => {
  test("m:ss, zero-padded seconds", () => {
    expect(fmtRemaining(65_000)).toBe("1:05");
    expect(fmtRemaining(1_800_000)).toBe("30:00");
    expect(fmtRemaining(9_000)).toBe("0:09");
    expect(fmtRemaining(600_000)).toBe("10:00");
  });

  test("floors to the second — 1999 ms is one second, not two", () => {
    expect(fmtRemaining(1_999)).toBe("0:01");
  });

  test("zero and below is 0:00, never a negative clock", () => {
    expect(fmtRemaining(0)).toBe("0:00");
    expect(fmtRemaining(-5_000)).toBe("0:00");
  });
});

describe("timerState (inventory S9, S10)", () => {
  test("null above the warn threshold — the attribute is REMOVED, not neutral", () => {
    expect(timerState(WARN_MS)).toBeNull();
    expect(timerState(1_800_000)).toBeNull();
  });

  test("warn strictly under a minute", () => {
    expect(timerState(WARN_MS - 1)).toBe("warn");
    expect(timerState(1_000)).toBe("warn");
  });

  test("expired at zero and below", () => {
    expect(timerState(0)).toBe("expired");
    expect(timerState(-1)).toBe("expired");
  });

  test("extending past the threshold CLEARS warn", () => {
    expect(timerState(30_000)).toBe("warn");
    expect(timerState(65_000)).toBeNull();
  });
});

describe("timerLabel (inventory S9)", () => {
  test("the word, not a clock, once expired", () => {
    expect(timerLabel(0)).toBe("expired");
    expect(timerLabel(-9_000)).toBe("expired");
    expect(timerLabel(65_000)).toBe("1:05");
  });
});

describe("shouldHeartbeat (inventory S16)", () => {
  test("at most one per five seconds", () => {
    expect(shouldHeartbeat(1_000_000, 999_000)).toBe(false);
    expect(shouldHeartbeat(1_000_000, 995_001)).toBe(false);
    expect(shouldHeartbeat(1_000_000, 995_000)).toBe(true);
    expect(HEARTBEAT_MIN_GAP_MS).toBe(5000);
  });

  test("the FIRST keystroke always heartbeats — lastAt starts at 0 against a real clock", () => {
    // `lastHeartbeatAt = 0` at boot (template.html 1062) and `now` is a unix
    // millisecond, so the gap is ~1.8e12. The rate limit can never suppress the
    // first one, which is the whole reason the daemon learns the page is live.
    expect(shouldHeartbeat(Date.now(), 0)).toBe(true);
  });
});
