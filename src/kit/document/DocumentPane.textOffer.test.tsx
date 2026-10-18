// The pane's `textOffer` slot, in a DOM against a real fixture daemon: an app's
// offer is a line under the header; taking it puts the text it fetched at the
// top of the active version as the human's own edit, unsaved, in raw (through
// the editor, one undo step) and in the rendered view (through `writeText`).
// Nothing is written when the app answers null, when the offer has gone by the
// time the answer arrives, or for a JSON document; a throw is announced.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { useMemo } from "react";
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
import type { DocView } from "../workspace/protocol";
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { type AppView, DocumentPane, type TextOffer } from "./DocumentPane.tsx";

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
let world: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
let announced: [string, string | undefined][] = [];
/** The ops this test's client has sent, in order. */
let sent: string[] = [];
const Native = nativeGlobal<typeof WebSocket>("WebSocket");
class Recording extends Native {
  override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === "string") sent.push((JSON.parse(data) as { op: string }).op);
    super.send(data);
  }
}

beforeEach(async () => {
  root = tempRoot("document-pane-offer");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  const ws = testWorkspace(root, "ws");
  world = join(ws, "world");
  mkdirSync(world, { recursive: true });
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
  announced = [];
  sent = [];
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

const HEAD = "HEAD\n";

/** The app's slot: offered while the text does not start with HEAD. */
type Slot = (doc: DocView, text: string) => TextOffer | null;
const offering =
  (take: TextOffer["take"]): Slot =>
  (_doc, text) =>
    text.startsWith(HEAD) ? null : { id: "head", message: "No head.", label: "Add one", take };

function Host({ slot, appView }: { slot: Slot; appView?: AppView }) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: Recording as typeof WebSocket,
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
    announce: (title, message) => {
      announced.push([title, message]);
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
      <main data-pane="centre" tabIndex={-1} style={{ width: 900, height: 700 }}>
        <DocumentPane textOffer={slot} appView={appView} />
      </main>
    </WorkspaceContext.Provider>
  );
}

const q = (sel: string) => document.querySelector(sel);
const offer = () => q('[data-slot="text-offer"]');
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const take = () => click(q('[data-slot="text-offer"] button'));
const viewOf = () => EditorView.findFromDOM(q(".cm-editor") as HTMLElement) as EditorView;
const active = () => {
  const d = daemon.session.doc("story");
  return readFileSync(d.versions.find((v) => v.n === d.active)?.path ?? "", "utf8");
};

async function open(slot: Slot, name = "story.md", text = "Body.\n", appView?: AppView) {
  const path = join(world, name);
  writeFileSync(path, text);
  await mount(<Host slot={slot} appView={appView} />);
  await waitFor(() => client?.state !== null && client?.connection === "open", "the hello");
  await settle(() => {
    client?.send({ op: "context.add", path: world });
  });
  await waitFor(() => (client?.state?.context.length ?? 0) === 1, "the set");
  await settle(() => {
    client?.send({ op: "open", path });
  });
  await waitFor(() => (q('[data-pane="centre"]')?.textContent ?? "").includes("Body."), "the text");
  // The open's own text frames, all in: an edit made while one is still on its
  // way is overwritten in the client's copy by it (the client's race, not the
  // slot's; the daemon keeps the edit).
  await Bun.sleep(200);
  return path;
}

describe("textOffer: an app's offer of text for the top of the document", () => {
  test("raw: shown under the header; taken, it goes in through the editor, unsaved, one undo step", async () => {
    const path = await open(offering(async () => HEAD));
    await waitFor(() => offer() !== null, "the offer");
    expect(offer()?.getAttribute("data-offer")).toBe("head");
    expect(offer()?.textContent).toBe("No head.Add one");
    await take();
    await waitFor(() => viewOf().state.doc.toString() === `${HEAD}Body.\n`, "the editor");
    await waitFor(() => active() === `${HEAD}Body.\n`, "the active version");
    expect(readFileSync(path, "utf8")).toBe("Body.\n");
    await waitFor(() => offer() === null, "the offer spent");
    await settle(() => {
      undo(viewOf());
    });
    expect(viewOf().state.doc.toString()).toBe("Body.\n");
  });

  test("rendered: taken, it goes in through writeText, and the file waits for Save", async () => {
    localStorage.setItem("spellbook:view-mode", "rendered");
    const path = await open(offering(() => HEAD));
    expect(q(".cm-editor")).toBeNull();
    await waitFor(() => offer() !== null, "the offer");
    await take();
    await waitFor(() => active() === `${HEAD}Body.\n`, "the active version");
    expect(readFileSync(path, "utf8")).toBe("Body.\n");
    await waitFor(() => offer() === null, "the offer spent");
  });

  test("an answer of null writes nothing", async () => {
    await open(offering(() => null));
    await waitFor(() => offer() !== null, "the offer");
    await take();
    await settle(() => {});
    expect(active()).toBe("Body.\n");
    expect(offer()).not.toBeNull();
  });

  test("a throw is announced with its message, and nothing is written", async () => {
    await open(
      offering(async () => {
        throw new Error("story.md already has one");
      }),
    );
    await waitFor(() => offer() !== null, "the offer");
    await take();
    await waitFor(() => announced.length > 0, "the announcement");
    expect(announced).toEqual([["Not done: Add one", "story.md already has one"]]);
    expect(active()).toBe("Body.\n");
  });

  test("an offer gone by the time its answer arrives writes nothing", async () => {
    let answer: (s: string) => void = () => {};
    await open(offering(() => new Promise<string>((r) => (answer = r))));
    await waitFor(() => offer() !== null, "the offer");
    await take();
    // The human types the head themselves while the answer is on its way.
    await settle(() => viewOf().dispatch({ changes: { from: 0, insert: HEAD } }));
    await settle(() => answer("OTHER\n"));
    await settle(() => {});
    expect(viewOf().state.doc.toString()).toBe(`${HEAD}Body.\n`);
  });

  test("a JSON document is not asked", async () => {
    let asked = 0;
    const slot: Slot = (doc, text) => {
      asked++;
      return offering(() => HEAD)(doc, text);
    };
    await open(slot, "data.json", '{ "a": "Body." }\n');
    expect(asked).toBe(0);
    expect(offer()).toBeNull();
  });

  test("while the app's own view is showing, nothing is offered", async () => {
    const view: AppView = {
      id: "board",
      label: "Board",
      icon: null,
      active: true,
      onActive: () => {},
      render: () => <p>The app's view. Body.</p>,
    };
    await open(
      offering(() => HEAD),
      "story.md",
      "Body.\n",
      view,
    );
    await waitFor(() => q('[data-slot="app-view"]') !== null, "the app's view");
    expect(offer()).toBeNull();
  });

  test("an answer that arrives after another version became active writes nothing", async () => {
    let answer: (s: string) => void = () => {};
    await open(offering(() => new Promise<string>((r) => (answer = r))));
    await waitFor(() => offer() !== null, "the offer");
    await take();
    // Another version is made and made active while the answer is on its way.
    await settle(() => {
      client?.send({ op: "version.new", doc: "story", activate: true });
    });
    await waitFor(() => daemon.session.doc("story").active === 2, "v2 active");
    await waitFor(() => client?.state?.docs[0]?.active === 2, "the client sees v2");
    await settle(() => answer(HEAD));
    await settle(() => new Promise((r) => setTimeout(r, 400)));
    const d = daemon.session.doc("story");
    for (const v of d.versions) expect(readFileSync(v.path, "utf8")).toBe("Body.\n");
  });

  test("taken, the text is sent at once, not after the typing pause", async () => {
    localStorage.setItem("spellbook:view-mode", "rendered");
    await open(offering(() => HEAD));
    await waitFor(() => offer() !== null, "the offer");
    sent = [];
    await take();
    // The take resolves at once, and the edit has gone with it: without the
    // flush it would wait out the client's 250 ms pause.
    await settle(() => {});
    expect(sent).toContain("edit");
    await waitFor(() => active() === `${HEAD}Body.\n`, "the active version");
  });

  test("rendered: taken there, one undo in the raw editor takes it back", async () => {
    localStorage.setItem("spellbook:view-mode", "rendered");
    await open(offering(() => HEAD));
    await waitFor(() => offer() !== null, "the offer");
    await take();
    await waitFor(() => active() === `${HEAD}Body.\n`, "the active version");
    await click(q('button[aria-label="Raw text"]'));
    await waitFor(
      () => !!q(".cm-editor") && viewOf().state.doc.toString() === `${HEAD}Body.\n`,
      "the raw editor",
    );
    await settle(() => {
      undo(viewOf());
    });
    expect(viewOf().state.doc.toString()).toBe("Body.\n");
    await waitFor(() => active() === "Body.\n", "the undo written");
  });
});
