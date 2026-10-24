// The right-click menu in the document pane, in a DOM against a REAL workspace
// daemon (kit-context-menu-without-selection): it opens with or without a
// selection; with only a caret it inserts a link there, taking the link's text
// and its target; it carries Cut, Copy and Paste; and the browser's own menu
// stays one gesture away (Shift, or a second right-click while ours is open).

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EditorView } from "@codemirror/view";
import { useMemo, useState } from "react";
import { NATIVE_MENU_HINT } from "../chat/NoteAtSelection.tsx";
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
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";
import type { ViewMode } from "./pane.ts";

beforeAll(() => {
  installDom();
  // CodeMirror measures text with ranges and rects, which happy-dom does not lay out.
  const proto = window.Range.prototype as unknown as Record<string, unknown>;
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  proto.getClientRects = () => [];
  proto.getBoundingClientRect = () => ({ ...rect, toJSON() {} });
  const el = window.Element.prototype as unknown as Record<string, unknown>;
  el.getClientRects = el.getClientRects ?? (() => []);
  (document as unknown as Record<string, unknown>).elementFromPoint ??= () => null;
});
afterAll(async () => {
  await removeDom();
});

let root: string;
let set: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
let announced: string[];
let startMode: ViewMode = "split";
/** What the page's clipboard holds, and whether it lets the page read it. */
let clipboard: { text: string; readable: boolean; writable: boolean };

const A = "# A\n\nsee the bakery here\n";
const C = "# C\n\nPlain [link to b](./part/b.md) after\n";
/** A CRLF file: the daemon counts each `\r\n` as two, the editor as one. */
const D = "# D\r\n\r\nfirst line\r\nsecond line here\r\n";
const E = "# E\r\n\r\none\r\ntwo\r\nsee [a link](./a.md) end\r\n";

beforeEach(async () => {
  root = tempRoot("pane-context-menu");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  set = join(root, "docs", "set");
  mkdirSync(join(set, "part"), { recursive: true });
  writeFileSync(join(set, "a.md"), A);
  writeFileSync(join(set, "part", "b.md"), "# B\n\nback\n");
  writeFileSync(join(set, "c.md"), C);
  writeFileSync(join(set, "d.md"), D);
  writeFileSync(join(set, "e.md"), E);
  localStorage.clear();
  client = null;
  announced = [];
  startMode = "split";
  clipboard = { text: "", readable: true, writable: true };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (t: string) => {
        if (!clipboard.writable) throw new Error("NotAllowedError");
        clipboard.text = t;
      },
      readText: async () => {
        if (!clipboard.readable) throw new Error("NotAllowedError");
        return clipboard.text;
      },
    },
  });
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: join(root, "docs") });
  await daemon.start();
  daemon.session.addContext(set);
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Host() {
  const [mode] = useState<ViewMode>(startMode);
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  const toasts = useMemo(() => createToastStore(), []);
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
    announce: (title) => {
      announced.push(title);
      return 0;
    },
    theme: "dark",
    setTheme: () => {},
    focusPane: () => {},
    columns: { collapsed: { context: false, chat: false }, collapse: () => {}, expand: () => {} },
    setQuiet: () => {},
  };
  return (
    <WorkspaceContext.Provider value={workspace}>
      <main data-pane="centre" style={{ width: 1200, height: 700 }}>
        <DocumentPane mode={mode} splitView />
      </main>
    </WorkspaceContext.Provider>
  );
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const view = () => EditorView.findFromDOM(q(".cm-editor") as HTMLElement) as EditorView;
const text = () => view().state.doc.toString();
const menu = () => q('[data-slot="note-at-selection"]');
const item = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-slot="note-at-selection"] button')].find(
    (b) => (b.textContent ?? "").startsWith(label),
  ) ?? null;
const items = () =>
  [...document.querySelectorAll('[data-slot="note-at-selection"] button')].map((b) =>
    (b.textContent ?? "").replace(/(⌘|Ctrl ?)\S*$/u, "").trim(),
  );
const picker = () => q('[data-slot="link-picker"]');
const options = () => [...document.querySelectorAll('[data-slot="link-picker"] [role="option"]')];
const docField = () => q<HTMLInputElement>('input[aria-label="Find a document to link to"]');
const labelField = () => q<HTMLInputElement>('input[aria-label="Link text"]');

