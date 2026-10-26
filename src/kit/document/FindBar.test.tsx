// The find bar in the rendered view and the compare view, in a DOM: Cmd-F opens
// it where it should and nowhere else, matches are counted, painted and stepped
// through, Escape gives focus back, and painting them changes nothing the
// rendered view maps source offsets through.
//
// happy-dom has no CSS Custom Highlight API, so a minimal one is installed: a
// registry and a Highlight that keeps its ranges, which is all the bar uses.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { onMac } from "../lib/platform.ts";
import {
  cleanup,
  installDom,
  mount,
  removeDom,
  settle,
  typeInto,
  waitFor,
} from "../lib/testDom.ts";
import type { DiffPayload } from "../workspace/protocol";
import { CompareView } from "./CompareView.tsx";
import { FIND_CURRENT_HL, FIND_MATCH_HL } from "./FindBar.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import { project } from "./projection.ts";
import { resolveRange } from "./renderedRange.ts";

/** Set-like, as the real one is: ranges are added one at a time. */
class FakeHighlight extends Set<Range> {
  get ranges(): Range[] {
    return [...this];
  }
}
let highlights: Map<string, FakeHighlight>;
let cssBefore: PropertyDescriptor | undefined;

beforeAll(() => {
  installDom();
  highlights = new Map();
  (globalThis as { Highlight?: unknown }).Highlight = FakeHighlight;
  // happy-dom's CSS can be a fresh object on every read, so the registry is pinned.
  cssBefore = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", {
    value: { highlights, supports: () => false, escape: (s: string) => s },
    configurable: true,
    writable: true,
  });
});
afterAll(async () => {
  delete (globalThis as { Highlight?: unknown }).Highlight;
  if (cssBefore) Object.defineProperty(globalThis, "CSS", cssBefore);
  else delete (globalThis as { CSS?: unknown }).CSS;
  await removeDom();
});
afterEach(async () => {
  await cleanup();
  highlights.clear();
});

const TEXT = "# The lantern\n\nThe *lantern* is lit.\n\nNo light here.\n\nA lantern again.\n";

const findKey = (target: Element) =>
  settle(() => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "f",
        metaKey: onMac(),
        ctrlKey: !onMac(),
        bubbles: true,
        cancelable: true,
      }),
    );
  });
const key = (target: Element, k: string, shiftKey = false) =>
  settle(() => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true }),
    );
  });
const bar = () => document.querySelector('[data-slot="find-bar"]');
const field = () => document.querySelector<HTMLInputElement>('input[aria-label="Find"]');
const count = () => document.querySelector('[data-slot="find-count"]')?.textContent ?? "";
const painted = (name: string) => highlights.get(name)?.ranges.map((r) => r.toString()) ?? [];
/** Let React finish what the last act started. */
const tick = () => settle();

async function openRendered() {
  await mount(
    <div style={{ height: 500, display: "flex" }}>
      <MarkdownView text={TEXT} />
    </div>,
  );
  const scroller = document.querySelector<HTMLElement>('[data-slot="markdown-view"]');
  if (!scroller) throw new Error("no rendered view");
  scroller.focus();
  return scroller;
}

