// How long a toast stays up. A toast that offers an act (the new-version
// toast's Activate / Show diff) needs longer than "that happened, carry on".
import { expect, test } from "bun:test";
import { toastMs } from "./Toasts";

test("a plain announcement keeps its six seconds", () => {
  expect(toastMs({})).toBe(6000);
  expect(toastMs({ actions: [] })).toBe(6000);
});

test("a toast with buttons stays longer than a plain one", () => {
  expect(toastMs({ actions: [{ label: "Activate", onAct: () => {} }] })).toBeGreaterThan(
    toastMs({}),
  );
});
