// Writing a link in the raw editor, in a DOM against a REAL workspace daemon:
// Add link on a selection (the right-click menu and Mod-Shift-K), `](` and `[[`
// typed, a relation from the session's own vocabulary or typed, and an ended
// session that offers none of it. Every link written is then FOLLOWED, by a
// click in the rendered half of the split view, so a link that is written but
// does not open fails here. The host stands in for the shell, as in
// `DocumentPane.links.test.tsx`.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  typeInto,
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
const editor = createRef<EditorHandle>();

const A = "# A\n\nsee the bakery here\n\n[b](./part/b.md?rel=sister-of,extends)\n";
const B = "# B\n\nback to a\n";

beforeEach(async () => {
  root = tempRoot("pane-link-insert");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  set = join(root, "docs", "set");
  mkdirSync(join(set, "part"), { recursive: true });
  writeFileSync(join(set, "a.md"), A);
  writeFileSync(join(set, "part", "b.md"), B);
  writeFileSync(join(set, "Maren's Bakery.md"), "# Maren's Bakery\n\n[a](./a.md?rel=applies)\n");
  mkdirSync(join(set, "images"), { recursive: true });
  writeFileSync(join(set, "images", "fox.png"), pngBytes(8, 8));
  localStorage.clear();
  client = null;
  announced = [];
  startMode = "split";
  // The workspace is the folder that holds the set, so the set is a
  // top-level entry (every file of a session lives inside its workspace).
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

/** The view the host starts in, and how a test changes it after. */
let startMode: ViewMode = "split";
let setMode: (m: ViewMode) => void = () => {};

function Host() {
  const [mode, setOwnMode] = useState<ViewMode>(startMode);
  setMode = setOwnMode;
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
        {/* Split: the raw editor to write in, the rendered half to follow from. */}
        <DocumentPane mode={mode} splitView editor={editor} />
      </main>
    </WorkspaceContext.Provider>
  );
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const view = () => EditorView.findFromDOM(q(".cm-editor") as HTMLElement) as EditorView;
const text = () => view().state.doc.toString();
const openName = () => client?.state?.docs.find((d) => d.slug === client?.state?.openDoc)?.name;
const openSlug = () => client?.state?.openDoc ?? "";
const picker = () => q('[data-slot="link-picker"]');
const options = () => [...document.querySelectorAll('[data-slot="link-picker"] [role="option"]')];
const docField = () => q<HTMLInputElement>('input[aria-label="Find a document to link to"]');
const relField = () => q<HTMLInputElement>('input[aria-label="Relation"]');
const renderedLink = (label: string) =>
  [...document.querySelectorAll(".md-prose a")].find((a) => a.textContent === label) ?? null;

async function key(el: Element | null, k: string) {
  if (!el) throw new Error(`nothing to press ${k} in`);
  await settle(() => {
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  });
}
async function click(el: Element | null) {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
/** Select the first `phrase` in the editor. */
async function select(phrase: string) {
  const at = text().indexOf(phrase);
  if (at === -1) throw new Error(`no "${phrase}" in the text`);
  await settle(() => view().dispatch({ selection: { anchor: at, head: at + phrase.length } }));
}
/** Type `s` at the caret, one keystroke per character, as the keyboard does. */
async function typeKeys(s: string) {
  for (const ch of s)
    await settle(() => {
      const v = view();
      const at = v.state.selection.main.head;
      v.dispatch({
        changes: { from: at, insert: ch },
        selection: { anchor: at + 1 },
        userEvent: "input.type",
      });
    });
}
/** Mod-Shift-K in the editor: Cmd on a Mac, Ctrl elsewhere, as CodeMirror reads `Mod`. */
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

async function open(rel: string) {
  await settle(() => {
    client?.send({ op: "open", path: join(set, rel) });
  });
  await waitFor(
    () => openName() === rel.split("/").pop() && !!q(".cm-content") && text().length > 0,
    `${rel} open`,
  );
  await waitFor(
    () => q(".cm-content")?.getAttribute("contenteditable") === "true",
    "the editable editor",
  );
}

async function start(rel = "a.md") {
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await open(rel);
  return m;
}

/** The picker open with its targets listed. */
async function pickerReady() {
  await waitFor(() => picker() !== null, "the link picker");
  await waitFor(() => options().length > 0, "the picker's documents");
}

/** Wait for the rendered half to show `label` as a link, click it, and wait for `name` to open. */
async function follow(label: string, name: string) {
  await waitFor(() => renderedLink(label) !== null, `the rendered link "${label}"`, 4000);
  await click(renderedLink(label));
  await waitFor(() => openName() === name, `${name} open from "${label}"`);
}

describe("Add link on a selection", () => {
  test("the right-click menu offers Add link; the selection becomes a link that follows", async () => {
    const m = await start();
    await select("the bakery");
    await settle(() => {
      view().contentDOM.dispatchEvent(
        new window.MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 40,
        }),
      );
    });
    const add = [...document.querySelectorAll('[data-slot="note-at-selection"] button')].find((b) =>
      (b.textContent ?? "").includes("Add link"),
    );
    expect(add).toBeDefined();
    await click(add ?? null);
    await pickerReady();
    // Every other document, and not the one being written in, and every image.
    expect(options().map((o) => o.getAttribute("data-path"))).toEqual([
      join(set, "images", "fox.png"),
      join(set, "Maren's Bakery.md"),
      join(set, "part", "b.md"),
    ]);
    expect(options()[0]?.querySelector('[data-kind="image"]')).not.toBeNull();
    expect(options()[1]?.querySelector('[data-kind="image"]')).toBeNull();
    await typeInto(docField() as HTMLInputElement, "mbak");
    await key(docField(), "Enter");
    expect(picker()).toBeNull();
    // A space in the name is percent-encoded, and no relation was chosen: bare.
    expect(text()).toContain("see [the bakery](./Maren's%20Bakery.md) here");
    await follow("the bakery", "Maren's Bakery.md");
    await m.unmount();
  });

  test("Mod-Shift-K links up to a parent with relations from the vocabulary and typed", async () => {
    const m = await start("part/b.md");
    await select("back to a");
    await linkShortcut();
    await pickerReady();
    // The session's vocabulary, most used first: nothing invented.
    const offered = [...document.querySelectorAll("[data-relation]")].map((b) =>
      b.getAttribute("data-relation"),
    );
    expect(offered.sort()).toEqual(["applies", "extends", "sister-of"]);
    await click(q('[data-relation="sister-of"]'));
    await typeInto(relField() as HTMLInputElement, "echoes");
    await key(relField(), "Enter");
    expect(
      [...document.querySelectorAll('[data-slot="link-relation"]')].map((c) => c.textContent),
    ).toEqual(["sister-of", "echoes"]);
    await typeInto(docField() as HTMLInputElement, "a");
    await key(docField(), "Enter");
    expect(text()).toContain("[back to a](../a.md?rel=sister-of,echoes)");
    await follow("back to a", "a.md");
    await m.unmount();
  });

  test("with no selection the target's name is the link's text; Escape writes nothing", async () => {
    const m = await start();
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await linkShortcut();
    await pickerReady();
    await key(docField(), "Escape");
    expect(picker()).toBeNull();
    expect(text()).toBe(A);
    await linkShortcut();
    await pickerReady();
    await typeInto(docField() as HTMLInputElement, "b");
    await key(docField(), "ArrowDown");
    await key(docField(), "ArrowUp");
    await key(docField(), "Enter");
    expect(text()).toBe(`${A}[b](./part/b.md)`);
    expect(daemon.session.resolveLink("./part/b.md", openSlug())).toEqual({
      state: "in-context",
      path: join(set, "part", "b.md"),
    });
    await m.unmount();
  });
});

describe("completing a link while typing", () => {
  test("`](` opens the picker; the choice writes the path and closes the paren", async () => {
    const m = await start();
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await typeKeys("[the mill](");
    await pickerReady();
    await typeInto(docField() as HTMLInputElement, "bak");
    await key(docField(), "Enter");
    expect(text()).toBe(`${A}[the mill](./Maren's%20Bakery.md)`);
    await follow("the mill", "Maren's Bakery.md");
    await m.unmount();
  });

  test("`[[` writes a whole standard link, never a wiki link", async () => {
    const m = await start("part/b.md");
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await typeKeys("[[");
    await pickerReady();
    await typeInto(docField() as HTMLInputElement, "maren");
    await key(docField(), "Enter");
    expect(text()).toBe(`${B}[Maren's Bakery](../Maren's%20Bakery.md)`);
    await follow("Maren's Bakery", "Maren's Bakery.md");
    await m.unmount();
  });

  test("an image chosen from `[[` is embedded; from `![alt](` its path is written", async () => {
    const m = await start("part/b.md");
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await typeKeys("[[");
    await pickerReady();
    await typeInto(docField() as HTMLInputElement, "fox");
    await key(docField(), "Enter");
    expect(text()).toBe(`${B}![fox](../images/fox.png)`);
    await typeKeys(" ![The fox](");
    await pickerReady();
    await typeInto(docField() as HTMLInputElement, "fox");
    await key(docField(), "Enter");
    expect(text()).toBe(`${B}![fox](../images/fox.png) ![The fox](../images/fox.png)`);
    await m.unmount();
  });

  test("a stray `](`, a paste, or Escape leaves the text as typed", async () => {
    const m = await start();
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await typeKeys("no bracket ](");
    await settle(() => new Promise((r) => setTimeout(r, 20)));
    expect(picker()).toBeNull();
    // A paste is not a keystroke.
    await settle(() => {
      const at = view().state.doc.length;
      view().dispatch({ changes: { from: at, insert: " [x](" }, userEvent: "input.paste" });
    });
    await settle(() => new Promise((r) => setTimeout(r, 20)));
    expect(picker()).toBeNull();
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await typeKeys(" [y](");
    await pickerReady();
    await key(docField(), "Escape");
    expect(picker()).toBeNull();
    expect(text()).toBe(`${A}no bracket ]( [x]( [y](`);
    await m.unmount();
  });

  test("the text changing under an open picker adds nothing, and says so", async () => {
    const m = await start();
    await select("the bakery");
    await linkShortcut();
    await pickerReady();
    // The agent (or the disk) rewrites the passage while the picker is open.
    await settle(() => {
      const at = text().indexOf("the bakery");
      view().dispatch({ changes: { from: at, to: at + 3, insert: "a" } });
    });
    await typeInto(docField() as HTMLInputElement, "b");
    await key(docField(), "Enter");
    expect(text()).toBe(A.replace("the bakery", "a bakery"));
    expect(announced).toEqual(["Link not added"]);
    await m.unmount();
  });
});

/** Select `phrase` in the rendered view with the browser's own selection, as a drag would. */
async function selectRendered(phrase: string) {
  const prose = q(".md-prose");
  if (!prose) throw new Error("no rendered view");
  const walker = document.createTreeWalker(prose, 4);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const at = (n.textContent ?? "").indexOf(phrase);
    if (at === -1) continue;
    const range = document.createRange();
    range.setStart(n, at);
    range.setEnd(n, at + phrase.length);
    await settle(() => {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      document.dispatchEvent(new window.Event("selectionchange"));
    });
    return;
  }
  throw new Error(`no "${phrase}" in the rendered text`);
}
async function renderedMenu() {
  await settle(() => {
    q(".md-prose")?.dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
  return (
    [...document.querySelectorAll('[data-slot="note-at-selection"] button')].find((b) =>
      (b.textContent ?? "").includes("Add link"),
    ) ?? null
  );
}
/** The daemon's text of the open document's active version. */
function daemonText(): string {
  const slug = openSlug();
  const d = daemon.session.doc(slug);
  return daemon.session.readVersion(slug, d.active).text;
}
async function startRendered(rel = "a.md") {
  startMode = "rendered";
  const m = await mount(<Host />);
  await waitFor(() => client?.connection === "open", "the connection");
  await settle(() => {
    client?.send({ op: "open", path: join(set, rel) });
  });
  await waitFor(
    () => !!q(".md-prose") && (q(".md-prose")?.textContent ?? "").length > 0,
    "rendered",
  );
  expect(q(".cm-editor")).toBeNull();
  return m;
}

describe("a selection that cannot be one link", () => {
  test("a blank line or a link inside it is refused with a toast; a lone bracket is escaped", async () => {
    const m = await start();
    await select("here\n\n[b");
    await linkShortcut();
    expect(picker()).toBeNull();
    await select("[b](./part/b.md?rel=sister-of,extends)");
    await linkShortcut();
    expect(picker()).toBeNull();
    expect(announced).toEqual(["Can't link this selection", "Can't link this selection"]);
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await typeKeys("odd ] bracket");
    await select("odd ] bracket");
    await linkShortcut();
    await pickerReady();
    await typeInto(docField() as HTMLInputElement, "b");
    await key(docField(), "Enter");
    expect(text()).toBe(`${A}[odd \\] bracket](./part/b.md)`);
    await follow("odd ] bracket", "b.md");
    await m.unmount();
  });

  test("text typed a moment ago links at once: the quote is the editor's, not the daemon's", async () => {
    const m = await start();
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await typeKeys("new target");
    // No wait: the daemon's copy still trails the editor.
    await select("target");
    await linkShortcut();
    await pickerReady();
    expect(docField()?.placeholder).toBe("Link “target” to…");
    await typeInto(docField() as HTMLInputElement, "b");
    await key(docField(), "Enter");
    expect(text()).toBe(`${A}new [target](./part/b.md)`);
    expect(announced).toEqual([]);
    await m.unmount();
  });

  test("one undo takes the whole link back", async () => {
    const m = await start();
    await select("the bakery");
    await linkShortcut();
    await pickerReady();
    await typeInto(docField() as HTMLInputElement, "b");
    await key(docField(), "Enter");
    expect(text()).toContain("[the bakery](./part/b.md)");
    // happy-dom fires `selectionchange` synchronously inside CodeMirror's own
    // update when the editor has focus (a browser fires it later), so the undo
    // runs unfocused here.
    await settle(() => view().contentDOM.blur());
    await settle(() => {
      undo(view());
    });
    expect(text()).toBe(A);
    await m.unmount();
  });

  test("an edit elsewhere while the picker is open does not refuse the link", async () => {
    const m = await start();
    await select("the bakery");
    await linkShortcut();
    await pickerReady();
    // The agent writes above the passage: every offset after it moves.
    await settle(() => view().dispatch({ changes: { from: 0, insert: "Intro.\n" } }));
    await typeInto(docField() as HTMLInputElement, "b");
    await key(docField(), "Enter");
    expect(text()).toBe(`Intro.\n${A.replace("the bakery", "[the bakery](./part/b.md)")}`);
    expect(announced).toEqual([]);
    await m.unmount();
  });
});

describe("typing that must not open the picker, or lose what was typed", () => {
  test("not in code, not for an image's `![[`, not mid-composition", async () => {
    const m = await start();
    const none = async (what: string) => {
      await settle(() => new Promise((r) => setTimeout(r, 20)));
      expect(picker() === null ? "closed" : `opened by ${what}`).toBe("closed");
    };
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await typeKeys("`code [x](");
    await none("inline code");
    await typeKeys("`\n\n    [indented](");
    await none("an indented block");
    await typeKeys("\n\n```\n[fenced](");
    await none("a fence");
    await typeKeys("\n```\n![[");
    await none("an image's [[");
    await settle(() => {
      const at = view().state.doc.length;
      view().dispatch({
        changes: { from: at, insert: " [ime](" },
        selection: { anchor: at + 7 },
        userEvent: "input.type.compose",
      });
    });
    await settle(() => new Promise((r) => setTimeout(r, 20)));
    expect(picker()).toBeNull();
    await m.unmount();
  });

  test("Escape keeps what was typed into the picker: `[link](http` stays", async () => {
    const m = await start();
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await typeKeys("[link](");
    await pickerReady();
    await typeInto(docField() as HTMLInputElement, "http");
    await key(docField(), "Escape");
    expect(picker()).toBeNull();
    expect(text()).toBe(`${A}[link](http`);
    await m.unmount();
  });

  test("keys typed before the picker took focus become its query, and are not stranded", async () => {
    const m = await start();
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await typeKeys("[x");
    // `](` and two more keys in one go, before the picker has opened.
    await settle(() => {
      for (const ch of "](ba") {
        const v = view();
        const at = v.state.selection.main.head;
        v.dispatch({
          changes: { from: at, insert: ch },
          selection: { anchor: at + 1 },
          userEvent: "input.type",
        });
      }
    });
    await pickerReady();
    expect(docField()?.value).toBe("ba");
    await key(docField(), "Enter");
    expect(text()).toBe(`${A}[x](./Maren's%20Bakery.md)`);
    await m.unmount();
  });
});

describe("Add link in the rendered view alone", () => {
  test("the right-click menu offers it; the link is written to the active version and follows", async () => {
    const m = await startRendered();
    await selectRendered("the bakery");
    const add = await renderedMenu();
    expect(add).not.toBeNull();
    await click(add);
    await pickerReady();
    await typeInto(docField() as HTMLInputElement, "mbak");
    await key(docField(), "Enter");
    await waitFor(() => daemonText().includes("[the bakery]("), "the daemon's text");
    expect(daemonText()).toBe(A.replace("the bakery", "[the bakery](./Maren's%20Bakery.md)"));
    await follow("the bakery", "Maren's Bakery.md");
    await m.unmount();
  });

  test("the guard holds: an edit elsewhere is mapped, an edit to the passage refuses", async () => {
    const m = await startRendered();
    const doc = () => client?.state?.docs.find((d) => d.slug === openSlug());
    const write = async (t: string) => {
      const d = doc();
      if (!d) throw new Error("no document");
      await settle(() => {
        client?.writeText(d, d.active, t);
        client?.flushText(d.slug);
      });
    };
    await selectRendered("the bakery");
    await click(await renderedMenu());
    await pickerReady();
    await write(`Intro.\n${A}`);
    await typeInto(docField() as HTMLInputElement, "b");
    await key(docField(), "Enter");
    await waitFor(() => daemonText().includes("[the bakery]("), "the mapped link");
    expect(daemonText()).toBe(`Intro.\n${A.replace("the bakery", "[the bakery](./part/b.md)")}`);

    await selectRendered("here");
    await click(await renderedMenu());
    await pickerReady();
    const before = daemonText();
    await write(before.replace("here", "hare"));
    await typeInto(docField() as HTMLInputElement, "b");
    await key(docField(), "Enter");
    expect(announced).toEqual(["Link not added"]);
    await settle(() => new Promise((r) => setTimeout(r, 50)));
    expect(daemonText()).toBe(before.replace("here", "hare"));
    await m.unmount();
  });

  test("back in raw, one undo takes the link back, and the daemon's text with it", async () => {
    const m = await startRendered();
    await selectRendered("the bakery");
    await click(await renderedMenu());
    await pickerReady();
    await typeInto(docField() as HTMLInputElement, "b");
    await key(docField(), "Enter");
    await waitFor(() => daemonText().includes("[the bakery]("), "the daemon's text");
    await settle(() => setMode("raw"));
    await waitFor(() => !!q(".cm-editor") && text().includes("[the bakery]("), "the raw editor");
    await settle(() => {
      undo(view());
    });
    expect(text()).toBe(A);
    await waitFor(() => daemonText() === A, "the undo written to the active version", 3000);
    await m.unmount();
  });

  test("an ended session offers no Add link there either", async () => {
    const m = await startRendered();
    client?.send({ op: "close" });
    await waitFor(() => client?.connection === "ended", "ended");
    await selectRendered("the bakery");
    expect(await renderedMenu()).toBeNull();
    expect(picker()).toBeNull();
    await m.unmount();
  });
});

describe("an ended session", () => {
  test("offers no link: the open picker closes, and neither the shortcut nor typing opens one", async () => {
    const m = await start();
    await select("the bakery");
    await linkShortcut();
    await pickerReady();
    client?.send({ op: "close" });
    await waitFor(() => client?.connection === "ended", "ended");
    await waitFor(() => picker() === null, "the picker closed");
    await waitFor(
      () => q(".cm-content")?.getAttribute("contenteditable") === "false",
      "the read-only editor",
    );
    await select("the bakery");
    await linkShortcut();
    await settle(() => view().dispatch({ selection: { anchor: text().length } }));
    await typeKeys("[x](");
    await settle(() => new Promise((r) => setTimeout(r, 20)));
    expect(picker()).toBeNull();
    // The handle refuses too: a link is typing, and an ended editor takes none.
    expect(editor.current?.replaceRange(0, 0, "[x](./a.md)")).toBe(false);
    await m.unmount();
  });
});
