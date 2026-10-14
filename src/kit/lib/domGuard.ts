// The test preload (root bunfig.toml) that gives every component test file a
// DOM while its modules load, and keeps that DOM out of every other file.
//
// `registerDom.ts` registers happy-dom the moment it is imported, because Base
// UI reads the DOM once, when its own module loads. A test file then claims the
// DOM in `beforeAll(installDom)` and gives it back in `afterAll(removeDom)`.
//
// Two things a test file's own code cannot do, so they live here:
//
// 1. Register again for a later file. A module evaluates once per process, so
//    importing `registerDom.ts` registers only in the first file that loads it.
//    A later DOM test file, after an earlier one removed the DOM, would load
//    its modules (Base UI's among them) with no DOM, and its popups would never
//    portal. A resolve hook fires for every file that imports `registerDom.ts`
//    or `testDom.ts`, before any module of that file evaluates, and registers
//    the DOM when it is absent. Like the import-time registration, this is not
//    a claim: the file claims the DOM in `beforeAll(installDom)`.
// 2. Clean up after a file that throws while it loads. It reaches neither hook,
//    and its DOM would stay registered for every later file in the process:
//    the backend tests would see a `window` and happy-dom's network globals.
//    Before each test, a DOM nobody claimed is removed.
//
// It never imports `registerDom.ts` (that would register a DOM in every run);
// it reads the handle that module leaves on a global symbol. Until a component
// test has loaded there is no handle, and this does nothing: the first import
// of `registerDom.ts` registers the DOM itself.

import { beforeEach } from "bun:test";
import { plugin } from "bun";

type DomGuardHandle = {
  stale: () => boolean;
  remove: () => Promise<void>;
  /** Register the DOM if it is absent, without claiming it. */
  register: () => void;
};

const handle = () =>
  (globalThis as Record<symbol, unknown>)[Symbol.for("spellbook.kit.registerDom")] as
    | DomGuardHandle
    | undefined;

plugin({
  name: "spellbook-kit-register-dom",
  setup(build) {
    build.onResolve({ filter: /(^|[\\/])(registerDom|testDom)\.ts$/ }, () => {
      handle()?.register();
      return undefined;
    });
  },
});

beforeEach(async () => {
  const h = handle();
  if (h?.stale()) await h.remove();
});
