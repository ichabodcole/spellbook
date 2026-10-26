// The rendered view while a costly redraw is held (`useCoalescedText`): the DOM
// still shows the text drawn last, and the pane already holds a newer one. Every
// position crossing between them is mapped: a selection made on the drawn text
// is reported in the newer one (its lines included), notes the pane placed in the
// newer text are painted on the drawn one, and a position inside what changed is
// dropped, never guessed.
//
// A redraw is made costly by moving `performance.now` on while the view draws
// (in its `onEmbedTargets`, said once per drawing, after the HTML is in).

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import type { PlacedNote } from "../workspace/protocol";
import type { SelectionReport } from "./DocumentView.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import type { Pane, Place } from "./place.ts";

class FakeHighlight extends Set<Range> {
  get ranges(): Range[] {
    return [...this];
  }
}
const highlights = new Map<string, FakeHighlight>();
let ownCss: PropertyDescriptor | undefined;
const realNow = performance.now.bind(performance);
let ahead = 0;

beforeAll(() => {
  installDom();
  ownCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  Object.defineProperty(globalThis, "CSS", {
    value: { highlights },
    configurable: true,
    writable: true,
  });
  (globalThis as Record<string, unknown>).Highlight = FakeHighlight;
});
beforeEach(() => {
  ahead = 0;
  performance.now = () => realNow() + ahead;
});
afterEach(async () => {
  await cleanup();
  performance.now = realNow;
  highlights.clear();
});
afterAll(async () => {
  if (ownCss) Object.defineProperty(globalThis, "CSS", ownCss);
  else delete (globalThis as Record<string, unknown>).CSS;
  delete (globalThis as Record<string, unknown>).Highlight;
  await removeDom();
});

/** Each drawing costs a second. */
const costly = () => {
  ahead += 1000;
};

