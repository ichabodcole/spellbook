import { describe, expect, test } from "bun:test";
import { createEventLog } from "./eventLog.ts";

describe("createEventLog — the frame", () => {
  test("ids are monotonic from 1 and `cursor()` follows them", () => {
    const log = createEventLog<{ type: string }>();
    expect(log.cursor()).toBe(0);
    expect(log.emit({ type: "a" }).id).toBe(1);
    expect(log.emit({ type: "b" }).id).toBe(2);
    expect(log.cursor()).toBe(2);
  });

  test("⛔ THE MONOTONIC ID BEATS A PAYLOAD `id` — the claim both daemons only made", () => {
    // Both copies wrote `{ id: ++seq, ...msg }` under a comment saying the
    // monotonic id MUST win. Spread order says otherwise, and the only thing
    // holding it was a convention in prose. This is the cell that makes the
    // sentence true; it fails against the shape it replaced.
    const log = createEventLog<Record<string, unknown>>();
    log.emit({ type: "x" });
    const frame = log.emit({ type: "y", id: 999 });
    expect(frame.id).toBe(2);
    // …and the wire key order is unchanged: `id` still comes first.
    expect(Object.keys(frame)[0]).toBe("id");
  });

  test("an epoch is stamped only when one was configured", () => {
    expect(createEventLog<{ t: string }>().emit({ t: "a" }).epoch).toBeUndefined();
    const stamped = createEventLog<{ t: string }>({ epoch: "e1" });
    expect(stamped.emit({ t: "a" }).epoch).toBe("e1");
    expect(stamped.epoch).toBe("e1");
  });

  test("a payload `epoch` cannot override the log's own", () => {
    const log = createEventLog<Record<string, unknown>>({ epoch: "real" });
    expect(log.emit({ epoch: "spoofed" }).epoch).toBe("real");
  });
});

describe("createEventLog — replay and subscribe", () => {
  const drain = (log: ReturnType<typeof createEventLog<{ t: string }>>, since: number) => {
    const seen: number[] = [];
    const off = log.subscribe(since, (f) => seen.push(f.id));
    return { seen, off };
  };

  test("replays strictly after `since`, then stays live", () => {
    const log = createEventLog<{ t: string }>();
    for (const t of ["a", "b", "c"]) log.emit({ t });
    const { seen, off } = drain(log, 1);
    expect(seen).toEqual([2, 3]);
    log.emit({ t: "d" });
    expect(seen).toEqual([2, 3, 4]);
    off();
    log.emit({ t: "e" });
    expect(seen).toEqual([2, 3, 4]);
  });

  test("⛔ A CURSOR BEYOND OUR OWN REPLAYS WHOLE — the restart gap, closed", () => {
    // The daemon restarted: ids begin again at 1 while the tail resumes at the
    // watermark it held from the PREVIOUS process. Filtering on `id > since`
    // sends nothing, so no frame arrives, so the client's epoch check never
    // runs and the tail sits connected and silent. Measured on astrolabe; this
    // is the half the client cannot do for itself.
    const log = createEventLog<{ t: string }>({ epoch: "boot-2" });
    log.emit({ t: "ready" });
    const { seen } = drain(log, 47);
    expect(seen).toEqual([1]);
  });

  test("a non-finite `since` replays whole rather than nothing", () => {
    // `parseInt("x")` is NaN and every `id > NaN` is false, so the copies
    // answered a typo'd cursor with an empty-but-open stream.
    const log = createEventLog<{ t: string }>();
    log.emit({ t: "a" });
    expect(drain(log, Number.NaN).seen).toEqual([1]);
  });

  test("the replay window is BOUNDED — census defect L5", () => {
    const log = createEventLog<{ t: string }>({ bufferSize: 3 });
    for (let i = 0; i < 10; i++) log.emit({ t: String(i) });
    expect(log.cursor()).toBe(10); // ids keep counting
    expect(drain(log, -1).seen).toEqual([8, 9, 10]); // only the window replays
  });

  test("two subscribers are independent, and one leaving does not deafen the other", () => {
    const log = createEventLog<{ t: string }>();
    const a = drain(log, -1);
    const b = drain(log, -1);
    log.emit({ t: "x" });
    a.off();
    log.emit({ t: "y" });
    expect(a.seen).toEqual([1]);
    expect(b.seen).toEqual([1, 2]);
  });
});
