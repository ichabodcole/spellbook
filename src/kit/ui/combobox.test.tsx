// The Combobox over Base UI: it opens, filters by the spell's rule, picks by keyboard,
// and the closed control names the pick.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useState } from "react";
import {
  cleanup,
  installDom,
  mount,
  removeDom,
  settle,
  typeInto,
  waitFor,
} from "../lib/testDom.ts";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemAction,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxTrigger,
} from "./index.ts";

beforeAll(installDom);
afterAll(removeDom);
afterEach(cleanup);

type Fruit = { id: string; name: string; note: string };
const FRUIT: Fruit[] = [
  { id: "a", name: "Apple", note: "crisp" },
  { id: "b", name: "Banana", note: "soft" },
  { id: "c", name: "Cherry", note: "tart and crisp" },
];

const slot = (root: ParentNode, name: string) => root.querySelector(`[data-slot="${name}"]`);
const key = async (el: Element, k: string) =>
  settle(() => {
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  });

function Demo({ onPreview }: { onPreview?: (id: string) => void }) {
  const [value, setValue] = useState<Fruit | null>(null);
  return (
    <Combobox<Fruit>
      items={FRUIT}
      value={value}
      onValueChange={setValue}
      itemToStringLabel={(f) => f.name}
      isItemEqualToValue={(a, b) => a.id === b.id}
      filter={(f, q) => `${f.name} ${f.note}`.toLowerCase().includes(q.trim().toLowerCase())}
    >
      <ComboboxTrigger placeholder="Choose a fruit">
        {value && <span data-testid="chosen">{value.name}</span>}
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput aria-label="Search fruit" />
        <ComboboxEmpty>No fruit matches.</ComboboxEmpty>
        <ComboboxList>
          {(f: Fruit) => (
            <ComboboxItem key={f.id} value={f} data-fruit={f.id}>
              <ComboboxItemIndicator />
              <span className="flex-1">{f.name}</span>
              <ComboboxItemAction
                aria-label={`Preview ${f.name}`}
                onClick={() => onPreview?.(f.id)}
              >
                ?
              </ComboboxItemAction>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

const open = async (container: HTMLElement) => {
  await settle(() => {
    (slot(container, "combobox-trigger") as HTMLElement).click();
  });
  await waitFor(() => slot(document.body, "combobox-content") !== null, "the popup");
};

describe("Combobox", () => {
  test("the closed control shows the placeholder until something is chosen", async () => {
    const m = await mount(<Demo />);
    expect(slot(m.container, "combobox-trigger")?.textContent).toContain("Choose a fruit");
    expect(slot(document.body, "combobox-content")).toBeNull();
  });

  test("it opens, filters by the spell's rule, picks by keyboard, and the control names the pick", async () => {
    const m = await mount(<Demo />);
    await open(m.container);
    expect(document.querySelectorAll("[data-fruit]").length).toBe(3);

    const input = slot(document.body, "combobox-input") as HTMLInputElement;
    await typeInto(input, "crisp");
    await waitFor(() => document.querySelectorAll("[data-fruit]").length === 2, "the filter");
    expect(
      [...document.querySelectorAll("[data-fruit]")].map((e) => e.getAttribute("data-fruit")),
    ).toEqual(["a", "c"]);

    await key(input, "ArrowDown");
    await key(input, "ArrowDown");
    await key(input, "Enter");
    await waitFor(() => slot(document.body, "combobox-content") === null, "the popup to close");
    expect(m.container.querySelector('[data-testid="chosen"]')?.textContent).toBe("Cherry");
  });

  test("only the chosen item carries the check", async () => {
    const m = await mount(<Demo />);
    await open(m.container);
    const checks = () =>
      [...document.querySelectorAll('[data-fruit] [data-slot="combobox-item-indicator"]')].map(
        (e) => e.closest("[data-fruit]")?.getAttribute("data-fruit"),
      );
    expect(checks()).toEqual([]);
    await settle(() => {
      (document.querySelector('[data-fruit="b"]') as HTMLElement).click();
    });
    await waitFor(() => slot(document.body, "combobox-content") === null, "the popup to close");
    await open(m.container);
    expect(checks()).toEqual(["b"]);
  });

  test("an item's action does not pick the item", async () => {
    const previewed: string[] = [];
    const m = await mount(<Demo onPreview={(id) => previewed.push(id)} />);
    await open(m.container);
    await settle(() => {
      (document.querySelector('[aria-label="Preview Banana"]') as HTMLElement).click();
    });
    expect(previewed).toEqual(["b"]);
    expect(slot(document.body, "combobox-content")).not.toBeNull();
    expect(m.container.querySelector('[data-testid="chosen"]')).toBeNull();
  });
});
