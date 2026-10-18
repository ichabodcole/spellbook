// The fence around a document view: a view that throws while drawing costs only
// that view, "Try again" draws it again once the fault has cleared, and a new
// `resetKey` (another document, another view) forgets the failure.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { cleanup, installDom, mount, removeDom, settle } from "../lib/testDom.ts";
import { ViewBoundary } from "./ViewBoundary.tsx";

let quiet: typeof console.error;
beforeAll(() => {
  installDom();
  // React reports a caught render error on the console; that is the point here.
  quiet = console.error;
  console.error = () => {};
});
afterAll(async () => {
  console.error = quiet;
  await removeDom();
});
afterEach(async () => {
  await cleanup();
});

/** A view that throws while `broken.now` holds. */
const broken = { now: true };
function Flaky() {
  if (broken.now) throw new Error("the ranges overflowed");
  return <p data-slot="drawn">drawn</p>;
}

const failed = () => document.querySelector('[data-slot="view-failed"]');
const drawn = () => document.querySelector('[data-slot="drawn"]');
const tryAgain = () =>
  [...document.querySelectorAll("button")].find((b) => b.textContent === "Try again") ?? null;

test("a view that throws is fenced: it says so, and the page around it stays", async () => {
  broken.now = true;
  await mount(
    <div>
      <span data-slot="around">the chat</span>
      <ViewBoundary resetKey="a">
        <Flaky />
      </ViewBoundary>
    </div>,
  );
  expect(failed()?.textContent).toContain("the ranges overflowed");
  expect(document.querySelector('[data-slot="around"]')?.textContent).toBe("the chat");
});

test("Try again draws the view once the fault has cleared, and not before", async () => {
  broken.now = true;
  await mount(
    <ViewBoundary resetKey="a">
      <Flaky />
    </ViewBoundary>,
  );
  await settle(() => tryAgain()?.click());
  expect(failed()).not.toBeNull();
  broken.now = false;
  await settle(() => tryAgain()?.click());
  expect(failed()).toBeNull();
  expect(drawn()).not.toBeNull();
});

test("a new resetKey forgets the failure", async () => {
  broken.now = true;
  const m = await mount(
    <ViewBoundary resetKey="story:rendered">
      <Flaky />
    </ViewBoundary>,
  );
  expect(failed()).not.toBeNull();
  broken.now = false;
  // The same key keeps the failure on screen...
  await m.render(
    <ViewBoundary resetKey="story:rendered">
      <Flaky />
    </ViewBoundary>,
  );
  expect(failed()).not.toBeNull();
  // ...another view clears it.
  await m.render(
    <ViewBoundary resetKey="story:raw">
      <Flaky />
    </ViewBoundary>,
  );
  expect(failed()).toBeNull();
  expect(drawn()).not.toBeNull();
});
