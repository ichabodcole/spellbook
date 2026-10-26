// A note with the agent, over a REAL workspace daemon: a note
// the human leaves shows the message wait's pulse, then its static "may be
// stuck", on the note, on the Notes tab, in the note menu and on the floating
// composer. It clears on exactly three things: the note resolved, an agent
// message after it, the agent rewriting it. Nothing else clears it.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { NoteAtSelection } from "../chat/NoteAtSelection.tsx";
import { ENDED_LABEL, NOTE_WAITING_LABEL } from "../chat/WaitingBadge.tsx";
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
import type { WorkspaceDaemon, WorkspaceDaemonOptions } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

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

async function startDaemon(more: Partial<WorkspaceDaemonOptions> = {}) {
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs, ...more });
  await daemon.start();
  letGo = await agentTail();
}
async function stopDaemon() {
  await letGo?.();
  letGo = null;
  await daemon.stop().catch(() => {});
}

beforeEach(async () => {
  root = tempRoot("shell-note-waiting");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  localStorage.clear();
  await startDaemon();
  stub = laidOut(1200);
});
afterEach(async () => {
  stub?.undo();
  stub = null;
  await stopDaemon();
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
/** The mark on a note: its badge, or null when it is not with the agent. */
const markOn = (body: string) => noteRow(body)?.querySelector('[data-waiting-of="note"]') ?? null;
const tabDot = () => tab(/Notes/)?.querySelector('[role="img"][data-waiting-of="note"]') ?? null;
const floatNote = () => q('[data-slot="floating-composer"] [data-slot="float-note"]');
const post = (cmd: Record<string, unknown>) =>
  nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
    method: "POST",
    body: JSON.stringify(cmd),
  });
