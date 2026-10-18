// Pasting and dropping images into the raw editor (kit-image-paste), in a DOM
// against a REAL workspace daemon: a paste is written to `images/` beside the
// document under a dated name and embedded at the caret; a drop keeps its name
// (made unique) and lands where it was dropped; several are one embed a line
// and one undo step; undo leaves the file; refusals are a notice and no embed;
// a JSON document and the rendered view take none.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { createRef, useMemo, useState } from "react";
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
import { pngBytes } from "../lib/testImages.ts";
import { createToastStore } from "../ui/toast-store.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";
import type { EditorHandle } from "./DocumentView.tsx";
import { clipboardImages, extensionForType, isImageLike, pastedImageName } from "./imagePaste.ts";
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
  // CodeMirror reads a file dropped on a JSON document with FileReader;
  // happy-dom's reads only its own Blob, and the files here are the runtime's.
  (window as unknown as Record<string, unknown>).FileReader = class {
    result: string | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsText(b: Blob) {
      b.text().then(
        (t) => {
          this.result = t;
          this.onload?.();
        },
        () => this.onerror?.(),
      );
    }
  };
});
afterAll(async () => {
  await removeDom();
});

let root: string;
let set: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
let announced: { title: string; body?: string }[];
let startMode: ViewMode = "raw";
const editor = createRef<EditorHandle>();

const A = "# A\n\nbefore after\n";

beforeEach(async () => {
  root = tempRoot("pane-image-paste");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  set = join(root, "docs", "set");
  mkdirSync(join(set, "part"), { recursive: true });
  writeFileSync(join(set, "a.md"), A);
  writeFileSync(join(set, "part", "b.md"), "# B\n\n");
  writeFileSync(join(set, "data.json"), '{\n  "a": 1\n}\n');
  localStorage.clear();
  client = null;
  announced = [];
  startMode = "raw";
  // The set is a top-level entry of the workspace: every file of a session
  // lives inside it.
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    workspace: join(root, "docs"),
    imageArrivalMs: 30,
  });
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

async function start(rel = "a.md") {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path: join(set, rel) });
  });
  await waitFor(() => openName() === rel.split("/").pop() && text().length > 0, `${rel} open`);
  await waitFor(
    () => q(".cm-content")?.getAttribute("contenteditable") === "true",
    "the editable editor",
  );
  return m;
}

const png = (name: string, type = "image/png") => new File([pngBytes(6, 6)], name, { type });
const caretAt = async (at: number) => settle(() => view().dispatch({ selection: { anchor: at } }));

async function paste(target: Element, files: File[], html = "") {
  await settle(() => {
    const ev = new window.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { files, types: ["Files"], getData: (f: string) => (f === "text/html" ? html : "") },
    });
    target.dispatchEvent(ev);
  });
}
async function drop(target: Element, files: File[]) {
  const dt = { types: ["Files"], files, getData: () => "" };
  await settle(() => {
    const ev = new window.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    target.dispatchEvent(ev);
  });
}

const DATED = /^pasted-\d{4}-\d{2}-\d{2}-\d{6}\.png$/;

describe("the pure parts", () => {
  test("a pasted image is named by local date and time, with the type's extension", () => {
    const at = new Date(2026, 9, 5, 15, 32, 10);
    expect(pastedImageName(at, "image/png")).toBe("pasted-2026-10-05-153210.png");
    expect(pastedImageName(at, "image/jpeg")).toBe("pasted-2026-10-05-153210.jpg");
    expect(extensionForType("image/svg+xml")).toBe(".svg");
    expect(extensionForType("")).toBe(".png");
  });

  test("a clipboard with words of its own beside the picture pastes as text", () => {
    const f = [png("image.png")];
    const clip = (html: string) => ({ files: f, getData: () => html });
    expect(clipboardImages(clip(""))).toHaveLength(1);
    expect(clipboardImages(clip('<img src="x.png">'))).toHaveLength(1);
    expect(clipboardImages(clip("<table><td>Sales</td></table>"))).toHaveLength(0);
    expect(clipboardImages({ files: [new File(["x"], "a.txt")], getData: () => "" })).toEqual([]);
  });
});

