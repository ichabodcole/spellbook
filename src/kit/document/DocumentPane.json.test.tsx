// A JSON document in the pane, in a DOM against a real fixture daemon (the
// kit-json-documents item): raw only, in CodeMirror's JSON mode, with the
// markdown-only controls gone (rendered, split, reader, links); a Save of text
// that does not parse is refused with the line, column and problem beside the
// editor and the text kept; Compare works as for any document.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syntaxTree } from "@codemirror/language";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { useMemo } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import { DocIcon } from "../context/EntryTree.tsx";
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
import type { WorkspaceDaemon } from "../workspace/server";
import { tempRoot } from "../workspace/testing";
import { DocumentPane } from "./DocumentPane.tsx";

beforeAll(() => {
  installDom();
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
// Awaited: the next file's installDom is a no-op while the DOM is still registered.
afterAll(async () => {
  await removeDom();
});

const VALID = '{\n  "kind": "location",\n  "required": ["title"]\n}\n';
const BROKEN = '{\n  "kind": "location"\n  "required": ["title"]\n}\n';

let root: string;
let world: string;
let profile: string;
let story: string;
let daemon: WorkspaceDaemon;
let client: Daemon | null = null;
let revealed: { from: number; to: number }[] = [];

beforeEach(async () => {
  root = tempRoot("document-pane-json");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // The world is inside the workspace, so it is a set there from the start
  // (every file of a session lives inside its workspace).
  const ws = testWorkspace(root, "ws");
  world = join(ws, "world");
  mkdirSync(join(world, "_meta", "profiles"), { recursive: true });
  profile = join(world, "_meta", "profiles", "location.json");
  writeFileSync(profile, VALID);
  story = join(world, "story.md");
  writeFileSync(story, "# Story\n");
  localStorage.clear();
  revealed = [];
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await daemon.stop().catch(() => {});
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
      revealed.push({ from: r.from, to: r.to });
    },
    revealApplied: () => {},
    toasts,
    announce: () => 0,
    theme: "dark",
    setTheme: () => {},
    focusPane: () => {},
    columns: {
      collapsed: { context: false, chat: false },
      collapse: () => {},
      expand: () => {},
    },
    setQuiet: () => {},
  };
  return (
    <WorkspaceContext.Provider value={workspace}>
      <main data-pane="centre" tabIndex={-1} style={{ width: 900, height: 700 }}>
        <DocumentPane splitView />
      </main>
    </WorkspaceContext.Provider>
  );
}

const q = (sel: string) => document.querySelector(sel);
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) ??
  null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const editorText = () => q(".cm-content")?.textContent ?? "";
const viewOf = () => EditorView.findFromDOM(q(".cm-editor") as HTMLElement) as EditorView;
const refused = () => q("[data-slot=json-refused]");
const toolbarSave = () =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Save") ?? null;

async function open(path: string) {
  await mount(<Host />);
  await waitFor(() => document.body.textContent?.includes("No document open") === true, "empty");
  await settle(() => {
    client?.send({ op: "context.add", path: world });
  });
  await waitFor(() => (client?.state?.context.length ?? 0) === 1, "the set");
  await settle(() => {
    client?.send({ op: "open", path });
  });
  await waitFor(() => editorText().length > 0, "the editor");
}

/** Replace the editor's whole text, as typing would. */
async function typeAll(text: string) {
  await settle(() =>
    viewOf().dispatch({ changes: { from: 0, to: viewOf().state.doc.length, insert: text } }),
  );
}

