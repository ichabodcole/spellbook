// The link picker's second step (kit-heading-links-build): with a document
// highlighted, `#` lists its headings, asked for that document alone; choosing
// one hands the heading over with the target; Backspace on an empty search goes
// back to the documents, with the search as it was.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  cleanup,
  installDom,
  mount,
  removeDom,
  settle,
  typeInto,
  waitFor,
} from "../lib/testDom.ts";
import type { HeadingOffer, LinkTarget } from "../workspace/protocol";
import { LinkPicker } from "./LinkPicker.tsx";
import { linkInsertion } from "./linkInsert.ts";

beforeAll(() => installDom());
afterAll(async () => {
  await removeDom();
});
afterEach(async () => {
  await cleanup();
});

const TARGETS: LinkTarget[] = [
  {
    path: "/w/touchstones/00-touchstones.md",
    name: "00-touchstones.md",
    href: "./touchstones/00-touchstones.md",
    shown: "touchstones/00-touchstones.md",
  },
  {
    path: "/w/06-design-lenses.md",
    name: "06-design-lenses.md",
    href: "./06-design-lenses.md",
    shown: "06-design-lenses.md",
  },
  {
    path: "/w/images/fox.png",
    name: "fox.png",
    href: "./images/fox.png",
    shown: "images/fox.png",
    image: true,
  },
];

const HEADINGS: Record<string, HeadingOffer[]> = {
  "/w/touchstones/00-touchstones.md": [
    { level: 1, text: "Touchstones", line: 9, anchor: "Touchstones" },
    {
      level: 3,
      text: "A Voyage to Arcturus — David Lindsay",
      line: 168,
      anchor: "A%20Voyage%20to%20Arcturus%20—%20David%20Lindsay",
    },
  ],
  "/w/06-design-lenses.md": [
    { level: 2, text: "How lenses work", line: 48, anchor: "How%20lenses%20work" },
    {
      level: 3,
      text: "Stacking lenses",
      line: 70,
      anchor: "How%20lenses%20work#Stacking%20lenses",
    },
    { level: 3, text: "Stacking lenses", line: 295, anchor: "Methodology#Stacking%20lenses" },
  ],
};

type Chosen = { target: LinkTarget; relations: string[]; heading?: HeadingOffer };

async function picker() {
  const asked: string[] = [];
  const chosen: Chosen[] = [];
  await mount(
    <LinkPicker
      at={{ x: 10, y: 10 }}
      kind="wrap"
      quote=""
      targets={TARGETS}
      relations={[{ rel: "grounded-in", count: 3, declared: false }]}
      failure={null}
      onHeadings={async (t) => {
        asked.push(t.path);
        return HEADINGS[t.path] ?? [];
      }}
      onChoose={(target, relations, heading) =>
        chosen.push({ target, relations, ...(heading ? { heading } : {}) })
      }
      onClose={() => {}}
    />,
  );
  return { asked, chosen };
}

const docField = () =>
  document.querySelector('[aria-label="Find a document to link to"]') as HTMLInputElement | null;
const headingField = () =>
  document.querySelector('[aria-label="Find a heading to link to"]') as HTMLInputElement | null;
const headingRows = () =>
  [...document.querySelectorAll("[data-heading]")].map((r) => r.getAttribute("data-heading"));
const press = (el: HTMLElement, key: string) =>
  settle(() => {
    el.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });

describe("the picker's headings", () => {
  test("# on a highlighted document lists its headings, asked for it alone, and Enter chooses one", async () => {
    const { asked, chosen } = await picker();
    await typeInto(docField() as HTMLInputElement, "touchstones");
    await press(docField() as HTMLInputElement, "#");
    await waitFor(() => headingRows().length === 2, "the headings");
    expect(asked).toEqual(["/w/touchstones/00-touchstones.md"]);
    expect(headingRows()).toEqual(["Touchstones", "A Voyage to Arcturus — David Lindsay"]);
    await typeInto(headingField() as HTMLInputElement, "arcturus");
    expect(headingRows()).toEqual(["A Voyage to Arcturus — David Lindsay"]);
    const rel = document.querySelector('[aria-label="Relation"]') as HTMLInputElement;
    await typeInto(rel, "grounded-in");
    await press(headingField() as HTMLInputElement, "Enter");
    expect(chosen).toHaveLength(1);
    const c = chosen[0] as Chosen;
    expect(c.target.path).toBe("/w/touchstones/00-touchstones.md");
    expect(c.relations).toEqual(["grounded-in"]);
    expect(linkInsertion("wrap", "", c.target, c.relations, c.heading)).toBe(
      "[A Voyage to Arcturus — David Lindsay](./touchstones/00-touchstones.md?rel=grounded-in#A%20Voyage%20to%20Arcturus%20—%20David%20Lindsay)",
    );
  });

  test("a repeated heading is handed over with its path, and the right arrow opens the step too", async () => {
    const { chosen } = await picker();
    await typeInto(docField() as HTMLInputElement, "lenses");
    await press(docField() as HTMLInputElement, "ArrowRight");
    await waitFor(() => headingRows().length === 3, "the headings");
    // The two "Stacking lenses" rows say which section each is under; a unique heading says nothing.
    expect(
      [...document.querySelectorAll("[data-heading]")].map(
        (r) => r.querySelector('[data-slot="heading-parent"]')?.textContent ?? null,
      ),
    ).toEqual([null, "How lenses work", "Methodology"]);
    const f = headingField() as HTMLInputElement;
    await press(f, "ArrowDown");
    await press(f, "ArrowDown");
    await press(f, "Enter");
    expect(chosen[0]?.heading?.anchor).toBe("Methodology#Stacking%20lenses");
    expect(
      linkInsertion("complete", "", chosen[0]?.target as LinkTarget, [], chosen[0]?.heading),
    ).toBe("./06-design-lenses.md#Methodology#Stacking%20lenses)");
  });

  test("Backspace on an empty search goes back to the documents, with the search as it was", async () => {
    await picker();
    await typeInto(docField() as HTMLInputElement, "touch");
    await press(docField() as HTMLInputElement, "#");
    await waitFor(() => headingRows().length === 2, "the headings");
    await press(headingField() as HTMLInputElement, "Backspace");
    expect(headingField()).toBeNull();
    expect(docField()?.value).toBe("touch");
  });

  test("an image has no headings: # stays a character", async () => {
    const { asked } = await picker();
    await typeInto(docField() as HTMLInputElement, "fox");
    await press(docField() as HTMLInputElement, "#");
    expect(headingField()).toBeNull();
    expect(asked).toEqual([]);
  });

  test("a plain choice is a plain link, as before", async () => {
    const { chosen } = await picker();
    await typeInto(docField() as HTMLInputElement, "touchstones");
    await press(docField() as HTMLInputElement, "Enter");
    expect(chosen[0]?.heading).toBeUndefined();
  });
});