async function click(el: Element | null) {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
async function key(el: Element | null, k: string) {
  if (!el) throw new Error(`nothing to press ${k} in`);
  await settle(() => {
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  });
}
/**
 * A right-click on `el`: the press, then the `contextmenu` the browser fires.
 * Returns whether the page cancelled it, which is what keeps the browser's own
 * menu shut.
 */
async function rightClick(el: Element | null, init: MouseEventInit = {}): Promise<boolean> {
  if (!el) throw new Error("nothing to right-click");
  let cancelled = false;
  await settle(() => {
    el.dispatchEvent(
      new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2, ...init }),
    );
    const e = new window.MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 40,
      clientY: 40,
      ...init,
    });
    el.dispatchEvent(e);
    cancelled = e.defaultPrevented;
  });
  return cancelled;
}
async function caretAt(offset: number) {
  await settle(() => view().dispatch({ selection: { anchor: offset } }));
}
async function select(phrase: string) {
  const at = text().indexOf(phrase);
  await settle(() => view().dispatch({ selection: { anchor: at, head: at + phrase.length } }));
}

async function start(rel = "a.md") {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path: join(set, rel) });
  });
  if (startMode === "rendered") {
    const heading = rel[0]?.toUpperCase() ?? "";
    await waitFor(() => (q(".md-prose h1")?.textContent ?? "") === heading, "rendered");
    return m;
  }
  await waitFor(
    () => !!q(".cm-content") && text().startsWith(`# ${rel[0]?.toUpperCase()}`),
    `${rel} open`,
  );
  await waitFor(
    () => q(".cm-content")?.getAttribute("contenteditable") === "true",
    "the editable editor",
  );
  return m;
}

describe("with only a caret, in the raw editor", () => {
  test("our menu opens: Insert a link, a disabled Add note saying why, Paste, and the way to the browser's", async () => {
    const m = await start();
    await caretAt(text().indexOf("here"));
    expect(await rightClick(view().contentDOM)).toBe(true);
    expect(items()).toEqual(["Add noteselect text first", "Insert a link", "Paste"]);
    expect(item("Add note")?.disabled).toBe(true);
    expect(item("Add note")?.title).toContain("select some text first");
    expect(menu()?.querySelector('[data-slot="native-menu-hint"]')?.textContent).toBe(
      NATIVE_MENU_HINT,
    );
    await m.unmount();
  });

  test("Insert a link takes the link's text and its target, and writes the link at the caret", async () => {
    const m = await start();
    const at = text().indexOf("here");
    await caretAt(at);
    await rightClick(view().contentDOM);
    await click(item("Insert a link"));
    expect(menu()).toBeNull();
    await waitFor(() => picker() !== null && options().length > 0, "the picker's documents");
    await typeInto(labelField() as HTMLInputElement, "the far side");
    await typeInto(docField() as HTMLInputElement, "b");
    await key(labelField(), "Enter");
    expect(picker()).toBeNull();
    expect(text()).toBe("# A\n\nsee the bakery [the far side](./part/b.md)here\n");
    await m.unmount();
  });

  test("left empty, the link's text is the document's name, as it always was", async () => {
    const m = await start();
    await caretAt(text().length);
    await rightClick(view().contentDOM);
    await click(item("Insert a link"));
    await waitFor(() => picker() !== null && options().length > 0, "the picker's documents");
    await typeInto(docField() as HTMLInputElement, "b");
    await key(docField(), "Enter");
    expect(text()).toBe(`${A}[b](./part/b.md)`);
    await m.unmount();
  });

  test("Paste puts the clipboard at the caret; refused, it says so and names the shortcut", async () => {
    const m = await start();
    clipboard.text = "fresh ";
    await caretAt(text().indexOf("here"));
    await rightClick(view().contentDOM);
    await click(item("Paste"));
    await waitFor(() => text().includes("fresh here"), "the paste");
    clipboard.readable = false;
    await rightClick(view().contentDOM);
    await click(item("Paste"));
    await waitFor(() => announced.length > 0, "the refusal");
    expect(announced).toEqual(["Couldn't paste"]);
    expect(text()).toBe("# A\n\nsee the bakery fresh here\n");
    await m.unmount();
  });
});