const lines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Line ${from + i}: lorem ipsum.`);
const OLD = `${lines(1, 9).join("\n\n")}\n`;
/** Six new paragraphs above the old first one. */
const NEW = `${["Added a.", "Added b.", "Added c.", "Added d.", "Added e.", "Added f."].join("\n\n")}\n\n${OLD}`;

function find(root: Element, word: string): { node: Text; at: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const at = (n as Text).data.indexOf(word);
    if (at !== -1) return { node: n as Text, at };
  }
  throw new Error(`"${word}" is not rendered`);
}
async function select(root: Element, within: string, word: string): Promise<void> {
  const s = find(root, within);
  const at = s.at + within.indexOf(word);
  const range = document.createRange();
  range.setStart(s.node, at);
  range.setEnd(s.node, at + word.length);
  await settle(() => {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}
const body = (c: Element) => c.querySelector(".md-prose") as Element;
const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;

test("a selection made on the held text is reported in the newer one, with its lines", async () => {
  const reports: SelectionReport[] = [];
  const menus: { from: number; to: number }[] = [];
  const view = (text: string) => (
    <MarkdownView
      text={text}
      textKey="doc@1"
      onEmbedTargets={costly}
      onSelect={(s) => reports.push(s)}
      onContextMenu={(at) => {
        menus.push(at);
        return true;
      }}
    />
  );
  const m = await mount(view(OLD));
  await m.render(view(NEW));
  // Held: the DOM still shows the old text.
  expect(body(m.container).textContent).not.toContain("Added a.");

  await select(body(m.container), "Line 7: lorem ipsum.", "ipsum");
  const at = NEW.indexOf("ipsum", NEW.indexOf("Line 7:"));
  const last = reports.at(-1);
  expect(last).toMatchObject({ from: at, to: at + 5, text: "ipsum" });
  expect(last?.fromLine).toBe(lineOf(NEW, at));
  expect(last?.fromLine).not.toBe(lineOf(OLD, OLD.indexOf("ipsum", OLD.indexOf("Line 7:"))));

  // A context menu over it offers the same passage, in the newer text.
  await settle(() => {
    body(m.container).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
  expect(menus.at(-1)).toMatchObject({ from: at, to: at + 5 });
});

test("a selection inside what changed is cleared, never reported against the wrong text", async () => {
  const reports: SelectionReport[] = [];
  const view = (text: string) => (
    <MarkdownView
      text={text}
      textKey="doc@1"
      onEmbedTargets={costly}
      onSelect={(s) => reports.push(s)}
    />
  );
  const m = await mount(view(OLD));
  // Line 3 was rewritten in the newer text.
  await m.render(view(OLD.replace("Line 3: lorem ipsum.", "Line 3: something else entirely.")));
  expect(body(m.container).textContent).toContain("Line 3: lorem ipsum.");
  await select(body(m.container), "Line 3: lorem ipsum.", "lorem");
  expect(reports.at(-1)).toEqual({ from: 0, to: 0, fromLine: 1, toLine: 1, text: "" });
});

test("notes placed in the newer text are painted on the held one; one in what changed is not", async () => {
  const note = (id: string, quote: string, from: number): PlacedNote =>
    ({ id, quote, from, to: from + quote.length }) as PlacedNote;
  const kept = NEW.indexOf("ipsum", NEW.indexOf("Line 8:"));
  const notes = [note("n1", "ipsum", kept), note("n2", "Added c.", NEW.indexOf("Added c."))];
  const view = (text: string, n?: PlacedNote[]) => (
    <MarkdownView text={text} textKey="doc@1" onEmbedTargets={costly} notes={n} />
  );
  const m = await mount(view(OLD));
  await m.render(view(NEW, notes));
  expect(body(m.container).textContent).not.toContain("Added c.");
  const painted = highlights.get("doc-note")?.ranges ?? [];
  expect(painted.map((r) => r.toString())).toEqual(["ipsum"]);
  // On Line 8's own words, not on whatever sits at that offset in the held text.
  expect(painted[0]?.startContainer.textContent).toContain("Line 8:");
});

test("the pending note and a flash, placed in the newer text, are painted on their own words", async () => {
  const at = NEW.indexOf("ipsum", NEW.indexOf("Line 8:"));
  const view = (text: string, marks?: boolean) => (
    <MarkdownView
      text={text}
      textKey="doc@1"
      onEmbedTargets={costly}
      {...(marks
        ? { pendingNote: { from: at, to: at + 5 }, flash: { from: at, to: at + 5, seq: 1 } }
        : {})}
    />
  );
  const m = await mount(view(OLD));
  await m.render(view(NEW, true));
  expect(body(m.container).textContent).not.toContain("Added a.");
  for (const name of ["doc-note-pending", "doc-flash"]) {
    const painted = highlights.get(name)?.ranges ?? [];
    expect(painted.map((r) => r.toString())).toEqual(["ipsum"]);
    expect(painted[0]?.startContainer.textContent).toContain("Line 8:");
  }
});

describe("keeping the place during a hold", () => {
  // happy-dom lays nothing out: each paragraph is put 100 px below the one before.
  let ownRect: PropertyDescriptor | undefined;
  beforeEach(() => {
    ownRect = Object.getOwnPropertyDescriptor(
      window.HTMLElement.prototype,
      "getBoundingClientRect",
    );
    window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const i =
        this.tagName === "P" && this.parentElement
          ? [...this.parentElement.children].indexOf(this)
          : 0;
      // In the viewport, as a browser says it: a paragraph moves up as the pane scrolls.
      const scrolled = this.closest<HTMLElement>("[data-slot=markdown-view]")?.scrollTop ?? 0;
      const top = this.tagName === "P" ? i * 100 - scrolled : 0;
      return { x: 0, y: top, top, left: 0, right: 0, bottom: top, width: 0, height: 0 } as DOMRect;
    };
  });
  afterEach(() => {
    if (ownRect)
      Object.defineProperty(window.HTMLElement.prototype, "getBoundingClientRect", ownRect);
  });

  /** A place that records what the view says, and hands the test the view's controls. */
  function fakePlace() {
    const said: number[] = [];
    let controls: Pane | null = null;
    const place: Place = {
      line: () => 1,
      report: (_pane, line) => said.push(line),
      join: (_pane, c) => {
        controls = c;
        return () => {};
      },
    };
    return { place, said, controls: () => controls as unknown as Pane };
  }
  const scroller = (c: Element) => c.querySelector("[data-slot=markdown-view]") as HTMLElement;
  /** The source line of "Line k:" in a text. */
  const lineOfPara = (text: string, k: number) => lineOf(text, text.indexOf(`Line ${k}:`));

  test("a line asked for in the newer text scrolls to that passage in the held one", async () => {
    const { place, controls } = fakePlace();
    const view = (text: string) => (
      <MarkdownView text={text} textKey="doc@1" onEmbedTargets={costly} place={place} />
    );
    const m = await mount(view(OLD));
    await m.render(view(NEW));
    expect(body(m.container).textContent).not.toContain("Added a.");
    // "Line 7:" is the seventh paragraph drawn: 600 px down.
    await settle(() => controls().to(lineOfPara(NEW, 7)));
    expect(scroller(m.container).scrollTop).toBe(600);
  });

  test("the line at the top is said in the newer text", async () => {
    const { place, said } = fakePlace();
    const view = (text: string) => (
      <MarkdownView text={text} textKey="doc@1" onEmbedTargets={costly} place={place} />
    );
    const m = await mount(view(OLD));
    await m.render(view(NEW));
    const sc = scroller(m.container);
    await settle(() => {
      sc.scrollTop = 600;
      sc.dispatchEvent(new Event("scroll"));
    });
    expect(said.at(-1)).toBe(lineOfPara(NEW, 7));
  });
});
