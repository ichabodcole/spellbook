// The line-number toggle in the document pane's header
// (scriptorium-toggle-line-numbers-in-raw-mode), against a REAL workspace daemon
// (the kit's fixture app), as DocumentPane.test.tsx runs the pane. An app offers
// it with `lineNumbers`; the choice is the human's, remembered as the view mode is;
// it is shown where the raw editor is (raw, split's raw half) and nowhere else.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useMemo, useState } from "react";
import type { Collapsed } from "../context/columns.ts";
import type { Daemon } from "../context/daemonClient.ts";
import { useDaemon } from "../context/useDaemon.ts";
import { type Workspace, WorkspaceContext } from "../context/workspace.ts";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../lib/testDom.ts";
import { createToastStore } from "../ui/toast-store.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { testWorkspace } from "../workspace/fixtures/harness";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { type AppView, DocumentPane, LINE_NUMBERS_LABEL } from "./DocumentPane.tsx";

beforeAll(() => {
  installDom();
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
afterAll(removeDom);

let root: string;
let story: string;
let data: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
let setColumns: ((c: Collapsed) => void) | null = null;

beforeEach(async () => {
  root = tempRoot("document-pane-line-numbers");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  const ws = testWorkspace(root, "ws");
  story = join(ws, "story.md");
  writeFileSync(story, "# Title\n\nFirst line.\n\nSecond line.\n");
  data = join(ws, "data.json");
  writeFileSync(data, '{\n  "a": 1\n}\n');
  localStorage.clear();
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

type PaneOptions = {
  lineNumbers?: boolean;
  lineNumbersKey?: string;
  splitView?: boolean;
  appView?: AppView;
};

function Host({ pane }: { pane?: PaneOptions }) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  const toasts = useMemo(() => createToastStore(), []);
  const [collapsed, setCollapsed] = useState<Collapsed>({ context: false, chat: false });
  setColumns = setCollapsed;
  const state = d.state;
  if (!state) return null;
  const workspace: Workspace = {
    daemon: d,
    state,
    openDoc: state.docs.find((doc) => doc.slug === state.openDoc) ?? null,
    selection: null,
    reportSelection: () => {},
    dropSelection: () => {},
    clearSeq: 0,
    reveal: null,
    requestReveal: () => {},
    revealApplied: () => {},
    toasts,
    announce: () => 0,
    theme: "dark",
    setTheme: () => {},
    focusPane: () => {},
    columns: {
      collapsed,
      collapse: (side) => setCollapsed((c) => ({ ...c, [side]: true })),
      expand: (side) => setCollapsed((c) => ({ ...c, [side]: false })),
    },
    setQuiet: () => {},
  };
  return (
    <WorkspaceContext.Provider value={workspace}>
      <main data-pane="centre" tabIndex={-1} style={{ width: 900, height: 700 }}>
        <DocumentPane {...pane} />
      </main>
    </WorkspaceContext.Provider>
  );
}

const cmd = async (body: Record<string, unknown>) => {
  const res = await fetch(`${daemon.url}/cmd`, { method: "POST", body: JSON.stringify(body) });
  return (await res.json()) as Record<string, unknown>;
};
const q = (sel: string) => document.querySelector(sel);
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const TOGGLE = "[data-slot=line-numbers-toggle]";
const pressed = () => q(TOGGLE)?.getAttribute("aria-pressed") === "true";
const gutters = () => document.querySelectorAll(".cm-lineNumbers").length;
const SPLIT = 'button[aria-label="Raw and rendered side by side"]';

async function openStory(pane?: PaneOptions, path = story) {
  const m = await mount(<Host pane={pane} />);
  await waitFor(
    () => document.body.textContent?.includes("No document open") === true,
    "the empty state",
  );
  await cmd({ op: "context.add", paths: [path] });
  await settle(() => {
    client?.send({ op: "open", path });
  });
  await waitFor(() => (q(".cm-content")?.textContent ?? "").length > 0, "the text in the editor");
  return m;
}

describe("the line-number toggle", () => {
  test("off by default: an app that does not offer it gets no toggle and no gutter", async () => {
    localStorage.setItem("spellbook:line-numbers", "on");
    await openStory();
    expect(q(TOGGLE)).toBeNull();
    expect(gutters()).toBe(0);
  });

  test("offered, it starts off; turned on, the gutter shows and the choice survives a reload", async () => {
    const m = await openStory({ lineNumbers: true });
    expect(q(TOGGLE)?.getAttribute("aria-label")).toBe(LINE_NUMBERS_LABEL);
    expect(pressed()).toBe(false);
    expect(gutters()).toBe(0);

    await click(q(TOGGLE));
    expect(pressed()).toBe(true);
    expect(gutters()).toBe(1);
    expect(localStorage.getItem("spellbook:line-numbers")).toBe("on");

    // A reload: a fresh pane on the same session reads the stored choice.
    await m.unmount();
    await mount(<Host pane={{ lineNumbers: true }} />);
    await waitFor(() => q(".cm-editor") !== null, "the editor after the reload");
    expect(pressed()).toBe(true);
    expect(gutters()).toBe(1);

    await click(q(TOGGLE));
    expect(gutters()).toBe(0);
    expect(localStorage.getItem("spellbook:line-numbers")).toBe("off");
  });

  test("an app's own key holds the choice, as `viewModeKey` holds the mode", async () => {
    await openStory({ lineNumbers: true, lineNumbersKey: "my-spell:line-numbers" });
    await click(q(TOGGLE));
    expect(localStorage.getItem("my-spell:line-numbers")).toBe("on");
    expect(localStorage.getItem("spellbook:line-numbers")).toBeNull();
  });

  test("not in the rendered view, which has no source lines; the choice is kept for raw", async () => {
    localStorage.setItem("spellbook:line-numbers", "on");
    await openStory({ lineNumbers: true });
    expect(gutters()).toBe(1);
    await click(q('button[aria-label="Rendered"]'));
    await waitFor(() => q(".md-prose p") !== null, "the rendered view");
    expect(q(TOGGLE)).toBeNull();
    expect(gutters()).toBe(0);
    await click(q('button[aria-label="Raw text"]'));
    await waitFor(() => q(".cm-editor") !== null, "the editor again");
    expect(pressed()).toBe(true);
    expect(gutters()).toBe(1);
  });

  test("in split only the raw half is numbered, and the rendered half is unchanged", async () => {
    await openStory({ lineNumbers: true, splitView: true });
    await click(q(SPLIT));
    await waitFor(() => q("[data-slot=split-view] .md-prose p") !== null, "the rendered half");
    expect(q(TOGGLE)).not.toBeNull();
    const renderedHalf = () => q("[data-slot=split-view] .md-prose") as HTMLElement;
    const before = renderedHalf().outerHTML;

    await click(q(TOGGLE));
    expect(gutters()).toBe(1);
    expect(q("[data-slot=split-view] .cm-editor .cm-lineNumbers")).not.toBeNull();
    expect(renderedHalf().querySelector(".cm-lineNumbers, .cm-gutters")).toBeNull();
    expect(renderedHalf().outerHTML).toBe(before);
  });

  test("reader mode draws no raw editor, so there is no toggle; leaving it, the numbers are as they were", async () => {
    localStorage.setItem("spellbook:line-numbers", "on");
    await openStory({ lineNumbers: true });
    await click(q("[data-slot=reader-toggle]"));
    await waitFor(() => q(".md-prose p") !== null, "the rendered view");
    expect(q("[data-reader]")).not.toBeNull();
    expect(q(TOGGLE)).toBeNull();
    expect(q(".cm-editor")).toBeNull();
    // Out of reader mode and back to raw: the choice stood throughout.
    await settle(() => setColumns?.({ context: false, chat: false }));
    await click(q('button[aria-label="Raw text"]'));
    await waitFor(() => q(".cm-editor") !== null, "the editor again");
    expect(gutters()).toBe(1);
    expect(localStorage.getItem("spellbook:line-numbers")).toBe("on");
  });

  test("not for JSON, which is always numbered: no toggle, one gutter, whatever is stored", async () => {
    localStorage.setItem("spellbook:line-numbers", "off");
    await openStory({ lineNumbers: true }, data);
    expect(q(TOGGLE)).toBeNull();
    expect(gutters()).toBe(1);
  });

  test("not over an app's own view, and back with the document", async () => {
    const appView = (active: boolean): AppView => ({
      id: "board",
      label: "Board",
      icon: <span />,
      active,
      onActive: () => {},
      render: () => <div data-slot="the-board" />,
    });
    const m = await openStory({ lineNumbers: true, appView: appView(false) });
    expect(q(TOGGLE)).not.toBeNull();
    await m.render(<Host pane={{ lineNumbers: true, appView: appView(true) }} />);
    expect(q(TOGGLE)).toBeNull();
    await m.render(<Host pane={{ lineNumbers: true, appView: appView(false) }} />);
    expect(q(TOGGLE)).not.toBeNull();
  });

  test("a press with the pointer leaves focus in the editor; the keyboard still works it", async () => {
    await openStory({ lineNumbers: true });
    const content = q(".cm-content") as HTMLElement;
    await settle(() => content.focus());
    const toggle = q(TOGGLE) as HTMLButtonElement;
    // A browser moves focus to a pressed button unless the press is prevented.
    const press = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
    await settle(() => {
      toggle.dispatchEvent(press);
    });
    expect(press.defaultPrevented).toBe(true);
    await click(toggle);
    expect(pressed()).toBe(true);
    expect(gutters()).toBe(1);
    expect(document.activeElement).toBe(content);

    // From the keyboard: Tab to the button, and Enter (a click) works it there.
    await settle(() => toggle.focus());
    expect(document.activeElement).toBe(toggle);
    await click(toggle);
    expect(pressed()).toBe(false);
    expect(gutters()).toBe(0);
  });
});
