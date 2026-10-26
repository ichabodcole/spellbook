// kit-lone-cr-line-endings: the rendered view says what the human selected, as
// the page shows it (`seen`), with each selection and each right-click over one.
// The daemon holds a note's range to it; without it the rendered view, where the
// wide-note bug lived, would go unchecked.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import type { SelectionReport } from "./DocumentView.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import { checkProjections } from "./projection.ts";

beforeAll(() => installDom());
afterEach(async () => {
  await cleanup();
});
afterAll(async () => {
  await removeDom();
});

const TEXT = "# Title\n\nSome **bold** words and more.\n";

/** Select from `a` in one text node to the end of `b` in another, as a drag would. */
async function selectAcross(root: Element, a: string, b: string): Promise<void> {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) nodes.push(n as Text);
  const start = nodes.find((n) => n.data.includes(a)) as Text;
  const end = nodes.find((n) => n.data.includes(b)) as Text;
  const range = document.createRange();
  range.setStart(start, start.data.indexOf(a));
  range.setEnd(end, end.data.indexOf(b) + b.length);
  await settle(() => {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

test("a selection and a right-click over it carry what the page showed", async () => {
  const reports: SelectionReport[] = [];
  const menus: { from: number; to: number; seen?: string }[] = [];
  const m = await mount(
    <MarkdownView
      text={TEXT}
      textKey="doc@1"
      onSelect={(s) => reports.push(s)}
      onContextMenu={(at) => {
        menus.push(at);
        return true;
      }}
    />,
  );
  const body = m.container.querySelector(".md-prose") as Element;
  // ⛔ The check uses the projection the view holds: projecting again cost close
  // to a second per selection on a 200 KB document.
  const made = checkProjections.made;
  await selectAcross(body, "bold", "words");
  const last = reports.at(-1);
  // The source holds the markup; what was seen does not.
  expect(last?.text).toBe("bold** words");
  expect(last?.seen).toBe("bold words");
  await settle(() => {
    body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  expect(menus.at(-1)?.seen).toBe("bold words");
  expect(checkProjections.made).toBe(made);
  await m.unmount();
});
