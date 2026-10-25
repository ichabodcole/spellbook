// A file with no DOM that imports Base UI at its top, as a backend-style test of
// a component module does. Where does the preload's DOM show? It reports what
// each phase saw, on one line, for `registerDom.loadOrder.test.ts` to pin: the
// module body, the `describe` body and `beforeAll` see the DOM (the window the
// preload cannot close, since its own `beforeAll` runs once per run); the test
// and `afterAll` do not.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ContextMenu } from "@base-ui/react/context-menu";

const seen: Record<string, string> = { load: typeof document };
describe("a file with no DOM", () => {
  seen.describe = typeof document;
  beforeAll(() => {
    seen.beforeAll = typeof document;
  });
  test("its test", () => {
    expect(ContextMenu.Root).toBeDefined();
    seen.test = typeof document;
  });
  afterAll(() => {
    seen.afterAll = typeof document;
    console.log(`SEEN ${JSON.stringify(seen)}`);
  });
});
