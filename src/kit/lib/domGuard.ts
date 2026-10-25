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
// 3. Give Base UI a DOM while it loads, whoever loads it. A file with no DOM
//    that imports a component module (mind-mapper's `GraphCanvas.test.ts` does,
//    for its layout functions) loads Base UI with none, and Base UI keeps what
//    it decided then for the rest of the process: its layout effects become
//    no-ops, and no later component test's popup opens. In a serial run that was
//    every component test after it (CI's red on Linux, whose filesystem order
//    put that file first; item `ci-red-on-linux`). So an import of `@base-ui/`
//    registers the DOM when it is absent, loading `registerDom.ts` if no file
//    has yet. Not a claim either: point 2 removes it before that file's next
//    test, so its own tests still run with no DOM.
//
// It never imports `registerDom.ts` up front (that would register a DOM in
// every run); it reads the handle that module leaves on a global symbol. Until
// a component test or a Base UI import has loaded there is no handle, and the
// first import of `registerDom.ts` registers the DOM itself.

import { beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { plugin } from "bun";

const REGISTER_DOM = join(import.meta.dir, "registerDom.ts");

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
    // A load hook, not a resolve hook: Bun runs this preload's resolve hooks
    // for the relative specifiers above but not for a package's bare one
    // (measured on Bun 1.4.0). A load hook must hand back the source, so it
    // reads the file as Bun would have. It runs before any module of the graph
    // evaluates, so Base UI finds the DOM in place.
    build.onLoad({ filter: /[\\/]node_modules[\\/]@base-ui[\\/].*\.m?js$/ }, (args) => {
      const h = handle();
      // Evaluating `registerDom.ts` registers the DOM; once it has, the handle
      // registers it again whenever a file removed it.
      if (h) h.register();
      else require(REGISTER_DOM);
      return { contents: readFileSync(args.path, "utf8"), loader: "js" };
    });
  },
});

beforeEach(async () => {
  const h = handle();
  if (h?.stale()) await h.remove();
});