describe("in the rendered view", () => {
  test("Cmd-F opens the bar; matches are counted, painted, and stepped with Enter", async () => {
    const scroller = await openRendered();
    await findKey(scroller);
    expect(bar()).not.toBeNull();
    await tick();
    expect(document.activeElement).toBe(field());
    await typeInto(field() as HTMLInputElement, "lantern");
    expect(count()).toBe("1 of 3");
    expect(painted(FIND_CURRENT_HL)).toEqual(["lantern"]);
    expect(painted(FIND_MATCH_HL)).toEqual(["lantern", "lantern"]);
    await key(field() as HTMLInputElement, "Enter");
    expect(count()).toBe("2 of 3");
    await key(field() as HTMLInputElement, "Enter", true);
    await key(field() as HTMLInputElement, "Enter", true);
    expect(count()).toBe("3 of 3");
  });

  test("a match runs across inline formatting, which is several text nodes", async () => {
    const scroller = await openRendered();
    await findKey(scroller);
    await typeInto(field() as HTMLInputElement, "the lantern is");
    expect(count()).toBe("1 of 1");
    expect(painted(FIND_CURRENT_HL)).toEqual(["The lantern is"]);
  });

  test("match case narrows it; nothing found says so", async () => {
    const scroller = await openRendered();
    await findKey(scroller);
    await typeInto(field() as HTMLInputElement, "LANTERN");
    expect(count()).toBe("1 of 3");
    const box = document.querySelector<HTMLInputElement>(
      '[data-slot="find-bar"] input[type=checkbox]',
    );
    await settle(() => box?.click());
    expect(count()).toBe("No results");
  });

  test("Escape closes it, unpaints, and gives focus back", async () => {
    const scroller = await openRendered();
    await findKey(scroller);
    await tick();
    await typeInto(field() as HTMLInputElement, "lantern");
    await key(field() as HTMLInputElement, "Escape");
    expect(bar()).toBeNull();
    expect(highlights.has(FIND_MATCH_HL)).toBe(false);
    expect(highlights.has(FIND_CURRENT_HL)).toBe(false);
    expect(document.activeElement).toBe(scroller);
  });

  test("painting matches changes nothing the source mapping reads", async () => {
    const scroller = await openRendered();
    const body = scroller.querySelector(".md-prose") as HTMLElement;
    const before = body.innerHTML;
    const p = project(TEXT);
    const pick = () => {
      const node = [...body.querySelectorAll("em")][0]?.firstChild as Text;
      const r = document.createRange();
      r.setStart(node, 0);
      r.setEnd(node, 7);
      return resolveRange(body, p, r);
    };
    const mapped = pick();
    expect(mapped).not.toBeNull();
    expect(TEXT.slice(mapped?.from, mapped?.to)).toBe("lantern");
    await findKey(scroller);
    await typeInto(field() as HTMLInputElement, "lantern");
    expect(painted(FIND_MATCH_HL).length).toBe(2);
    // Not one node added, split or wrapped, and the same passage maps to the same source.
    expect(body.innerHTML).toBe(before);
    expect(pick()).toEqual(mapped);
  });

  test("a word matching a hundred thousand times is counted, and a window of it painted", async () => {
    const many = `${"the ".repeat(120_000)}\n`;
    await mount(
      <div style={{ height: 500, display: "flex" }}>
        <MarkdownView text={many} />
      </div>,
    );
    const scroller = document.querySelector<HTMLElement>(
      '[data-slot="markdown-view"]',
    ) as HTMLElement;
    scroller.focus();
    await findKey(scroller);
    await typeInto(field() as HTMLInputElement, "the");
    expect(count()).toBe("1 of 120000");
    expect(painted(FIND_MATCH_HL).length).toBe(999);
    expect(painted(FIND_CURRENT_HL).length).toBe(1);
    await key(field() as HTMLInputElement, "Enter", true);
    expect(count()).toBe("120000 of 120000");
  }, 30_000);

  test("opened again, it starts from what is in view, not the match it closed on", async () => {
    const scroller = await openRendered();
    await findKey(scroller);
    await typeInto(field() as HTMLInputElement, "lantern");
    await key(field() as HTMLInputElement, "Enter");
    await key(field() as HTMLInputElement, "Enter");
    expect(count()).toBe("3 of 3");
    await key(field() as HTMLInputElement, "Escape");
    // Nothing is laid out here, so every match is "in view" and the first one wins.
    await findKey(scroller);
    expect(field()?.value).toBe("lantern");
    expect(count()).toBe("1 of 3");
  });

  test("the painted window follows a hand scroll far from the current match", async () => {
    // Five "the"s per paragraph, each paragraph ROW px below the last: 3,000
    // matches in 600 paragraphs. Few paragraphs keep the test quick: happy-dom
    // places each painted range by walking the document from its top, so a
    // window of a thousand ranges far down a long document took seconds.
    const ROW = 20;
    const text = Array.from({ length: 600 }, (_, i) => `the the the the the ${i}`).join("\n\n");
    await mount(
      <div style={{ height: 500, display: "flex" }}>
        <MarkdownView text={text} />
      </div>,
    );
    const scroller = document.querySelector<HTMLElement>(
      '[data-slot="markdown-view"]',
    ) as HTMLElement;
    const body = scroller.querySelector(".md-prose") as HTMLElement;
    const paragraphs = [...body.querySelectorAll("p")];
    const row = new Map(paragraphs.map((p, i) => [p, i]));
    const proto = window.Range.prototype as unknown as { getBoundingClientRect: () => DOMRect };
    const original = proto.getBoundingClientRect;
    proto.getBoundingClientRect = function (this: Range) {
      const p = (this.startContainer as Node).parentElement?.closest("p");
      const top = (row.get(p as HTMLParagraphElement) ?? 0) * ROW - scroller.scrollTop;
      return { top, bottom: top + ROW, left: 0, right: 0, width: 0, height: ROW } as DOMRect;
    };
    try {
      scroller.focus();
      await findKey(scroller);
      await typeInto(field() as HTMLInputElement, "the");
      expect(count()).toBe("1 of 3000");
      const paintedRows = () =>
        (highlights.get(FIND_MATCH_HL)?.ranges ?? []).map((r) =>
          row.get((r.startContainer as Node).parentElement?.closest("p") as HTMLParagraphElement),
        );
      // The first thousand matches are painted: paragraphs 0 to 199.
      expect(Math.max(...(paintedRows() as number[]))).toBeLessThan(200);
      // Scrolled by hand to paragraph 500 (match 2,501): the matches there are
      // painted, and the current one is still the first.
      await settle(() => {
        scroller.scrollTop = 500 * ROW;
        scroller.dispatchEvent(new window.Event("scroll"));
      });
      // The window moves a beat after the scroll settles: waited for, not slept on.
      await waitFor(() => paintedRows().includes(500), "the painted window at paragraph 500");
      expect(count()).toBe("1 of 3000");
    } finally {
      proto.getBoundingClientRect = original;
    }
  }, 30_000);

  test("Cmd-F in a text field elsewhere (the chat's composer) is left to it", async () => {
    await openRendered();
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    const e = new window.KeyboardEvent("keydown", {
      key: "f",
      metaKey: onMac(),
      ctrlKey: !onMac(),
      bubbles: true,
      cancelable: true,
    });
    await settle(() => {
      composer.dispatchEvent(e);
    });
    expect(bar()).toBeNull();
    expect(e.defaultPrevented).toBe(false);
  });

  test("Cmd-F inside the raw editor is left to CodeMirror", async () => {
    await mount(
      <div data-pane="centre" tabIndex={-1} style={{ display: "flex" }}>
        <div className="cm-editor">
          <div className="cm-content" tabIndex={-1} />
        </div>
        <MarkdownView text={TEXT} />
      </div>,
    );
    const content = document.querySelector<HTMLElement>(".cm-content") as HTMLElement;
    content.focus();
    await findKey(content);
    expect(bar()).toBeNull();
    const pane = document.querySelector<HTMLElement>('[data-pane="centre"]') as HTMLElement;
    // A button in the pane around the view (a view-mode button just clicked):
    // Cmd-F is meant for the view, not the browser.
    const modeButton = document.createElement("button");
    modeButton.textContent = "Rendered";
    pane.prepend(modeButton);
    modeButton.focus();
    const fromButton = new window.KeyboardEvent("keydown", {
      key: "f",
      metaKey: onMac(),
      ctrlKey: !onMac(),
      bubbles: true,
      cancelable: true,
    });
    await settle(() => {
      modeButton.dispatchEvent(fromButton);
    });
    expect(fromButton.defaultPrevented).toBe(true);
    expect(bar()).not.toBeNull();
    await key(field() as HTMLInputElement, "Escape");
    expect(bar()).toBeNull();
    // With the focus on the pane itself, the rendered half takes it too.
    pane.focus();
    await findKey(pane);
    expect(bar()).not.toBeNull();
  });
});

