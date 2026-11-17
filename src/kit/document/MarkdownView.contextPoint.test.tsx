// The point under a right-click in the rendered view (#146), when the browser's
// caret is not in text: beside the blocks, past the last one. The nearest text is
// found in one pass over the page, and only it is placed in the source: placing
// a text node aligns the whole page, so placing every one before the caret made a
// right-click past the end of a long document take seconds.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import { MarkdownView } from "./MarkdownView.tsx";

beforeAll(() => installDom());
afterEach(async () => {
  await cleanup();
});
afterAll(async () => {
  await removeDom();
});

const PARAS = 1500;
const TEXT = `${Array.from({ length: PARAS }, (_, i) => `Paragraph ${i + 1} says a few words.`).join("\n\n")}\n`;

test("a right-click past the last block of a long page places the end of its text, aligning the page a bounded number of times", async () => {
  const points: (number | null)[] = [];
  const m = await mount(
    <MarkdownView
      text={TEXT}
      textKey="doc@1"
      onContextMenu={(at) => {
        points.push(at.point);
        return true;
      }}
    />,
  );
  const body = m.container.querySelector(".md-prose") as HTMLElement;
  // happy-dom has no hit-testing: the browser's caret is on the body, after its last block.
  const doc = document as unknown as Record<string, unknown>;
  doc.caretRangeFromPoint = () => {
    const r = document.createRange();
    r.setStart(body, body.childNodes.length);
    r.setEnd(body, body.childNodes.length);
    return r;
  };
  // Each alignment of the page walks its text nodes once, with a tree walker of its own.
  const ownWalker = document.createTreeWalker;
  let walks = 0;
  document.createTreeWalker = ((...args: Parameters<typeof ownWalker>) => {
    walks++;
    return ownWalker.apply(document, args);
  }) as typeof ownWalker;
  try {
    await settle(() => {
      body.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 2 }),
      );
      body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
  } finally {
    document.createTreeWalker = ownWalker;
    delete doc.caretRangeFromPoint;
  }
  expect(points).toEqual([TEXT.length - 1]);
  // One page walk to find the nearest text and one alignment to place it, per
  // event that asks; not one per paragraph.
  expect(walks).toBeLessThanOrEqual(8);
});
