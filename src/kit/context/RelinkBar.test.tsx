// The offer after a rename or move that broke links, in a DOM: it names how
// many links in how many documents, Show lists each as written and as it would
// be written, and Update and Leave each answer once.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import type { RelinkOffer } from "../workspace/protocol";
import { RelinkBar } from "./RelinkBar.tsx";

beforeAll(installDom);
afterEach(cleanup);
// Awaited: the next file's installDom is a no-op while the DOM is still registered.
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

const offer: RelinkOffer = {
  what: "glade.md",
  by: "agent",
  count: 3,
  docs: [
    {
      path: "/w/keeper.md",
      shown: "world/keeper.md",
      fixes: [
        {
          line: 3,
          from: "./places/glade.md?rel=located-in",
          to: "./places/the-glade.md?rel=located-in",
        },
        {
          line: 3,
          from: "./places/glade.md?rel=located-in",
          to: "./places/the-glade.md?rel=located-in",
        },
      ],
    },
    {
      path: "/w/index.md",
      shown: "world/index.md",
      fixes: [{ line: 1, from: "places/glade.md", to: "./places/the-glade.md" }],
    },
  ],
  wiki: [],
};

test("names the links and the documents, lists them on Show, and answers once per button", async () => {
  const said: string[] = [];
  await mount(
    <RelinkBar
      offer={offer}
      onUpdate={() => said.push("update")}
      onLeave={() => said.push("leave")}
    />,
  );
  expect(q('[data-slot="relink-bar"]')?.textContent).toContain(
    "3 links in 2 documents still point at where glade.md was.",
  );
  expect(q('[data-action="relink-update"]')?.textContent).toBe("Update 3 links");
  expect(q('[data-slot="relink-list"]')).toBeNull();
  await click(q('[data-action="relink-show"]'));
  const list = q('[data-slot="relink-list"]');
  expect(list?.textContent).toContain("world/keeper.md");
  expect(list?.textContent).toContain("line 1: places/glade.md → ./places/the-glade.md");
  expect(list?.querySelectorAll("li li").length).toBe(3);
  await click(q('[data-action="relink-update"]'));
  await click(q('[data-action="relink-leave"]'));
  expect(said).toEqual(["update", "leave"]);
});

test("says how many wiki links it cannot update, and lists them", async () => {
  await mount(
    <RelinkBar
      offer={{
        ...offer,
        wiki: [{ path: "/w/notes.md", shown: "world/notes.md", line: 4, raw: "glade" }],
      }}
      onUpdate={() => {}}
      onLeave={() => {}}
    />,
  );
  expect(q('[data-slot="relink-bar"] p')?.textContent).toBe(
    "3 links in 2 documents still point at where glade.md was, and 1 wiki link it can't update.",
  );
  await click(q('[data-action="relink-show"]'));
  expect(q('[data-slot="relink-list"]')?.textContent).toContain(
    "world/notes.md line 4: [[glade]] can't be updated",
  );
});

test("answered with focus inside it, focus goes where it is told (the undo arrow), not to the page", async () => {
  for (const action of ["relink-update", "relink-leave"]) {
    let moved = 0;
    const m = await mount(
      <RelinkBar offer={offer} onUpdate={() => {}} onLeave={() => {}} focusAfter={() => moved++} />,
    );
    const button = q(`[data-action="${action}"]`) as HTMLElement;
    button.focus();
    await click(button);
    expect(moved).toBe(1);
    await m.unmount();
  }
  // A click with focus elsewhere moves nothing.
  let moved = 0;
  await mount(
    <RelinkBar offer={offer} onUpdate={() => {}} onLeave={() => {}} focusAfter={() => moved++} />,
  );
  (document.body as HTMLElement).focus();
  await click(q('[data-action="relink-update"]'));
  expect(moved).toBe(0);
});

test("one link reads in the singular", async () => {
  const one = { ...offer, count: 1, docs: [offer.docs[1] as RelinkOffer["docs"][number]] };
  await mount(
    <RelinkBar
      offer={{ ...one, wiki: [{ path: "/w/n.md", shown: "world/n.md", line: 1, raw: "g" }] }}
      onUpdate={() => {}}
      onLeave={() => {}}
    />,
  );
  expect(q('[data-slot="relink-bar"] p')?.textContent).toBe(
    "1 link in 1 document still points at where glade.md was, and 1 wiki link it can't update.",
  );
  expect(q('[data-action="relink-update"]')?.textContent).toBe("Update 1 link");
});
