// An earlier DOM test file: it registers the DOM and removes it again, as every
// component test file does. Run only by `registerDom.order.test.ts`, before
// `2-shortcut.tsx`, so that one loads its modules with no DOM registered.

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
