// The agent's `show`, end to end through the pane: a real daemon takes the
// command and broadcasts where to look, and the pane goes there. A change opens
// the comparison against the side its hunk was numbered in and marks it; a
// passage is scrolled to and marked in the view on screen, or on its line in
// compare. Pointing is never choosing: no selection, no focus, no reveal.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EditorView } from "@codemirror/view";
import { useMemo } from "react";
import type { Reveal } from "../context/selection.ts";
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
import { testWorkspace } from "../workspace/fixtures/harness";
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

const TEXT = "# Title\n\nfirst paragraph\n\nthe lantern is lit\n\nlast line\n";
let root: string;
let story: string;
let daemon: WorkspaceDaemon;
let revealed: Omit<Reveal, "seq">[];
let announced: string[];
let selections: string[];

beforeEach(async () => {
  root = tempRoot("document-show");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // The story sits in the session's workspace folder.
  const ws = testWorkspace(root, "ws");
  story = join(ws, "story.md");
  writeFileSync(story, TEXT);
  localStorage.clear();
  revealed = [];
  announced = [];
  selections = [];
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: ws });
  await daemon.start();
});
afterEach(async () => {
  await cleanup();
  localStorage.clear();
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

function Host({ mode }: { mode?: ViewMode }) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  const toasts = useMemo(() => createToastStore(), []);
  const state = d.state;
  if (!state) return null;
  const workspace: Workspace = {
    daemon: d,
    state,
    openDoc: state.docs.find((doc) => doc.slug === state.openDoc) ?? null,
    selection: null,
    reportSelection: (sel) => {
      selections.push(sel.text);
    },
    dropSelection: () => {},
    clearSeq: 0,
    reveal: null,
    requestReveal: (r) => revealed.push(r),
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
      <main data-pane="centre" style={{ width: 900, height: 700 }}>
        <DocumentPane {...(mode ? { mode } : {})} />
      </main>
    </WorkspaceContext.Provider>
  );
}

const cmd = async (body: Record<string, unknown>) => {
  const res = await fetch(`${daemon.url}/cmd`, { method: "POST", body: JSON.stringify(body) });
  return (await res.json()) as Record<string, unknown>;
};
const flashed = () => document.querySelectorAll('[data-flash="on"][data-row]').length;
const pressed = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Compare against"] button')]
    .find((b) => b.textContent === label)
    ?.getAttribute("aria-pressed");

/** The story open in the pane, with a v2 that changes the lantern line. */
async function openStory(mode?: ViewMode) {
  await mount(<Host mode={mode} />);
  await cmd({ op: "context.add", paths: [story] });
  const ws = new (nativeGlobal<typeof WebSocket>("WebSocket"))(`${daemon.url}/ws`);
  await new Promise<void>((r) => {
    ws.onopen = () => r();
  });
  ws.send(JSON.stringify({ op: "open", path: story }));
  ws.close();
  await waitFor(() => daemon.session.openDocSlug === "story", "the story open");
  const made = await cmd({ op: "version.new", doc: "story" });
  writeFileSync(made.path as string, TEXT.replace("the lantern is lit", "the lantern is out"));
  await waitFor(() => daemon.session.doc("story").versions.length === 2, "v2 made");
  await settle();
}

describe("the agent's show in the pane", () => {
  test("a change opens the comparison against its side and marks it", async () => {
    await openStory();
    expect(document.body.textContent).not.toContain("compared with");
    const r = await cmd({ op: "show", doc: "story", hunk: 1, against: 2 });
    expect(r).toMatchObject({ ok: true, hunk: 1, against: 2 });
    await waitFor(() => document.body.textContent?.includes("compared with") === true, "compare");
    await waitFor(() => pressed("v2") === "true", "the comparison against v2");
    await waitFor(() => flashed() > 0, "the change marked");
  });

  test("a passage in the rendered view is marked there, and asks no reveal", async () => {
    await openStory("rendered");
    await waitFor(() => document.querySelector(".md-prose p") !== null, "the rendered text");
    await cmd({ op: "show", doc: "story", quote: "the lantern" });
    // The mark is the rendered view's flash; nothing is selected.
    await settle(() => new Promise((r) => setTimeout(r, 200)));
    expect(revealed).toEqual([]);
    expect(selections).toEqual([]);
  });

  test("a passage in the raw view is marked without taking focus, so typing in the chat goes on", async () => {
    await openStory("raw");
    await waitFor(() => document.querySelector(".cm-content") !== null, "the editor");
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement);
    const composer = document.createElement("textarea");
    composer.setAttribute("aria-label", "Ask the agent");
    document.body.appendChild(composer);
    composer.focus();
    await typeInto(composer, "I was say");
    const r = await cmd({ op: "show", doc: "story", quote: "the lantern is lit" });
    expect(r).toMatchObject({ ok: true, surfaces: 1 });
    await waitFor(() => document.querySelector(".cm-flash") !== null, "the passage marked");
    expect(document.querySelector(".cm-flash")?.textContent).toBe("the lantern is lit");
    // Focus never left the composer; the editor selected nothing.
    expect(document.activeElement).toBe(composer);
    expect(view?.state.selection.main.empty).toBe(true);
    expect(revealed).toEqual([]);
    expect(selections).toEqual([]);
    // The human keeps typing: it lands in the composer, and the document is untouched.
    await typeInto(composer, "I was saying something");
    expect(composer.value).toBe("I was saying something");
    await settle(() => new Promise((r) => setTimeout(r, 400)));
    expect(view?.state.doc.toString()).toBe(TEXT);
    expect(daemon.session.doc("story").dirty).toBe(false);
    expect(readFileSync(story, "utf8")).toBe(TEXT);
    composer.remove();
  });

  test("a passage while comparing marks its line there, and asks no reveal", async () => {
    await openStory("compare");
    // v2 active, so the comparison with the saved file has a change to draw.
    await cmd({ op: "activate", doc: "story", version: 2 });
    await waitFor(() => document.body.textContent?.includes("1 change") === true, "compare");
    await cmd({ op: "show", doc: "story", quote: "last line" });
    await waitFor(() => flashed() > 0, "the line marked");
    const row = document.querySelector('[data-flash="on"][data-row]');
    expect(row?.textContent).toContain("last line");
    expect(revealed).toEqual([]);
  });
});