/** Two sides: the left (active v2) says "lantern" twice, the right once; line numbers hold digits. */
const PAYLOAD: DiffPayload = {
  doc: "story",
  active: 2,
  against: "original",
  diff: {
    same: false,
    coarse: false,
    lines: [
      { op: "same", a: 0, b: 0, text: "the lantern 1" },
      { op: "del", a: 1, text: "a lantern removed" },
      { op: "add", b: 1, text: "a lamp added" },
      { op: "same", a: 2, b: 2, text: "end" },
    ],
    hunks: [
      {
        id: 1,
        aFrom: 1,
        aTo: 2,
        bFrom: 1,
        bTo: 2,
        del: ["a lantern removed"],
        add: ["a lamp added"],
      },
    ],
  },
};

async function openCompare() {
  await mount(
    <div style={{ height: 500, display: "flex" }}>
      <CompareView
        payload={PAYLOAD}
        file="story.md"
        versions={[
          { n: 1, by: "human", createdAt: "2026-10-01T00:00:00Z" },
          { n: 2, by: "agent", createdAt: "2026-10-02T00:00:00Z" },
        ]}
        onAgainst={() => {}}
        onTake={() => {}}
      />
    </div>,
  );
  const scroller = document.querySelector<HTMLElement>('[data-slot="compare-scroller"]');
  if (!scroller) throw new Error("no compare view");
  scroller.focus();
  return scroller;
}

