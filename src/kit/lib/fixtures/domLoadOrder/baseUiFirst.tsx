// Base UI loaded first by a file with no DOM, the way mind-mapper's
// `GraphCanvas.test.ts` did: through a context menu, and nothing else. Base UI
// decides once, when its modules load, whether there is a DOM, so with no DOM at
// that moment every later component test in the process lost its popups. That
// was CI's red on Linux, where such a file ran first. Run only by
// `registerDom.loadOrder.test.ts`.
//
// One file, its tests in order, so the order holds on every filesystem: the
// first test loads Base UI's context menu with no DOM of its own, the second
// checks the backend half still has no DOM, and the third is the later
// component test, opening a dialog: an entry the first never loaded, over the
// modules it shares with the context menu.

import { expect, test } from "bun:test";

test("a file with no DOM loads Base UI's context menu", async () => {
  expect(typeof document).toBe("undefined");
  await import("@base-ui/react/context-menu");
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
