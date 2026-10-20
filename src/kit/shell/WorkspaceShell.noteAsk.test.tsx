// "Ask the agent" on a note that may be stuck, over a REAL workspace daemon,
// with a real agent tail listening. The act is offered beside "may be stuck" in
// the Notes panel and on the floating composer's note line; it sends one
// message (`via: "ask"`, `about.noteId`) that the agent's tail receives once,
// however often it is pressed; the note then says it was asked, and the act is
// not offered again until the note is a new question. Absent the shell's
// `askAboutNotes`, it is not offered at all.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  ASKED_LABEL,
  ASKED_UNHEARD_LABEL,
  NOTE_WAITING_LABEL,
  UNHEARD_LABEL,
} from "../chat/WaitingBadge.tsx";
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
import { WorkspaceShell, type WorkspaceShellProps } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(async () => {
  await removeDom();
});

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
let stub: LaidOut | null = null;
let tail: { stop: () => Promise<void>; text: () => string } | null = null;

/** The agent's tail, as the kit's `tail` verb opens it, keeping what it hears. */
async function agentTail() {
  const ac = new AbortController();
  const res = await nativeGlobal<typeof fetch>("fetch")(
    `${daemon.url}/events?since=-1&${AGENT_TAIL_PARAM}=1`,
    { signal: ac.signal },
  );
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let heard = "";
  const draining = (async () => {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        heard += decoder.decode(r.value, { stream: true });
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    stop: async () => {
      ac.abort();
      await draining;
    },
    text: () => heard,
  };
}

/** The asks the agent's tail has heard: message events through the ask gesture. */
const asksHeard = (): { via?: string; about?: { noteId?: string }; text?: string }[] =>
  (tail?.text() ?? "")
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => {
      try {
        return JSON.parse(l.slice(5)) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .map((e) => (typeof e.data === "object" && e.data !== null ? e.data : e) as never)
    .filter((e: { via?: string }) => e.via === "ask");

beforeEach(async () => {
  root = tempRoot("shell-note-ask");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  localStorage.clear();
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    workspace: docs,
    stallMs: 300,
    attentionMs: 40,
    // Presence lets go soon after the tail does, for the "no agent listening" case.
    agentGraceMs: 50,
  });
  await daemon.start();
  tail = await agentTail();
  stub = laidOut(1200);
});
afterEach(async () => {
  stub?.undo();
  stub = null;
  await tail?.stop();
  tail = null;
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

let w: Workspace | null = null;
const ws = () => w as Workspace;
function Centre() {
  w = useWorkspace();
  return <p data-testid="centre">the centre</p>;
}
function Host({ ask }: { ask?: WorkspaceShellProps["askAboutNotes"] }) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell
        daemon={d}
        centre={<Centre />}
        {...(ask !== undefined ? { askAboutNotes: ask } : {})}
      />
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
const markOn = (body: string) => noteRow(body)?.querySelector("[data-waiting-of]") ?? null;
const askOn = (body: string) => noteRow(body)?.querySelector('[data-action="note-ask"]') ?? null;
const floatNote = () => q('[data-slot="floating-composer"] [data-slot="float-note"]');
const floatAsk = () => floatNote()?.querySelector('[data-action="float-note-ask"]') ?? null;
const post = (cmd: Record<string, unknown>) =>
  nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
    method: "POST",
    body: JSON.stringify(cmd),
  });
async function chat() {
  const res = await nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/state?full=1`);
  return (
    (await res.json()) as {
      chat: { from: string; text: string; via?: string; about?: { noteId?: string } }[];
    }
  ).chat;
}

/** Mount with `solo.md` open, on the Notes tab, and return its slug. */
async function openSolo(ask?: WorkspaceShellProps["askAboutNotes"]) {
  daemon.session.addContext(join(docs, "solo.md"));
  w = null;
  const m = await mount(<Host {...(ask !== undefined ? { ask } : {})} />);
  await waitFor(() => w !== null && !!q('[data-pane="chat"]'), "the shell");
  await waitFor(() => (q('[data-pane="context"]')?.textContent ?? "").includes("solo.md"), "entry");
  await click(
    qa('[data-pane="context"] button').find((b) => (b.textContent ?? "").includes("solo.md")) ??
      null,
  );
  await waitFor(() => !!ws().openDoc, "the open document");
  await click(tab(/Notes/));
  return { m, slug: ws().openDoc?.slug as string };
}

/** The human leaves a note on "Solo", and its id. */
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
  const id = ws()
    .daemon.state?.docs.find((d) => d.slug === slug)
    ?.notes.find((n) => n.body === body)?.id;
  if (!id) throw new Error(`no note "${body}" stored`);
  return id;
}

/** Press twice in one go: the second press finds nothing to press, or sends nothing. */
async function pressTwice(find: () => Element | null) {
  await settle(() => {
    const first = find();
    if (!first) throw new Error("nothing to press");
    first.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    (find() ?? first).dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

describe("a note that may be stuck offers Ask the agent", () => {
  test("in the Notes panel: one ask reaches the agent's tail, and the note says it was asked", async () => {
    const { m, slug } = await openSolo(true);
    const id = await humanNote(slug, "is this the right word?");
    // While the note is only with the agent, nothing to ask yet.
    expect(markOn("is this the right word?")?.textContent).toBe(NOTE_WAITING_LABEL.working);
    expect(askOn("is this the right word?")).toBeNull();
    await waitFor(() => askOn("is this the right word?") !== null, "the act", 4000);
    expect(markOn("is this the right word?")?.textContent).toBe(NOTE_WAITING_LABEL.stalled);

    await pressTwice(() => askOn("is this the right word?"));
    // Gone at once, before the daemon's snapshot: nothing left to press again.
    expect(askOn("is this the right word?")).toBeNull();
    await waitFor(() => asksHeard().length > 0, "the ask on the agent's tail");
    const [heard] = asksHeard();
    expect(heard?.about?.noteId).toBe(id);
    expect(heard?.text).toContain("is this the right word?");
    // The note waits on that message now, and says so.
    await waitFor(
      () => markOn("is this the right word?")?.getAttribute("data-waiting-of") === "asked",
      "the asked mark",
    );
    // The note's own wait is stuck, but it now waits on a fresh message: it
    // reads the conversation's badge (working), not its own.
    expect(markOn("is this the right word?")?.textContent).toBe(ASKED_LABEL.working);
    // Once the ask itself goes quiet, the note says that too, and still offers nothing.
    await waitFor(
      () => markOn("is this the right word?")?.textContent === ASKED_LABEL.stalled,
      "the ask gone quiet",
      4000,
    );
    expect(askOn("is this the right word?")).toBeNull();
    // One message in the conversation, one on the tail, after every press.
    await new Promise((r) => setTimeout(r, 150));
    expect(asksHeard()).toHaveLength(1);
    expect((await chat()).filter((c) => c.via === "ask")).toHaveLength(1);
    await m.unmount();
  });

  test("on the floating composer's note line, with the column collapsed", async () => {
    const { m, slug } = await openSolo(true);
    const id = await humanNote(slug, "float me");
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => floatNote() !== null, "the float's note row");
    await waitFor(() => floatAsk() !== null, "the float's act", 4000);
    await pressTwice(floatAsk);
    expect(floatAsk()).toBeNull();
    await waitFor(() => asksHeard().length > 0, "the ask on the agent's tail");
    await waitFor(
      () => floatNote()?.querySelector('[data-waiting-of="asked"]') !== null,
      "the float's asked mark",
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(asksHeard()).toHaveLength(1);
    expect(asksHeard()[0]?.about?.noteId).toBe(id);
    await m.unmount();
  });

  test("the float names the oldest note not yet asked about, with its act", async () => {
    const { m, slug } = await openSolo(true);
    await humanNote(slug, "older, asked");
    await humanNote(slug, "newer, not asked");
    await waitFor(() => askOn("older, asked") !== null, "the act", 4000);
    await click(askOn("older, asked"));
    await waitFor(() => asksHeard().length === 1, "the ask");
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => floatNote() !== null, "the float's note row");
    const named = floatNote()?.querySelector("p.truncate")?.textContent ?? "";
    expect(named).toContain("newer, not asked");
    expect(named).not.toContain("older, asked");
    expect(floatNote()?.querySelector('[data-waiting-of="note"]')).not.toBeNull();
    await waitFor(() => floatAsk() !== null, "the float's act on the newer note", 4000);
    await m.unmount();
  });

  test("with no agent listening, an asked note still says it was asked, and nothing offers an ask", async () => {
    const { m, slug } = await openSolo(true);
    await humanNote(slug, "asked before it left");
    await humanNote(slug, "never asked");
    await waitFor(() => askOn("asked before it left") !== null, "the act", 4000);
    await click(askOn("asked before it left"));
    await waitFor(() => asksHeard().length === 1, "the ask");
    await tail?.stop();
    await waitFor(
      () => markOn("asked before it left")?.getAttribute("data-badge") === "unheard",
      "the unheard mark",
      4000,
    );
    expect(markOn("asked before it left")?.textContent).toBe(ASKED_UNHEARD_LABEL);
    expect(markOn("never asked")?.textContent).toBe(UNHEARD_LABEL);
    // An ask would reach nobody, so none is offered.
    expect(askOn("never asked")).toBeNull();
    await m.unmount();
  });

  test("the agent's answer clears it; a human rewrite makes it a new question, asked again", async () => {
    const { m, slug } = await openSolo(true);
    const id = await humanNote(slug, "first question");
    await waitFor(() => askOn("first question") !== null, "the act", 4000);
    await click(askOn("first question"));
    await waitFor(() => asksHeard().length === 1, "the first ask");
    await post({ op: "say", text: "Looking at it." });
    await waitFor(() => markOn("first question") === null, "the mark to clear");

    await settle(() => {
      ws().daemon.send({ op: "note.edit", doc: slug, id, body: "second question" });
    });
    await waitFor(() => askOn("second question") !== null, "the act again", 4000);
    await click(askOn("second question"));
    await waitFor(() => asksHeard().length === 2, "the second ask");
    await m.unmount();
  });

  test("an app's own words, through a function", async () => {
    const { m, slug } = await openSolo((note, doc) => `Still waiting on "${note.body}" (${doc})`);
    await humanNote(slug, "my words");
    await waitFor(() => askOn("my words") !== null, "the act", 4000);
    await click(askOn("my words"));
    await waitFor(() => asksHeard().length === 1, "the ask");
    expect(asksHeard()[0]?.text).toBe('Still waiting on "my words" (solo.md)');
    await m.unmount();
  });

  test("absent askAboutNotes, not offered: the badge alone", async () => {
    const { m, slug } = await openSolo();
    await humanNote(slug, "no act here");
    await waitFor(
      () => markOn("no act here")?.textContent === NOTE_WAITING_LABEL.stalled,
      "the stuck mark",
      4000,
    );
    expect(askOn("no act here")).toBeNull();
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => floatNote() !== null, "the float's note row");
    expect(floatAsk()).toBeNull();
    await m.unmount();
  });
});
