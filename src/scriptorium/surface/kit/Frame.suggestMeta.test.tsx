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
import { ADD_A_BLOCK, NO_FRONTMATTER, noFrontmatterOf, scriptoriumTextOffer } from "./suggestMeta";
import { reseedPrefs, seedPrefs } from "./testPrefs";

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
  // These tests type into the raw editor: they start there (`./testPrefs.ts`).
  seedPrefs(join(root, "home"), { "doc:view": "raw" });
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
  await reseedPrefs(join(root, "home"), { "doc:view": "raw" });
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
    seedPrefs(join(root, "home"), { "doc:view": "rendered" });
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
    seedPrefs(join(root, "home"), { "doc:view": "rendered" });
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

/** A second tab: its own daemon client and frame, beside the first. */
let second: Daemon | null = null;
function SecondTab() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  second = d;
  return (
    <div style={{ width: 1400, height: 800 }}>
      <Frame daemon={d} />
    </div>
  );
}

describe("two tabs: the offer follows the daemon, not one tab's copy", () => {
  test("one tab takes it and types on; the other tab's offer goes, and the typing is kept", async () => {
    const path = join(notes, "twotab.md");
    const original = "# Two tabs\n\nProse.\n";
    const one = await openFile(path, original, "Prose.");
    const two = await mount(<SecondTab />);
    await waitFor(() => second?.state?.openDoc === openDoc()?.slug, "the second tab's state");
    const offerIn = (m: { container: HTMLElement }) =>
      m.container.querySelector('[data-slot="text-offer"]');
    const editorIn = (m: { container: HTMLElement }) =>
      EditorView.findFromDOM(m.container.querySelector(".cm-editor") as HTMLElement) as EditorView;
    await waitFor(() => offerIn(one) !== null && offerIn(two) !== null, "both tabs offer");
    await click(offerIn(one)?.querySelector("button") ?? null);
    await waitFor(() => editorIn(one).state.doc.toString().startsWith("---\n"), "tab one's block");
    await settle(() => {
      const v = editorIn(one);
      v.dispatch({ changes: { from: v.state.doc.length, insert: "MORE FROM TAB ONE\n" } });
    });
    // The daemon's broadcast takes the offer from the tab that never saw the edit.
    await waitFor(() => offerIn(two) === null, "tab two's offer gone");
    expect(readFileSync(path, "utf8")).toBe(original);
    const saveIn = () =>
      [...one.container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save") as
        | HTMLButtonElement
        | undefined;
    await waitFor(() => saveIn()?.disabled === false, "Save on in tab one");
    await click(saveIn() ?? null);
    await waitFor(() => readFileSync(path, "utf8").includes("MORE FROM TAB ONE"), "saved");
    const saved = readFileSync(path, "utf8");
    expect(saved.match(/^---$/gm)?.length).toBe(2);
    expect(saved.endsWith(`---\n${original}MORE FROM TAB ONE\n`)).toBe(true);
    await two.unmount();
    await one.unmount();
  }, 20_000);

  test("the daemon's list: an open document leaves it when its active version gains a block", async () => {
    const path = join(notes, "listed.md");
    const m = await openFile(path, "# Listed\n\nText.\n", "Text.");
    const slug = openDoc()?.slug as string;
    expect(noFrontmatterOf(client?.state)).toContain(slug);
    await settle(() => {
      client?.send({
        op: "edit",
        doc: slug,
        version: openDoc()?.active as number,
        text: "---\ntype: x\n---\n# Listed\n",
      });
    });
    await waitFor(() => !noFrontmatterOf(client?.state).includes(slug), "off the list");
    // A block that cannot be read is a block: still off.
    await settle(() => {
      client?.send({
        op: "edit",
        doc: slug,
        version: openDoc()?.active as number,
        text: "---\n: : :\n---\n# Listed\n",
      });
    });
    await settle(() => new Promise((r) => setTimeout(r, 400)));
    expect(noFrontmatterOf(client?.state)).not.toContain(slug);
    await m.unmount();
  });
});

describe("the offer's rule is the shipped header's", () => {
  const ask = scriptoriumTextOffer(
    {
      request: async () => {
        throw new Error("not asked");
      },
    },
    ["a"],
  );
  const doc = { slug: "a", original: "/x/a.md" } as DocView;
  test("no block: offered; a block, readable or not, or an empty one: not", () => {
    expect(ask(doc, "# A\n")?.label).toBe(ADD_A_BLOCK);
    expect(ask(doc, "")?.label).toBe(ADD_A_BLOCK);
    expect(ask(doc, "---\ntype: a\n---\n")).toBeNull();
    expect(ask(doc, "---\n: : :\n---\n# A\n")).toBeNull();
    // The shipped reader's rule, not the kit's: a block with no key line is still a block.
    expect(ask(doc, "---\n\n---\nBody\n")).toBeNull();
  });
  test("a document the daemon says has a block is not offered, whatever this tab's copy says", () => {
    expect(ask({ ...doc, slug: "b" }, "# A\n")).toBeNull();
  });
});
