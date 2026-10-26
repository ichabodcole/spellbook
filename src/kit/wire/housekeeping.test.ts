import { describe, expect, test } from "bun:test";
import {
  drainAndStop,
  readSeconds,
  shouldIdleClose,
  startHousekeeping,
  TIMER_MAX_S,
} from "./housekeeping.ts";
import type { SseClients } from "./sse.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("shouldIdleClose", () => {
  test("⛔ L1 — A LIVE SUBSCRIBER KEEPS THE DAEMON OPEN, however idle the clock says", () => {
    // The defect this closes: glamour, imago and magpie counted the idle floor
    // down while an agent held a `/events` tail, so an agent watching a quiet
    // board was killed WITH ITS CONNECTION OPEN. `subscriberCount` is a
    // required argument, so the broken shape cannot be written any more.
    expect(shouldIdleClose(1, 999_999, 5_000)).toBe(false);
    expect(shouldIdleClose(0, 999_999, 5_000)).toBe(true);
  });

  test("a timeout of zero (or less) means NEVER — astrolabe's standing daemon", () => {
    expect(shouldIdleClose(0, 10_000, 0)).toBe(false);
    expect(shouldIdleClose(0, 10_000, -1)).toBe(false);
  });

  test("the floor is inclusive and not crossed early", () => {
    expect(shouldIdleClose(0, 4_999, 5_000)).toBe(false);
    expect(shouldIdleClose(0, 5_000, 5_000)).toBe(true);
  });
});

describe("readSeconds", () => {
  test("a plain count of seconds reads, 0 (stands until closed) and fractions included", () => {
    expect(readSeconds("0")).toEqual({ ok: true, seconds: 0 });
    expect(readSeconds("1800")).toEqual({ ok: true, seconds: 1800 });
    expect(readSeconds("0.6")).toEqual({ ok: true, seconds: 0.6 });
    expect(readSeconds(" 30 ")).toEqual({ ok: true, seconds: 30 });
  });

  test("⛔ anything else is refused, never coerced to NaN (which never idle-closes)", () => {
    const huge = "9".repeat(400); // matches the pattern, and is still Infinity
    for (const t of [
      "",
      " ",
      "abc",
      "NaN",
      "Infinity",
      "-5",
      "+5",
      "1e3",
      "0x10",
      "5s",
      ".5",
      huge,
    ]) {
      const r = readSeconds(t);
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.message).toContain("is not a number of seconds");
    }
  });

  test("the refusal names the valid form, which `.5` and `5.` are not", () => {
    for (const t of [".5", "5."]) {
      const r = readSeconds(t);
      expect(r.ok, t).toBe(false);
      if (!r.ok) expect(r.message).toContain("such as 90 or 0.5");
    }
  });

  test("TIMER_MAX_S is the longest wait one setTimeout holds, in whole seconds", () => {
    expect(TIMER_MAX_S * 1000).toBeLessThanOrEqual(2 ** 31 - 1);
    expect((TIMER_MAX_S + 1) * 1000).toBeGreaterThan(2 ** 31 - 1);
  });
});

describe("startHousekeeping", () => {
  test("touches the clock while watched, and fires exactly once when it is not", async () => {
    let subscribers = 1;
    let touches = 0;
    let idle = 10_000;
    let closed = 0;
    const stop = startHousekeeping({
      subscriberCount: () => subscribers,
      idleMs: () => idle,
      touch: () => {
        touches += 1;
      },
      timeoutMs: 1_000,
      onIdleClose: () => {
        closed += 1;
      },
      tickMs: 5,
    });
    await sleep(30);
    expect(touches).toBeGreaterThan(0);
    expect(closed).toBe(0); // watched: the floor never counts down

    subscribers = 0;
    await sleep(30);
    stop();
    expect(closed).toBeGreaterThan(0);

    // …and stopping really stops: nothing fires after the returned function.
    const after = closed;
    idle = 10_000;
    await sleep(20);
    expect(closed).toBe(after);
  });

  test("the snapshot writes only when dirty, and clears the flag before writing", async () => {
    let dirty = true;
    let writes = 0;
    const stop = startHousekeeping({
      subscriberCount: () => 1,
      idleMs: () => 0,
      touch: () => {},
      timeoutMs: 0,
      onIdleClose: () => {},
      tickMs: 1_000,
      snapshotMs: 5,
      snapshot: {
        dirty: () => dirty,
        clear: () => {
          dirty = false;
        },
        write: () => {
          writes += 1;
        },
      },
    });
    await sleep(30);
    stop();
    expect(writes).toBe(1); // one dirty flag, one write, not one per tick
  });

  test("a daemon with no snapshot is a legal caller", async () => {
    const stop = startHousekeeping({
      subscriberCount: () => 0,
      idleMs: () => 0,
      touch: () => {},
      timeoutMs: 0,
      onIdleClose: () => {},
      tickMs: 5,
    });
    await sleep(15);
    stop();
  });
});

