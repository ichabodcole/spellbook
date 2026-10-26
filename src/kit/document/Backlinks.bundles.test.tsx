// "On the board The well" under a document's backlinks, in a DOM: the bundles a
// document is on (an app's boards) listed under their own heading, apart from
// "Linked from", each opening its bundle; with no links at all, only they show.
// And the words a rename's offer uses for them.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { RelinkBar } from "../context/RelinkBar.tsx";
import { linkPlacesText } from "../lib/bundles.ts";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import type { Backlinks as BacklinksData, ReferenceBacklinkView } from "../workspace/protocol";
import { Backlinks, placesOn } from "./Backlinks.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => [...document.querySelectorAll(sel)];
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

const data = (over: Partial<BacklinksData> = {}): BacklinksData => ({
  doc: "glade",
  path: "/w/places/glade.md",
  count: 1,
  backlinks: [
    {
      source: "/w/index.md",
      name: "index.md",
      shown: "index.md",
      line: 1,
      raw: "places/glade.md",
      rel: [],
      kind: "markdown",
      context: "- [Glade](places/glade.md)",
      from: 2,
      to: 27,
    },
  ],
  relations: [],
  bare: 1,
  bundles: [well],
  ...over,
});

test("the boards a document is on are listed under their own heading, and each opens its board", async () => {
  const opened: string[] = [];
  await mount(
    <Backlinks data={data()} onOpen={() => {}} onOpenBundle={(b) => opened.push(b.source)} />,
  );
  const on = q('[data-slot="backlinks-on"]');
  expect(on?.querySelector("h2")?.textContent).toBe("On a boardnot canon");
  const entry = q('[data-slot="backlink-bundle"]');
  expect(entry?.textContent).toContain("On the board The well");
  expect(entry?.textContent).toContain("The Glade (The Well)");
  // "Linked from" is still its own list, above.
  expect(qa('[data-slot="backlink"]')).toHaveLength(1);
  await click(entry);
  expect(opened).toEqual([well.source]);
});

test("a document only boards point at shows them alone, with no 'Linked from' heading", async () => {
  await mount(
    <Backlinks
      data={data({ count: 0, backlinks: [], bare: 0 })}
      onOpen={() => {}}
      onOpenBundle={() => {}}
    />,
  );
  expect(q('[data-slot="backlinks"]')?.textContent).not.toContain("Linked from");
  expect(qa('[data-slot="backlink-bundle"]')).toHaveLength(1);
});

test("a pane that cannot open a bundle lists none", async () => {
  await mount(<Backlinks data={data({ count: 0, backlinks: [], bare: 0 })} onOpen={() => {}} />);
  expect(q('[data-slot="backlinks"]') === null).toBe(true);
});

test("several cards on one board are counted and named", () => {
  expect(
    placesOn({
      ...well,
      refs: [
        { id: "a", line: 3, raw: "x.md", label: "The Glade", from: 0, to: 1 },
        { id: "b", line: 4, raw: "x.md", from: 2, to: 3 },
      ],
    }),
  ).toBe("2 cards: The Glade, card");
});

test("a rename's offer names a board beside the documents", async () => {
  expect(linkPlacesText([{}, { noun: "board" }])).toBe("1 document and 1 board");
  expect(linkPlacesText([{ noun: "board" }, { noun: "board" }])).toBe("2 boards");
  expect(linkPlacesText([])).toBe("0 documents");
  await mount(
    <RelinkBar
      offer={{
        what: "glade.md",
        by: "human",
        count: 2,
        docs: [
          {
            path: "/w/index.md",
            shown: "world/index.md",
            fixes: [{ line: 1, from: "places/glade.md", to: "./places/the-glade.md" }],
          },
          {
            path: well.source,
            shown: "The well",
            noun: "board",
            fixes: [
              {
                line: 3,
                id: "g",
                label: "The Glade",
                from: "places/glade.md",
                to: "places/the-glade.md",
              },
            ],
          },
        ],
        wiki: [],
      }}
      onUpdate={() => {}}
      onLeave={() => {}}
    />,
  );
  expect(q('[data-slot="relink-bar"] p')?.textContent).toBe(
    "2 links in 1 document and 1 board still point at where glade.md was.",
  );
  await click(q('[data-action="relink-show"]'));
  const list = q('[data-slot="relink-list"]')?.textContent ?? "";
  expect(list).toContain("the board The well");
  expect(list).toContain("The Glade: places/glade.md → places/the-glade.md");
});
