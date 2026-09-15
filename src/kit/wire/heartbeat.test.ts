import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HEARTBEAT_MS,
  heartbeatMs,
  idleTimeoutSec,
  MAX_IDLE_TIMEOUT_SEC,
  MIN_HEARTBEAT_MS,
  tailIdleMs,
} from "./heartbeat.ts";

describe("idleTimeoutSec", () => {
  test("defaults to Bun's maximum and clamps to it", () => {
    expect(idleTimeoutSec(undefined)).toBe(MAX_IDLE_TIMEOUT_SEC);
    expect(idleTimeoutSec("9999")).toBe(MAX_IDLE_TIMEOUT_SEC);
    expect(idleTimeoutSec("30")).toBe(30);
  });

  test("junk, empty and non-positive all fall back rather than becoming zero", () => {
    // ⛔ ZERO IS NOT "DISABLED" IN BUN — it is the 10-second default, which is
    // shorter than every heartbeat in the house. A parse that yielded 0 here
    // would silently reintroduce the bug the whole constant exists to prevent.
    for (const raw of ["", "abc", "0", "-5"]) {
      expect(idleTimeoutSec(raw)).toBe(MAX_IDLE_TIMEOUT_SEC);
    }
  });
});

describe("heartbeatMs", () => {
  test("⛔ CLAMPED TO HALF THE IDLE TIMEOUT, for ANY configured pair", () => {
    // The census's convergence target #4. The other daemons write 15s against
    // 255s and record the relationship only in prose — true at the default and
    // at no other value.
    expect(heartbeatMs(undefined, 255)).toBe(DEFAULT_HEARTBEAT_MS);
    expect(heartbeatMs("60000", 255)).toBe(60_000); // under half of 255s
    expect(heartbeatMs("200000", 255)).toBe(127_500); // clamped to half
    expect(heartbeatMs(undefined, 4)).toBe(2_000); // a short test window clamps too
  });

  test("never falls below 500ms, however short the idle timeout is", () => {
    expect(heartbeatMs(undefined, 1)).toBe(500);
  });

  test("the fallback is per-spell, and junk uses it", () => {
    expect(heartbeatMs("nonsense", 255, 10_000)).toBe(10_000);
  });

  test("⛔ THE HOSTILE VALUES, AND THE ONE THAT IS NOT OBVIOUSLY HOSTILE", () => {
    // These take the fallback, and always did — `intOr` rejects anything that
    // does not parse to a positive integer.
    for (const raw of ["", "0", "-1", "abc", "NaN", "Infinity"]) {
      expect(heartbeatMs(raw, 255, 3_000)).toBe(3_000);
    }
    // ⛔ AND THESE ARE WHY `MIN_HEARTBEAT_MS` EXISTS. `parseInt` reads the most
    // plausible spelling of "make it huge" as ONE. Driven before the floor
    // existed: `GRAPEVINE_HEARTBEAT_MS=1e9` put ~528 keepalive comments into
    // every open SSE client in 528 ms.
    expect(Number.parseInt("1e9", 10)).toBe(1); // the mechanism, stated
    expect(heartbeatMs("1e9", 255, 3_000)).toBe(MIN_HEARTBEAT_MS);
    expect(heartbeatMs("3.9", 255, 3_000)).toBe(MIN_HEARTBEAT_MS);
    expect(heartbeatMs("5abc", 255, 3_000)).toBe(MIN_HEARTBEAT_MS);
    expect(heartbeatMs("1", 255, 3_000)).toBe(MIN_HEARTBEAT_MS);
  });

  test("the floor can never cross the ceiling", () => {
    // The ceiling is itself `Math.max(MIN_HEARTBEAT_MS, idle/2)`, so a tiny idle
    // timeout narrows the window to exactly one legal value rather than to none.
    for (const idle of [1, 2, 4, 255]) {
      const beat = heartbeatMs("1e9", idle, 3_000);
      expect(beat).toBeGreaterThanOrEqual(MIN_HEARTBEAT_MS);
      expect(beat).toBeLessThanOrEqual(Math.max(MIN_HEARTBEAT_MS, (idle * 1000) / 2));
    }
  });
});

describe("tailIdleMs", () => {
  test("three missed beats", () => {
    expect(tailIdleMs(10_000)).toBe(30_000);
    expect(tailIdleMs(DEFAULT_HEARTBEAT_MS)).toBe(45_000);
  });

  test("⛔ IT IS ALWAYS ABOVE THE BEAT IT WATCHES — the invariant, not the number", () => {
    for (const beat of [500, 1_000, 10_000, 15_000, 127_500]) {
      expect(tailIdleMs(beat)).toBeGreaterThan(beat);
    }
  });
});
