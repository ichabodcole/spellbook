// The compare view's way between changes, in a DOM: it lands on the first change,
// the minimap and the change picker each bring a change into view and mark it,
// and a focus request (the agent's `show`) does the same once.
//
// happy-dom lays nothing out, so each row's top is stubbed as its index times
// ROW_PX: that is what lets a test read where the view scrolled to.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle, waitFor } from "../lib/testDom.ts";
import type { DiffLine, DiffPayload } from "../workspace/protocol";
import { type CompareFocus, CompareView, FLASH_MS } from "./CompareView.tsx";

const ROW_PX = 20;

beforeAll(() => {
  installDom();
  const proto = window.HTMLElement.prototype as unknown as {
    getBoundingClientRect: () => DOMRect;
  };
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: HTMLElement) {
    const row = this.getAttribute("data-row");
    if (row !== null) {
      const sc = this.closest<HTMLElement>('[data-slot="compare-scroller"]');
      const top = Number(row) * ROW_PX - (sc?.scrollTop ?? 0);
      return { top, bottom: top + ROW_PX, left: 0, right: 0, width: 0, height: ROW_PX } as DOMRect;
    }
    return original.call(this);
  };
});
afterAll(async () => {
  await removeDom();
});
afterEach(async () => {
  jest.useRealTimers();
  await cleanup();
});

/** A 60-line document with the given lines replaced. */
function payload(changed: number[], against: DiffPayload["against"] = "original"): DiffPayload {
  const lines: DiffLine[] = [];
  const hunks: DiffPayload["diff"]["hunks"] = [];
  for (let i = 0; i < 60; i++) {
    if (changed.includes(i)) {
      lines.push({ op: "del", a: i, text: `old ${i}` }, { op: "add", b: i, text: `new ${i}` });
      hunks.push({
        id: hunks.length + 1,
        aFrom: i,
        aTo: i + 1,
        bFrom: i,
        bTo: i + 1,
        del: [`old ${i}`],
        add: [`new ${i}`],
      });
    } else lines.push({ op: "same", a: i, b: i, text: `line ${i}` });
  }
  return { doc: "story", active: 2, against, diff: { lines, hunks, same: false, coarse: false } };
}

const scroller = () => document.querySelector<HTMLElement>('[data-slot="compare-scroller"]');
const flashed = () =>
  [...document.querySelectorAll<HTMLElement>('[data-flash="on"][data-row]')].map((el) =>
    Number(el.getAttribute("data-row")),
  );
const marks = () => [
  ...document.querySelectorAll<HTMLButtonElement>('[data-slot="change-minimap"] button'),
];
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

function View({ p, focus }: { p: DiffPayload; focus?: CompareFocus | null }) {
  return (
    <div style={{ height: 400, display: "flex" }}>
      <CompareView
        payload={p}
        file="story.md"
        versions={[
          { n: 1, by: "human", createdAt: "2026-10-01T00:00:00Z" },
          { n: 2, by: "agent", createdAt: "2026-10-02T00:00:00Z" },
        ]}
        onAgainst={() => {}}
        onTake={() => {}}
        focus={focus ?? null}
      />
    </div>
  );
}

