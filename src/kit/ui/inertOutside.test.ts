// `inertOutside` on its own, over plain DOM: no Base UI, so its guards do
// nothing of their own and what holds is this module's (in a browser, Base UI
// 1.6.0's guards let focus out: `ui.test.tsx` covers the kit's modals, and the
// real-browser check is in the item doc).
import "../lib/registerDom.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { installDom, removeDom } from "../lib/testDom.ts";
import { inertOutside } from "./inertOutside.ts";

beforeAll(installDom);
afterAll(removeDom);

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
