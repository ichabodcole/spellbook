import { describe, expect, test } from "bun:test";
import {
  ACTION_TOAST_MS,
  createToastStore,
  TOAST_MS,
  type ToastTimers,
  toastMs,
} from "./toast-store.ts";

/** A clock the test turns by hand. */
function fakeTimers(): ToastTimers & { advance: (ms: number) => void; pending: () => number } {
  let now = 0;
  let nextHandle = 1;
  const due = new Map<number, { at: number; fn: () => void }>();
  return {
    set: (fn, ms) => {
      const h = nextHandle++;
      due.set(h, { at: now + ms, fn });
      return h;
    },
    clear: (h) => {
      due.delete(h as number);
    },
    advance(ms) {
      now += ms;
      for (const [h, t] of [...due]) {
        if (t.at <= now) {
          due.delete(h);
          t.fn();
        }
      }
    },
    pending: () => due.size,
  };
}

describe("toast durations", () => {
  test("a plain announcement keeps its six seconds", () => {
    expect(toastMs({})).toBe(TOAST_MS);
    expect(toastMs({ actions: [] })).toBe(TOAST_MS);
  });

  test("a toast with buttons stays longer than a plain one", () => {
    expect(toastMs({ actions: [{ label: "Activate", onAct: () => {} }] })).toBe(ACTION_TOAST_MS);
    expect(ACTION_TOAST_MS).toBeGreaterThan(TOAST_MS);
  });
});

describe("the toast store", () => {
  test("announce adds a toast, which withdraws itself after its time", () => {
    const t = fakeTimers();
    const s = createToastStore(t);
    const id = s.announce("Hello");
    expect(s.snapshot().map((x) => x.id)).toEqual([id]);
    t.advance(TOAST_MS - 1);
    expect(s.snapshot()).toHaveLength(1);
    t.advance(1);
    expect(s.snapshot()).toHaveLength(0);
  });

  test("the snapshot is the same array until something changes", () => {
    const s = createToastStore(fakeTimers());
    s.announce("a");
    const first = s.snapshot();
    expect(s.snapshot()).toBe(first);
    s.announce("b");
    expect(s.snapshot()).not.toBe(first);
  });

  test("a held toast does not expire, and restarts its full time on release", () => {
    const t = fakeTimers();
    const s = createToastStore(t);
    const id = s.announce("Hold me");
    t.advance(TOAST_MS - 100);
    s.hold(id, true);
    t.advance(TOAST_MS * 3);
    expect(s.snapshot()).toHaveLength(1);
    s.hold(id, false);
    t.advance(TOAST_MS - 1);
    expect(s.snapshot()).toHaveLength(1);
    t.advance(1);
    expect(s.snapshot()).toHaveLength(0);
  });

  test("dismiss removes a toast and its timer, and tells subscribers", () => {
    const t = fakeTimers();
    const s = createToastStore(t);
    let heard = 0;
    const off = s.subscribe(() => heard++);
    const id = s.announce("x");
    s.dismiss(id);
    expect(s.snapshot()).toHaveLength(0);
    expect(t.pending()).toBe(0);
    expect(heard).toBe(2);
    off();
    s.announce("y");
    expect(heard).toBe(2);
  });

  test("dispose cancels every timer", () => {
    const t = fakeTimers();
    const s = createToastStore(t);
    s.announce("a");
    s.announce("b");
    s.dispose();
    expect(t.pending()).toBe(0);
  });
});
