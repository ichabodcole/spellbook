// Test support, beside testDom, for the shell's DOM tests: lays the panels out as a browser would,
// so react-resizable-panels can collapse and reopen a column under happy-dom.
// Imported by tests only.

import { settle } from "./testDom.ts";

/**
 * Give every element a width and a height, so react-resizable-panels can lay the
 * panels out and collapse or reopen one, as it does in a browser. `resize` changes
 * the window's width and tells the library, as a browser's ResizeObserver would.
 */
export type LaidOut = { undo: () => void; resize: (width: number) => Promise<void> };
export function laidOut(width = 1200): LaidOut {
  const proto = window.HTMLElement.prototype;
  const win = window as unknown as { ResizeObserver?: unknown };
  const was = {
    w: Object.getOwnPropertyDescriptor(proto, "offsetWidth"),
    h: Object.getOwnPropertyDescriptor(proto, "offsetHeight"),
    ro: win.ResizeObserver,
  };
  const size = { width };
  // The library takes the group's width as the sum of its three panels' widths,
  // so each panel reports a third of the window and the sum is the window.
  Object.defineProperty(proto, "offsetWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-panel") ? size.width / 3 : size.width;
    },
  });
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => 700 });
  type Entry = { target: Element; borderBoxSize: { inlineSize: number; blockSize: number }[] };
  const observers = new Set<{ cb: (entries: Entry[]) => void; els: Set<Element> }>();
  win.ResizeObserver = class {
    me: { cb: (entries: Entry[]) => void; els: Set<Element> };
    constructor(cb: (entries: Entry[]) => void) {
      this.me = { cb, els: new Set() };
      observers.add(this.me);
    }
    observe(el: Element) {
      this.me.els.add(el);
    }
    unobserve(el: Element) {
      this.me.els.delete(el);
    }
    disconnect() {
      observers.delete(this.me);
    }
  };
  return {
    undo: () => {
      if (was.w) Object.defineProperty(proto, "offsetWidth", was.w);
      else delete (proto as unknown as Record<string, unknown>).offsetWidth;
      if (was.h) Object.defineProperty(proto, "offsetHeight", was.h);
      else delete (proto as unknown as Record<string, unknown>).offsetHeight;
      win.ResizeObserver = was.ro;
    },
    resize: (next) =>
      settle(() => {
        size.width = next;
        for (const o of observers)
          o.cb(
            [...o.els].map((target) => ({
              target,
              borderBoxSize: [{ inlineSize: next, blockSize: 700 }],
            })),
          );
      }),
  };
}

/**
 * Stored layouts the layout library cannot use: what a hand edit, a crash mid-write
 * or an older build can leave under a `react-resizable-panels:` key. Each must be
 * ignored, and the default layout opened.
 */
export const BAD_LAYOUTS: readonly { what: string; value: string }[] = [
  { what: "text that is not JSON", value: "{not json" },
  { what: "null", value: "null" },
  { what: "a number", value: "5" },
  { what: "a string", value: '"wide"' },
  { what: "an array of numbers", value: "[30, 70]" },
  { what: "an empty object", value: "{}" },
  { what: "sizes that are not numbers", value: '{"a": "wide", "b": null}' },
  { what: "sizes for panels that are not there", value: '{"elsewhere": 40, "other": 60}' },
];
