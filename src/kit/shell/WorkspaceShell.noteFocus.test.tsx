// The focused note reaches the centre, in the shell over a REAL workspace
// daemon: a note chosen in the Notes tab is the workspace's `focusedNote`, the
// same note the panel borders; another choice moves it; moving to another
// document lets it go; and a note on another document, opened from the panel's
// "owed" line, is focused once chosen there. A second click on the chosen note,
// Escape in the panel, or resolving it lets it go; and the panel's "show
// resolved" reaches the centre too, so the document paints what the panel
// lists. The centre's painting of it is held
// in `document/DocumentPane.noteFocus.test.tsx` (shell and document may not
// import each other).

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useDaemon } from "../context/useDaemon.ts";
import { useWorkspace, type Workspace } from "../context/workspace.ts";
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
import { type LaidOut, laidOut } from "../lib/testLayout.ts";
import { fixtureDaemon } from "../workspace/fixtures/app";
import { AGENT_TAIL_PARAM } from "../workspace/heartbeat";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

const SOLO = "# Solo\n\nThe lantern is lit.\n\nThe harbour is dark.\n";
let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
let stub: LaidOut | null = null;
let letGo: (() => Promise<void>) | null = null;

/** The agent's tail, as the kit's `tail` verb opens it: an agent is listening. */
async function agentTail(): Promise<() => Promise<void>> {
  const ac = new AbortController();
  const res = await nativeGlobal<typeof fetch>("fetch")(
    `${daemon.url}/events?since=-1&${AGENT_TAIL_PARAM}=1`,
    { signal: ac.signal },
  );
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const draining = (async () => {
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch {
      /* aborted */
    }
  })();
  return async () => {
    ac.abort();
    await draining;
  };
}

