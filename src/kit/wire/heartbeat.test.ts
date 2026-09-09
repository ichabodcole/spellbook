import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HEARTBEAT_MS,
  heartbeatMs,
  idleTimeoutSec,
  MAX_IDLE_TIMEOUT_SEC,
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