describe("with a selection, in the raw editor", () => {
  test("the menu is as before, with Cut, Copy and Paste", async () => {
    const m = await start();
    await select("bakery");
    await rightClick(view().contentDOM);
    expect(items()).toEqual(["Add note", "Add link", "Cut", "Copy", "Paste"]);
    expect(item("Add note")?.disabled).toBe(false);
    await click(item("Copy"));
    await waitFor(() => clipboard.text === "bakery", "the copy");
    expect(text()).toBe(A);
    await rightClick(view().contentDOM);
    await click(item("Cut"));
    await waitFor(() => text() === "# A\n\nsee the  here\n", "the cut");
    expect(clipboard.text).toBe("bakery");
    await m.unmount();
  });

  test("a cut the clipboard refuses leaves the text alone", async () => {
    const m = await start();
    clipboard.writable = false;
    await select("bakery");
    await rightClick(view().contentDOM);
    await click(item("Cut"));
    await waitFor(() => announced.length > 0, "the refusal");
    expect(announced).toEqual(["Couldn't cut"]);
    expect(text()).toBe(A);
    await m.unmount();
  });
});

describe("the browser's own menu", () => {
  test("Shift-right-click goes straight to it", async () => {
    const m = await start();
    expect(await rightClick(view().contentDOM, { shiftKey: true })).toBe(false);
    expect(menu()).toBeNull();
    await m.unmount();
  });

  test("a second right-click while ours is open lets it through, and a third opens ours again", async () => {
    const m = await start();
    await select("bakery");
    expect(await rightClick(view().contentDOM)).toBe(true);
    expect(menu()).not.toBeNull();
    expect(await rightClick(view().contentDOM)).toBe(false);
    expect(menu()).toBeNull();
    expect(await rightClick(view().contentDOM)).toBe(true);
    expect(menu()).not.toBeNull();
    await m.unmount();
  });
});

describe("in the rendered view alone", () => {
  test("a right-click with no selection opens ours at the point; Insert a link writes there", async () => {
    startMode = "rendered";
    const m = await start();
    // happy-dom has no hit-testing: the point under the pointer is the start of "here".
    const prose = q(".md-prose") as HTMLElement;
    const walker = document.createTreeWalker(prose, 4);
    let node: Node | null = walker.nextNode();
    while (node && !(node.textContent ?? "").includes("here")) node = walker.nextNode();
    const hit = node as Text;
    const doc = document as unknown as Record<string, unknown>;
    doc.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(hit, hit.data.indexOf("here"));
      r.setEnd(hit, hit.data.indexOf("here"));
      return r;
    };
    try {
      window.getSelection()?.removeAllRanges();
      expect(await rightClick(prose)).toBe(true);
      // Read, not typed in: Copy only over a selection, and no Cut or Paste.
      expect(items()).toEqual(["Add noteselect text first", "Insert a link"]);
      await click(item("Insert a link"));
      await waitFor(() => picker() !== null && options().length > 0, "the picker's documents");
      await typeInto(labelField() as HTMLInputElement, "over there");
      await typeInto(docField() as HTMLInputElement, "b");
      await key(docField(), "Enter");
      await waitFor(
        () => (q(".md-prose")?.textContent ?? "").includes("over there"),
        "the link written",
      );
      const slug = client?.state?.openDoc ?? "";
      const d = daemon.session.doc(slug);
      expect(daemon.session.readVersion(slug, d.active).text).toBe(
        "# A\n\nsee the bakery [over there](./part/b.md)here\n",
      );
    } finally {
      delete doc.caretRangeFromPoint;
    }
    await m.unmount();
  });
});

