// "Add a block" (E35) in the flagged frame, against a REAL flagged daemon
// (`kitDaemon`, in this process, under a scratch SCRIPTORIUM_HOME), mounted in
// happy-dom: a document with no frontmatter is offered a block; taking it puts
// the daemon's suggestion at the top of the buffer, unsaved, in raw and in the
// rendered view, and the file changes only on Save. A document with a block,
// readable or not, is offered nothing.

import "../../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EditorView } from "@codemirror/view";
import type { Daemon } from "../../../kit/context/daemonClient";
import { useDaemon } from "../../../kit/context/useDaemon";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../../../kit/lib/testDom";
import type { DocView } from "../../../kit/workspace/protocol";
import type { WorkspaceDaemon } from "../../../kit/workspace/server";
import { tempRoot } from "../../../kit/workspace/testing";
import { kitDaemon } from "../../backend/kit/server";
import { Frame } from "./Frame";
import { ADD_A_BLOCK, NO_FRONTMATTER, scriptoriumTextOffer } from "./suggestMeta";

const root = tempRoot("scriptorium-frame-suggest");
const docs = join(root, "docs");
const notes = join(docs, "notes");
const savedHome = process.env.SCRIPTORIUM_HOME;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  installDom();
  const proto = window.Range.prototype as unknown as Record<string, unknown>;
  const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  proto.getClientRects = () => [];
  proto.getBoundingClientRect = () => ({ ...rect, toJSON() {} });
  const el = window.Element.prototype as unknown as Record<string, unknown>;
  el.getClientRects = el.getClientRects ?? (() => []);
  (document as unknown as Record<string, unknown>).elementFromPoint ??= () => null;
  process.env.SCRIPTORIUM_HOME = join(root, "home");
  mkdirSync(join(root, "tmp"), { recursive: true });
  mkdirSync(notes, { recursive: true });
  // A neighbour that says its type, so the suggestion has one to take.
  writeFileSync(join(notes, "said.md"), "---\ntype: memo\n---\n# Said\n");
  daemon = kitDaemon({
    tmp: join(root, "tmp"),
    drainGraceMs: 10,
    trash: async () => {
      throw new Error("no Trash in this test");
    },
  });
  await daemon.start();
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
});
afterAll(async () => {
  await daemon?.stop().catch(() => {});
  await removeDom();
  if (savedHome === undefined) delete process.env.SCRIPTORIUM_HOME;
  else process.env.SCRIPTORIUM_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
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
const all = (sel: string) => [...document.querySelectorAll(sel)];
const withText = (sel: string, text: string) =>
  all(sel).find((e) => (e.textContent ?? "").includes(text)) ?? null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const centre = () => q('[data-pane="centre"]')?.textContent ?? "";
const offer = () => q('[data-slot="text-offer"]');
const viewOf = () => EditorView.findFromDOM(q(".cm-editor") as HTMLElement) as EditorView;
const openDoc = (): DocView | null =>
  client?.state?.docs.find((d) => d.slug === client?.state?.openDoc) ?? null;

/** A fresh document at `path` with `text`, open in the frame's centre. */
async function openFile(path: string, text: string, body: string) {
  writeFileSync(path, text);
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open" && client.state !== null, "the hello");
  await settle(() => {
    client?.send({ op: "context.add", path: notes });
  });
  await waitFor(
    () =>
      client?.state?.context.some((e) => e.nodes.some((n) => join(e.root, n.rel) === path)) ===
      true,
    "the document in the context",
  );
  await settle(() => {
    client?.send({ op: "open", path });
  });
  await waitFor(
    () => openDoc()?.original === path && centre().includes(body),
    "the document on screen",
  );
  return m;
}

const save = () => click(q('button[aria-label^="Save"]') ?? withText("button", "Save"));

describe("Add a block (E35): offered, put in the buffer, written by Save", () => {
  test("raw: the daemon's suggestion goes at the top of the editor, unsaved; Save writes it", async () => {
    const path = join(notes, "bare.md");
    const original = "# The bare one\n\nBody.\n";
    const m = await openFile(path, original, "Body.");
    await waitFor(() => offer() !== null, "the offer");
    expect(offer()?.textContent).toBe(`${NO_FRONTMATTER}${ADD_A_BLOCK}`);
    await click(withText('[data-slot="text-offer"] button', ADD_A_BLOCK));
    const block = `---\ntype: memo\ntitle: The bare one\ndescription: \ntags: []\nstatus: draft\ngenerated: { by: human, at: ${today} }\n---\n`;
    await waitFor(
      () => viewOf().state.doc.toString() === `${block}${original}`,
      "the block in the editor",
    );
    await waitFor(() => openDoc()?.dirty === true, "unsaved");
    expect(readFileSync(path, "utf8")).toBe(original);
    // Once the buffer has a block, the offer is spent.
    await waitFor(() => offer() === null, "the offer gone");
    await save();
    await waitFor(() => readFileSync(path, "utf8") === `${block}${original}`, "the file saved");
    await m.unmount();
  });

  test("rendered: the same, with no editor mounted", async () => {
    localStorage.setItem("scriptorium:view-mode", "rendered");
    const path = join(notes, "seen.md");
    const original = "# Seen\n\nRead here.\n";
    const m = await openFile(path, original, "Read here.");
    expect(q(".cm-editor")).toBeNull();
    await waitFor(() => offer() !== null, "the offer");
    await click(withText('[data-slot="text-offer"] button', ADD_A_BLOCK));
    await waitFor(() => openDoc()?.dirty === true, "unsaved");
    await waitFor(() => q('[data-slot="frontmatter-header"]') !== null, "the header drawn");
    expect(offer()).toBeNull();
    expect(readFileSync(path, "utf8")).toBe(original);
    await save();
    await waitFor(() => readFileSync(path, "utf8").startsWith("---\ntype: "), "the file saved");
    expect(readFileSync(path, "utf8").endsWith(`---\n${original}`)).toBe(true);
    await m.unmount();
  });

  test("a document with a block is offered nothing", async () => {
    const m = await openFile(
      join(notes, "has.md"),
      "---\ntitle: Has\n---\n# Has\n\nKept.\n",
      "Kept.",
    );
    await settle(() => {});
    expect(offer()).toBeNull();
    expect(centre()).not.toContain(NO_FRONTMATTER);
    await m.unmount();
  });

  test("a block that cannot be read is offered nothing: the header shows it as written", async () => {
    localStorage.setItem("scriptorium:view-mode", "rendered");
    const m = await openFile(
      join(notes, "bad.md"),
      "---\ntype: [unclosed\n---\n# Bad\n\nStill.\n",
      "Still.",
    );
    await waitFor(
      () => q('[data-slot="frontmatter-header"][data-invalid]') !== null,
      "the invalid header",
    );
    expect(offer()).toBeNull();
    await m.unmount();
  });
});

describe("the offer's rule is the shipped header's", () => {
  const ask = scriptoriumTextOffer({
    request: async () => {
      throw new Error("not asked");
    },
  });
  const doc = { original: "/x/a.md" } as DocView;
  test("no block: offered; a block, readable or not, or an empty one: not", () => {
    expect(ask(doc, "# A\n")?.label).toBe(ADD_A_BLOCK);
    expect(ask(doc, "")?.label).toBe(ADD_A_BLOCK);
    expect(ask(doc, "---\ntype: a\n---\n")).toBeNull();
    expect(ask(doc, "---\n: : :\n---\n# A\n")).toBeNull();
    // The shipped reader's rule, not the kit's: a block with no key line is still a block.
    expect(ask(doc, "---\n\n---\nBody\n")).toBeNull();
  });
});
