// E53's waiting mark with the composer closed, over a REAL workspace daemon. The
// chat column collapsed and the float closed leave only the rail; while the
// human's message (or a note) waits on the agent, the rail's composer button
// carries the mark: unheard with no agent, a pulse while one listens, static and
// "may be stuck" once it stalls. It goes when the wait does, and it is not the
// unseen mark: the agent's answer swaps one for the other.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { UNHEARD_LABEL, WAITING_LABEL } from "../chat/WaitingBadge.tsx";
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
}

beforeEach(async () => {
  root = tempRoot("shell-rail-waiting");
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
const float = () => q('[data-slot="floating-composer"]');
const floatInput = () =>
  q('[data-slot="floating-composer"] [data-slot="composer-input"]') as HTMLTextAreaElement | null;
const showIcon = () => q('[data-column-control="chat-float-show"]');
/** The waiting mark on the rail: its dot, or null. */
const railMark = () => q('[data-slot="chat-rail-waiting"] [data-badge]');
const unseen = () => q("[data-slot=chat-unseen]");
const agentSays = (text: string) =>
  nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
    method: "POST",
    body: JSON.stringify({ op: "say", text, from: "agent" }),
  });

async function mountShell() {
  w = null;
  const m = await mount(<Host />);
  await waitFor(() => w !== null && !!q('[data-pane="chat"]'), "the shell");
  return m;
}
/** Collapse the column, send `text` from the float, then close the float. */
async function sendThenClose(text: string) {
  await click(q('[data-column-control="chat-collapse"]'));
  await waitFor(() => floatInput() !== null, "the float");
  await typeInto(floatInput() as HTMLTextAreaElement, text);
  await click(
    qa('[data-slot="floating-composer"] button').find((b) => b.textContent?.includes("Send")) ??
      null,
  );
  await waitFor(() => !!ws().state.waiting, "the message waiting");
  await click(q('[data-slot="floating-composer"] [data-action="float-close"]'));
  await waitFor(() => float() === null && showIcon() !== null, "the float closed");
}

describe("the closed composer's rail shows what waits on the agent", () => {
  test("unheard with no agent, a pulse once one listens, gone when it answers", async () => {
    const m = await mountShell();
    await sendThenClose("and the rivers?");
    // No agent yet: the unheard mark, which does not pulse, and the button says so.
    await waitFor(() => railMark()?.getAttribute("data-badge") === "unheard", "unheard");
    expect(railMark()?.className).not.toContain("animate-pulse");
    expect(showIcon()?.getAttribute("aria-label")).toBe(
      `Show the composer (your message: ${UNHEARD_LABEL})`,
    );
    // The mark is the button's words, not a second thing to read.
    expect(q('[data-slot="chat-rail-waiting"]')?.getAttribute("aria-hidden")).toBe("true");
    expect(unseen()).toBeNull();

    letGo = await agentTail();
    await waitFor(() => railMark()?.getAttribute("data-badge") === "working", "working");
    expect(railMark()?.className).toContain("animate-pulse");
    expect(showIcon()?.getAttribute("aria-label")).toBe(
      `Show the composer (your message: ${WAITING_LABEL.working})`,
    );

    // The answer ends the wait: the waiting mark goes and the unseen mark comes.
    // Two marks, two facts, never both about the same thing.
    await agentSays("Mapped them too.");
    await waitFor(() => railMark() === null, "the mark gone");
    await waitFor(() => unseen() !== null, "the unseen mark");
    expect(showIcon()?.getAttribute("aria-label")).toBe("Show the composer");
    await m.unmount();
  });

  test("after the stall it is static and says it may be stuck", async () => {
    await daemon.stop();
    await startDaemon({ stallMs: 300, attentionMs: 40 });
    letGo = await agentTail();
    const m = await mountShell();
    await sendThenClose("is this right?");
    await waitFor(() => railMark()?.getAttribute("data-badge") === "stalled", "stalled", 4000);
    expect(railMark()?.className).not.toContain("animate-pulse");
    expect(showIcon()?.getAttribute("aria-label")).toBe(
      `Show the composer (your message: ${WAITING_LABEL.stalled})`,
    );
    expect(showIcon()?.getAttribute("aria-label")).toContain("may be stuck");
    await m.unmount();
  });

  test("opening the composer or the column takes the mark with the rail; it is back while the wait is", async () => {
    letGo = await agentTail();
    const m = await mountShell();
    await sendThenClose("still there?");
    await waitFor(() => railMark() !== null, "the mark");
    // The composer reopened: its own line carries the badge, the rail's mark is gone.
    await click(showIcon());
    await waitFor(() => float() !== null, "the float");
    expect(railMark()).toBeNull();
    expect(q('[data-slot="floating-composer"] [data-badge]')).not.toBeNull();
    // Closed again while it still waits: the mark is the wait, so it is back.
    await click(q('[data-slot="floating-composer"] [data-action="float-close"]'));
    await waitFor(() => railMark() !== null, "the mark again");
    // The column reopened: no rail, no mark.
    await click(q('[data-column-control="chat-reopen"]'));
    await waitFor(() => !ws().columns.collapsed.chat, "the column open");
    expect(railMark()).toBeNull();
    await m.unmount();
  });

  test("a note owed an answer marks it too, in counted words", async () => {
    letGo = await agentTail();
    daemon.session.addContext(join(docs, "solo.md"));
    const m = await mountShell();
    await waitFor(
      () => (q('[data-pane="context"]')?.textContent ?? "").includes("solo.md"),
      "entry",
    );
    await click(
      qa('[data-pane="context"] button').find((b) => (b.textContent ?? "").includes("solo.md")) ??
        null,
    );
    await waitFor(() => !!ws().openDoc, "the open document");
    const slug = ws().openDoc?.slug as string;
    await settle(() => {
      ws().daemon.send({ op: "note.add", doc: slug, quote: "Solo", body: "tighten" });
    });
    await waitFor(() => (ws().state.notesWaiting ?? []).length === 1, "the note owed");
    await click(q('[data-column-control="chat-collapse"]'));
    await waitFor(() => float() !== null, "the float");
    await click(q('[data-slot="floating-composer"] [data-action="float-close"]'));
    await waitFor(() => railMark()?.getAttribute("data-badge") === "working", "the note's mark");
    expect(showIcon()?.getAttribute("aria-label")).toBe(
      "Show the composer (1 note owed an answer)",
    );
    await m.unmount();
  });
});