/** Every edit the editor is asked to make from here on, by what it records it as. */
function recordEvents(): string[] {
  const v = view();
  const seen: string[] = [];
  const dispatch = v.dispatch.bind(v);
  v.dispatch = ((...specs: Parameters<EditorView["dispatch"]>) => {
    const spec = specs[0] as { userEvent?: string } | undefined;
    // An edit: a caret or a selection moved (`select`) is not one.
    if (spec && typeof spec === "object" && spec.userEvent && spec.userEvent !== "select")
      seen.push(spec.userEvent);
    return (dispatch as (...a: unknown[]) => void)(...specs);
  }) as EditorView["dispatch"];
  return seen;
}
/** Mod-Shift-K in the editor. */
async function linkShortcut() {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform ?? "");
  await settle(() => {
    view().contentDOM.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "K",
        code: "KeyK",
        keyCode: 75,
        shiftKey: true,
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

describe("round two", () => {
  test("a paste and a cut are recorded as a paste and a cut, not as a link", async () => {
    const m = await start();
    const events = recordEvents();
    clipboard.text = "x";
    await caretAt(text().indexOf("here"));
    await rightClick(view().contentDOM);
    await click(item("Paste"));
    await waitFor(() => text().includes("xhere"), "the paste");
    await select("bakery");
    await rightClick(view().contentDOM);
    await click(item("Cut"));
    await waitFor(() => !text().includes("bakery"), "the cut");
    expect(events).toEqual(["input.paste", "delete.cut"]);
    await m.unmount();
  });

  test("macOS's Ctrl-click opens ours, and a second Ctrl-click lets the browser's through", async () => {
    const m = await start();
    await select("bakery");
    const ctrl = { button: 0, ctrlKey: true };
    expect(await rightClick(view().contentDOM, ctrl)).toBe(true);
    expect(menu()).not.toBeNull();
    expect(await rightClick(view().contentDOM, ctrl)).toBe(false);
    expect(menu()).toBeNull();
    await m.unmount();
  });

  test("over a selection the picker asks for no link text: the selection is the text", async () => {
    const m = await start();
    await select("bakery");
    await rightClick(view().contentDOM);
    await click(item("Add link"));
    await waitFor(() => picker() !== null, "the picker");
    expect(labelField()).toBeNull();
    await m.unmount();
  });

  test("inside an existing link, the menu's link act is off with its reason, and the shortcut refuses", async () => {
    const m = await start("c.md");
    await caretAt(text().indexOf("to b"));
    await rightClick(view().contentDOM);
    expect(item("Insert a link")?.disabled).toBe(true);
    expect(item("Insert a link")?.title).toContain("inside a link");
    await settle(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });
    await linkShortcut();
    expect(picker()).toBeNull();
    expect(announced).toEqual(["Can't link here"]);
    // At the link's edge the caret is outside it, and a link goes in beside it.
    await caretAt(text().indexOf(" after"));
    await rightClick(view().contentDOM);
    expect(item("Insert a link")?.disabled).toBe(false);
    expect(text()).toBe(C);
    await m.unmount();
  });

  test("an ended session: a caret's menu would be empty, so the browser's opens; over a selection, Copy and a disabled Add note", async () => {
    const m = await start();
    client?.send({ op: "close" });
    await waitFor(() => client?.connection === "ended", "ended");
    await waitFor(
      () => q(".cm-content")?.getAttribute("contenteditable") === "false",
      "the read-only editor",
    );
    await caretAt(text().indexOf("here"));
    expect(await rightClick(view().contentDOM)).toBe(false);
    expect(menu()).toBeNull();
    await select("bakery");
    expect(await rightClick(view().contentDOM)).toBe(true);
    expect(items()).toEqual(["Add notesession ended", "Copy"]);
    expect(item("Add note")?.disabled).toBe(true);
    expect(item("Add note")?.title).toContain("session has ended");
    await m.unmount();
  });
});

describe("round two, rendered", () => {
  test("a right-click on a link is the browser's: its link entries, and no link inside a link", async () => {
    startMode = "rendered";
    const m = await start("c.md");
    const link = q(".md-prose a") as HTMLElement;
    expect(link.textContent).toBe("link to b");
    // happy-dom has no hit-testing: the point under the pointer is inside the link's text.
    const hit = link.firstChild as Text;
    const doc = document as unknown as Record<string, unknown>;
    doc.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(hit, 3);
      r.setEnd(hit, 3);
      return r;
    };
    try {
      window.getSelection()?.removeAllRanges();
      expect(await rightClick(link)).toBe(false);
      expect(menu()).toBeNull();
      // With its words selected too, which ours would otherwise offer a note on.
      await settle(() => {
        const r = document.createRange();
        r.setStart(hit, 0);
        r.setEnd(hit, 4);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(r);
        document.dispatchEvent(new window.Event("selectionchange"));
      });
      expect(await rightClick(link)).toBe(false);
      expect(menu()).toBeNull();
      window.getSelection()?.removeAllRanges();
      // Beside the link, the same point in plain text opens ours.
      const plain = link.previousSibling as Text;
      doc.caretRangeFromPoint = () => {
        const r = document.createRange();
        r.setStart(plain, 2);
        r.setEnd(plain, 2);
        return r;
      };
      expect(await rightClick(q(".md-prose p") as HTMLElement)).toBe(true);
      expect(menu()).not.toBeNull();
    } finally {
      delete doc.caretRangeFromPoint;
    }
    await m.unmount();
  });

  test("an ended session with no selection leaves the right-click to the browser", async () => {
    startMode = "rendered";
    const m = await start();
    client?.send({ op: "close" });
    await waitFor(() => client?.connection === "ended", "ended");
    const prose = q(".md-prose") as HTMLElement;
    const walker = document.createTreeWalker(prose, 4);
    let node: Node | null = walker.nextNode();
    while (node && !(node.textContent ?? "").includes("here")) node = walker.nextNode();
    const hit = node as Text;
    const doc = document as unknown as Record<string, unknown>;
    doc.caretRangeFromPoint = () => {
      const r = document.createRange();
      r.setStart(hit, hit.data.indexOf("here"));
      r.setEnd(hit, hit.data.indexOf("here"));
      return r;
    };
    try {
      window.getSelection()?.removeAllRanges();
      expect(await rightClick(prose)).toBe(false);
      expect(menu()).toBeNull();
    } finally {
      delete doc.caretRangeFromPoint;
    }
    await m.unmount();
  });
});

