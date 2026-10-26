// Sidebar rows dropped onto a document (kit-tree-drag-into-document), in a DOM
// against a REAL workspace daemon: an image row is embedded at the drop point,
// relative to the document, its file untouched, and one undo takes it back; an
// image in another set is refused with a notice; a document or folder row
// writes nothing, and nor does the text the browser may carry beside it. Also
// the payload itself: the kit's row type, written and read back.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { createRef, useMemo, useState } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import {
  carriesRows,
  type DraggedRow,
  encodeRowDrag,
  ROW_DRAG_MIME,
  readRowDrag,
  rowKindOf,
  writeRowDrag,
} from "../context/rowDrag.ts";
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
import { pngBytes } from "../lib/testImages.ts";
import { createToastStore } from "../ui/toast-store.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";
import type { EditorHandle } from "./DocumentView.tsx";
import type { ViewMode } from "./pane.ts";

beforeAll(() => {
  installDom();
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
let other: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
let announced: { title: string; body?: string }[];
let startMode: ViewMode = "raw";
const editor = createRef<EditorHandle>();

const A = "# A\n\nbefore after\n";

beforeEach(async () => {
  root = tempRoot("pane-row-drop");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  set = join(root, "docs", "set");
  other = join(root, "docs", "other");
  mkdirSync(join(set, "images"), { recursive: true });
  mkdirSync(other, { recursive: true });
  writeFileSync(join(set, "a.md"), A);
  writeFileSync(join(set, "b.md"), "# B\n");
  writeFileSync(join(set, "images", "fox den.png"), pngBytes(4, 4));
  writeFileSync(join(other, "stray.png"), pngBytes(4, 4));
  localStorage.clear();
  client = null;
  announced = [];
  startMode = "raw";
  // The session's workspace is the folder that holds the set.
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: join(root, "docs") });
  await daemon.start();
  daemon.session.addContext(set);
  daemon.session.addContext(other);
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
    announce: (title, body) => {
      announced.push({ title, ...(body ? { body } : {}) });
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
        <DocumentPane mode={mode} splitView editor={editor} />
      </main>
    </WorkspaceContext.Provider>
  );
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const view = () => EditorView.findFromDOM(q(".cm-editor") as HTMLElement) as EditorView;
const text = () => view().state.doc.toString();
const openName = () => client?.state?.docs.find((d) => d.slug === client?.state?.openDoc)?.name;
const entryId = (root: string) => daemon.session.context.find((e) => e.root === root)?.id ?? "";

async function start() {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path: join(set, "a.md") });
  });
  await waitFor(() => openName() === "a.md" && text().length > 0, "a.md open");
  await waitFor(
    () => q(".cm-content")?.getAttribute("contenteditable") === "true",
    "the editable editor",
  );
  return m;
}

const caretAt = async (at: number) => settle(() => view().dispatch({ selection: { anchor: at } }));

/**
 * A drop carrying rows, and the plain text a browser may put beside a drag: the
 * editor must write neither of its own accord.
 */
async function dropRows(target: Element, rows: DraggedRow[]) {
  const data: Record<string, string> = {
    [ROW_DRAG_MIME]: encodeRowDrag(rows),
    "text/plain": "STRAY",
    Text: "STRAY",
  };
  const dt = {
    types: [ROW_DRAG_MIME, "text/plain"],
    files: [],
    getData: (f: string) => data[f] ?? "",
  };
  let taken = false;
  await settle(() => {
    const over = new window.Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(over, "dataTransfer", { value: dt });
    target.dispatchEvent(over);
    taken = over.defaultPrevented;
    const ev = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    target.dispatchEvent(ev);
  });
  return taken;
}