describe("pasting an image", () => {
  test("writes it to images/ under a dated name, the folder made, and embeds it at the caret", async () => {
    await start();
    expect(existsSync(join(set, "images"))).toBe(false);
    const at = A.indexOf(" after");
    await caretAt(at);
    await paste(view().contentDOM, [png("image.png")]);
    await waitFor(() => text().includes("!["), "the embed");
    const files = readdirSync(join(set, "images"));
    expect(files).toHaveLength(1);
    const name = files[0] as string;
    expect(name).toMatch(DATED);
    const stem = name.replace(/\.png$/, "");
    expect(text()).toBe(`${A.slice(0, at)}![${stem}](./images/${name}) after\n`);
    // The rendered view would draw it: the daemon's tree shows the image.
    expect(daemon.session.context[0]?.nodes.some((n) => n.rel === "images")).toBe(true);
  });

  test("undo removes the embed in one step; the file stays", async () => {
    await start();
    await caretAt(A.length);
    await paste(view().contentDOM, [png("image.png"), png("image.png")]);
    await waitFor(() => (text().match(/!\[/g) ?? []).length === 2, "two embeds");
    // Several at once: one embed to a line.
    const added = text().slice(A.length);
    expect(added.split("\n")).toHaveLength(2);
    expect(added).toMatch(/^!\[pasted-[^\]]+\]\(\.\/images\/pasted-[^)]+\.png\)\n!\[pasted-/);
    await settle(() => {
      undo(view());
    });
    expect(text()).toBe(A);
    expect(readdirSync(join(set, "images"))).toHaveLength(2);
  });

  test("from a nested document, the path is relative to it", async () => {
    await start("part/b.md");
    await caretAt(text().length);
    await paste(view().contentDOM, [png("image.png")]);
    await waitFor(() => text().includes("!["), "the embed");
    const name = readdirSync(join(set, "part", "images"))[0] as string;
    expect(text()).toContain(`](./images/${name})`);
    expect(existsSync(join(set, "images"))).toBe(false);
  });

  test("a clipboard from a spreadsheet pastes its text as before", async () => {
    await start();
    await caretAt(A.length);
    await paste(view().contentDOM, [png("image.png")], "<table><td>Sales</td></table>");
    await settle(() => {});
    expect(existsSync(join(set, "images"))).toBe(false);
  });
});

describe("dropping images", () => {
  test("keeps the name, made unique when taken, with no question", async () => {
    mkdirSync(join(set, "images"));
    writeFileSync(join(set, "images", "fox.png"), pngBytes(4, 4));
    await start();
    await caretAt(A.length);
    await drop(view().contentDOM, [png("fox.png")]);
    await waitFor(() => text().includes("!["), "the embed");
    expect(text()).toContain("![fox 2](./images/fox%202.png)");
    expect(readdirSync(join(set, "images")).sort()).toEqual(["fox 2.png", "fox.png"]);
    expect(announced).toEqual([]);
  });

  test("SVG, a fake image and an oversized one are refused with a notice and no embed", async () => {
    await start();
    const svg = new File(["<svg xmlns='http://www.w3.org/2000/svg'/>"], "logo.svg", {
      type: "image/svg+xml",
    });
    const fake = new File(["not an image"], "fake.png", { type: "image/png" });
    const big = new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
    await drop(view().contentDOM, [svg, fake, big]);
    await waitFor(() => announced.length > 0, "the notice");
    expect(announced[0]?.title).toBe("Images not added");
    expect(announced[0]?.body).toContain("SVG is not brought in");
    expect(announced[0]?.body).toContain("fake.png was not added");
    expect(announced[0]?.body).toContain("larger than 20 MB");
    expect(text()).toBe(A);
    expect(existsSync(join(set, "images"))).toBe(false);
  });

  test("a file that is not an image is left to the editor, as before", () => {
    // The editor's own drop reads a text file in as text; it cannot be driven
    // here (nothing is laid out), so the decision that leaves it alone is checked.
    expect(isImageLike({ name: "notes.txt", type: "text/plain" })).toBe(false);
    expect(isImageLike({ name: "brief.pdf", type: "application/pdf" })).toBe(false);
    expect(isImageLike({ name: "photo.HEIC", type: "" })).toBe(true);
    expect(isImageLike({ name: "logo.svg", type: "image/svg+xml" })).toBe(true);
  });
});

describe("where images are not taken", () => {
  test("a JSON document pastes and drops as it always has", async () => {
    await start("data.json");
    await paste(view().contentDOM, [png("image.png")]);
    await drop(view().contentDOM, [png("fox.png")]);
    await settle(() => {});
    expect(text()).toBe('{\n  "a": 1\n}\n');
    expect(existsSync(join(set, "images"))).toBe(false);
    expect(announced).toEqual([]);
  });

  test("the rendered view refuses with a hint to use the raw view", async () => {
    startMode = "rendered";
    const m = await mount(<Host />);
    await waitFor(() => client?.connection === "open", "the connection");
    await settle(() => {
      client?.send({ op: "open", path: join(set, "a.md") });
    });
    await waitFor(() => !!q(".md-prose"), "the rendered view");
    await paste(q(".md-prose") as HTMLElement, [png("image.png")]);
    expect(announced.map((a) => a.title)).toEqual(["Paste images in the raw view"]);
    await drop(q(".md-prose") as HTMLElement, [png("fox.png")]);
    expect(announced).toHaveLength(2);
    expect(existsSync(join(set, "images"))).toBe(false);
    await m.unmount();
  });
});
