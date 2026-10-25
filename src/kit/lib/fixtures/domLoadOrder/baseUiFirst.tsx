// Base UI loaded first by a file with no DOM, as a backend-style test file that
// imports a component module does (mind-mapper's `GraphCanvas.test.ts` did). Base
// UI decides once, when its modules load, whether there is a DOM, so with no DOM
// at that moment every later component test in the process lost its popups. That
// was CI's red on Linux, where such a file ran first. Run only by
// `registerDom.loadOrder.test.ts`.
//
// One file, its tests in order, so the order holds on every filesystem: the
// first test loads Base UI with no DOM of its own, the second checks the backend
// half still has no DOM, and the third is the later component test.

import { expect, test } from "bun:test";

test("a file with no DOM loads Base UI", async () => {
  expect(typeof document).toBe("undefined");
  await import("../../../ui/index.ts");
});

test("its next test still sees no DOM", () => {
  expect(typeof document).toBe("undefined");
});

test("a Base UI dialog opens in a component test after it", async () => {
  const { installDom, mount, removeDom, waitFor } = await import("../../testDom.ts");
  const { Dialog, DialogContent, DialogTitle } = await import("../../../ui/index.ts");
  installDom();
  try {
    const m = await mount(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Rename</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    const title = () => document.body.querySelector('[data-slot="dialog-title"]');
    await waitFor(() => title() !== null, "the dialog title");
    expect(title()?.textContent).toBe("Rename");
    await m.unmount();
  } finally {
    await removeDom();
  }
});
