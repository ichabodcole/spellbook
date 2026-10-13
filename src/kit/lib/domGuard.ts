// The test preload (root bunfig.toml) that keeps a component test's DOM out of
// every other file in the run.
//
// `registerDom.ts` registers happy-dom the moment it is imported, because Base
// UI reads the DOM once, when its own module loads. A test file then claims the
// DOM in `beforeAll(installDom)` and gives it back in `afterAll(removeDom)`. A
// file that throws while it loads reaches neither hook, and its DOM would stay
// registered for every later file in the process: the backend tests would see
// a `window` and happy-dom's network globals. Registration cannot move later
// without breaking the reason it happens early, and a file's own hooks never
// run when it fails to load, so the cleanup has to live in a hook every file
// gets. This is that hook: before each test, a DOM nobody claimed is removed.
//
// It never imports `registerDom.ts` (that would register a DOM in every run);
// it reads the handle that module leaves on a global symbol. When no component
// test has loaded, there is no handle and this does nothing.

import { beforeEach } from "bun:test";

type DomGuardHandle = { stale: () => boolean; remove: () => Promise<void> };

beforeEach(async () => {
  const handle = (globalThis as Record<symbol, unknown>)[Symbol.for("spellbook.kit.registerDom")] as
    | DomGuardHandle
    | undefined;
  if (handle?.stale()) await handle.remove();
});
