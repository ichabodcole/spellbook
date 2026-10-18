// A link that is only `#heading`, in the rendered document, against a REAL
// workspace daemon (kit-heading-links-build): it stays in the document and asks
// for the heading to be revealed, with nothing sent to the daemon; a footnote
// still jumps by its id; a heading that is not there says so.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EditorView } from "@codemirror/view";
import { useMemo } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import type { Reveal } from "../context/selection.ts";
import { useDaemon } from "../context/useDaemon.ts";
import { type Workspace, WorkspaceContext } from "../context/workspace.ts";
import { onMac } from "../lib/platform.ts";
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
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";

beforeAll(() => {
  installDom();
  // CodeMirror measures text with ranges, which happy-dom does not lay out.
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
  (document as unknown as Record<string, unknown>).elementFromPoint ??= () => null;
});
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

const A = [
  "# A",
  "",
  "[up](#Stacking%20lenses) and [nowhere](#Not%20here) and a note.[^1]",
  "",
  "Raw: [site](https://example.com/x) and [op](op:doc/01a0) and [b](./part/b.md).",
  "",
  "## How lenses work",
  "",
  "### Stacking lenses",
  "",
  "body",
  "",
  "[^1]: The note.",
  "",
].join("\n");

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
let sent: { op?: string; [k: string]: unknown }[];
let reveals: Omit<Reveal, "seq">[];
let said: string[];
let client: Daemon | null = null;
let paneMode: "rendered" | "raw" = "rendered";

beforeEach(async () => {
  root = tempRoot("pane-headings");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  writeFileSync(join(docs, "set", "a.md"), A);
  localStorage.clear();
  sent = [];
  reveals = [];
  paneMode = "rendered";
  said = [];
  client = null;
  // The seeded folder is the workspace, so its set is in the context from the start.
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs });
  await daemon.start();
  daemon.session.addContext(join(docs, "set"));
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Recording(url: string, protocols?: string | string[]) {
  const ws = new (nativeGlobal<typeof WebSocket>("WebSocket"))(url, protocols);
  const send = ws.send.bind(ws);
  ws.send = (data) => {
    try {
      sent.push(JSON.parse(String(data)));
    } catch {
      /* not a frame */
    }
    send(data);
  };
  return ws;
}

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: Recording as unknown as typeof WebSocket,
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
    requestReveal: (r) => {
      reveals.push(r);
    },
    revealApplied: () => {},
    toasts,
    announce: (title, body) => {
      said.push(`${title}: ${body ?? ""}`);
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
      <main data-pane="centre" style={{ width: 900, height: 700 }}>
        <DocumentPane mode={paneMode} />
      </main>
    </WorkspaceContext.Provider>
  );
}

const link = (label: string) =>
  [...document.querySelectorAll(".md-prose a")].find((a) => a.textContent === label) ?? null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

async function openA() {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path: join(docs, "set", "a.md") });
  });
  await waitFor(() => link("up") !== null, "the rendered links");
  return m;
}

describe("a fragment-only link in the rendered document", () => {
  test("goes to the heading in this document, caret at its start, its line to mark, nothing sent", async () => {
    const m = await openA();
    await click(link("up"));
    const at = A.indexOf("### Stacking lenses");
    expect(reveals).toEqual([
      {
        doc: "a",
        version: 1,
        from: at,
        to: at,
        heading: { from: at, to: at + "### Stacking lenses".length },
      },
    ]);
    expect(sent.some((f) => f.op === "link.open")).toBe(false);
    await m.unmount();
  });

  test("a heading that is not there says so, and moves nothing", async () => {
    const m = await openA();
    await click(link("nowhere"));
    expect(reveals).toEqual([]);
    expect(said).toEqual(["Heading not found: No heading “Not here” in a.md."]);
    await m.unmount();
  });

  test("a footnote still jumps by its id, and asks for no heading", async () => {
    const m = await openA();
    const ref = document.querySelector('.md-prose a[href*="fn"]');
    await click(ref);
    expect(reveals).toEqual([]);
    expect(said).toEqual([]);
    await m.unmount();
  });
});

describe("Mod-click in the raw editor", () => {
  /** Mod-click at the offset of `text` in the editor, as a pointer would. */
  async function modClick(text: string) {
    const dom = document.querySelector(".cm-editor") as HTMLElement;
    const view = EditorView.findFromDOM(dom) as EditorView;
    const at = view.state.doc.toString().indexOf(text) + 1;
    // happy-dom lays nothing out, so the pointer's position is given.
    view.posAtCoords = (() => at) as typeof view.posAtCoords;
    const mod = onMac() ? { metaKey: true } : { ctrlKey: true };
    await settle(() => {
      view.contentDOM.dispatchEvent(
        new window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...mod }),
      );
    });
  }
  async function openRaw() {
    paneMode = "raw";
    const m = await mount(<Host />);
    await waitFor(() => client?.connection === "open", "the connection");
    await settle(() => {
      client?.send({ op: "open", path: join(docs, "set", "a.md") });
    });
    await waitFor(() => document.querySelector(".cm-editor") !== null, "the editor");
    return m;
  }

  test("a web address opens outward, never at the daemon", async () => {
    const opened: unknown[][] = [];
    const was = window.open;
    window.open = ((...a: unknown[]) => {
      opened.push(a);
      return null;
    }) as typeof window.open;
    try {
      const m = await openRaw();
      await modClick("site]");
      expect(opened).toEqual([["https://example.com/x", "_blank", "noopener,noreferrer"]]);
      expect(sent.some((f) => f.op === "link.open")).toBe(false);
      await m.unmount();
    } finally {
      window.open = was;
    }
  });

  test("a scheme nothing here opens does nothing but say so", async () => {
    const m = await openRaw();
    await modClick("op]");
    expect(sent.some((f) => f.op === "link.open")).toBe(false);
    expect(said).toEqual([
      "That link doesn't open here: op:doc/01a0 is not a document or a web address.",
    ]);
    await m.unmount();
  });

  test("a path goes to the daemon as written, and #heading stays in the document", async () => {
    const m = await openRaw();
    await modClick("b]");
    expect(sent.find((f) => f.op === "link.open")).toMatchObject({
      target: "./part/b.md",
      doc: "a",
    });
    await modClick("up]");
    const at = A.indexOf("### Stacking lenses");
    expect(reveals.at(-1)).toMatchObject({ from: at, to: at });
    await m.unmount();
  });
});
