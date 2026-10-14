// A later DOM test file, and the first in its process to load Base UI. The
// earlier file has removed the DOM, and `registerDom.ts` is already evaluated,
// so its import alone registers nothing: Base UI must still load under a DOM,
// or its popup never portals. Run only by `registerDom.reregister.test.ts`.

import "../../registerDom.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Dialog, DialogContent, DialogTitle } from "../../../ui/index.ts";
import { installDom, mount, removeDom, waitFor } from "../../testDom.ts";

beforeAll(installDom);
afterAll(async () => {
  await removeDom();
});

test("a Base UI dialog opens in a file that loaded after another removed the DOM", async () => {
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
});
