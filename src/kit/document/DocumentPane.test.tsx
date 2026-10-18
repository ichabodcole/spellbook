// The document pane in a DOM against a REAL workspace daemon (the kit's fixture
// app), over the daemon client a surface uses. The workspace around it is a small
// host built here from that client, as the shell builds its own: the pane's subpath
// does not reach the shell. The first block fills none of the pane's slots, which is
// what holds the pane complete without an app's additions; the second fills each
// slot once and checks it reaches the view.
//
// CodeMirror mounts under happy-dom (its layout reads are stubbed below), so the
// editor under test is the real one.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EditorView } from "@codemirror/view";
import { createRef, type Ref, useMemo, useState } from "react";
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
  typeInto,
  waitFor,
} from "../lib/testDom.ts";
import { createToastStore } from "../ui/toast-store.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { testWorkspace } from "../workspace/fixtures/harness";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { NOTHING_TO_COMPARE } from "./CompareView.tsx";
import { DocumentPane, type DocumentPaneSlots } from "./DocumentPane.tsx";
import type { EditorHandle } from "./DocumentView.tsx";
import type { ViewMode } from "./pane.ts";

beforeAll(() => {
  installDom();
  // CodeMirror measures text with ranges and rects, which happy-dom does not lay out.
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
let ws: string;
let story: string;
let daemon: WorkspaceDaemon;

beforeEach(async () => {
  root = tempRoot("document-pane");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // The story sits in the workspace, so it is in the context from the start.
  ws = testWorkspace(root, "ws");
  story = join(ws, "story.md");
  writeFileSync(story, "First line.\n\nSecond line.\n");
  localStorage.clear();
  announced = [];
  reported = [];
  quietSaid = [];
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

/** What the pane announced, newest last. */
let announced: string[] = [];
/** The text of each selection the pane reported, newest last. */
let reported: string[] = [];
/** The host's daemon client, for what a sidebar would send (opening a document). */
let client: Daemon | null = null;

/** Every quiet the pane said to the shell, newest last. */
let quietSaid: boolean[] = [];
/** The host's columns, so a test can shut one the way a drag or a button would. */
let setColumns: ((c: Collapsed) => void) | null = null;

/** The pane's own options, beside its slots. */
type PaneOptions = { splitView?: boolean; viewModeKey?: string; mode?: ViewMode };

function Host({
  slots,
  editor,
  pane,
}: {
  slots?: DocumentPaneSlots;
  editor?: Ref<EditorHandle>;
  pane?: PaneOptions;
}) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  const toasts = useMemo(() => createToastStore(), []);
  // The shell's columns, as a plain pair: collapsing and reopening are the shell's
  // own acts, which this host stands in for.
  const [collapsed, setCollapsed] = useState<Collapsed>({ context: false, chat: false });
  setColumns = setCollapsed;
  const state = d.state;
  if (!state) return null;
  const workspace: Workspace = {
    daemon: d,
    state,
    openDoc: state.docs.find((doc) => doc.slug === state.openDoc) ?? null,
    selection: null,
    reportSelection: (s) => {
      reported.push(s.text);
    },
    dropSelection: () => {},
    clearSeq: 0,
    reveal: null,
    requestReveal: () => {},
    revealApplied: () => {},
    toasts,
    announce: (title) => announced.push(title),
    theme: "dark",
    setTheme: () => {},
    focusPane: () => {},
    columns: {
      collapsed,
      collapse: (side) => setCollapsed((c) => ({ ...c, [side]: true })),
      expand: (side) => setCollapsed((c) => ({ ...c, [side]: false })),
    },
    setQuiet: (quiet) => {
      quietSaid.push(quiet);
    },
  };
  return (
    <WorkspaceContext.Provider value={workspace}>
      {/* Focusable by script, as the shell's centre pane is: the pane forwards that focus to the editor. */}
      <main data-pane="centre" tabIndex={-1} style={{ width: 900, height: 700 }}>
        <DocumentPane {...slots} {...pane} editor={editor} />
      </main>
    </WorkspaceContext.Provider>
  );
}

const cmd = async (body: Record<string, unknown>) => {
  const res = await fetch(`${daemon.url}/cmd`, { method: "POST", body: JSON.stringify(body) });
  return (await res.json()) as Record<string, unknown>;
};
const q = (sel: string) => document.querySelector(sel);
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) ??
  null;
const menuItem = (text: string) =>
  [...document.querySelectorAll('[role="menuitem"]')].find((i) =>
    (i.textContent ?? "").includes(text),
  ) ?? null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const editorText = () => q(".cm-content")?.textContent ?? "";
const viewOf = () => EditorView.findFromDOM(q(".cm-editor") as HTMLElement) as EditorView;
const versionFile = (n: number) => join(daemon.dir, "docs", "story", `v${n}.md`);
const active = () => daemon.session.doc("story").active;

async function openStory(
  slots?: DocumentPaneSlots,
  editor?: Ref<EditorHandle>,
  pane?: PaneOptions,
) {
  await mount(<Host slots={slots} editor={editor} pane={pane} />);
  await waitFor(
    () => document.body.textContent?.includes("No document open") === true,
    "the empty state",
  );
  await cmd({ op: "context.add", paths: [story] });
  await settle(() => {
    client?.send({ op: "open", path: story });
  });
  await waitFor(() => editorText().length > 0, "the text in the editor");
}

async function openVersionMenu() {
  const trigger = q('button[aria-label^="Version "]');
  await click(trigger);
  await waitFor(() => q('[role="menuitem"]') !== null, "the version menu");
}

describe("the document pane with no slots filled", () => {
  test("an edit reaches the active version's file, never the original", async () => {
    await openStory();
    expect(document.body.textContent).toContain("Version:");
    await settle(() => viewOf().dispatch({ changes: { from: 0, insert: "Now. " } }));
    await waitFor(
      () => readFileSync(versionFile(1), "utf8").startsWith("Now. First line."),
      "the edit in v1",
    );
    expect(readFileSync(story, "utf8")).toBe("First line.\n\nSecond line.\n");
    await waitFor(() => document.body.textContent?.includes("Unsaved") === true, "Unsaved");
  });

  test("the rendered view shows the text, and raw shows the editor again", async () => {
    await openStory();
    await click(q('button[aria-label="Rendered"]'));
    await waitFor(() => q(".md-prose p") !== null, "the rendered paragraphs");
    expect([...document.querySelectorAll(".md-prose p")].map((p) => p.textContent)).toEqual([
      "First line.",
      "Second line.",
    ]);
    expect(q(".cm-editor")).toBeNull();
    await click(q('button[aria-label="Raw text"]'));
    await waitFor(() => editorText().includes("Second line."), "the editor");
    expect(q(".md-prose")).toBeNull();
  });

  test("a new version is named, made and edited; another is activated from the menu", async () => {
    await openStory();
    await openVersionMenu();
    await click(menuItem("New version from v1"));
    await waitFor(() => q("#version-label") !== null, "the new-version dialog");
    await typeInto(q("#version-label") as HTMLInputElement, "a second try");
    await click(button("Make v2 and edit it"));
    await waitFor(() => active() === 2, "v2 made and active");
    expect(daemon.session.doc("story").versions.find((v) => v.n === 2)?.label).toBe("a second try");
    await waitFor(() => announced.includes("Now editing v2 · a second try"), "the announcement");
    await waitFor(() => q('button[aria-label^="Version 2"]') !== null, "the menu on v2");

    await openVersionMenu();
    const v1 = [...document.querySelectorAll('[role="menuitem"]')].find(
      (i) => i.getAttribute("aria-current") !== "true" && (i.textContent ?? "").includes("v1"),
    );
    await click(v1 ?? null);
    await waitFor(() => active() === 1, "v1 active again");
    await waitFor(() => q('button[aria-label^="Version 1"]') !== null, "the menu on v1");
  });

  test("compare shows the difference from another version and takes it", async () => {
    await openStory();
    const made = await cmd({ op: "version.new", doc: "story", label: "other" });
    writeFileSync(made.path as string, "First line, changed.\n\nSecond line.\n");
    await waitFor(() => daemon.session.doc("story").versions.length === 2, "v2 made");
    await openVersionMenu();
    await click(button("Compare"));
    await waitFor(
      () => document.body.textContent?.includes("compared with") === true,
      "the compare view",
    );
    expect(document.body.textContent).toContain("1 change");
    await click(button("Take all"));
    await waitFor(
      () => readFileSync(versionFile(1), "utf8").startsWith("First line, changed."),
      "the merge into v1",
    );
    await click(q('button[aria-label="Raw text"]'));
    await waitFor(() => editorText().includes("First line, changed."), "the merged text");
  });

  test("deleting a version asks first, with only the pane's own warning", async () => {
    await openStory();
    await cmd({ op: "version.new", doc: "story" });
    await waitFor(() => daemon.session.doc("story").versions.length === 2, "v2 made");
    await openVersionMenu();
    await click(q('button[aria-label="Delete v2"]'));
    await waitFor(() => q('[data-slot="confirm-dialog"]') !== null, "the confirm");
    const text = q('[data-slot="confirm-dialog"]')?.textContent ?? "";
    expect(text).toContain("Anything written only in this version is lost.");
    const confirm = [...(q('[data-slot="confirm-dialog"]')?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Delete",
    );
    await click(confirm ?? null);
    await waitFor(() => daemon.session.doc("story").versions.length === 1, "v2 deleted");
  });
});

describe("the pane's slots", () => {
  test("each slot an app fills reaches the view, and the handle's commands act on the editor", async () => {
    writeFileSync(story, "Say {wave} here.\n");
    const editor = createRef<EditorHandle>();
    const slots: DocumentPaneSlots = {
      rawExtensions: [EditorView.editorAttributes.of({ "data-app-extension": "on" })],
      rawTokens: [{ name: "brace", pattern: /^\{[a-z]+\}/, style: { fontWeight: "700" } }],
      inlineWidgets: [
        {
          className: "brace-widget",
          find: (text) =>
            [...text.matchAll(/\{[a-z]+\}/g)].map((m) => ({
              start: m.index,
              end: m.index + m[0].length,
            })),
          render: (text) => <b data-widget>{text.slice(1, -1)}</b>,
        },
      ],
      versionDeleteWarnings: (_doc, n) => [`The app's things for v${n} go too.`, null],
    };
    await openStory(slots, editor);
    expect(editorText()).toContain("{wave}");

    expect(q('.cm-editor[data-app-extension="on"]')).not.toBeNull();

    await settle(() => viewOf().dispatch({ selection: { anchor: 3 } }));
    expect(editor.current?.selection()).toEqual({ from: 3, to: 3 });
    await settle(() => editor.current?.insertAtCaret((before) => (before === "y" ? " !" : "!")));
    expect(editor.current?.text()).toBe("Say ! {wave} here.\n");
    expect(editor.current?.selection()).toEqual({ from: 5, to: 5 });
    await settle(() => editor.current?.insertAtCaret("?"));
    expect(editor.current?.text()).toBe("Say !? {wave} here.\n");

    await click(q('button[aria-label="Rendered"]'));
    await waitFor(() => q(".brace-widget [data-widget]") !== null, "the widget");
    const span = q(".brace-widget") as HTMLElement;
    expect(span.querySelector("[data-widget]")?.textContent).toBe("wave");

    await cmd({ op: "version.new", doc: "story" });
    await waitFor(() => daemon.session.doc("story").versions.length === 2, "v2 made");
    await openVersionMenu();
    await click(q('button[aria-label="Delete v2"]'));
    await waitFor(() => q('[data-slot="confirm-dialog"]') !== null, "the confirm");
    expect(q('[data-slot="confirm-dialog"]')?.textContent).toContain(
      "Anything written only in this version is lost. The app's things for v2 go too.",
    );
  });

  test("a frontmatter block is a header in the rendered view, with the app's chips, and YAML in raw", async () => {
    writeFileSync(story, "---\ntype: place\nregion: north\n---\nThe body.\n");
    await openStory({
      frontmatterChips: (fields, chips) => [
        ...chips,
        { key: "region", label: `region ${String(fields.region)}` },
      ],
    });
    // The raw view keeps the block as written (its lines, joined, as `editorText` reads them).
    expect(editorText()).toBe("---type: placeregion: north---The body.");
    await click(q('button[aria-label="Rendered"]'));
    await waitFor(() => q("[data-slot=frontmatter-header]") !== null, "the header");
    expect(q("[data-chip=type]")?.textContent).toBe("place");
    expect(q("[data-chip=region]")?.textContent).toBe("region north");
    expect(q("[data-slot=frontmatter-header] dl")).toBeNull();
    expect(q(".md-prose")?.textContent?.trim()).toBe("The body.");
  });
});

/**
 * Lay the pane out `width` pixels wide: every ResizeObserver reports that width
 * as soon as it observes, as a browser's does on its first frame. Returns the undo.
 */
function paneWidth(width: number): () => void {
  const g = globalThis as { ResizeObserver?: unknown };
  const was = g.ResizeObserver;
  g.ResizeObserver = class {
    cb: (entries: { contentRect: { width: number } }[]) => void;
    constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
      this.cb = cb;
    }
    observe() {
      this.cb([{ contentRect: { width } }]);
    }
    unobserve() {}
    disconnect() {}
  };
  return () => {
    g.ResizeObserver = was;
  };
}

const SPLIT = 'button[aria-label="Raw and rendered side by side"]';

describe("split, raw and rendered side by side", () => {
  test("off by default: the view switch offers no split", async () => {
    await openStory();
    expect(q('button[aria-label="Rendered"]')).not.toBeNull();
    expect(q(SPLIT)).toBeNull();
  });

  test("on, split shows both views of the text, and an edit in raw re-renders the other side", async () => {
    await openStory(undefined, undefined, { splitView: true });
    await click(q(SPLIT));
    await waitFor(() => q("[data-slot=split-view] .md-prose p") !== null, "the rendered half");
    expect(q("[data-slot=split-view] .cm-editor")).not.toBeNull();
    expect(q(SPLIT)?.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("story-studio:view-mode")).toBe("split");
    await settle(() => viewOf().dispatch({ changes: { from: 0, insert: "Now. " } }));
    await waitFor(
      () => q(".md-prose p")?.textContent === "Now. First line.",
      "the edit in the rendered half",
    );
    // Back to raw keeps the editor (the same one) and drops the rendered half.
    const editorEl = q(".cm-editor");
    await click(q('button[aria-label="Raw text"]'));
    expect(q(".md-prose")).toBeNull();
    expect(q(".cm-editor")).toBe(editorEl);
  });

  test("in split, a press on the rendered half keeps focus out of the editor, and a selection there is reported", async () => {
    await openStory(undefined, undefined, { splitView: true });
    await click(q(SPLIT));
    await waitFor(() => q("[data-slot=split-view] .md-prose p") !== null, "the rendered half");
    const inEditor = () => q(".cm-editor")?.contains(document.activeElement) === true;

    // A press focuses the nearest focusable ancestor of what was pressed; happy-dom
    // does not, so this does it the browser's way. Before the fix that ancestor was
    // the centre pane, which hands its focus to the editor.
    const para = q(".md-prose p") as HTMLElement;
    const target = para.closest<HTMLElement>("[tabindex]");
    expect(target?.getAttribute("data-slot")).toBe("markdown-view");
    await settle(() => target?.focus());
    expect(document.activeElement).toBe(target);
    expect(inEditor()).toBe(false);

    const text = para.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 5);
    await settle(() => {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(reported.at(-1)).toBe("First");
    expect(inEditor()).toBe(false);

    // Focus on the pane itself (the keyboard's way in) still reaches the editor.
    await settle(() => (q("main[data-pane=centre]") as HTMLElement).focus());
    expect(inEditor()).toBe(true);
  });

  test("too narrow, split is disabled with the reason, and a stored split shows raw", async () => {
    localStorage.setItem("story-studio:view-mode", "split");
    const undo = paneWidth(600);
    try {
      await openStory(undefined, undefined, { splitView: true });
      const split = q(SPLIT) as HTMLButtonElement;
      expect(split.disabled).toBe(true);
      expect(split.title).toContain("too narrow");
      expect(split.title).toContain("720 px");
      expect(q(".md-prose")).toBeNull();
      expect(q('button[aria-label="Raw text"]')?.getAttribute("aria-pressed")).toBe("true");
      // The choice is kept, so a wider pane brings split back.
      expect(localStorage.getItem("story-studio:view-mode")).toBe("split");
    } finally {
      undo();
    }
  });

  test("a stored split in an app with split off falls back to raw", async () => {
    localStorage.setItem("story-studio:view-mode", "split");
    await openStory();
    expect(q(SPLIT)).toBeNull();
    expect(q(".md-prose")).toBeNull();
    expect(q('button[aria-label="Raw text"]')?.getAttribute("aria-pressed")).toBe("true");
  });
});

const READER = "[data-slot=reader-toggle]";
const readerPressed = () => q(READER)?.getAttribute("aria-pressed") === "true";
const FADED = "opacity-40";
/** Whether an element sits in a bar whose hover or keyboard focus brings it back. */
const inChromeGroup = (el: Element | null) => {
  for (let e = el?.parentElement; e; e = e.parentElement)
    if (e.classList.contains("group/chrome")) return true;
  return false;
};

describe("reader mode, rendered with both columns out of the way", () => {
  test("entering from raw shows rendered and shuts both columns; leaving reopens them and stays rendered", async () => {
    await openStory();
    expect(readerPressed()).toBe(false);
    expect(q(READER)?.getAttribute("title")).toContain("Reader mode");
    await click(q(READER));
    await waitFor(() => q(".md-prose p") !== null, "the rendered view");
    expect(readerPressed()).toBe(true);
    expect(q(READER)?.getAttribute("title")).toContain("Leave reader mode");
    expect(q("[data-reader]")).not.toBeNull();
    expect(localStorage.getItem("story-studio:view-mode")).toBe("rendered");
    expect(quietSaid.at(-1)).toBe(true);

    await click(q(READER));
    expect(readerPressed()).toBe(false);
    expect(q("[data-reader]")).toBeNull();
    // Still rendered: a preset remembers nothing about where you were.
    expect(q(".md-prose p")).not.toBeNull();
    expect(q('button[aria-label="Rendered"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(quietSaid.at(-1)).toBe(false);
  });

  test("it is derived: rendered with both columns shut reads as reader mode however it came about", async () => {
    await openStory();
    await click(q('button[aria-label="Rendered"]'));
    await settle(() => setColumns?.({ context: true, chat: false }));
    expect(readerPressed()).toBe(false);
    await settle(() => setColumns?.({ context: true, chat: true }));
    expect(readerPressed()).toBe(true);
    // Raw with both shut is not reader mode.
    await click(q('button[aria-label="Raw text"]'));
    expect(readerPressed()).toBe(false);
    // The toggle from there only switches to rendered: there is nothing left to shut.
    await click(q(READER));
    expect(readerPressed()).toBe(true);
  });

  test("split leaves for rendered on the way in", async () => {
    await openStory(undefined, undefined, { splitView: true });
    await click(q(SPLIT));
    await waitFor(() => q("[data-slot=split-view]") !== null, "split");
    await click(q(READER));
    expect(q("[data-slot=split-view]")).toBeNull();
    expect(q(".cm-editor")).toBeNull();
    expect(q('button[aria-label="Rendered"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(readerPressed()).toBe(true);
  });

  test("idle chrome fades; unsaved edits keep Save and the save marker at full strength", async () => {
    await openStory();
    const save = () => button("Save") as HTMLElement;
    const marker = () =>
      [...document.querySelectorAll("[data-slot=status-strip] > span")].find((s) =>
        /Saved|Unsaved|Changed on disk/.test(s.textContent ?? ""),
      ) as HTMLElement;
    expect(save().classList.contains(FADED)).toBe(false);
    await click(q(READER));
    // Nothing unsaved: Save is disabled and fades with the rest.
    expect(save().classList.contains(FADED)).toBe(true);
    expect(marker().classList.contains(FADED)).toBe(true);
    expect(button("Revert")?.classList.contains(FADED)).toBe(true);
    expect(q('[role="toolbar"]')?.classList.contains(FADED)).toBe(true);
    expect(q(READER)?.classList.contains(FADED)).toBe(true);
    // The header and the strip are the groups whose hover or keyboard focus brings them back.
    expect(inChromeGroup(q(READER))).toBe(true);
    expect(inChromeGroup(q("[data-slot=status-strip]"))).toBe(true);

    // Out, an edit, and back in: Save and "Unsaved" ask for attention, so they stay loud.
    await click(q(READER));
    await click(q('button[aria-label="Raw text"]'));
    await waitFor(() => editorText().length > 0, "the editor");
    await settle(() => viewOf().dispatch({ changes: { from: 0, insert: "Now. " } }));
    await waitFor(() => marker().textContent?.includes("Unsaved") === true, "Unsaved");
    await click(q(READER));
    expect(readerPressed()).toBe(true);
    expect(save().classList.contains(FADED)).toBe(false);
    expect(marker().classList.contains(FADED)).toBe(false);
    expect(button("Revert")?.classList.contains(FADED)).toBe(true);
  });

  test("a change on disk keeps the marker and the banner at full strength", async () => {
    await openStory();
    // Unsaved edits first: a clean version simply follows its file.
    await settle(() => viewOf().dispatch({ changes: { from: 0, insert: "Now. " } }));
    await waitFor(() => readFileSync(versionFile(1), "utf8").startsWith("Now. "), "the edit in v1");
    writeFileSync(story, "Changed outside.\n");
    await waitFor(
      () => document.body.textContent?.includes("Changed on disk") === true,
      "the change on disk",
      5000,
    );
    await click(q(READER));
    expect(readerPressed()).toBe(true);
    const marker = [...document.querySelectorAll("[data-slot=status-strip] > span")].find((s) =>
      (s.textContent ?? "").includes("Changed on disk"),
    );
    expect(marker?.classList.contains(FADED)).toBe(false);
    const banner = q('[role="alert"]');
    expect(banner?.textContent).toContain("changed on disk");
    // Neither the banner nor anything in it is faded.
    for (let e: Element | null = banner; e; e = e.parentElement)
      expect(e.classList.contains(FADED)).toBe(false);
    expect(banner?.querySelectorAll(`.${FADED}`).length).toBe(0);
    // The idle parts still fade.
    expect(q('[role="toolbar"]')?.classList.contains(FADED)).toBe(true);
  });

  test("entering from compare shows rendered", async () => {
    await openStory();
    const made = await cmd({ op: "version.new", doc: "story", label: "other" });
    writeFileSync(made.path as string, "First line, changed.\n\nSecond line.\n");
    await waitFor(() => daemon.session.doc("story").versions.length === 2, "v2 made");
    await openVersionMenu();
    await click(button("Compare"));
    await waitFor(
      () => document.body.textContent?.includes("compared with") === true,
      "the compare view",
    );
    await click(q(READER));
    expect(readerPressed()).toBe(true);
    expect(document.body.textContent).not.toContain("compared with");
    expect(q(".md-prose p")).not.toBeNull();
    expect(q('button[aria-label="Rendered"]')?.getAttribute("aria-pressed")).toBe("true");
  });

  test("the pane takes its quiet back from the shell when it goes", async () => {
    const m = await mount(<Host />);
    await waitFor(() => q(READER) !== null, "the pane");
    await click(q(READER));
    expect(quietSaid.at(-1)).toBe(true);
    await m.unmount();
    expect(quietSaid.at(-1)).toBe(false);
  });

  test("outside reader mode nothing is faded", async () => {
    await openStory();
    expect(document.querySelectorAll(`.${FADED}`).length).toBe(0);
    expect(quietSaid.includes(true)).toBe(false);
  });

  describe("compare with nothing to compare", () => {
    const compareButton = () =>
      q('button[aria-label="Compare with another version"]') as HTMLButtonElement;
    const doc = () => client?.state?.docs[0];
    const edit = async () => {
      await settle(() => {
        viewOf().dispatch({ changes: { from: 0, insert: "Edited. " } });
      });
      await waitFor(() => doc()?.dirty === true, "the dirty buffer");
    };

    test("one version that matches its file disables Compare, with the reason", async () => {
      await openStory();
      expect(doc()?.versions.length).toBe(1);
      expect(compareButton().disabled).toBe(true);
      expect(compareButton().title).toBe(NOTHING_TO_COMPARE);
    });

    test("one version with unsaved edits can still be compared with the file", async () => {
      await openStory();
      await edit();
      expect(compareButton().disabled).toBe(false);
      expect(compareButton().title).toBe("Compare with another version");
      await click(compareButton());
      await waitFor(
        () => document.body.textContent?.includes("compared with") === true,
        "the compare view",
      );
      expect(document.body.textContent).not.toContain(NOTHING_TO_COMPARE);
    });

    test("one version whose file changed on disk can still be compared", async () => {
      await openStory();
      await edit();
      writeFileSync(story, "Changed outside.\n");
      await waitFor(() => doc()?.outsideChanged === true, "the outside change");
      expect(compareButton().disabled).toBe(false);
    });

    test("a second version enables Compare again", async () => {
      await openStory();
      expect(compareButton().disabled).toBe(true);
      await cmd({ op: "version.new", doc: "story", label: "other" });
      await waitFor(() => doc()?.versions.length === 2, "v2 made");
      expect(compareButton().disabled).toBe(false);
    });

    test("a saved compare mode shows the message, not an empty comparison", async () => {
      await mount(<Host pane={{ mode: "compare" }} />);
      await waitFor(
        () => document.body.textContent?.includes("No document open") === true,
        "the empty state",
      );
      await cmd({ op: "context.add", paths: [story] });
      await settle(() => {
        client?.send({ op: "open", path: story });
      });
      await waitFor(
        () => document.body.textContent?.includes(NOTHING_TO_COMPARE) === true,
        "the message",
      );
      expect(q('[role="status"]')?.textContent).toContain(NOTHING_TO_COMPARE);
      expect(document.body.textContent).not.toContain("identical");
    });
  });
});
