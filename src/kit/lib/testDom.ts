// Helpers for component tests under `bun test`. Importing this registers a DOM
// (see `registerDom.ts`, which must be imported before anything that loads
// React or Base UI); a test file still pairs it with `afterAll(removeDom)`.

import "./registerDom.ts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { lastLook, probed } from "./afterIo.ts";

export { installDom, nativeGlobal, removeDom } from "./registerDom.ts";

export type Mounted = {
  container: HTMLElement;
  /** Re-render with a new tree. */
  render: (node: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
};

const live = new Set<Mounted>();

/** Unmount whatever a test left mounted (a failed test never reaches its own unmount). Use in `afterEach`. */
export async function cleanup(): Promise<void> {
  for (const m of [...live]) await m.unmount().catch(() => {});
  document.body.innerHTML = "";
}

/** Mount a tree into a fresh container attached to the document. */
export async function mount(node: ReactNode): Promise<Mounted> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const render = async (n: ReactNode) => {
    await inAct(async () => {
      root.render(n);
    });
  };
  await render(node);
  const mounted: Mounted = {
    container,
    render,
    unmount: async () => {
      if (!live.delete(mounted)) return;
      await inAct(async () => root.unmount());
      container.remove();
    },
  };
  live.add(mounted);
  return mounted;
}

/**
 * Type into a controlled input or textarea the way a keyboard does. React reads
 * the value on `input` where the DOM advertises it, and on `keyup` through a
 * polyfill where it does not (happy-dom handles the event but does not say so),
 * so both are sent: whichever path React took sees the change once.
 */
export async function typeInto(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const proto =
    el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement : window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
  if (!setter) throw new Error("no value setter");
  await settle(() => el.focus());
  await settle(() => {
    // The prototype's setter, not the element's: React wraps the element's own to
    // notice a change, and calling the wrapped one would hide this one from it.
    setter.call(el, value);
    el.dispatchEvent(new window.Event("input", { bubbles: true }));
    el.dispatchEvent(new window.KeyboardEvent("keyup", { key: "Unidentified", bubbles: true }));
  });
}

type ActGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

/**
 * Run `fn` inside React's act. The act environment is on only while it runs:
 * the daemon updates state on its own schedule, between a test's awaits, and
 * React warns about every update outside act while the environment is on.
 */
async function inAct(fn: () => void | Promise<void>): Promise<void> {
  const g = globalThis as ActGlobal;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => {
      await fn();
    });
  } finally {
    g.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

/** Run `fn` inside React's act, settling effects and microtasks. */
export async function settle(fn: () => void | Promise<void> = () => {}): Promise<void> {
  await inAct(fn);
}

/**
 * Wait until `check` holds, or fail with `what` after `ms`. Past the deadline it
 * looks once more after pending I/O has run, so an event that arrived while the
 * process was stalled still counts.
 */
export async function waitFor(check: () => boolean, what: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (probed(check())) return;
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  if (await lastLook(check)) return;
  throw new Error(`timed out waiting for ${what}`);
}
