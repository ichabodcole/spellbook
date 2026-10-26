// `inertOutside` on its own, over plain DOM: no Base UI, so its guards do
// nothing of their own and what holds is this module's (in a browser, Base UI
// 1.6.0's guards let focus out: `ui.test.tsx` covers the kit's modals, and the
// real-browser check is in the item doc).
import "../lib/registerDom.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installDom, removeDom } from "../lib/testDom.ts";
import { inertOutside, inertOutsideWith } from "./inertOutside.ts";

beforeAll(installDom);
afterAll(removeDom);

describe("two modals, one over the other, closing in either order", () => {
  /** The page, modal A's portal, then modal B's opened over it. */
  function nested() {
    document.body.innerHTML = `
      <div id="root"><button>Behind</button></div>
      <div id="already" inert></div>
      <div id="pa"><div id="a"><button>A</button></div></div>`;
    const $ = (id: string) => document.getElementById(id) as HTMLElement;
    const undoA = inertOutside($("a"));
    const pb = document.createElement("div");
    pb.id = "pb";
    const b = document.createElement("div");
    b.appendChild(document.createElement("button"));
    pb.appendChild(b);
    document.body.appendChild(pb);
    const undoB = inertOutside(b);
    expect([$("root").inert, $("pa").inert, $("pb").inert]).toEqual([true, true, false]);
    return { $, undoA, undoB };
  }

  test("the first closes first: the page stays inert while the second is open", () => {
    const { $, undoA, undoB } = nested();
    undoA();
    expect($("root").inert).toBe(true);
    undoB();
    expect([$("root").inert, $("pa").inert, $("already").inert]).toEqual([false, false, true]);
  });

  test("the second closes first: back to the first alone, then to the page", () => {
    const { $, undoA, undoB } = nested();
    undoB();
    expect([$("root").inert, $("pa").inert]).toEqual([true, false]);
    undoA();
    expect([$("root").inert, $("already").inert]).toEqual([false, true]);
  });
});

test("inertOutsideWith sets a caller's own ref as well, and unsets both", () => {
  document.body.innerHTML = `<div id="root"></div><div id="p"><div id="pop"></div></div>`;
  const pop = document.getElementById("pop") as HTMLElement;
  const ref: { current: HTMLElement | null } = { current: null };
  const cleanup = inertOutsideWith(ref)(pop);
  expect(ref.current).toBe(pop);
  expect((document.getElementById("root") as HTMLElement).inert).toBe(true);
  cleanup?.();
  expect(ref.current).toBeNull();
  expect((document.getElementById("root") as HTMLElement).inert).toBe(false);
});

test("the page is inert, a guard sends focus round, and closing undoes only what it did", () => {
  document.body.innerHTML = `
    <div id="root"><button id="behind">Behind</button></div>
    <div id="already" inert></div>
    <div id="portal">
      <span id="g1" tabindex="0"></span>
      <div id="popup" role="dialog"><button id="a">A</button><button id="b">B</button></div>
      <span id="g2" tabindex="0"></span>
    </div>`;
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const undo = inertOutside($("popup"));
  expect($("root").inert).toBe(true);
  expect($("portal").inert).toBe(false);
  $("g2").focus();
  expect(document.activeElement).toBe($("a"));
  $("g1").focus();
  expect(document.activeElement).toBe($("b"));
  // Closing starts: the page comes back before the popup goes.
  $("popup").setAttribute("data-closed", "");
  return new Promise<void>((resolve) =>
    setTimeout(() => {
      expect($("root").inert).toBe(false);
      // It was inert before; it is not this module's to wake.
      expect($("already").inert).toBe(true);
      // The guard is just a guard again.
      $("g2").focus();
      expect(document.activeElement).toBe($("g2"));
      undo();
      resolve();
    }, 0),
  );
});