describe("a JSON document in the pane", () => {
  test("opens raw in JSON mode, with no rendered, split, reader or link controls", async () => {
    // A stored rendered mode, as a reader of markdown would leave it.
    localStorage.setItem("story-studio:view-mode", "rendered");
    await open(profile);
    expect(q(".md-prose")).toBeNull();
    expect(q(".cm-editor")).not.toBeNull();
    // The JSON language is the editor's: its tree names JSON's nodes.
    const tree = syntaxTree(viewOf().state);
    const names = new Set<string>();
    tree.iterate({ enter: (n) => void names.add(n.name) });
    expect(names.has("PropertyName")).toBe(true);
    expect(q('button[aria-label="Raw text"]')).not.toBeNull();
    expect(q('button[aria-label="Compare with another version"]')).not.toBeNull();
    expect(q('button[aria-label="Rendered"]')).toBeNull();
    expect(q('button[aria-label^="Raw and rendered"]')).toBeNull();
    expect(q("[data-slot=reader-toggle]")).toBeNull();
    // No frontmatter header: that is the rendered view's, and there is none.
    expect(q("[data-slot=frontmatter-header]")).toBeNull();
    // Typing `](` opens no link picker.
    const at = viewOf().state.doc.length;
    await settle(() =>
      viewOf().dispatch({ changes: { from: at, insert: "](" }, userEvent: "input.type" }),
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(q('[data-slot="link-picker"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Link to");
  });

  test("a markdown document still has its rendered view and reader toggle", async () => {
    await open(story);
    expect(q('button[aria-label="Rendered"]')).not.toBeNull();
    expect(q("[data-slot=reader-toggle]")).not.toBeNull();
  });

  test("Save of text that does not parse is refused beside the editor; the text is kept", async () => {
    await open(profile);
    await typeAll(BROKEN);
    await waitFor(() => document.body.textContent?.includes("Unsaved") === true, "Unsaved");
    await click(toolbarSave());
    await waitFor(() => refused() !== null, "the refusal");
    expect(refused()?.getAttribute("role")).toBe("alert");
    expect(refused()?.textContent).toContain("Not saved: this is not valid JSON.");
    expect(refused()?.textContent).toContain("Line 2, column 21:");
    expect(refused()?.textContent).toContain('","');
    // The file is unchanged, the text is still in the editor and the version.
    expect(readFileSync(profile, "utf8")).toBe(VALID);
    expect(viewOf().state.doc.toString()).toBe(BROKEN);
    await waitFor(
      () => daemon.session.readVersion("location", 1).text === BROKEN,
      "the text in the version",
    );
    // The way to the problem.
    await click(button("Go to the problem"));
    expect(revealed.at(-1)?.from).toBe(BROKEN.indexOf('"location"') + '"location"'.length);
    // Fixed, the notice goes, and Save writes.
    await typeAll(VALID.replace("location", "place"));
    await waitFor(() => refused() === null, "the refusal gone");
    await click(toolbarSave());
    await waitFor(() => readFileSync(profile, "utf8").includes('"place"'), "saved");
  });

  test("Mod-S is refused the same way", async () => {
    await open(profile);
    await typeAll("{,}");
    // Through the editor's own key handling, with whichever modifier is Mod here.
    await settle(() => {
      for (const mod of [{ metaKey: true }, { ctrlKey: true }])
        runScopeHandlers(
          viewOf(),
          new window.KeyboardEvent("keydown", { key: "s", code: "KeyS", ...mod }) as KeyboardEvent,
          "editor",
        );
    });
    await waitFor(() => refused() !== null, "the refusal");
    expect(refused()?.textContent).toContain("Line 1, column 2:");
    expect(readFileSync(profile, "utf8")).toBe(VALID);
  });

  test("Compare works on a JSON document", async () => {
    await open(profile);
    await typeAll(VALID.replace('"title"', '"title", "status"'));
    await waitFor(() => document.body.textContent?.includes("Unsaved") === true, "Unsaved");
    await click(q('button[aria-label="Compare with another version"]'));
    await waitFor(
      () => document.body.textContent?.includes("compared with") === true,
      "the compare view",
    );
    expect(document.body.textContent).toContain("1 change");
  });

  test("Mod-Shift-K does nothing to a JSON document: no picker, and no line deleted", async () => {
    await open(profile);
    await settle(() => viewOf().dispatch({ selection: { anchor: 5 } }));
    // Cmd on a Mac, Ctrl elsewhere, as CodeMirror reads `Mod`.
    const mac = /Mac|iPhone|iPad/.test(navigator.platform ?? "");
    await settle(() => {
      viewOf().contentDOM.dispatchEvent(
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
    expect(viewOf().state.doc.toString()).toBe(VALID);
    expect(q('[data-slot="link-picker"]')).toBeNull();
  });

  test("lines are numbered, and the status strip counts characters, not words", async () => {
    await open(profile);
    expect(q(".cm-lineNumbers")).not.toBeNull();
    expect(document.body.textContent).toContain("Characters");
    expect(document.body.textContent).not.toContain("Words");
  });

  test("Raw, the way out of Compare, does not become the markdown documents' view", async () => {
    localStorage.setItem("story-studio:view-mode", "rendered");
    await open(profile);
    await typeAll(VALID.replace('"title"', '"title", "status"'));
    await waitFor(() => document.body.textContent?.includes("Unsaved") === true, "Unsaved");
    await click(q('button[aria-label="Compare with another version"]'));
    await waitFor(() => document.body.textContent?.includes("compared with") === true, "compare");
    await click(q('button[aria-label="Raw text"]'));
    await waitFor(() => q(".cm-editor") !== null, "the editor again");
    expect(localStorage.getItem("story-studio:view-mode")).toBe("rendered");
  });

  test("activating a version that does not parse says so at once, before any Save", async () => {
    await open(profile);
    const res = await fetch(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "version.new", doc: "location" }),
    });
    const made = (await res.json()) as { path: string };
    writeFileSync(made.path, BROKEN);
    await waitFor(() => daemon.session.readVersion("location", 2).text === BROKEN, "v2 written");
    await settle(() => {
      client?.send({ op: "activate", doc: "location", version: 2 });
    });
    await waitFor(() => refused() !== null, "the notice");
    expect(refused()?.textContent).toContain("v2 is not valid JSON, so it will not save");
    expect(refused()?.textContent).toContain("Line 2, column 21:");
    expect(refused()?.textContent).not.toContain("Not saved");
  });

  test("moving between two broken documents shows each one's problem every time", async () => {
    const comma = join(world, "comma.json");
    const quote = join(world, "quote.json");
    writeFileSync(comma, '{\n  "a": 1\n  "b": 2\n}\n');
    writeFileSync(quote, "{'a': 1}\n");
    // The world was in the context before these were written: read it again,
    // as adding it after them once did.
    for (const e of daemon.session.context) daemon.session.rescan(e.id);
    await open(comma);
    const at = (name: string, what: string) =>
      waitFor(
        () =>
          q("[data-slot=json-refused]")?.textContent?.includes(what) === true &&
          document.body.textContent?.includes(name) === true,
        `the notice on ${name}`,
      );
    await at("comma.json", "is missing here");
    for (const [path, name, what] of [
      [quote, "quote.json", "double quotes"],
      [comma, "comma.json", "is missing here"],
      [quote, "quote.json", "double quotes"],
    ] as const) {
      await settle(() => {
        client?.send({ op: "open", path });
      });
      await at(name, what);
    }
    // A markdown document has none, and a JSON one that parses neither.
    await settle(() => {
      client?.send({ op: "open", path: story });
    });
    await waitFor(() => refused() === null, "no notice on markdown");
    await settle(() => {
      client?.send({ op: "open", path: profile });
    });
    await waitFor(() => document.body.textContent?.includes("location.json") === true, "profile");
    expect(refused()).toBeNull();
  });
});

describe("the sidebar's document icon", () => {
  test("braces for JSON, a page for markdown", async () => {
    await mount(
      <div>
        <DocIcon name="_meta/profiles/location.json" className="a" />
        <DocIcon name="story.md" className="b" />
      </div>,
    );
    expect(q("svg.a")?.getAttribute("data-format")).toBe("json");
    expect(q("svg.b")?.getAttribute("data-format")).toBeNull();
  });
});