describe("finding the changes", () => {
  test("opening lands on the first change, without marking it", async () => {
    await mount(<View p={payload([30, 50])} />);
    // Row 30 is the first change; it sits a third of the way down a 0-tall
    // scroller, so the scroll is its top.
    expect(scroller()?.scrollTop).toBe(30 * ROW_PX);
    expect(flashed()).toEqual([]);
  });

  test("a refreshed payload for the same comparison leaves the reader where they are", async () => {
    const m = await mount(<View p={payload([30, 50])} />);
    const sc = scroller() as HTMLElement;
    sc.scrollTop = 5;
    await m.render(<View p={payload([31, 50])} />);
    expect(sc.scrollTop).toBe(5);
  });

  test("the minimap has a mark per change; clicking one goes there and marks it", async () => {
    await mount(<View p={payload([10, 30, 50])} />);
    expect(marks().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Change 1 of 3, line 11",
      "Change 2 of 3, line 31",
      "Change 3 of 3, line 51",
    ]);
    // Placed by row: row 30 of 60 rows.
    expect(marks()[1]?.style.top).toBe(`${(30 / 60) * 100}%`);
    await click(marks()[2] ?? null);
    expect(scroller()?.scrollTop).toBe(50 * ROW_PX);
    expect(flashed()).toEqual([50]);
  });

  // On a fake clock, installed before the click makes the flash's timer;
  // nothing in it polls (`waitFor` would, with timers).
  test("the mark fades: it is gone once the flash has run", async () => {
    jest.useFakeTimers();
    await mount(<View p={payload([10, 30])} />);
    await click(marks()[1] ?? null);
    expect(flashed()).toEqual([30]);
    await settle(() => {
      jest.advanceTimersByTime(FLASH_MS - 50);
    });
    expect(flashed()).toEqual([30]);
    await settle(() => {
      jest.advanceTimersByTime(100);
    });
    expect(flashed()).toEqual([]);
  });

  test("with one change the count is a button that goes straight there", async () => {
    await mount(<View p={payload([40])} />);
    const picker = document.querySelector<HTMLElement>('[data-slot="change-picker"]');
    expect(picker?.textContent).toBe("1 change");
    (scroller() as HTMLElement).scrollTop = 0;
    await click(picker);
    expect(scroller()?.scrollTop).toBe(40 * ROW_PX);
    expect(flashed()).toEqual([40]);
  });

  test("with several the count lists them, and picking one goes there", async () => {
    await mount(<View p={payload([10, 30, 50])} />);
    const picker = document.querySelector<HTMLElement>('[data-slot="change-picker"]');
    expect(picker?.textContent).toContain("3 changes");
    await click(picker);
    const items = () => [...document.querySelectorAll('[role="menuitem"]')];
    await waitFor(() => items().length === 3, "the change list");
    expect(items().map((i) => i.textContent)).toEqual([
      "Change 1line 11old 10",
      "Change 2line 31old 30",
      "Change 3line 51old 50",
    ]);
    await click(items()[1] ?? null);
    expect(scroller()?.scrollTop).toBe(30 * ROW_PX);
    expect(flashed()).toEqual([30]);
  });
});

describe("a focus request", () => {
  test("a hunk is brought into view and marked, once", async () => {
    const p = payload([10, 30, 50]);
    const m = await mount(<View p={p} focus={{ seq: 1, hunk: 3, against: "original" }} />);
    expect(scroller()?.scrollTop).toBe(50 * ROW_PX);
    expect(flashed()).toEqual([50]);
    (scroller() as HTMLElement).scrollTop = 0;
    await m.render(<View p={{ ...p }} focus={{ seq: 1, hunk: 3, against: "original" }} />);
    expect(scroller()?.scrollTop).toBe(0);
  });

  test("a hunk named against another side waits for that comparison", async () => {
    const m = await mount(<View p={payload([10, 30])} focus={{ seq: 1, hunk: 2, against: 1 }} />);
    // Not the comparison the hunk was numbered in: no landing, no jump, yet.
    expect(scroller()?.scrollTop).toBe(0);
    await m.render(<View p={payload([10, 30], 1)} focus={{ seq: 1, hunk: 2, against: 1 }} />);
    expect(scroller()?.scrollTop).toBe(30 * ROW_PX);
  });

  test("a line of the active version is brought into view and marked", async () => {
    await mount(<View p={payload([10])} focus={{ seq: 1, line: 45 }} />);
    expect(scroller()?.scrollTop).toBe(45 * ROW_PX);
    expect(flashed()).toEqual([45]);
  });
});

describe("two sides that are the same", () => {
  const same = (against: DiffPayload["against"]): DiffPayload => ({
    doc: "story",
    active: 1,
    against,
    diff: { lines: [{ op: "same", a: 0, b: 0, text: "x" }], hunks: [], same: true, coarse: false },
  });
  const body = () => document.body.textContent ?? "";

  test("against the file: the version matches the file, which is not called a version", async () => {
    await mount(<View p={same("original")} />);
    expect(body()).toContain("v1 matches the file on disk.");
    expect(body()).not.toContain("These two versions are identical");
  });

  test("picked, and nothing differs: one line says every version matches", async () => {
    await mount(<View p={{ ...same("original"), picked: true, everyMatches: true }} />);
    expect(body()).toContain("v1 matches the file on disk, and so does every other version.");
  });

  test("against another version: the two versions are identical", async () => {
    await mount(<View p={same(2)} />);
    expect(body()).toContain("These two versions are identical.");
  });
});