describe("in the compare view", () => {
  test("one search covers both sides, and the filter keeps it to one", async () => {
    const scroller = await openCompare();
    await findKey(scroller);
    await typeInto(field() as HTMLInputElement, "lantern");
    // Left: "the lantern 1", "a lantern removed". The right's "the lantern 1" is the
    // same unchanged line, so "both" counts it once.
    expect(count()).toBe("1 of 2");
    const radio = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[aria-label="Search in"] [role="radio"]')].find(
        (b) => b.textContent === label,
      );
    expect(
      [...document.querySelectorAll('[aria-label="Search in"] [role="radio"]')].map(
        (b) => b.textContent,
      ),
    ).toEqual(["both", "v2", "story.md"]);
    await settle(() => radio("v2")?.click());
    expect(count()).toBe("1 of 2");
    await settle(() => radio("story.md")?.click());
    expect(count()).toBe("1 of 1");
    await settle(() => radio("both")?.click());
    expect(count()).toBe("1 of 2");
  });

  test("the side filter is a radio group the arrow keys move through", async () => {
    const scroller = await openCompare();
    await findKey(scroller);
    await typeInto(field() as HTMLInputElement, "lantern");
    const group = document.querySelector('[aria-label="Search in"]') as HTMLElement;
    const checked = () => group.querySelector('[aria-checked="true"]')?.textContent;
    expect(checked()).toBe("both");
    expect(
      [...group.querySelectorAll("[role=radio]")].map((b) => b.getAttribute("tabindex")),
    ).toEqual(["0", "-1", "-1"]);
    await key(group.querySelector('[aria-checked="true"]') as HTMLElement, "ArrowRight");
    expect(checked()).toBe("v2");
    expect(count()).toBe("1 of 2");
    expect(document.activeElement?.textContent).toBe("v2");
    await key(document.activeElement as HTMLElement, "ArrowLeft");
    await key(document.activeElement as HTMLElement, "ArrowLeft");
    expect(checked()).toBe("story.md");
    expect(count()).toBe("1 of 1");
  });

  test("line numbers and the Take buttons are not text to find", async () => {
    const scroller = await openCompare();
    await findKey(scroller);
    await typeInto(field() as HTMLInputElement, "1");
    // Only the "1" in "the lantern 1", once; no gutter numbers.
    expect(count()).toBe("1 of 1");
    await typeInto(field() as HTMLInputElement, "Take");
    expect(count()).toBe("No results");
  });
});
