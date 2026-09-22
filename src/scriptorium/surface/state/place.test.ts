// E63: keeping your place — the source line at the top of a pane, and what it
// takes to put another pane at the same line without the two chasing each other.
import { describe, expect, test } from "bun:test";
import { createPlace, lineAtTop, sourceLine, topForLine } from "./place";
import { project } from "./projection";

/**
 * A document with frontmatter, a fenced block and a list — the shapes the
 * anchors have to survive. ⚠ The assertions below ask THE SOURCE what is on
 * the line they were given (`src.split("\n")[line - 1]`) rather than counting
 * newlines a second time; re-deriving the expectation with the code's own
 * arithmetic is the defect branch 1 hit twice.
 */
const DOC = `---
title: A test
---

# The heading

A paragraph of prose that sits under the heading.

\`\`\`ts
const x = 1;
\`\`\`

- **Boundary check:** the theme organises and must never derive.
- A second item.

> A quoted line.
`;

describe("sourceLine", () => {
  const p = project(DOC);
  const at = (needle: string) => p.plain.indexOf(needle);

  test("a rendered offset names the source line that text is written on", () => {
    const lines = DOC.split("\n");
    for (const needle of ["The heading", "A paragraph", "Boundary check", "quoted"]) {
      const line = sourceLine(p, DOC, at(needle));
      expect(lines[line - 1]).toContain(needle);
    }
  });

  // A fenced block renders as ONE run whose source span is the whole fence, so
  // it is not `exact` and every offset inside it resolves to the fence's own
  // start (E51). That is the honest answer — there is no per-line mapping to
  // be had — and it is what an anchor wants anyway: the block begins there.
  test("an offset inside a fenced block names the line the fence opens on", () => {
    const line = sourceLine(p, DOC, at("const x = 1;"));
    expect(DOC.split("\n")[line - 1]).toBe("```ts");
  });

  test("the frontmatter is not rendered, so no offset points into it", () => {
    expect(sourceLine(p, DOC, 0)).toBeGreaterThan(3);
  });
});

describe("topForLine / lineAtTop", () => {
  /** Ten source lines to a hundred pixels — chosen so the midpoints are round. */
  const anchors = [
    { line: 1, top: 0 },
    { line: 11, top: 100 },
    { line: 21, top: 300 },
  ];

  test("an anchor's own line scrolls to that anchor's top", () => {
    expect(topForLine(anchors, 1)).toBe(0);
    expect(topForLine(anchors, 11)).toBe(100);
    expect(topForLine(anchors, 21)).toBe(300);
  });

  test("a line between two anchors lands proportionally between them", () => {
    expect(topForLine(anchors, 6)).toBe(50);
    expect(topForLine(anchors, 16)).toBe(200);
  });

  // The rendered pane's first block does NOT start at 0 — the metadata header
  // sits above it — and the frontmatter those first source lines belong to is
  // not rendered at all. Landing on the first block's own top would scroll the
  // header out of sight for a document you had not scrolled.
  test("a line at or before the first rendered block goes to the very top of the pane", () => {
    const belowAHeader = [
      { line: 12, top: 180 },
      { line: 20, top: 400 },
    ];
    expect(topForLine(belowAHeader, 1)).toBe(0);
    expect(topForLine(belowAHeader, 12)).toBe(0);
    expect(lineAtTop(belowAHeader, 0)).toBe(12);
  });

  test("a line outside the anchors clamps to the ends", () => {
    expect(topForLine(anchors, 0)).toBe(0);
    expect(topForLine(anchors, 99)).toBe(300);
  });

  test("a scroll position reads back as the line that put it there", () => {
    for (const a of anchors) expect(lineAtTop(anchors, topForLine(anchors, a.line))).toBe(a.line);
    expect(lineAtTop(anchors, 50)).toBe(6);
    expect(lineAtTop(anchors, 200)).toBe(16);
  });

  test("a scroll position outside the anchors clamps to the end lines", () => {
    expect(lineAtTop(anchors, -40)).toBe(1);
    expect(lineAtTop(anchors, 9999)).toBe(21);
  });

  test("a line with no anchor of its own — inside a fence — still lands between its neighbours", () => {
    const top = topForLine(anchors, 14);
    expect(top).toBeGreaterThan(100);
    expect(top).toBeLessThan(300);
  });

  test("a document with nothing measurable answers the top and the first line", () => {
    expect(topForLine([], 40)).toBe(0);
    expect(lineAtTop([], 400)).toBe(1);
  });

  test("a document shorter than the pane has one anchor and never scrolls", () => {
    const one = [{ line: 5, top: 0 }];
    expect(topForLine(one, 1)).toBe(0);
    expect(topForLine(one, 900)).toBe(0);
    expect(lineAtTop(one, 0)).toBe(5);
  });
});

describe("createPlace", () => {
  /** A hand-run clock: the drive guard releases only when the test says so. */
  function manual() {
    const queued: (() => void)[] = [];
    return {
      schedule: (fn: () => void) => {
        queued.push(fn);
      },
      settle: () => {
        const run = queued.splice(0);
        for (const fn of run) fn();
      },
    };
  }

  test("a pane's report reaches the other pane, not itself", () => {
    const place = createPlace();
    const heard: string[] = [];
    place.follow("raw", (n) => heard.push(`raw:${n}`));
    place.follow("rendered", (n) => heard.push(`rendered:${n}`));
    place.report("raw", 42);
    expect(heard).toEqual(["rendered:42"]);
    expect(place.line()).toBe(42);
  });

  test("the pane being driven does not report back — the feedback loop", () => {
    const clock = manual();
    const place = createPlace({ schedule: clock.schedule });
    const heard: string[] = [];
    place.follow("raw", (n) => {
      heard.push(`raw:${n}`);
      // What a real pane does: the programmatic scroll fires its own handler.
      place.report("raw", n + 1);
    });
    place.follow("rendered", (n) => {
      heard.push(`rendered:${n}`);
      place.report("rendered", n + 1);
    });
    place.report("raw", 40);
    expect(heard).toEqual(["rendered:40"]);
    expect(place.line()).toBe(40);
  });

  test("the guard lifts once the scroll has settled", () => {
    const clock = manual();
    const place = createPlace({ schedule: clock.schedule });
    const heard: number[] = [];
    place.follow("raw", (n) => heard.push(n));
    place.follow("rendered", () => {});
    place.report("raw", 40);
    place.report("rendered", 41);
    expect(heard).toEqual([]);
    clock.settle();
    place.report("rendered", 41);
    expect(heard).toEqual([41]);
  });

  test("a restore is a drive too: the pane reading the place does not re-report it", () => {
    const clock = manual();
    const place = createPlace({ line: 120, schedule: clock.schedule });
    const heard: number[] = [];
    place.follow("rendered", (n) => heard.push(n));
    place.driven("raw", () => {
      // Mounting: read the place, scroll there, and the scroll handler fires.
      expect(place.line()).toBe(120);
      place.report("raw", 118);
    });
    expect(heard).toEqual([]);
    expect(place.line()).toBe(120);
  });

  test("the same line twice is not news", () => {
    const place = createPlace();
    const heard: number[] = [];
    place.follow("rendered", (n) => heard.push(n));
    place.report("raw", 7);
    place.report("raw", 7);
    expect(heard).toEqual([7]);
  });

  test("an unfollowed pane hears nothing", () => {
    const place = createPlace();
    const heard: number[] = [];
    const stop = place.follow("rendered", (n) => heard.push(n));
    stop();
    place.report("raw", 9);
    expect(heard).toEqual([]);
    expect(place.line()).toBe(9);
  });
});
