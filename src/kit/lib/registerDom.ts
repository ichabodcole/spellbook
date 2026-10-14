// Registers a DOM the moment it is imported. It must be the FIRST import of a
// component test file: a library such as Base UI decides once, when its module
// loads, whether it is running in a browser, so a DOM registered in `beforeAll`
// (which runs after every import) arrives too late and popups never portal.
//
// A module evaluates once per process, so this import registers only in the
// first file that loads it. For every later file, `domGuard.ts` (the repo's
// test preload) registers the DOM again when the file imports this module or
// `testDom.ts`, before any of its modules load. A test file pairs the import
// with `beforeAll(installDom)`, which claims the DOM, and `afterAll(removeDom)`.
// A file that throws while it loads never reaches those hooks; the preload
// removes the DOM it left behind before the next test runs. Nothing registers
// a DOM for the whole run:
// the daemon's tests share the process and rely on Bun's own `fetch`,
// `WebSocket`, `Request` and timers, which a DOM replaces. The happy-dom
// registrator does not put every one of them back, so the globals are
// snapshotted before it registers and restored exactly after it leaves.
//
// Tests only; `@happy-dom/global-registrator` is a dev dependency.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

let snapshot: Map<string, PropertyDescriptor> | null = null;

function takeSnapshot(): Map<string, PropertyDescriptor> {
  const out = new Map<string, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(globalThis)) {
    if (typeof key !== "string") continue;
    const d = Object.getOwnPropertyDescriptor(globalThis, key);
    if (d) out.set(key, d);
  }
  return out;
}

/** The runtime's own value of a global, as it was before the DOM replaced it. */
export function nativeGlobal<T>(key: string): T {
  const saved = snapshot?.get(key);
  return (
    saved && "value" in saved ? saved.value : (globalThis as Record<string, unknown>)[key]
  ) as T;
}

/**
 * What stays the runtime's own while the DOM is registered: the network and the
 * bytes and timers under it. A test that starts a real daemon in this process
 * needs them native (`Bun.serve` wants a native `Response`, and a happy-dom
 * `fetch` cannot read what it answers), and a component has no use for the DOM's
 * version of any of them.
 */
const KEEP_NATIVE = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "FormData",
  "WebSocket",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "Blob",
  "File",
  "URL",
  "URLSearchParams",
  "AbortController",
  "AbortSignal",
  "TextEncoder",
  "TextDecoder",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "queueMicrotask",
];

/**
 * The DOM's `navigator.platform` is pinned to the runtime's own. A module may
 * read the platform once, when it loads: CodeMirror decides there whether `Mod`
 * is Cmd or Ctrl. A module that first loads with no DOM registered (one a
 * backend file loaded first, say) reads Bun's own navigator ("MacIntel" on a
 * Mac), while a test reads happy-dom's (from its user agent, "X11; Darwin
 * arm64") and presses the other key. One platform for both keeps the order of
 * files from mattering.
 */
function pinPlatform(platform: string | undefined): void {
  if (platform === undefined) return;
  Object.defineProperty(globalThis.navigator, "platform", { value: platform, configurable: true });
}

/**
 * Whether a test file has claimed the registered DOM by calling `installDom`
 * from its own `beforeAll`. The registration this module makes when it is
 * imported is NOT a claim: a file that throws while it loads has registered the
 * DOM and never reaches its hooks, so nothing of its own would remove it. A DOM
 * still unclaimed when a test starts is therefore stale, and `domGuard.ts` (the
 * repo's test preload) removes it before that test runs.
 */
let claimed = false;

/** Register the DOM (idempotent) and claim it for the file that calls this. */
export function installDom(): void {
  register();
  claimed = true;
}

function register(): void {
  if (!GlobalRegistrator.isRegistered) {
    const platform = (globalThis as { navigator?: Navigator }).navigator?.platform;
    snapshot = takeSnapshot();
    GlobalRegistrator.register({ url: "http://localhost:3000/" });
    for (const key of KEEP_NATIVE) {
      const d = snapshot.get(key);
      if (d) Object.defineProperty(globalThis, key, d);
    }
    pinPlatform(platform);
  }
  (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = false;
}

export async function removeDom(): Promise<void> {
  claimed = false;
  (globalThis as ActGlobal).IS_REACT_ACT_ENVIRONMENT = false;
  if (!GlobalRegistrator.isRegistered) return;
  await GlobalRegistrator.unregister();
  if (!snapshot) return;
  for (const key of Reflect.ownKeys(globalThis)) {
    if (typeof key === "string" && !snapshot.has(key)) {
      try {
        delete (globalThis as Record<string, unknown>)[key];
      } catch {
        /* non-configurable: leave it */
      }
    }
  }
  for (const [key, d] of snapshot) {
    const now = Object.getOwnPropertyDescriptor(globalThis, key);
    if (!now || now.value !== d.value || now.get !== d.get) {
      try {
        Object.defineProperty(globalThis, key, d);
      } catch {
        /* non-configurable: leave it */
      }
    }
  }
  snapshot = null;
}

/**
 * What the preload guard reads. It sits on a global symbol so the guard never
 * imports this module, since importing it registers a DOM. `domGuard.ts`
 * spells the same key.
 */
(globalThis as Record<symbol, unknown>)[Symbol.for("spellbook.kit.registerDom")] = {
  stale: () => GlobalRegistrator.isRegistered && !claimed,
  remove: removeDom,
  register,
};

register();
