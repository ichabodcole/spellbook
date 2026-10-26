// The storage slot over a REAL workspace daemon: an app whose port changes per
// session passes its own store, backed here by a fake of a daemon that keeps
// prefs (asynchronous, keyed and validated as a prefs file on disk would be).
// What the viewer chose survives an unmount and a remount, and a new origin (a
// fresh localStorage), because none of it is kept in the browser.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useDaemon } from "../context/useDaemon.ts";
import { useWorkspace, type Workspace } from "../context/workspace.ts";
import { DocumentPane } from "../document/DocumentPane.tsx";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../lib/testDom.ts";
import { type LaidOut, laidOut } from "../lib/testLayout.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import type { ShellStorage } from "./storage.ts";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(() => {
  installDom();
  // CodeMirror (the raw view) measures text with ranges and rects, which happy-dom
  // does not lay out.
  const proto = window.Range.prototype as unknown as Record<string, unknown>;
  const rect = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON() {},
  };
  proto.getClientRects = () => [];
  proto.getBoundingClientRect = () => rect;
  const el = window.Element.prototype as unknown as Record<string, unknown>;
  el.getClientRects = el.getClientRects ?? (() => []);
  (document as unknown as Record<string, unknown>).elementFromPoint ??= () => null;
});
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
let stub: LaidOut | null = null;

beforeEach(async () => {
  root = tempRoot("shell-storage");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  localStorage.clear();
  document.documentElement.dataset.theme = "dark";
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs });
  await daemon.start();
  stub = laidOut(1200);
});
afterEach(async () => {
  stub?.undo();
  stub = null;
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

/**
 * A fake of a daemon that keeps prefs: a file of string pairs that outlives
 * every session, a key rule and a value cap, and nothing synchronous. A set
 * lands after a delay and is broadcast as a whole snapshot, and a connecting
 * page hears the first snapshot after a delay too. `writes` is what the page's
 * adapter asked to set, in order; a set from elsewhere (another session) is not
 * in it.
 */
class FakePrefs {
  readonly file = new Map<string, string>();
  readonly refused: string[] = [];
  readonly writes: [string, string][] = [];
  private listeners = new Set<(snap: Record<string, string>) => void>();
  private snapshot = () => Object.fromEntries(this.file);
  connect(listener: (snap: Record<string, string>) => void) {
    this.listeners.add(listener);
    const t = setTimeout(() => listener(this.snapshot()), 15);
    return () => {
      clearTimeout(t);
      this.listeners.delete(listener);
    };
  }
  set(key: string, value: string) {
    setTimeout(() => {
      if (!/^[a-z][a-z0-9:._-]{0,63}$/.test(key) || value.length > 4096) {
        this.refused.push(key);
        return;
      }
      if (this.file.get(key) === value) return;
      this.file.set(key, value);
      const snap = this.snapshot();
      for (const l of this.listeners) l(snap);
    }, 5);
  }
  /** The keys the page's adapter wrote, each once. */
  written = () => new Set(this.writes.map(([k]) => k));
}

/** An app's own key mapping: the layout library's long prefix, shortened to fit the key rule. */
const prefKey = (key: string) => key.replace(/^react-resizable-panels:/, "panes:").slice(0, 64);

let w: Workspace | null = null;
const ws = () => w as Workspace;
function Centre() {
  w = useWorkspace();
  return <p data-testid="centre">the centre</p>;
}
function DocCentre() {
  w = useWorkspace();
  return <DocumentPane lineNumbers viewModeKey="doc:view" lineNumbersKey="doc:line-numbers" />;
}

/** An app whose daemon keeps prefs: the shell mounts once the first snapshot is in. */
function PrefsHost({ prefs, centre }: { prefs: FakePrefs; centre?: ReactNode }) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  const [snap, setSnap] = useState<Record<string, string> | null>(null);
  useEffect(() => prefs.connect(setSnap), [prefs]);
  const snapRef = useRef(snap);
  snapRef.current = snap;
  const storage = useMemo<ShellStorage>(
    () => ({
      getItem: (key) => snapRef.current?.[prefKey(key)] ?? null,
      setItem: (key, value) => {
        prefs.writes.push([prefKey(key), value]);
        prefs.set(prefKey(key), value);
      },
    }),
    [prefs],
  );
  if (!snap) return <div data-testid="hydrating" />;
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={d} centre={centre ?? <Centre />} storage={storage} />
    </div>
  );
}