beforeEach(async () => {
  root = tempRoot("shell-note-focus");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  writeFileSync(join(docs, "solo.md"), SOLO);
  localStorage.clear();
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs });
  await daemon.start();
  letGo = await agentTail();
  stub = laidOut(1200);
});
afterEach(async () => {
  stub?.undo();
  stub = null;
  await letGo?.();
  letGo = null;
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

let w: Workspace | null = null;
const ws = () => w as Workspace;
function Centre() {
  w = useWorkspace();
  return <p data-testid="centre">the centre</p>;
}
function Host() {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={d} centre={<Centre />} />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => [...document.querySelectorAll(sel)];
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const tab = (label: RegExp) =>
  qa('[data-pane="chat"] [role="tab"]').find((b) => label.test(b.textContent ?? "")) ?? null;
const chatPane = () => q('[data-pane="chat"]') as HTMLElement;
const noteRow = (body: string) =>
  qa('[data-slot="note"]').find((n) => (n.textContent ?? "").includes(body)) ?? null;
/** The note's quote: the button in its row that shows its passage. */
const goTo = (body: string) => noteRow(body)?.querySelector("button") ?? null;
const post = (cmd: Record<string, unknown>) =>
  nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
    method: "POST",
    body: JSON.stringify(cmd),
  });
const sidebarRow = (name: string) =>
  qa('[data-pane="context"] button').find((b) => (b.textContent ?? "").includes(name)) ?? null;
const idOf = (body: string) => ws().openDoc?.notes.find((n) => n.body === body)?.id ?? null;
const focused = () => ws().focusedNote ?? null;
const inRow = (body: string, sel: string) =>
  (noteRow(body)?.querySelector(sel) ?? null) as HTMLElement | null;
const key = (el: Element | null, k: string) => {
  if (!el) throw new Error("nothing to press a key on");
  return settle(() => {
    el.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  });
};

async function openByRow(name: string) {
  await waitFor(() => sidebarRow(name) !== null, `${name} in the sidebar`);
  await click(sidebarRow(name));
  await waitFor(() => ws().openDoc?.name === name, `${name} open`);
}

/** Mount with `solo.md` open on the Notes tab, and two notes on it. */
async function openSolo() {
  daemon.session.addContext(join(docs, "solo.md"));
  w = null;
  const m = await mount(<Host />);
  await waitFor(() => w !== null && !!q('[data-pane="chat"]'), "the shell");
  await openByRow("solo.md");
  await click(tab(/Notes/));
  const slug = ws().openDoc?.slug as string;
  await post({ op: "note.add", doc: slug, quote: "lantern", body: "the light" });
  await post({ op: "note.add", doc: slug, quote: "harbour", body: "the water" });
  await waitFor(() => !!noteRow("the light") && !!noteRow("the water"), "both notes");
  return { m, slug };
}

async function openSibling() {
  await settle(() => {
    ws().daemon.send({ op: "context.add", path: join(docs, "sibling.md") });
  });
  await openByRow("sibling.md");
}

describe("a note chosen in the Notes tab is the centre's focused note", () => {
  test("none at first; the chosen one, the one the panel borders; another choice moves it", async () => {
    const { m } = await openSolo();
    expect(focused()).toBeNull();
    await click(goTo("the water"));
    await waitFor(() => focused() !== null, "the focused note");
    expect(focused()).toBe(idOf("the water"));
    expect(noteRow("the water")?.getAttribute("data-focused")).toBe("true");

    await click(goTo("the light"));
    await waitFor(() => focused() === idOf("the light"), "the second choice");
    expect(noteRow("the water")?.getAttribute("data-focused")).toBeNull();
    await m.unmount();
  });

  test("moving to another document lets it go", async () => {
    const { m } = await openSolo();
    await click(goTo("the water"));
    await waitFor(() => focused() === idOf("the water"), "the focused note");
    await openSibling();
    expect(focused()).toBeNull();
    await m.unmount();
  });

  test("a note on another document is focused once its document is open and it is chosen", async () => {
    const { m, slug } = await openSolo();
    // The human's own note, so it is owed an answer and pointed at from elsewhere.
    await settle(() =>
      ws().reportSelection({
        doc: slug,
        version: 1,
        from: SOLO.indexOf("lit"),
        to: SOLO.indexOf("lit") + 3,
        fromLine: 3,
        toLine: 3,
        text: "lit",
      }),
    );
    await waitFor(() => (chatPane().textContent ?? "").includes("lit"), "the quote");
    await typeInto(
      chatPane().querySelector('textarea[aria-label="New note"]') as HTMLTextAreaElement,
      "is it?",
    );
    await click(
      qa('[data-pane="chat"] button').find((b) => b.textContent?.includes("Add note")) ?? null,
    );
    await waitFor(() => noteRow("is it?") !== null, "the human's note");

    await openSibling();
    await waitFor(() => !!q('[data-slot="notes-elsewhere"] button'), "the pointer");
    await click(q('[data-slot="notes-elsewhere"] button'));
    await waitFor(() => ws().openDoc?.name === "solo.md", "solo.md again");
    await waitFor(() => goTo("is it?") !== null, "its note in the panel");
    await click(goTo("is it?"));
    await waitFor(() => focused() !== null, "the focused note");
    expect(focused()).toBe(idOf("is it?"));
    await m.unmount();
  });
});

describe("a chosen note is let go", () => {
  test("by a second click on it", async () => {
    const { m } = await openSolo();
    await click(goTo("the water"));
    await waitFor(() => focused() === idOf("the water"), "the focused note");
    await click(goTo("the water"));
    await waitFor(() => focused() === null, "let go");
    expect(noteRow("the water")?.getAttribute("data-focused")).toBeNull();
    // A third click chooses it again.
    await click(goTo("the water"));
    await waitFor(() => focused() === idOf("the water"), "chosen again");
    await m.unmount();
  });

  test("by Escape in the Notes panel, but not by the edit draft's own Escape", async () => {
    const { m } = await openSolo();
    await click(goTo("the water"));
    await waitFor(() => focused() === idOf("the water"), "the focused note");
    // Escape in the draft closes the draft and keeps the choice.
    await click(inRow("the water", 'button[aria-label="Edit note"]'));
    await waitFor(() => inRow("the water", "textarea") !== null, "the draft");
    await key(inRow("the water", "textarea"), "Escape");
    await waitFor(() => inRow("the water", "textarea") === null, "the draft closed");
    expect(focused()).toBe(idOf("the water"));
    // Escape anywhere else in the panel lets it go.
    await key(goTo("the water"), "Escape");
    await waitFor(() => focused() === null, "let go");
    await m.unmount();
  });

  test("by resolving it", async () => {
    const { m } = await openSolo();
    await click(goTo("the water"));
    await waitFor(() => focused() === idOf("the water"), "the focused note");
    await click(inRow("the water", 'button[aria-label="Resolve note"]'));
    await waitFor(
      () => ws().openDoc?.notes.find((n) => n.body === "the water")?.resolved === true,
      "resolved",
    );
    await waitFor(() => focused() === null, "let go");
    // Its row goes with the other resolved ones.
    await waitFor(() => noteRow("the water") === null, "the row hidden");
    await m.unmount();
  });
});

describe("a resolved note, chosen while resolved notes are shown", () => {
  test("stays chosen; reopened and resolved again, it is let go", async () => {
    const { m } = await openSolo();
    const resolvedNow = () =>
      ws().openDoc?.notes.find((n) => n.body === "the water")?.resolved === true;
    await click(inRow("the water", 'button[aria-label="Resolve note"]'));
    await waitFor(resolvedNow, "resolved");
    const toggle = () =>
      qa('[data-pane="chat"] button').find((b) => /resolved$/.test(b.textContent ?? "")) ?? null;
    await waitFor(() => toggle() !== null, "the toggle");
    await click(toggle());
    await waitFor(() => goTo("the water") !== null, "its row shown");
    await click(goTo("the water"));
    await waitFor(() => focused() === idOf("the water"), "chosen while resolved");

    await click(inRow("the water", 'button[aria-label="Reopen note"]'));
    await waitFor(() => !resolvedNow(), "reopened");
    expect(focused()).toBe(idOf("the water"));
    await click(inRow("the water", 'button[aria-label="Resolve note"]'));
    await waitFor(resolvedNow, "resolved again");
    await waitFor(() => focused() === null, "let go");
    await m.unmount();
  });
});

describe("the panel's show-resolved reaches the centre", () => {
  test("off at first, on while the panel shows resolved notes", async () => {
    const { m } = await openSolo();
    expect(ws().showResolvedNotes ?? false).toBe(false);
    await click(inRow("the water", 'button[aria-label="Resolve note"]'));
    const toggle = () =>
      qa('[data-pane="chat"] button').find((b) => /resolved$/.test(b.textContent ?? "")) ?? null;
    await waitFor(() => toggle() !== null, "the toggle");
    await click(toggle());
    await waitFor(() => ws().showResolvedNotes === true, "shown");
    expect(noteRow("the water")).not.toBeNull();
    await click(toggle());
    await waitFor(() => ws().showResolvedNotes === false, "hidden");
    await m.unmount();
  });
});