async function state() {
  const res = await nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/state?full=1`);
  return (await res.json()) as {
    chat: Array<{ from: string; text: string }>;
    docs: Array<{ slug: string; notes: Array<{ id: string; body: string }> }>;
    notesWaiting?: Array<{ noteId: string; badge: string }>;
  };
}

async function mountShell() {
  w = null;
  const m = await mount(<Host />);
  await waitFor(() => w !== null && !!q('[data-pane="chat"]'), "the shell");
  return m;
}

/** Mount with `solo.md` open, on the Notes tab, and return its slug. */
async function openSolo() {
  daemon.session.addContext(join(docs, "solo.md"));
  const m = await mountShell();
  await waitFor(() => (q('[data-pane="context"]')?.textContent ?? "").includes("solo.md"), "entry");
  await click(
    qa('[data-pane="context"] button').find((b) => (b.textContent ?? "").includes("solo.md")) ??
      null,
  );
  await waitFor(() => !!ws().openDoc, "the open document");
  await click(tab(/Notes/));
  return { m, slug: ws().openDoc?.slug as string };
}

/** The human leaves a note on "Solo" (the panel's own way), and its id. */
/** A note the agent makes, on the same passage: not owed, since the human did not write it. */
async function agentNote(slug: string, body: string): Promise<string> {
  const r = await post({ op: "note.add", doc: slug, quote: "Solo", body });
  expect(r.ok).toBe(true);
  return String(((await r.json()) as { note: string }).note);
}

async function humanNote(slug: string, body: string): Promise<string> {
  await settle(() =>
    ws().reportSelection({
      doc: slug,
      version: 1,
      from: 2,
      to: 6,
      fromLine: 1,
      toLine: 1,
      text: "Solo",
    }),
  );
  await waitFor(() => (chatPane().textContent ?? "").includes("Solo"), "the quote");
  await typeInto(
    chatPane().querySelector('textarea[aria-label="New note"]') as HTMLTextAreaElement,
    body,
  );
  await click(
    qa('[data-pane="chat"] button').find((b) => b.textContent?.includes("Add note")) ?? null,
  );
  await waitFor(() => noteRow(body) !== null, `the note "${body}"`);
  const id = (await state()).docs
    .find((d) => d.slug === slug)
    ?.notes.find((n) => n.body === body)?.id;
  if (!id) throw new Error(`no note "${body}" stored`);
  return id;
}

describe("a note the human leaves shows that it is with the agent", () => {
  test("a pulse on the note and a dot on the Notes tab; the agent's own note has none", async () => {
    const { m, slug } = await openSolo();
    await humanNote(slug, "rename this");
    await waitFor(() => markOn("rename this") !== null, "the mark");
    const mark = markOn("rename this") as Element;
    expect(mark.textContent).toBe(NOTE_WAITING_LABEL.working);
    expect(mark.getAttribute("data-badge")).toBe("working");
    expect(mark.querySelector(".animate-pulse")).not.toBeNull();
    expect(noteRow("rename this")?.getAttribute("data-waiting")).toBe("working");
    // The tab keeps its count and adds the dot, with counted words.
    expect(tab(/Notes/)?.textContent).toBe("Notes (1)");
    expect(tabDot()?.getAttribute("aria-label")).toBe("1 note owed an answer");

    // A note the agent leaves is not waiting on the agent.
    await post({ op: "note.add", doc: slug, quote: "Solo", body: "the agent's own" });
    await waitFor(() => noteRow("the agent's own") !== null, "the agent's note");
    expect(markOn("the agent's own")).toBeNull();
    expect(tab(/Notes/)?.textContent).toBe("Notes (2)");
    await m.unmount();
  });

  test("once it has waited as long as a message would, it is stuck: static, and said in words", async () => {
    await stopDaemon();
    await startDaemon({ stallMs: 300, attentionMs: 40 });
    const { m, slug } = await openSolo();
    await humanNote(slug, "is this right?");
    await waitFor(
      () => markOn("is this right?")?.getAttribute("data-badge") === "stalled",
      "the stuck mark",
      4000,
    );
    const mark = markOn("is this right?") as Element;
    expect(mark.textContent).toBe(NOTE_WAITING_LABEL.stalled);
    // Stalled must not pulse: an animation over a wedged agent is false liveness.
    expect(mark.querySelector(".animate-pulse")).toBeNull();
    expect(tabDot()?.getAttribute("data-badge")).toBe("stalled");
    expect(tabDot()?.getAttribute("aria-label")).toBe("1 note owed an answer; it may be stuck");
    await m.unmount();
  });

  test("after End session a stuck note says the session ended instead: on the note, the tab and the float", async () => {
    await stopDaemon();
    await startDaemon({ stallMs: 300, attentionMs: 40 });
    const { m, slug } = await openSolo();
    await humanNote(slug, "still owed");
    await waitFor(
      () => markOn("still owed")?.getAttribute("data-badge") === "stalled",
      "the stuck mark",
      4000,
    );
    await settle(() => {
      ws().daemon.send({ op: "close" });
    });
    await waitFor(() => ws().daemon.connection === "ended", "the session ended");
    await waitFor(() => markOn("still owed")?.getAttribute("data-badge") === "ended", "ended");
    expect(markOn("still owed")?.textContent).toBe(ENDED_LABEL.note);
    expect(markOn("still owed")?.querySelector(".animate-pulse") === null).toBe(true);
    expect(tabDot()?.getAttribute("data-badge")).toBe("ended");
    expect(tabDot()?.getAttribute("aria-label")).toBe(`1 note owed an answer; ${ENDED_LABEL.note}`);
    // The float's note row, with the column collapsed.
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => floatNote() !== null, "the float's note");
    expect(floatNote()?.querySelector("[data-badge]")?.getAttribute("data-badge")).toBe("ended");
    expect(floatNote()?.textContent ?? "").not.toContain("may be stuck");
    await m.unmount();
  });

  test("the note menu on the passage marks a note that is still with the agent", async () => {
    const at = { x: 10, y: 10, from: 2, to: 6, noteIds: ["n1", "n2"] };
    const m = await mount(
      <NoteAtSelection
        at={at}
        quote="Solo"
        existing={[
          { id: "n1", label: "owed", waiting: "stalled" },
          { id: "n2", label: "answered" },
        ]}
        onClose={() => {}}
        onAdd={() => {}}
        onShowNote={() => {}}
        onDeleteNote={() => {}}
      />,
    );
    const rowOf = (label: string) => qa("button").find((b) => b.textContent === label);
    await waitFor(() => !!rowOf("owed"), "the menu");
    expect(
      rowOf("owed")?.querySelector('[data-waiting-of="note"]')?.getAttribute("data-badge"),
    ).toBe("stalled");
    expect(rowOf("answered")?.querySelector('[data-waiting-of="note"]')).toBeNull();
    await m.unmount();
  });

  test("a note owed on another document is pointed at from the panel, and opens it", async () => {
    const { m, slug } = await openSolo();
    await humanNote(slug, "over here");
    await settle(() => {
      ws().daemon.send({ op: "context.add", path: join(docs, "sibling.md") });
    });
    await waitFor(
      () => (q('[data-pane="context"]')?.textContent ?? "").includes("sibling.md"),
      "the sibling",
    );
    await click(
      qa('[data-pane="context"] button').find((b) =>
        (b.textContent ?? "").includes("sibling.md"),
      ) ?? null,
    );
    await waitFor(() => ws().openDoc?.name === "sibling.md", "the other document");
    await waitFor(() => !!q('[data-slot="notes-elsewhere"]'), "the pointer");
    expect(q('[data-slot="notes-elsewhere"]')?.textContent).toContain(
      "A note owed an answer on solo.md",
    );
    // The tab's dot is the session's, so it shows here too.
    expect(tabDot()).not.toBeNull();
    await click(q('[data-slot="notes-elsewhere"] button'));
    await waitFor(() => ws().openDoc?.name === "solo.md", "solo.md again");
    await waitFor(() => markOn("over here") !== null, "the mark on its note");
    expect(q('[data-slot="notes-elsewhere"]')).toBeNull();
    await m.unmount();
  });
});

describe("the floating composer says when a note is with the agent", () => {
  test("its own row names the note above the agent's line, with the note's badge", async () => {
    const { m, slug } = await openSolo();
    await post({ op: "say", text: "The harbour is mapped." });
    await humanNote(slug, "tighten the opening");
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => floatNote() !== null, "the float's note row");
    const row = floatNote() as Element;
    expect(row.textContent).toContain("Your note");
    expect(row.textContent).toContain("tighten the opening");
    // A note on the open document needs no document named.
    expect(row.textContent).not.toContain("solo.md");
    expect(row.querySelector('[data-waiting-of="note"]')?.textContent).toBe(
      NOTE_WAITING_LABEL.working,
    );
    // The note's row and the conversation's line are two waits: neither hides the other.
    expect(q('[data-slot="float-line"]')?.textContent).toContain("The harbour is mapped.");
    const rows = qa('[data-slot="floating-composer"] > div');
    expect(rows.indexOf(row)).toBeLessThan(
      rows.findIndex((r) => r.querySelector('[data-slot="float-line"]')),
    );
    await m.unmount();
  });

  test("a second note is counted outside the text, and the agent's answer clears the row", async () => {
    const { m, slug } = await openSolo();
    await humanNote(slug, "first of two");
    await humanNote(slug, "second of two");
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => floatNote() !== null, "the float's note row");
    // The oldest is named, and the count sits outside the truncated text.
    const text = floatNote()?.querySelector("p.truncate");
    expect(text?.textContent).toContain("first of two");
    expect(text?.textContent).not.toContain("+1 more");
    expect(floatNote()?.textContent).toContain("+1 more");
    await post({ op: "say", text: "Both seen." });
    await waitFor(() => floatNote() === null, "the row to go");
    await m.unmount();
  });

  test("a note on another document names that document", async () => {
    const { m, slug } = await openSolo();
    await humanNote(slug, "elsewhere note");
    await settle(() => {
      ws().daemon.send({ op: "context.add", path: join(docs, "sibling.md") });
      ws().daemon.send({ op: "open", path: join(docs, "sibling.md") });
    });
    await waitFor(() => ws().openDoc?.name === "sibling.md", "the other document");
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(
      () => (floatNote()?.textContent ?? "").includes("Your note on solo.md"),
      "the document named",
    );
    await m.unmount();
  });
});

describe("the mark clears on exactly three things", () => {
  test("the note resolved", async () => {
    const { m, slug } = await openSolo();
    await humanNote(slug, "resolve me");
    await waitFor(() => markOn("resolve me") !== null, "the mark");
    await click(noteRow("resolve me")?.querySelector('[aria-label="Resolve note"]') ?? null);
    await waitFor(() => noteRow("resolve me") === null, "the note to hide");
    await click(
      qa('[data-pane="chat"] button').find((b) => /Show 1 resolved/.test(b.textContent ?? "")) ??
        null,
    );
    await waitFor(() => noteRow("resolve me") !== null, "the resolved note shown");
    expect(markOn("resolve me")).toBeNull();
    expect(tabDot()).toBeNull();
    await m.unmount();
  });

  test("an agent message after the note", async () => {
    const { m, slug } = await openSolo();
    await humanNote(slug, "answer me");
    await waitFor(() => markOn("answer me") !== null, "the mark");
    await post({ op: "say", text: "Done." });
    await waitFor(() => markOn("answer me") === null, "the mark to clear");
    // The note stays open: an answer is not "dealt with".
    expect(noteRow("answer me")?.hasAttribute("data-resolved")).toBe(false);
    expect(tabDot()).toBeNull();
    await m.unmount();
  });

  // note-reply-cannot-overwrite: the agent answers the human's note beside it.
  // A rewrite of it is refused, and the note keeps the human's words.
  test("the agent replying to the note: the reply shows with it, the note's words unchanged", async () => {
    const { m, slug } = await openSolo();
    const id = await humanNote(slug, "reply to me");
    await waitFor(() => markOn("reply to me") !== null, "the mark");
    expect(
      (await post({ op: "note.edit", doc: slug, id, body: "rewritten by the agent" })).status,
    ).toBe(409);
    const r = await post({ op: "note.reply", doc: slug, id, body: "replied by the agent" });
    expect(r.ok).toBe(true);
    await waitFor(
      () => !!noteRow("reply to me")?.querySelector('[data-slot="note-reply"]'),
      "the reply on the note",
    );
    const row = noteRow("reply to me");
    expect(row?.querySelector('[data-slot="note-body"]')?.textContent).toBe("reply to me");
    expect(row?.querySelector('[data-slot="note-reply"]')?.textContent).toContain(
      "replied by the agent",
    );
    expect(row?.querySelector('[data-slot="note-edited"]')).toBeNull();
    expect(markOn("reply to me")).toBeNull();
    expect(tabDot()).toBeNull();
    await m.unmount();
  });

  test("the agent rewriting its own note", async () => {
    const { m, slug } = await openSolo();
    const id = await agentNote(slug, "the agent's first try");
    const r = await post({ op: "note.edit", doc: slug, id, body: "the agent's second try" });
    expect(r.ok).toBe(true);
    await waitFor(() => noteRow("the agent's second try") !== null, "the rewrite");
    expect(markOn("the agent's second try")).toBeNull();
    await m.unmount();
  });

  test("a note the agent replied to stays answered after a daemon restart, its reply still shown", async () => {
    const first = await openSolo();
    const id = await humanNote(first.slug, "before the restart");
    await post({ op: "note.reply", doc: first.slug, id, body: "answered by a reply" });
    await waitFor(
      () => !!noteRow("before the restart")?.querySelector('[data-slot="note-reply"]'),
      "the reply",
    );
    expect(markOn("before the restart")).toBeNull();
    await first.m.unmount();
    const port = daemon.port;
    const sessionId = daemon.sessionId;
    await stopDaemon();
    await startDaemon({ port, restore: sessionId });
    const again = await mountShell();
    await click(tab(/Notes/));
    await waitFor(
      () =>
        (
          noteRow("before the restart")?.querySelector('[data-slot="note-reply"]')?.textContent ??
          ""
        ).includes("answered by a reply"),
      "the note and its reply after a restart",
    );
    expect(markOn("before the restart")).toBeNull();
    expect(tabDot()).toBeNull();
    await again.unmount();
  });
});

describe("a rewrite shows on the note", () => {
  test("the agent's says so, keeps what it replaced, and puts it back in one act that asks again", async () => {
    const { m, slug } = await openSolo();
    // The agent's own note: the human's it may not rewrite.
    const id = await agentNote(slug, "my own words");
    await post({ op: "note.edit", doc: slug, id, body: "the agent's words" });
    await waitFor(() => noteRow("the agent's words") !== null, "the rewrite");
    const row = () => noteRow("the agent's words") ?? noteRow("my own words");
    expect(row()?.querySelector('[data-slot="note-edited"]')?.textContent).toBe(
      "edited by the agent",
    );
    // What it replaced is there on asking, not in the way.
    expect(row()?.querySelector('[data-slot="note-replaced"]')).toBeNull();
    await click(row()?.querySelector('[data-action="note-show-replaced"]') ?? null);
    expect(row()?.querySelector('[data-slot="note-replaced"]')?.textContent).toContain(
      "my own words",
    );
    // Putting it back is the human's rewrite: the note is with the agent again.
    await click(row()?.querySelector('[data-action="note-restore"]') ?? null);
    await waitFor(
      () =>
        (noteRow("my own words")?.querySelector('[data-slot="note-body"]')?.textContent ?? "") ===
        "my own words",
      "the words put back",
    );
    await waitFor(() => markOn("my own words") !== null, "owed again");
    expect(noteRow("my own words")?.querySelector('[data-slot="note-edited"]')?.textContent).toBe(
      "edited",
    );
    // Nothing is left to put back.
    expect(noteRow("my own words")?.querySelector('[data-action="note-show-replaced"]')).toBeNull();
    const stored = (await state()).docs
      .find((d) => d.slug === slug)
      ?.notes.find((n) => n.id === id);
    expect(stored).toMatchObject({ body: "my own words" });
    expect(stored).not.toHaveProperty("replacedBody");
    await m.unmount();
  });

  test("the agent rewriting its note back to the words it replaced reads as plain edited, with nothing to put back", async () => {
    const { m, slug } = await openSolo();
    const id = await agentNote(slug, "back again");
    await post({ op: "note.edit", doc: slug, id, body: "a detour" });
    await waitFor(() => noteRow("a detour") !== null, "the rewrite");
    await post({ op: "note.edit", doc: slug, id, body: "back again" });
    await waitFor(
      () =>
        noteRow("back again")?.querySelector('[data-slot="note-edited"]')?.textContent === "edited",
      "plain edited",
    );
    expect(noteRow("back again")?.querySelector('[data-action="note-show-replaced"]')).toBeNull();
    expect(markOn("back again")).toBeNull();
    await m.unmount();
  });

  test("a note never rewritten says nothing; the human's own rewrite says edited", async () => {
    const { m, slug } = await openSolo();
    await humanNote(slug, "untouched");
    expect(noteRow("untouched")?.querySelector('[data-slot="note-edited"]')).toBeNull();
    await click(noteRow("untouched")?.querySelector('[aria-label="Edit note"]') ?? null);
    await typeInto(
      noteRow("untouched")?.querySelector("textarea") as HTMLTextAreaElement,
      "touched",
    );
    await click(qa('[data-slot="note"] button').find((b) => b.textContent === "Save") ?? null);
    await waitFor(() => noteRow("touched") !== null, "the rewrite");
    await waitFor(
      () =>
        noteRow("touched")?.querySelector('[data-slot="note-edited"]')?.textContent === "edited",
      "edited",
    );
    expect(noteRow("touched")?.querySelector('[data-action="note-show-replaced"]')).toBeNull();
    await m.unmount();
  });
});

describe("and on nothing else", () => {
  test("not a human message", async () => {
    const { m, slug } = await openSolo();
    await humanNote(slug, "still owed");
    await settle(() => {
      ws().daemon.send({ op: "say", text: "any news?", withSelection: false });
    });
    // The snapshot after the message is on screen: the message is waiting too.
    await waitFor(
      () => !!tab(/Chat/)?.querySelector('[data-waiting-of="message"]'),
      "the message's own wait",
    );
    expect(markOn("still owed")).not.toBeNull();
    expect(tabDot()).not.toBeNull();
    await m.unmount();
  });

  test("not the human rewriting it", async () => {
    const { m, slug } = await openSolo();
    await humanNote(slug, "my words");
    await post({ op: "say", text: "Seen." });
    await waitFor(() => markOn("my words") === null, "answered");
    // A human rewrite puts it in front of the agent again.
    await click(noteRow("my words")?.querySelector('[aria-label="Edit note"]') ?? null);
    await typeInto(noteRow("my words")?.querySelector("textarea") as HTMLTextAreaElement, "mine");
    await click(qa('[data-slot="note"] button').find((b) => b.textContent === "Save") ?? null);
    await waitFor(() => noteRow("mine") !== null, "the rewrite");
    await waitFor(() => markOn("mine") !== null, "owed again");
    expect(markOn("mine")?.getAttribute("data-badge")).toBe("working");
    await m.unmount();
  });

  test("not a reload, nor a restart of the daemon", async () => {
    const first = await openSolo();
    await humanNote(first.slug, "survives");
    await waitFor(() => markOn("survives") !== null, "the mark");
    await first.m.unmount();

    // The page reloads: the mark is derived again from what the daemon holds.
    const again = await mountShell();
    await click(tab(/Notes/));
    await waitFor(() => markOn("survives") !== null, "the mark after a reload");
    await again.unmount();

    // The daemon restarts: nothing stored it, and it is derived again.
    const port = daemon.port;
    const sessionId = daemon.sessionId;
    await stopDaemon();
    await startDaemon({ port, restore: sessionId });
    const third = await mountShell();
    await click(tab(/Notes/));
    await waitFor(() => markOn("survives") !== null, "the mark after a restart");
    await third.unmount();
  });

  test("not the agent rewriting a different note", async () => {
    const { m, slug } = await openSolo();
    await humanNote(slug, "this one");
    const other = await agentNote(slug, "that one");
    const r = await post({ op: "note.edit", doc: slug, id: other, body: "that one, rewritten" });
    expect(r.ok).toBe(true);
    await waitFor(() => noteRow("that one, rewritten") !== null, "the other rewrite");
    expect(markOn("that one, rewritten")).toBeNull();
    expect(markOn("this one")).not.toBeNull();
    expect(tabDot()?.getAttribute("aria-label")).toBe("1 note owed an answer");
    await m.unmount();
  });
});