const LAYOUT_PREF = "panes:panes:context:centre:chat";
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
const float = () => q('[data-slot="floating-composer"]');
const showIcon = () => q('[data-column-control="chat-float-show"]');
const chatRail = () => q('[aria-label="Reopen the conversation column"]');

async function mountShell(prefs: FakePrefs, centre?: ReactNode) {
  w = null;
  const m = await mount(<PrefsHost prefs={prefs} centre={centre} />);
  await waitFor(() => w !== null && !!q('[data-pane="chat"]'), "the shell");
  return m;
}
/** A new origin: the browser keeps nothing, and the pre-paint script found no theme. */
function newOrigin() {
  localStorage.clear();
  document.documentElement.dataset.theme = "dark";
}
/** Everything in localStorage. With an adapter: only the theme's pre-paint copy. */
const browserKeys = () => Object.keys(localStorage).sort();

describe("the storage slot", () => {
  test("layout, reopen widths, float, tab and theme survive a remount on a new origin", async () => {
    const prefs = new FakePrefs();
    // A width a viewer chose under an earlier build, in the format it kept.
    prefs.file.set("panes:open", JSON.stringify({ chat: 33 }));

    const first = await mountShell(prefs);
    await click(tab("Tasks"));
    await click(q('[aria-label="Switch to the light theme"]'));
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => ws().columns.collapsed.chat, "the chat shut");
    await waitFor(() => float() !== null, "the float");
    await click(q('[data-slot="floating-composer"] [data-action="float-close"]'));
    await waitFor(() => float() === null && showIcon() !== null, "the float closed");
    // Every write is in the prefs, in the kept formats, and none was refused.
    await waitFor(
      () =>
        prefs.file.get("tab") === "tasks" &&
        prefs.file.get("theme") === "light" &&
        prefs.file.get("panes:float") === "closed" &&
        (JSON.parse(prefs.file.get(LAYOUT_PREF) ?? "{}").chat ?? 100) < 10,
      "the prefs written",
    );
    expect(prefs.refused).toEqual([]);
    expect(JSON.parse(prefs.file.get("panes:open") ?? "")).toEqual({ chat: 33 });
    // The browser keeps the theme's copy for the pre-paint script, and nothing else.
    expect(browserKeys()).toEqual(["spellbook:theme"]);
    expect(localStorage.getItem("spellbook:theme")).toBe("light");
    await first.unmount();

    newOrigin();
    prefs.writes.length = 0;
    const again = await mountShell(prefs);
    // The layout: the chat column comes back a rail.
    expect(ws().columns.collapsed.chat).toBe(true);
    expect(chatRail()).not.toBeNull();
    // The float: still closed, its icon on the rail.
    expect(float()).toBeNull();
    expect(showIcon()).not.toBeNull();
    // The tab.
    expect(tab("Tasks")?.getAttribute("aria-selected")).toBe("true");
    // The theme, though the page painted dark, and the browser copy follows.
    await waitFor(() => document.documentElement.dataset.theme === "light", "the light theme");
    expect(q('[data-slot="workspace-shell"]')?.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("spellbook:theme")).toBe("light");
    // The reopen width, from the kept value.
    await click(chatRail());
    await waitFor(() => !ws().columns.collapsed.chat, "the chat open");
    // A drag cannot be made in a DOM without layout (`WorkspaceShell.test.tsx`), so
    // the width read is the one an earlier build wrote, seeded above.
    const share = () =>
      Number(
        (q('[data-pane="chat"]')?.closest("[data-panel]") as HTMLElement | null)?.style.flexGrow,
      );
    await waitFor(() => Math.abs(share() - 33) < 0.5, "the chat reopened at 33%");
    // A closed float lasts until the column is next opened, and that is kept too.
    await waitFor(() => prefs.file.get("panes:float") === "open", "the float reset");
    expect(browserKeys()).toEqual(["spellbook:theme"]);
    // Following the kept theme wrote nothing back.
    expect(prefs.written().has("theme")).toBe(false);
    await again.unmount();
  });

  test("a theme that arrives or changes after mount is followed, and never written back", async () => {
    const prefs = new FakePrefs();
    const m = await mountShell(prefs);
    expect(document.documentElement.dataset.theme).toBe("dark");
    // Another session's choice, in this session's next snapshot.
    prefs.set("theme", "light");
    // The page's root and the shell's own switch both follow.
    await waitFor(
      () =>
        document.documentElement.dataset.theme === "light" &&
        !!q('[aria-label="Switch to the dark theme"]'),
      "the light theme",
    );
    // Nonsense in the store is not a theme.
    prefs.set("theme", "purple");
    await settle(() => new Promise((r) => setTimeout(r, 30)));
    expect(document.documentElement.dataset.theme).toBe("light");
    // Only a human's toggle writes the theme.
    expect(prefs.written().has("theme")).toBe(false);
    await click(q('[aria-label="Switch to the dark theme"]'));
    expect(prefs.writes.filter(([k]) => k === "theme")).toEqual([["theme", "dark"]]);
    await m.unmount();
  });

  test("a new adapter is picked up", async () => {
    const before = new FakePrefs();
    const after = new FakePrefs();
    const m = await mountShell(before);
    await m.render(<PrefsHost prefs={after} />);
    await settle(() => new Promise((r) => setTimeout(r, 30)));
    await click(tab("Tasks"));
    await waitFor(() => after.file.get("tab") === "tasks", "the tab in the new store");
    expect(before.file.has("tab")).toBe(false);
    await m.unmount();
  });

  test("the document pane keeps its view mode and line numbers in the same store", async () => {
    const prefs = new FakePrefs();
    const solo = join(docs, "solo.md");
    const openSolo = async () => {
      await settle(() => {
        ws().daemon.send({ op: "context.add", path: solo });
      });
      await waitFor(() => ws().state.context.length > 0, "the document in the context");
      await settle(() => {
        ws().daemon.send({ op: "open", path: solo });
      });
      await waitFor(() => !!ws().openDoc && !!q('button[aria-label="Rendered"]'), "the document");
    };
    const first = await mountShell(prefs, <DocCentre />);
    await openSolo();
    await waitFor(() => !!q('[data-slot="line-numbers-toggle"]'), "the line-number toggle");
    await click(q('[data-slot="line-numbers-toggle"]'));
    await click(q('button[aria-label="Rendered"]'));
    // Under the app's own keys, in the values a prefs file already holds.
    await waitFor(
      () =>
        prefs.file.get("doc:view") === "rendered" && prefs.file.get("doc:line-numbers") === "on",
      "the pane's prefs written",
    );
    expect(browserKeys()).toEqual([]);
    await first.unmount();

    newOrigin();
    const again = await mountShell(prefs, <DocCentre />);
    await openSolo();
    expect(q('button[aria-label="Rendered"]')?.getAttribute("aria-pressed")).toBe("true");
    await click(q('button[aria-label="Raw text"]'));
    await waitFor(() => !!q('[data-slot="line-numbers-toggle"]'), "the raw view");
    expect(q('[data-slot="line-numbers-toggle"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(browserKeys()).toEqual([]);
    await again.unmount();
  });
});