describe("drainAndStop", () => {
  test("closes every tail and socket, then stops the server", async () => {
    const order: string[] = [];
    const clients: SseClients = new Set([
      { close: () => order.push("tail-a"), send: () => {} },
      { close: () => order.push("tail-b"), send: () => {} },
    ]);
    const sockets = [{ close: () => order.push("ws") }];
    await drainAndStop({
      server: {
        stop: (force) => {
          order.push(`stop:${force}`);
        },
      },
      clients,
      sockets,
      graceMs: 1,
      stopMs: 50,
    });
    expect(order).toEqual(["tail-a", "tail-b", "ws", "stop:true"]);
  });

  describe("the grace period", () => {
    const stopOnly = { stop: () => {} };
    const timed = async (opts: Parameters<typeof drainAndStop>[0]) => {
      const t0 = performance.now();
      await drainAndStop(opts);
      return performance.now() - t0;
    };
    const tail = (): SseClients => new Set([{ close: () => {}, send: () => {} }]);

    test("a connected tail gets the whole grace before it is closed", async () => {
      let closedAt = Number.NaN;
      const t0 = performance.now();
      const clients: SseClients = new Set([
        { close: () => (closedAt = performance.now() - t0), send: () => {} },
      ]);
      await drainAndStop({ server: stopOnly, clients, graceMs: 120, stopMs: 20 });
      expect(closedAt).toBeGreaterThanOrEqual(110);
    });

    test("a connected socket, or a request still being answered, gets it too", async () => {
      expect(
        await timed({ server: stopOnly, sockets: [{ close: () => {} }], graceMs: 120, stopMs: 20 }),
      ).toBeGreaterThanOrEqual(110);
      expect(
        await timed({ server: { ...stopOnly, pendingRequests: 1 }, graceMs: 120, stopMs: 20 }),
      ).toBeGreaterThanOrEqual(110);
    });

    test("with nobody connected there is no wait at all", async () => {
      expect(
        await timed({ server: stopOnly, clients: new Set(), sockets: [], graceMs: 5_000 }),
      ).toBeLessThan(1_000);
      expect(
        await timed({ server: { ...stopOnly, pendingRequests: 0 }, graceMs: 5_000 }),
      ).toBeLessThan(1_000);
    });

    test("the stop race's timer is cleared once the stop wins", async () => {
      const real = globalThis.setTimeout;
      const live = new Set<unknown>();
      const cleared = globalThis.clearTimeout;
      globalThis.setTimeout = ((fn: () => void, ms?: number) => {
        const t = real(fn, ms);
        if (ms === 60_000) live.add(t); // the stop race's, not the grace's
        return t;
      }) as typeof setTimeout;
      globalThis.clearTimeout = ((t: Parameters<typeof clearTimeout>[0]) => {
        live.delete(t);
        cleared(t);
      }) as typeof clearTimeout;
      try {
        await drainAndStop({ server: stopOnly, clients: tail(), graceMs: 1, stopMs: 60_000 });
        expect(live.size).toBe(0);
      } finally {
        globalThis.setTimeout = real;
        globalThis.clearTimeout = cleared;
      }
    });
  });

  test("⛔ A HANGING `server.stop` DOES NOT HANG TEARDOWN", async () => {
    // `server.stop(true)` awaits its connections and one wedged peer parks it
    // forever — which is how a 23-minute hang shipped once. The race is the
    // whole reason this function is not two lines at each call site.
    const started = Date.now();
    await drainAndStop({
      server: { stop: () => new Promise(() => {}) },
      graceMs: 1,
      stopMs: 20,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a socket that throws on close does not abort the drain", async () => {
    let stopped = false;
    await drainAndStop({
      server: {
        stop: () => {
          stopped = true;
        },
      },
      sockets: [
        {
          close: () => {
            throw new Error("already gone");
          },
        },
      ],
      graceMs: 1,
      stopMs: 20,
    });
    expect(stopped).toBe(true);
  });
});
