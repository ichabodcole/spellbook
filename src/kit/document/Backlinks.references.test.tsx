// An app's edges under "Linked from", in a DOM, on data shaped as the daemon
// sends it: one source naming a target twice under the same key is two entries;
// with no opener for edges they are not listed; and each list says where it
// was cut, the links' note with the links and the references' with theirs.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom } from "../lib/testDom.ts";
import type {
  Backlinks as BacklinksData,
  BacklinkView,
  EdgeBacklinkView,
} from "../workspace/protocol";
import { Backlinks } from "./Backlinks.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => [...document.querySelectorAll(sel)];
/** The links' cut note: a note of its own, unmarked so the markup without edges is as it was. */
const linksCut = () =>
  qa('[data-slot="backlinks"] p').find(
    (p) =>
      p.getAttribute("data-slot") !== "references-cut" &&
      /^Showing the first/.test(p.textContent ?? ""),
  ) ?? null;

const link = (n: number): BacklinkView => ({
  source: `/w/s${n}.md`,
  name: `s${n}.md`,
  shown: `s${n}.md`,
  line: 3,
  raw: "t.md",
  rel: [],
  kind: "markdown",
  context: "See [t](t.md).",
  from: 4,
  to: 12,
});

const edge = (over: Partial<EdgeBacklinkView> = {}): EdgeBacklinkView => ({
  source: "/w/notes/r.md",
  name: "r.md",
  shown: "notes/r.md",
  edge: "frontmatter",
  raw: "concept/target",
  key: "related",
  rel: [],
  ...over,
});

const data = (over: Partial<BacklinksData> = {}): BacklinksData => ({
  doc: "t",
  path: "/w/t.md",
  count: 1,
  backlinks: [link(1)],
  relations: [],
  bare: 1,
  bundles: [],
  ...over,
});

test("one source naming the target twice under one key is two entries, with no duplicate-key warning", async () => {
  const errors: string[] = [];
  const was = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await mount(
      <Backlinks
        data={data({ edges: [edge(), edge()], edgeCount: 2 })}
        onOpen={() => {}}
        onOpenEdge={() => {}}
      />,
    );
  } finally {
    console.error = was;
  }
  expect(qa('[data-slot="backlink-reference"]')).toHaveLength(2);
  expect(errors.filter((e) => /same key/i.test(e))).toEqual([]);
});

test("without an opener for edges, they are not listed and not counted", async () => {
  await mount(<Backlinks data={data({ edges: [edge()], edgeCount: 1 })} onOpen={() => {}} />);
  expect(q('[data-slot="backlink-reference"]')).toBeNull();
  expect(q('[data-slot="backlink-references"]')).toBeNull();
  expect(q("h2")?.textContent).toBe("Linked from1 link");
});

test("without an opener, a document reached only by an edge shows no section", async () => {
  await mount(
    <Backlinks
      data={data({ count: 0, backlinks: [], bare: 0, edges: [edge()], edgeCount: 1 })}
      onOpen={() => {}}
    />,
  );
  expect(q('[data-slot="backlinks"]')).toBeNull();
});

test("references cut alone: their note says so, and no links note is printed", async () => {
  await mount(
    <Backlinks
      data={data({ edges: [edge()], edgeCount: 4, truncated: true })}
      onOpen={() => {}}
      onOpenEdge={() => {}}
    />,
  );
  expect(q('[data-slot="references-cut"]')?.textContent).toBe(
    "Showing the first 1 of 4 references.",
  );
  expect(linksCut()).toBeNull();
  expect(q('[data-slot="backlinks"]')?.textContent).not.toContain("Showing the first 1 of 1.");
});

test("both cut: the links' note sits with the links, above the references", async () => {
  await mount(
    <Backlinks
      data={data({ count: 9, edges: [edge()], edgeCount: 4, truncated: true })}
      onOpen={() => {}}
      onOpenEdge={() => {}}
    />,
  );
  const links = linksCut();
  const refs = q('[data-slot="backlink-references"]');
  expect(links?.textContent).toBe("Showing the first 1 of 9.");
  expect(refs).not.toBeNull();
  // The links' note comes before the references block in the document.
  expect(
    (links?.compareDocumentPosition(refs as Node) ?? 0) & window.Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(q('[data-slot="references-cut"]')?.textContent).toBe(
    "Showing the first 1 of 4 references.",
  );
});

test("the entry's name needs no article, whatever the kind; it shows no line it cannot open at", async () => {
  await mount(
    <Backlinks
      data={data({ edges: [edge({ edge: "artifact", line: 7 })], edgeCount: 1 })}
      onOpen={() => {}}
      onOpenEdge={() => {}}
    />,
  );
  const entry = q('[data-slot="backlink-reference"]');
  expect(entry?.getAttribute("aria-label")).toBe("r: reference (artifact), not a link in its text");
  expect(entry?.textContent).not.toContain("line 7");
});