describe("the row payload", () => {
  test("is written under the kit's type and read back, typed", () => {
    const store = new Map<string, string>();
    const rows: DraggedRow[] = [
      { entry: "e1", path: "/w/images/fox.png", kind: "image" },
      { entry: "e1", path: "/w/places", kind: "folder" },
    ];
    writeRowDrag({ setData: (f, v) => store.set(f, v) }, rows);
    expect([...store.keys()]).toEqual([ROW_DRAG_MIME]);
    expect(readRowDrag({ getData: (f) => store.get(f) ?? "" })).toEqual(rows);
    expect(carriesRows({ types: [ROW_DRAG_MIME] } as unknown as DataTransfer)).toBe(true);
    expect(carriesRows({ types: ["Files"] } as unknown as DataTransfer)).toBe(false);
    expect(carriesRows(null)).toBe(false);
  });

  test("a malformed row or an unknown kind is left out; nothing readable is null", () => {
    const read = (raw: string) => readRowDrag({ getData: () => raw });
    expect(read("")).toBeNull();
    expect(read("not json")).toBeNull();
    expect(read('{"rows":"x"}')).toBeNull();
    expect(
      read(
        JSON.stringify({
          rows: [
            { entry: "e", path: "/a.md", kind: "document" },
            { entry: "e", path: "/b", kind: "board" },
            { entry: "e", path: "", kind: "image" },
            { path: "/c.png", kind: "image" },
          ],
        }),
      ),
    ).toEqual([{ entry: "e", path: "/a.md", kind: "document" }]);
  });

  test("a tree node's kind: a group is a folder", () => {
    expect(rowKindOf({ kind: "doc" })).toBe("document");
    expect(rowKindOf({ kind: "image" })).toBe("image");
    expect(rowKindOf({ kind: "group" })).toBe("folder");
  });
});

describe("an image row dropped onto the raw editor", () => {
  test("is embedded at the drop point, relative and encoded, the file left where it was", async () => {
    await start();
    const at = A.indexOf(" after");
    await caretAt(at);
    const fox = join(set, "images", "fox den.png");
    const taken = await dropRows(view().contentDOM, [
      { entry: entryId(set), path: fox, kind: "image" },
    ]);
    expect(taken).toBe(true);
    await waitFor(() => text().includes("!["), "the embed");
    expect(text()).toBe(`${A.slice(0, at)}![fox den](./images/fox%20den.png) after\n`);
    expect(readdirSync(join(set, "images"))).toEqual(["fox den.png"]);
    expect(announced).toEqual([]);
    // An ordinary edit: one undo takes it back.
    await settle(() => {
      undo(view());
    });
    expect(text()).toBe(A);
  });

  test("an image in another set is refused with a notice, and nothing is written", async () => {
    await start();
    await caretAt(A.length);
    await dropRows(view().contentDOM, [
      { entry: entryId(other), path: join(other, "stray.png"), kind: "image" },
    ]);
    await waitFor(() => announced.length > 0, "the notice");
    expect(announced[0]?.title).toBe("Image not embedded");
    expect(announced[0]?.body).toContain("stray.png");
    expect(text()).toBe(A);
  });
});

describe("a document row", () => {
  test("inserts a link at the drop point, its title as the text, and one undo removes it", async () => {
    await start();
    const at = A.indexOf(" after");
    await caretAt(at);
    const taken = await dropRows(view().contentDOM, [
      { entry: entryId(set), path: join(set, "b.md"), kind: "document" },
    ]);
    expect(taken).toBe(true);
    await waitFor(() => text().includes("[B]"), "the link");
    expect(text()).toBe(`${A.slice(0, at)}[B](./b.md) after\n`);
    expect(text()).not.toContain("STRAY");
    expect(announced).toEqual([]);
    await settle(() => {
      undo(view());
    });
    expect(text()).toBe(A);
  });
});

describe("rows that write nothing", () => {
  test("a folder row inserts nothing, and no stray text", async () => {
    await start();
    await caretAt(A.length);
    // Laid out, as in a browser: the editor's own drop would put the text here.
    const v = view();
    v.posAtCoords = (() => A.length) as typeof v.posAtCoords;
    await dropRows(v.contentDOM, [
      { entry: entryId(set), path: join(set, "images"), kind: "folder" },
    ]);
    await settle(() => {});
    expect(text()).toBe(A);
    expect(announced).toEqual([]);
  });

  test("the rendered view hints at the raw view for an image row, and writes nothing", async () => {
    startMode = "rendered";
    const m = await mount(<Host />);
    await waitFor(() => client?.connection === "open", "the connection");
    await settle(() => {
      client?.send({ op: "open", path: join(set, "a.md") });
    });
    await waitFor(() => !!q(".md-prose"), "the rendered view");
    await dropRows(q(".md-prose") as HTMLElement, [
      { entry: entryId(set), path: join(set, "images", "fox den.png"), kind: "image" },
    ]);
    expect(announced.map((a) => a.title)).toEqual(["Paste images in the raw view"]);
    await m.unmount();
  });
});
