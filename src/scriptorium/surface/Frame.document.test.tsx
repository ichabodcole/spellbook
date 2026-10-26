// The frame's centre against a REAL flagged daemon (`kitDaemon`, in this
// process, under a scratch SCRIPTORIUM_HOME), mounted in happy-dom: the kit's
// document pane opens what the tree opens, an edit reaches a version and Save
// the file, a selection in either view is the chat's chip and what `say`
// attaches, Notes adds a note on it (which consumes it), goes to a note and
// marks the one chosen, the trust and stale chips follow the document, and an
// outside change's toast opens compare against the file on disk.
//
// CodeMirror mounts under happy-dom with its layout reads stubbed, as in the
// kit's own pane tests.

import "../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EditorView } from "@codemirror/view";
import { useCallback, useRef } from "react";
import type { Daemon } from "../../kit/context/daemonClient";
import { useDaemon } from "../../kit/context/useDaemon";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  typeInto,
  waitFor,
} from "../../kit/lib/testDom";
import { type LaidOut, laidOut } from "../../kit/lib/testLayout";
import type { DocView, PublicState } from "../../kit/workspace/protocol";
import type { WorkspaceDaemon } from "../../kit/workspace/server";
import { tempRoot } from "../../kit/workspace/testing";
import { kitDaemon } from "../backend/kit/server";
import { Frame, scriptoriumChips, scriptoriumEndWarning } from "./Frame";
import { keptPrefs, reseedPrefs, seedPrefs } from "./testPrefs";

const root = tempRoot("scriptorium-frame-document");
const docs = join(root, "docs");
const plain = join(docs, "plain.md");
const kept = join(docs, "kept.md");
const savedHome = process.env.SCRIPTORIUM_HOME;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;

/** The panels laid out as a browser would, so the shell's columns can collapse (reader mode). */
let layout: LaidOut | null = null;

