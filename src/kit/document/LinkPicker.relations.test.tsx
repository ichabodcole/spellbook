// The link picker's relation step and "Linked from", in a DOM, fed by a REAL
// session over a small Dreamwood (kit-picker-relation-meanings): each declared
// relation's label and meaning, a used-but-undeclared one flagged, the order
// following the target in view (Ruin to Cave: contrasts-with first; into the
// touchstones: sourced-from first), a world with no vocabulary as before, and
// a backlink group read from this end ("grounds").

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanup, installDom, mount, removeDom, typeInto } from "../lib/testDom.ts";
import { smallDreamwood } from "../workspace/fixtures/relations";
import type { WorkspaceSession } from "../workspace/session";
import { inContext, tempRoot } from "../workspace/testing";
import { Backlinks } from "./Backlinks.tsx";
import { LinkPicker } from "./LinkPicker.tsx";

beforeAll(() => installDom());
afterAll(async () => {
  await removeDom();
});
afterEach(async () => {
  await cleanup();
});

let root: string;
let world: string;
let s: WorkspaceSession;

beforeEach(() => {
  root = tempRoot("picker-relations");
  world = join(root, "bible");
  mkdirSync(world, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function picker(from: string) {
  const t = s.linkTargets(s.openPath(join(world, from)).slug);
  return mount(
    <LinkPicker
      at={{ x: 10, y: 10 }}
      kind="wrap"
      quote=""
      targets={t.targets}
      relations={t.relations}
      byKind={t.byKind}
      vocabulary={t.vocabulary}
      failure={null}
      onChoose={() => {}}
      onClose={() => {}}
    />,
  );
}

const field = () =>
  document.querySelector('[aria-label="Find a document to link to"]') as HTMLInputElement;
const offered = () =>
  [...document.querySelectorAll("[data-relation]")].map((b) => b.getAttribute("data-relation"));
const row = (rel: string) => document.querySelector(`[data-relation="${rel}"]`) as HTMLElement;

describe("the relation step", () => {
  test("a declared relation shows its label and its meaning; an undeclared one is flagged", async () => {
    smallDreamwood(world);
    s = inContext(join(root, "sessions"), world);
    await picker("locations/the-ruin.md");
    const contrasts = row("contrasts-with");
    expect(contrasts.textContent).toContain("contrasts with");
    expect(contrasts.querySelector('[data-slot="relation-means"]')?.textContent).toBe(
      "Defined against the target; each sharpens the other.",
    );
    // Cut to one line in the list, whole on hover.
    expect(contrasts.querySelector('[data-slot="relation-means"]')?.getAttribute("title")).toBe(
      "Defined against the target; each sharpens the other.",
    );
    expect(contrasts.querySelector('[data-slot="relation-undeclared"]')).toBeNull();
    const typo = row("sourced_from");
    expect(typo.querySelector('[data-slot="relation-undeclared"]')?.textContent).toBe(
      "used, not declared",
    );
    expect(typo.querySelector('[data-slot="relation-means"]')).toBeNull();
    // Declared but never used yet: still offered.
    expect(offered()).toContain("sister-of");
  });

  test("ranked for the target in view: the Cave puts contrasts-with first, the touchstones sourced-from", async () => {
    smallDreamwood(world);
    s = inContext(join(root, "sessions"), world);
    await picker("locations/the-ruin.md");
    await typeInto(field(), "the-cave");
    expect(offered()[0]).toBe("contrasts-with");
    expect(row("contrasts-with").querySelector('[data-slot="relation-usual"]')).not.toBeNull();
    await typeInto(field(), "touchstones");
    expect(offered()[0]).toBe("sourced-from");
    expect(row("contrasts-with").querySelector('[data-slot="relation-usual"]')).toBeNull();
  });

  test("a world with no vocabulary: the relations in use, by count, with no meanings and nothing flagged", async () => {
    smallDreamwood(world, false);
    s = inContext(join(root, "sessions"), world);
    await picker("the-eight-marks.md");
    expect(offered()).toEqual([
      "contrasts-with",
      "applies",
      "sourced-from",
      "grounded-in",
      "sourced_from",
    ]);
    expect(document.querySelector('[data-slot="relation-means"]')).toBeNull();
    expect(document.querySelector('[data-slot="relation-undeclared"]')).toBeNull();
  });
});

describe("Linked from, read from this end", () => {
  test("a relation's group says its inverse, or a symmetric relation's label", async () => {
    smallDreamwood(world);
    s = inContext(join(root, "sessions"), world);
    await mount(
      <Backlinks data={s.backlinks(join(world, "the-eight-marks.md"))} onOpen={() => {}} />,
    );
    const chip = document.querySelector('[data-rel="grounded-in"] [data-slot="backlink-relation"]');
    expect(chip?.textContent).toBe("grounds");
    expect(chip?.getAttribute("title")).toBe(
      "Written grounded-in in the documents below; read from here, grounds",
    );
    await cleanup();
    await mount(
      <Backlinks data={s.backlinks(join(world, "locations", "the-glade.md"))} onOpen={() => {}} />,
    );
    expect(
      document.querySelector('[data-rel="contrasts-with"] [data-slot="backlink-relation"]')
        ?.textContent,
    ).toBe("contrasts with");
  });

  test("with no vocabulary, the relation as written", async () => {
    smallDreamwood(world, false);
    s = inContext(join(root, "sessions"), world);
    await mount(
      <Backlinks data={s.backlinks(join(world, "the-eight-marks.md"))} onOpen={() => {}} />,
    );
    const chip = document.querySelector('[data-rel="grounded-in"] [data-slot="backlink-relation"]');
    expect(chip?.textContent).toBe("grounded-in");
    expect(chip?.getAttribute("title")).toBeNull();
  });
});
