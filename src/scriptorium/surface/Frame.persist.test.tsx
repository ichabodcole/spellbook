// What a viewer chose survives closing a session and opening another, against
// REAL flagged daemons (`kitDaemon`, in this process, under one scratch
// SCRIPTORIUM_HOME): the first session's page chooses a tab, the theme, a
// collapsed conversation with its float closed, raw and line numbers; the
// session ends; a second session (a new daemon, a new port, so a new origin with
// an empty localStorage) opens with every one of them, read from the daemon's
// prefs (`$SCRIPTORIUM_HOME/prefs.json`).

import "../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Daemon } from "../../kit/context/daemonClient";
import { useDaemon } from "../../kit/context/useDaemon";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../../kit/lib/testDom";
import { type LaidOut, laidOut } from "../../kit/lib/testLayout";
import type { WorkspaceDaemon } from "../../kit/workspace/server";
import { tempRoot } from "../../kit/workspace/testing";
import { kitDaemon } from "../backend/kit/server";
import { Frame } from "./Frame";
import { keptPrefs } from "./testPrefs";

const root = tempRoot("scriptorium-frame-persist");
const home = join(root, "home");
const doc = join(root, "docs", "kept.md");
const savedHome = process.env.SCRIPTORIUM_HOME;
let daemon: WorkspaceDaemon | null = null;
let client: Daemon | null = null;
let layout: LaidOut | null = null;

beforeAll(() => {
  installDom();
  layout = laidOut(1400);
  // CodeMirror measures text with ranges and rects, which happy-dom does not lay out.
  const proto = window.Range.prototype as unknown as Record<string, unknown>;
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  proto.getClientRects = () => [];
  proto.getBoundingClientRect = () => ({ ...rect, toJSON() {} });
  const el = window.Element.prototype as unknown as Record<string, unknown>;
  el.getClientRects = el.getClientRects ?? (() => []);
  (document as unknown as Record<string, unknown>).elementFromPoint ??= () => null;
  process.env.SCRIPTORIUM_HOME = home;
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(doc, "# Kept\n\nOne.\nTwo.\n");
});
afterEach(cleanup);
afterAll(async () => {
  layout?.undo();
  await daemon?.stop().catch(() => {});
  await removeDom();
  if (savedHome === undefined) delete process.env.SCRIPTORIUM_HOME;
  else process.env.SCRIPTORIUM_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** A session: a daemon of its own, on a port of its own. */
async function startSession() {
  daemon = kitDaemon({
    tmp: join(root, "tmp"),
    drainGraceMs: 10,
    trash: async () => {
      throw new Error("no Trash in this test");
    },
  });
  await daemon.start();
  return daemon;
}

function Host({ url }: { url: string }) {
  const d = useDaemon({
    url: `${url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  return (
    <div style={{ width: 1400, height: 800 }}>
      <Frame daemon={d} />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel);
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const tab = (label: string) =>
  [...document.querySelectorAll('[data-pane="chat"] [role="tab"]')].find(
    (b) => b.textContent === label,
  ) ?? null;
const chatHidden = () => (q('[data-pane="chat"]') as HTMLElement | null)?.hidden ?? null;
const float = () => q('[data-slot="floating-composer"]');

async function openOn(url: string) {
  const m = await mount(<Host url={url} />);
  await waitFor(() => client?.connection === "open" && !!q('[data-pane="chat"]'), "the shell");
  await settle(() => {
    client?.send({ op: "context.add", path: doc });
  });
  await waitFor(() => (client?.state?.context.length ?? 0) > 0, "the document listed");
  await settle(() => {
    client?.send({ op: "open", path: doc });
  });
  await waitFor(() => !!q('button[aria-label="Rendered"]'), "the document on screen");
  return m;
}

describe("closing a session and opening another", () => {
  test("layout, open columns, the float, the tab, the theme, the view mode and line numbers survive", async () => {
    const first = await startSession();
    document.documentElement.dataset.theme = "dark";
    const m = await openOn(first.url);
    // First use opens rendered; the human goes to raw and turns line numbers on.
    expect(q('button[aria-label="Rendered"]')?.getAttribute("aria-pressed")).toBe("true");
    await click(q('button[aria-label="Raw text"]'));
    await waitFor(() => !!q('[data-slot="line-numbers-toggle"]'), "the raw view");
    await click(q('[data-slot="line-numbers-toggle"]'));
    await click(tab("Tasks"));
    await click(q('[aria-label="Switch to the light theme"]'));
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => chatHidden() === true && float() !== null, "the chat shut, the float up");
    await click(q('[data-slot="floating-composer"] [data-action="float-close"]'));
    await waitFor(() => float() === null, "the float closed");
    await waitFor(() => {
      const p = keptPrefs(home);
      return (
        p["doc:view"] === "raw" &&
        p["doc:line-numbers"] === "on" &&
        p.tab === "tasks" &&
        p.theme === "light" &&
        p["panes:float"] === "closed" &&
        (JSON.parse(p["panes:panes:context:centre:chat"] ?? "{}").chat ?? 100) < 10
      );
    }, "every choice in the prefs file");
    await m.unmount();
    await first.stop();

    // A new session: a new port, so a new origin, which keeps nothing.
    localStorage.clear();
    document.documentElement.dataset.theme = "dark";
    const second = await startSession();
    expect(second.url).not.toBe(first.url);
    const again = await openOn(second.url);
    // The layout and the open columns: the conversation is still a rail.
    expect(chatHidden()).toBe(true);
    expect(q('[aria-label="Reopen the conversation column"]')).not.toBeNull();
    expect((q('[data-pane="context"]') as HTMLElement | null)?.hidden).toBe(false);
    // The float: still closed, its icon on the rail.
    expect(float()).toBeNull();
    expect(q('[data-column-control="chat-float-show"]')).not.toBeNull();
    // The tab.
    expect(tab("Tasks")?.getAttribute("aria-selected")).toBe("true");
    // The theme, though the page painted dark.
    await waitFor(() => document.documentElement.dataset.theme === "light", "the light theme");
    // The view mode and line numbers.
    expect(q('button[aria-label="Raw text"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-slot="line-numbers-toggle"]')?.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => q(".cm-lineNumbers") !== null, "the gutter");
    await again.unmount();
  });
});
