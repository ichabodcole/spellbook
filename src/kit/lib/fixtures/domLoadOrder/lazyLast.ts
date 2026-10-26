// A file with no DOM that loads Base UI inside its last test. The preload's DOM
// is there for the rest of that test; once the test ends it must be gone, or
// this file's `afterAll` and the next file's module load would see it. Reports
// on one line for `registerDom.loadOrder.test.ts`.

import { afterAll, test } from "bun:test";

const seen: Record<string, string> = {};
test("loads Base UI lazily", async () => {
  seen.before = typeof document;
  await import("@base-ui/react/dialog");
  seen.after = typeof document;
});
afterAll(() => {
  seen.afterAll = typeof document;
  console.log(`SEEN ${JSON.stringify(seen)}`);
});
