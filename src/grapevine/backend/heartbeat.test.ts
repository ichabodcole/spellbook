import { describe, expect, test } from "bun:test";
import { MIN_HEARTBEAT_MS, MISSED_BEATS } from "../../kit/wire/heartbeat.ts";
import {
  DEFAULT_SSE_HEARTBEAT_MS,
  IDLE_TIMEOUT_SEC,
  SSE_HEARTBEAT_MS,
  TAIL_IDLE_MS,
} from "./heartbeat.ts";

/**
 * ⛔ THE PAIR MUST MOVE TOGETHER, AND ONLY A SUBPROCESS CAN SEE THAT.
 *
 * These constants resolve `process.env` at MODULE LOAD, so an in-process
 * `process.env.X = …` proves nothing: the module is already evaluated. Each cell
 * below therefore runs a fresh `bun` that imports the real seam file under the
 * env in question and prints what both halves computed.
 *
 * The defect this pins (D75) shipped GREEN under every in-process assertion
 * there was: `daemon.ts` resolved `GRAPEVINE_HEARTBEAT_MS` and `heartbeat.ts`
 * derived the tail's watchdog from the literal 3,000, so at
 * `GRAPEVINE_HEARTBEAT_MS=20000` a real tail's watchdog fired at 9 s against a
 * daemon beating every 20 s — four re-subscribes in 30 s, and `count: 2` for one
 * connection.
 */
async function resolveUnder(env: Record<string, string>): Promise<{
  idleSec: number;
  beat: number;
  watchdog: number;
}> {
  const mod = new URL("./heartbeat.ts", import.meta.url).href;
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const m = await import(${JSON.stringify(mod)});` +
        `console.log(JSON.stringify({ idleSec: m.IDLE_TIMEOUT_SEC, beat: m.SSE_HEARTBEAT_MS, watchdog: m.TAIL_IDLE_MS }));`,
    ],
    { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  expect(await proc.exited, err).toBe(0);
  return JSON.parse(out);
}

describe("grapevine's connection-timing seam", () => {
  test("in-process: the watchdog is three of THIS spell's beats", () => {
    expect(SSE_HEARTBEAT_MS).toBe(DEFAULT_SSE_HEARTBEAT_MS);
    expect(TAIL_IDLE_MS).toBe(SSE_HEARTBEAT_MS * MISSED_BEATS);
    expect(SSE_HEARTBEAT_MS).toBeLessThanOrEqual((IDLE_TIMEOUT_SEC * 1000) / 2);
  });

  test("⛔ A TUNED BEAT MOVES THE TAIL'S WATCHDOG WITH IT — the D75 repair", async () => {
    const tuned = await resolveUnder({ GRAPEVINE_HEARTBEAT_MS: "20000" });
    expect(tuned.beat).toBe(20_000);
    // Before the repair this read 9,000 — a watchdog that fires twice before the
    // first beat lands.
    expect(tuned.watchdog).toBe(60_000);
    expect(tuned.watchdog).toBeGreaterThan(tuned.beat);
  });

  test("the watchdog stays above the beat at every value an operator can set", async () => {
    for (const raw of ["500", "1000", "20000", "1e9", "abc", "0", "200000"]) {
      const r = await resolveUnder({ GRAPEVINE_HEARTBEAT_MS: raw });
      expect(r.watchdog).toBeGreaterThan(r.beat);
      expect(r.beat).toBeGreaterThanOrEqual(MIN_HEARTBEAT_MS);
      expect(r.beat).toBeLessThanOrEqual((r.idleSec * 1000) / 2);
    }
  });

  test("⛔ `1e9` IS A FLOOR CASE, NOT A CEILING CASE — `parseInt` reads it as 1", async () => {
    const flood = await resolveUnder({ GRAPEVINE_HEARTBEAT_MS: "1e9" });
    expect(flood.beat).toBe(MIN_HEARTBEAT_MS);
    expect(flood.watchdog).toBe(MIN_HEARTBEAT_MS * MISSED_BEATS);
  });

  test("the idle timeout is env-tunable too, and the beat is clamped to half of it", async () => {
    const short = await resolveUnder({
      GRAPEVINE_IDLE_TIMEOUT_SEC: "4",
      GRAPEVINE_HEARTBEAT_MS: "20000",
    });
    expect(short.idleSec).toBe(4);
    expect(short.beat).toBe(2_000);
    expect(short.watchdog).toBe(6_000);
  });
});