beforeAll(async () => {
  installDom();
  layout = laidOut(1400);
  // CodeMirror measures text with ranges and rects, which happy-dom does not lay out.
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
  mkdirSync(docs, { recursive: true });
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
  layout?.undo();
  await daemon?.stop().catch(() => {});
  await removeDom();
  if (savedHome === undefined) delete process.env.SCRIPTORIUM_HOME;
  else process.env.SCRIPTORIUM_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

/** An op the page sends, as `watch` sees it. */
type SentOp = { op: string; key?: string };

function Host({ watch }: { watch?: (op: SentOp) => void }) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  client = d;
  // The same `send` from one snapshot to the next, as `useDaemon` promises (and
  // as `Frame.test.tsx` gives it): the shell keys a made document's open and
  // compare mode's `diff` on `send`, and a fresh one per render re-sends them.
  const watching = useRef(watch);
  watching.current = watch;
  const { send } = d;
  const watchedSend = useCallback<Daemon["send"]>(
    (op) => {
      watching.current?.(op as SentOp);
      return send(op);
    },
    [send],
  );
  const seen: Daemon = watch ? { ...d, send: watchedSend } : d;
  return (
    <div style={{ width: 1400, height: 800 }}>
      <Frame daemon={seen} />
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
const chat = () => q('[data-pane="chat"]')?.textContent ?? "";
const viewOf = () => EditorView.findFromDOM(q(".cm-editor") as HTMLElement) as EditorView;
const openDoc = (): DocView | null =>
  client?.state?.docs.find((d) => d.slug === client?.state?.openDoc) ?? null;
const tab = (name: string) => click(withText('[role="tab"]', name));

/** A fresh document at `path` with `text`, open in the frame's centre. */
async function openFile(path: string, text: string, watch?: (op: SentOp) => void) {
  writeFileSync(path, text);
  const m = await mount(<Host watch={watch} />);
  await waitFor(() => client?.connection === "open" && client.state !== null, "the hello");
  await settle(() => {
    client?.send({ op: "context.add", path });
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
  // The session outlives each mount, so the document the last test opened is
  // still open at first: wait for this one, and for its text in the editor.
  await waitFor(
    () =>
      openDoc()?.original.endsWith(path.split("/").at(-1) as string) === true &&
      centre().includes((text.trim().split("\n").at(-1) as string).replace(/^#+ /, "")),
    "the document on screen",
  );
  return m;
}

/** What the daemon holds as the selection `say` attaches (ambient: read, never pushed). */
const held = async () =>
  ((await (await fetch(`${daemon.url}/state`)).json()) as { selection: { text: string } | null })
    .selection;
async function heldBecomes(text: string | null, what: string) {
  const end = Date.now() + 2000;
  while (Date.now() < end) {
    if (((await held())?.text ?? null) === text) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Select `from`..`to` of the rendered view's first paragraph, as a drag would. */
async function selectRendered(para: Element, from: number, to: number) {
  const target = para.closest<HTMLElement>("[tabindex]");
  await settle(() => target?.focus());
  const range = document.createRange();
  range.setStart(para.firstChild as Text, from);
  range.setEnd(para.firstChild as Text, to);
  await settle(() => {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

describe("the frame's centre is the kit's document pane", () => {
  test("with nothing open the pane's own empty state shows, and nothing says the pane is coming", async () => {
    const m = await mount(<Host />);
    await waitFor(() => centre().includes("No document open"), "the pane's empty state");
    expect(centre()).not.toContain("next cycle");
    await m.unmount();
  });

  test("a document opened is edited into its active version, and Save writes the file", async () => {
    const path = join(docs, "edit.md");
    const m = await openFile(path, "First line.\n");
    await settle(() => viewOf().dispatch({ changes: { from: 0, insert: "Now. " } }));
    await waitFor(() => openDoc()?.dirty === true, "unsaved");
    expect(readFileSync(path, "utf8")).toBe("First line.\n");
    await click(q('button[aria-label^="Save"]') ?? withText("button", "Save"));
    await waitFor(() => readFileSync(path, "utf8") === "Now. First line.\n", "the file saved");
    await m.unmount();
  });

  test("split is offered, and the view mode is kept in the daemon's prefs under the shipped name", async () => {
    const m = await openFile(join(docs, "split.md"), "# Split\n\nBody.\n");
    const split = q('button[aria-label="Raw and rendered side by side"]') as HTMLButtonElement;
    expect(split).not.toBeNull();
    await click(q('button[aria-label="Rendered"]'));
    await waitFor(() => client?.state?.prefs["doc:view"] === "rendered", "the mode in the prefs");
    expect(keptPrefs(join(root, "home"))["doc:view"]).toBe("rendered");
    // Nothing in the browser: a new session is a new origin.
    expect(localStorage.length).toBe(0);
    await m.unmount();
  });

  test("raw offers line numbers, and the choice is kept in the daemon's prefs", async () => {
    const m = await openFile(join(docs, "numbers.md"), "One.\nTwo.\n");
    const toggle = q('[data-slot="line-numbers-toggle"]');
    expect(toggle).not.toBeNull();
    await click(toggle);
    await waitFor(() => q(".cm-lineNumbers") !== null, "the gutter");
    await waitFor(
      () => client?.state?.prefs["doc:line-numbers"] === "on",
      "line numbers in the prefs",
    );
    expect(localStorage.length).toBe(0);
    await m.unmount();
  });

  test("mounting writes neither the view mode nor line numbers: only the human's choice does", async () => {
    // Nothing kept: what the pane reads (rendered, numbers off) is not in the
    // prefs, so a write on mount would be sent, not skipped as already held.
    seedPrefs(join(root, "home"), {});
    const sent: { op: string; key?: string }[] = [];
    const m = await openFile(join(docs, "quiet.md"), "# Quiet\n\nStill.\n", (op) => sent.push(op));
    // Another document on screen re-reads the mode, which must not write it either.
    const other = join(docs, "quiet-two.md");
    writeFileSync(other, "# Two\n");
    await settle(() => {
      client?.send({ op: "context.add", path: other });
    });
    await settle(() => {
      client?.send({ op: "open", path: other });
    });
    await waitFor(() => openDoc()?.original.endsWith("quiet-two.md") === true, "the second one");
    // Well past the adapter's pause.
    await Bun.sleep(400);
    const keys = sent.filter((o) => o.op === "prefs.set").map((o) => o.key);
    expect(keys).not.toContain("doc:view");
    expect(keys).not.toContain("doc:line-numbers");
    await m.unmount();
  });

  test("a choice still in its pause is sent when the page goes away: on pagehide, and on unmount", async () => {
    const sent: { op: string; key?: string; value?: string }[] = [];
    const m = await mount(<Host watch={(op) => sent.push(op)} />);
    await waitFor(() => q('[data-pane="chat"] [role="tab"]') !== null, "the shell");
    const tabSets = () => sent.filter((o) => o.op === "prefs.set" && o.key === "tab");
    await tab("Tasks");
    // Well inside the adapter's 250 ms pause: nothing yet, until the page hides.
    expect(tabSets()).toEqual([]);
    await settle(() => {
      window.dispatchEvent(new window.Event("pagehide"));
    });
    expect(tabSets().map((o) => o.value)).toEqual(["tasks"]);
    await tab("Notes");
    expect(tabSets().length).toBe(1);
    await m.unmount();
    expect(tabSets().map((o) => o.value)).toEqual(["tasks", "notes"]);
  });

  test("first use, with no mode kept, opens rendered, as the shipped app does", async () => {
    seedPrefs(join(root, "home"), {});
    const path = join(docs, "first.md");
    writeFileSync(path, "# First\n\nRendered.\n");
    const m = await mount(<Host />);
    await waitFor(() => client?.connection === "open" && client.state !== null, "the hello");
    await settle(() => {
      client?.send({ op: "context.add", path });
    });
    await settle(() => {
      client?.send({ op: "open", path });
    });
    await waitFor(() => q(".md-prose") !== null, "the rendered view");
    expect(q(".cm-editor")).toBeNull();
    expect(q('button[aria-label="Rendered"]')?.getAttribute("aria-pressed")).toBe("true");
    await m.unmount();
  });

  test("reader mode hides both columns, and leaving it brings them back", async () => {
    const m = await openFile(join(docs, "reader.md"), "# Reader\n\nQuiet.\n");
    const hidden = (pane: string) =>
      (q(`[data-pane="${pane}"]`) as HTMLElement | null)?.hidden ?? null;
    expect([hidden("context"), hidden("chat")]).toEqual([false, false]);
    await click(q('button[aria-label^="Reader mode"]'));
    await waitFor(() => hidden("chat") === true, "the chat column hidden");
    expect(hidden("context")).toBe(true);
    await click(q('button[aria-label^="Leave reader mode"]'));
    await waitFor(() => hidden("chat") === false, "the chat column back");
    expect(hidden("context")).toBe(false);
    await m.unmount();
  });
});

describe("a new version", () => {
  test("its toast's Show diff opens compare against that version, without activating it", async () => {
    const m = await openFile(join(docs, "versions.md"), "First.\n");
    const slug = openDoc()?.slug as string;
    await fetch(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "version.new", doc: slug, label: "theirs" }),
    });
    await waitFor(
      () => withText('[data-slot="toasts"] article', "New version") !== null,
      "the toast",
    );
    await click(withText('[data-slot="toasts"] button', "Show diff"));
    await waitFor(() => centre().includes("compared with"), "the compare view");
    const pressed = q('[aria-label="Compare against"] button[aria-pressed="true"]');
    expect(pressed?.textContent).toBe("v2");
    expect(openDoc()?.active).toBe(1);
    await m.unmount();
  });
});

describe("the held selection reaches the chat and Notes", () => {
  test("a raw selection is the chat's chip and what say attaches; the chip's X drops it everywhere", async () => {
    const m = await openFile(join(docs, "chat.md"), "Alpha beta gamma.\n");
    await settle(() => viewOf().dispatch({ selection: { anchor: 6, head: 10 } }));
    await heldBecomes("beta", "the daemon holds it");
    expect(chat()).toContain("beta");
    await typeInto(q('[data-slot="composer-input"]') as HTMLTextAreaElement, "What is this?");
    await click(withText('[data-pane="chat"] button', "Send"));
    const asked = () => client?.state?.chat.find((x) => x.text === "What is this?");
    await waitFor(() => asked() !== undefined, "the message");
    const said = asked();
    expect(said?.from).toBe("human");
    expect(said?.about?.text).toBe("beta");
    expect(said?.about?.fromLine).toBe(1);
    // The path is the active version's file, whose lines fromLine counts: the
    // kit's `about.path`, not the shipped app's `selection.path` (the original).
    const shown = openDoc();
    expect(said?.about?.path).toBe(shown?.versions.find((v) => v.n === shown.active)?.path);
    expect(said?.about?.path).not.toBe(shown?.original);

    await click(q('[data-pane="chat"] button[aria-label="Clear the selection"]'));
    await heldBecomes(null, "the daemon let it go");
    expect(viewOf().state.selection.main.empty).toBe(true);
    await m.unmount();
  });

  test("Notes adds a note on a rendered selection, which consumes it; going to a note marks it chosen", async () => {
    const m = await openFile(kept, "The lantern by the harbour.\n");
    await click(q('button[aria-label="Rendered"]'));
    await waitFor(() => q(".md-prose p") !== null, "the rendered view");
    await selectRendered(q(".md-prose p") as Element, 4, 11);
    await heldBecomes("lantern", "the daemon holds it");

    await tab("Notes");
    expect(q('[data-pane="chat"]')?.textContent).toContain("lantern");
    expect(chat()).not.toContain("cannot show");
    await typeInto(q('textarea[aria-label="New note"]') as HTMLTextAreaElement, "Which lantern?");
    await click(withText('[data-pane="chat"] button', "Add note"));
    await waitFor(() => (openDoc()?.notes.length ?? 0) === 1, "the note made");
    const note = openDoc()?.notes[0];
    expect(note?.body).toBe("Which lantern?");
    expect(note && openDoc()?.versions[0] ? note.from : null).toBe(4);
    // A note consumes the passage it was written about: the daemon, the form and the chip.
    await heldBecomes(null, "the selection consumed");
    expect(q('[data-pane="chat"] form')?.textContent).toContain("No selection");

    await click(q('[data-slot="note"] button[title="Show this in the document"]'));
    await waitFor(() => q('[data-slot="note"][data-focused]') !== null, "the note chosen");
    // Raw marks the chosen note's passage.
    await click(q('button[aria-label="Raw text"]'));
    await waitFor(
      () =>
        all(".cm-editor .cm-note-focus")
          .map((e) => e.textContent)
          .join("") === "lantern",
      "the focus mark",
    );
    await m.unmount();
  });
});

describe("Scriptorium's chips", () => {
  test("trust shows only on a document with verified, and a document past stale_after is stale", async () => {
    const m = await openFile(
      join(docs, "chips.md"),
      "---\ntype: note\nverified:\n  - by: cole\n    at: 2026-01-01\nstale_after: 2020-01-01\n---\n# Chips\n",
    );
    await click(q('button[aria-label="Rendered"]'));
    await waitFor(() => q('[data-chip="type"]') !== null, "the header");
    expect(q('[data-chip="verified"]')).not.toBeNull();
    expect(withText("span[title]", "stale")?.getAttribute("title")).toBe(
      "Past its stale_after date",
    );
    await m.unmount();

    const n = await openFile(join(docs, "bare.md"), "---\ntype: note\n---\n# Bare\n");
    await click(q('button[aria-label="Rendered"]'));
    await waitFor(() => q('[data-chip="type"]') !== null, "the header");
    expect(q('[data-chip="verified"]')).toBeNull();
    expect(q(".md-prose")?.textContent).not.toContain("unverified");
    expect(withText("span[title]", "stale")).toBeNull();
    await n.unmount();
  });

  test("the stale chip follows the shipped rule: an instant, stale from it on", () => {
    const at = Date.parse("2026-05-01T00:00:00Z");
    const chips = scriptoriumChips(() => at);
    const labels = (fields: Record<string, unknown>) => chips(fields, []).length;
    expect(labels({ stale_after: "2026-05-01T00:00:00Z" })).toBe(1);
    expect(labels({ stale_after: "2026-05-02" })).toBe(0);
    expect(labels({ stale_after: new Date("2026-04-01") })).toBe(1);
    expect(labels({ stale_after: "soon" })).toBe(0);
    expect(labels({})).toBe(0);
    // The kit's chips are kept, and the stale chip claims no key: stale_after stays listed.
    const kit = [{ key: "type", label: "note" }];
    const out = chips({ stale_after: "2020-01-01" }, kit);
    expect(out[0]).toBe(kit[0]);
    expect(out[1]?.key).toBeUndefined();
  });
});

describe("an outside change", () => {
  test("the toast offers See the difference, which opens compare against the file on disk", async () => {
    const m = await openFile(plain, "Mine.\n");
    await settle(() => viewOf().dispatch({ changes: { from: 0, insert: "Edited. " } }));
    await waitFor(() => openDoc()?.dirty === true, "unsaved");
    writeFileSync(plain, "Theirs.\n");
    await waitFor(() => openDoc()?.outsideChanged === true, "the outside change");
    await waitFor(() => q('[data-slot="toasts"]') !== null, "the toast");
    const toast = q('[data-slot="toasts"] article');
    expect(toast?.textContent).toContain("plain.md changed on disk");
    const labels = [...(toast?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
    expect(labels.slice(0, 3)).toEqual(["See the difference", "Reload", "Keep"]);
    await click(withText('[data-slot="toasts"] button', "See the difference"));
    await waitFor(() => centre().includes("compared with"), "the compare view");
    // Against the file on disk, not a version.
    const pressed = q('[aria-label="Compare against"] button[aria-pressed="true"]');
    expect(pressed?.getAttribute("title")).toBe("plain.md");
    await waitFor(() => client?.diff?.against === "original", "the daemon's diff");
    // Nothing was decided: the edit and the flag are both still there.
    expect(openDoc()?.dirty).toBe(true);
    expect(readFileSync(plain, "utf8")).toBe("Theirs.\n");
    await m.unmount();
  });
});

describe("End session", () => {
  test("it warns of the unsaved document, in the shipped words, and ending is still offered", async () => {
    const path = join(docs, "unsaved.md");
    const m = await openFile(path, "Draft.\n");
    await settle(() => viewOf().dispatch({ changes: { from: 0, insert: "More. " } }));
    await waitFor(() => openDoc()?.dirty === true, "unsaved");
    await click(q('[data-column-control="end-session"]'));
    await waitFor(() => q('[data-slot="session-end-dialog"]') !== null, "the confirm");
    // The session outlives each test, so an earlier test's unsaved edit counts
    // too: the warning is the rule's, with the open document named first.
    const warned = q('[data-slot="end-warning"]')?.textContent ?? "";
    expect(warned).toBe(scriptoriumEndWarning(client?.state as PublicState) as string);
    expect(warned).toMatch(
      /^(v1 of unsaved\.md has|\d+ documents have unsaved changes \(unsaved\.md)/,
    );
    expect(warned).toContain("They stay in this session");
    const end = withText('[data-slot="session-end-dialog"] button', "End session");
    expect((end as HTMLButtonElement | null)?.disabled).toBe(false);
    await click(withText('[data-slot="session-end-dialog"] button', "Cancel"));
    await waitFor(() => q('[data-slot="session-end-dialog"]') === null, "the dialog closed");
    // Saved, it is no longer warned of; with nothing unsaved at all, nothing is.
    await click(q('button[aria-label^="Save"]') ?? withText("button", "Save"));
    await waitFor(() => openDoc()?.dirty === false, "saved");
    await click(q('[data-column-control="end-session"]'));
    await waitFor(() => q('[data-slot="session-end-dialog"]') !== null, "the confirm again");
    expect(q('[data-slot="end-warning"]')?.textContent ?? "").not.toContain("unsaved.md");
    if (!client?.state?.docs.some((d) => d.dirty))
      expect(q('[data-slot="end-warning"]')).toBeNull();
    await click(withText('[data-slot="session-end-dialog"] button', "Cancel"));
    await m.unmount();
  });

  test("every unsaved document counts, the open one named first", () => {
    const docOf = (slug: string, name: string, dirty: boolean) => ({
      slug,
      name,
      active: 2,
      dirty,
    });
    expect(scriptoriumEndWarning({ openDoc: "a", docs: [docOf("a", "a.md", false)] })).toBeNull();
    expect(
      scriptoriumEndWarning({
        openDoc: "c",
        docs: [docOf("a", "a.md", true), docOf("b", "b.md", false), docOf("c", "c.md", true)],
      }),
    ).toBe(
      "2 documents have unsaved changes (c.md, a.md). They stay in this session (the agent can bring it back with open --restore), but they won't be in your files.",
    );
  });
});
