// An earlier DOM test file that never loads Base UI: it registers the DOM and
// removes it again, as every component test file does. Run only by
// `registerDom.reregister.test.ts`, before `2-popup.tsx`, so that file is the
// first to load Base UI, after this one has removed the DOM.

import "../../registerDom.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { installDom, removeDom } from "../../registerDom.ts";

beforeAll(installDom);
afterAll(async () => {
  await removeDom();
});

test("a DOM is registered", () => {
  expect(typeof document).toBe("object");
});
