import { describe, expect, test } from "bun:test";
import { drainAndStop, shouldIdleClose, startHousekeeping } from "./housekeeping.ts";
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
    const clients: SseClients = new Set([() => order.push("tail-a"), () => order.push("tail-b")]);
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