describe("in a CRLF file, the menu's offsets stay in the daemon's count", () => {
  const daemonText = () => {
    const slug = client?.state?.openDoc ?? "";
    return daemon.session.readVersion(slug, daemon.session.doc(slug).active).text;
  };

  test("Insert a link at a caret after a CRLF line lands at the caret", async () => {
    const m = await start("d.md");
    await caretAt(text().indexOf("second"));
    await rightClick(view().contentDOM);
    await click(item("Insert a link"));
    await waitFor(() => picker() !== null && options().length > 0, "the picker's documents");
    await typeInto(labelField() as HTMLInputElement, "x");
    await typeInto(docField() as HTMLInputElement, "b");
    await key(docField(), "Enter");
    expect(text()).toBe("# D\n\nfirst line\n[x](./part/b.md)second line here\n");
    await waitFor(() => daemonText().includes("[x]("), "the daemon's text");
    // Whatever line endings the write keeps, the link is at the caret.
    expect(daemonText().replace(/\r\n/g, "\n")).toBe(text());
    await m.unmount();
  });

  test("Cut and Paste across a CRLF line take and put back exactly the selection", async () => {
    const m = await start("d.md");
    await select("line\nsecond");
    await rightClick(view().contentDOM);
    expect(items()).toContain("Cut");
    await click(item("Cut"));
    await waitFor(() => text() === "# D\n\nfirst  line here\n", "the cut");
    expect(clipboard.text).toBe("line\nsecond");
    await caretAt(text().indexOf(" line here"));
    await rightClick(view().contentDOM);
    await click(item("Paste"));
    await waitFor(() => text() === "# D\n\nfirst line\nsecond line here\n", "the paste");
    await m.unmount();
  });

  test("Add note over a CRLF-spanning selection anchors on the selected words", async () => {
    const m = await start("d.md");
    await select("line\nsecond");
    await rightClick(view().contentDOM);
    await click(item("Add note"));
    await typeInto(q("textarea") as HTMLTextAreaElement, "across the break");
    await click(item("Add note"));
    const notes = () => client?.state?.docs.find((d) => d.slug === client?.state?.openDoc)?.notes;
    await waitFor(() => (notes()?.length ?? 0) > 0, "the note");
    const n = notes()?.[0];
    expect(D.slice(n?.from ?? 0, n?.to ?? 0)).toBe("line\r\nsecond");
    await m.unmount();
  });

  test("inside a link after CRLF lines, the link act is off; just past it, on", async () => {
    const m = await start("e.md");
    // A count off by one per line above would land these on the wrong side of the link.
    await caretAt(text().indexOf("a link") + 1);
    await rightClick(view().contentDOM);
    expect(item("Insert a link")?.disabled).toBe(true);
    await settle(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });
    await caretAt(text().indexOf(" end"));
    await rightClick(view().contentDOM);
    expect(item("Insert a link")?.disabled).toBe(false);
    await settle(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });
    await caretAt(text().indexOf("see [") + 4);
    await rightClick(view().contentDOM);
    expect(item("Insert a link")?.disabled).toBe(false);
    await m.unmount();
  });
});
