// A board's broken references in the link check, in a DOM: the status bar's
// words, and a section of their own beside the broken links, each entry
// opening its bundle.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import type { LinkCheck, ReferenceBacklinkView } from "../workspace/protocol";
import { LinkCheckList, linkCheckLabel } from "./LinkCheck.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

const q = (sel: string) => document.querySelector(sel);
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

const well: ReferenceBacklinkView = {
  source: "/w/boards/the-well.pinbundle/pins.json",
  bundle: "/w/boards/the-well.pinbundle",
  name: "The well",
  shown: "boards/the-well.pinbundle",
  noun: "board",
  part: "card",
  refs: [
    {
      id: "g",
      line: 3,
      raw: "places/glade.md",
      label: "The Glade",
      subpath: "#The Well",
      from: 0,
      to: 9,
    },
  ],
};

test("the link check lists a board's broken references beside the broken links, and counts them", async () => {
  const check: LinkCheck = {
    count: 1,
    dangling: { count: 0, links: [] },
    unsupported: { count: 0, schemes: [], links: [] },
    duplicates: { count: 0, names: [] },
    unusedImages: { count: 0, images: [] },
    symmetry: { count: 0, hints: [] },
    headings: { count: 0, links: [] },
    ambiguousHeadings: { count: 0, hints: [] },
    references: {
      count: 1,
      links: [
        {
          ...well,
          id: "r",
          line: 4,
          raw: "places/ruin.md",
          label: "The Ruin",
          from: 10,
          to: 20,
          tried: ["/w/places/ruin.md"],
          text: "card 'The Ruin' points at `places/ruin.md`, which is missing",
        },
      ],
    },
  };
  expect(linkCheckLabel(check)).toBe("1 broken reference");
  const opened: string[] = [];
  await mount(<LinkCheckList data={check} onOpen={(p) => opened.push(p)} />);
  const entry = q('[data-slot="link-check-reference"]');
  expect(entry?.textContent).toContain("boards/the-well.pinbundle");
  expect(entry?.textContent).toContain(
    "card 'The Ruin' points at `places/ruin.md`, which is missing",
  );
  await click(entry);
  expect(opened).toEqual([well.source]);
});
