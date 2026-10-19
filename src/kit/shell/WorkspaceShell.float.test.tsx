// The floating composer over a REAL workspace daemon: with the conversation
// column collapsed, the composer floats at the foot of the centre (chip, the
// agent's latest line, a way back to the conversation), or is closed to a chat
// icon on the rail. One draft wherever the composer is drawn.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
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
import type { WorkspaceDaemon } from "../workspace/server";
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

beforeEach(async () => {
  root = tempRoot("shell-float");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  localStorage.clear();
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs });
  await daemon.start();
  stub = laidOut(1200);
});
afterEach(async () => {
  stub?.undo();
  stub = null;
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

/** The library's own key for the shell's layout, and a layout with the chat shut. */
const LAYOUT_KEY = "story-studio:react-resizable-panels:panes:context:centre:chat";
const CHAT_SHUT = JSON.stringify({ context: 22, centre: 75, chat: 3 });

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
const columnInput = () =>
  q('[data-pane="chat"] [data-slot="composer-input"]') as HTMLTextAreaElement | null;
const showIcon = () => q('[data-column-control="chat-float-show"]');
const closeFloat = () => q('[data-slot="floating-composer"] [data-action="float-close"]');
const openConversation = () => q('[data-slot="floating-composer"] [data-action="float-open"]');
const mark = () => q("[data-slot=chat-unseen]");
const agentSays = (text: string) =>
  nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
    method: "POST",
    body: JSON.stringify({ op: "say", text, from: "agent" }),
  });
async function chatLog() {
  const res = await nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/state?full=1`);
  return ((await res.json()) as { chat: Array<{ from: string; text: string; about?: unknown }> })
    .chat;
}

async function mountShell() {
  w = null;
  const m = await mount(<Host />);
  await waitFor(() => w !== null && !!q('[data-pane="chat"]'), "the shell");
  return m;
}
async function collapseChat() {
  await click(q('[data-column-control="chat-collapse"]'));
  await waitFor(() => ws().columns.collapsed.chat, "the chat shut");
}

describe("the floating composer", () => {
  test("floats exactly while the chat column is collapsed, at the foot of the centre", async () => {
    const m = await mountShell();
    expect(float()).toBeNull();
    // One composer while the column is open: the column's.
    expect(qa('[data-slot="composer-input"]').length).toBe(1);
    await collapseChat();
    await waitFor(() => float() !== null, "the float");
    expect(float()?.closest('[data-pane="centre"]')).not.toBeNull();
    // Drawn in one place at a time: the column's composer is gone, not hidden.
    expect(columnInput()).toBeNull();
    expect(qa('[data-slot="composer-input"]').length).toBe(1);
    // After the centre in the flow, so it covers none of it.
    const centre = q('[data-testid="centre"]') as Node;
    expect(
      centre.compareDocumentPosition(float() as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect((float() as Element).contains(centre)).toBe(false);
    await click(q('[data-column-control="chat-reopen"]'));
    await waitFor(() => !ws().columns.collapsed.chat, "the chat open");
    expect(float()).toBeNull();
    expect(columnInput()).not.toBeNull();
    await m.unmount();
  });

  test("carries the chip of the held selection", async () => {
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
    await collapseChat();
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
    await waitFor(
      () => !!q('[data-slot="floating-composer"] [data-slot="selection-chip"]'),
      "chip",
    );
    expect(
      q('[data-slot="floating-composer"] [data-slot="selection-chip"]')?.textContent,
    ).toContain("solo.md · v1 · line 1");
    // Sent from the float, the passage rides along as from the column.
    await typeInto(floatInput() as HTMLTextAreaElement, "about this");
    await click(
      qa('[data-slot="floating-composer"] button').find((b) => b.textContent?.includes("Send")) ??
        null,
    );
    let said: { from: string; about?: unknown } | undefined;
    for (let i = 0; i < 80 && !said; i++) {
      said = (await chatLog()).find((c) => c.text === "about this");
      if (!said) await new Promise((r) => setTimeout(r, 25));
    }
    expect(said?.about).toMatchObject({ doc: slug, fromLine: 1, toLine: 1, text: "Solo" });
    await m.unmount();
  });

  test("shows the agent's latest line, and still working while the agent is on it", async () => {
    const m = await mountShell();
    await collapseChat();
    await waitFor(() => float() !== null, "the float");
    await agentSays("The harbour is mapped.");
    await waitFor(
      () => (float()?.textContent ?? "").includes("The harbour is mapped."),
      "the latest line",
    );
    // The human's own message puts the agent to work: the line says so.
    await typeInto(floatInput() as HTMLTextAreaElement, "and the rivers?");
    await click(
      qa('[data-slot="floating-composer"] button').find((b) => b.textContent?.includes("Send")) ??
        null,
    );
    await waitFor(() => !!q('[data-slot="floating-composer"] [data-badge]'), "the waiting badge");
    await m.unmount();
  });

  test("sends from the float as from the column, and the draft clears", async () => {
    const m = await mountShell();
    await collapseChat();
    await waitFor(() => floatInput() !== null, "the float");
    await typeInto(floatInput() as HTMLTextAreaElement, "from the float");
    await click(
      qa('[data-slot="floating-composer"] button').find((b) => b.textContent?.includes("Send")) ??
        null,
    );
    let said: { from: string } | undefined;
    for (let i = 0; i < 80 && !said; i++) {
      said = (await chatLog()).find((c) => c.text === "from the float");
      if (!said) await new Promise((r) => setTimeout(r, 25));
    }
    expect(said?.from).toBe("human");
    expect(floatInput()?.value).toBe("");
    await m.unmount();
  });

  test("its open button reopens the column on the conversation", async () => {
    const m = await mountShell();
    // Another tab was showing when the column shut.
    await click(
      qa('[data-pane="chat"] [role="tab"]').find((t) => t.textContent === "Tasks") ?? null,
    );
    await collapseChat();
    await waitFor(() => openConversation() !== null, "the float's open button");
    await click(openConversation());
    await waitFor(() => !ws().columns.collapsed.chat, "the chat open");
    expect(
      qa('[data-pane="chat"] [role="tab"]')
        .find((t) => t.getAttribute("aria-selected") === "true")
        ?.textContent?.startsWith("Chat"),
    ).toBe(true);
    expect(float()).toBeNull();
    await m.unmount();
  });
});

describe("one draft wherever the composer is drawn", () => {
  test("what was typed in the column is in the float, and back again", async () => {
    const m = await mountShell();
    await typeInto(columnInput() as HTMLTextAreaElement, "half a thought");
    await collapseChat();
    await waitFor(() => floatInput() !== null, "the float");
    expect(floatInput()?.value).toBe("half a thought");
    await typeInto(floatInput() as HTMLTextAreaElement, "half a thought, finished");
    await click(openConversation());
    await waitFor(() => columnInput() !== null, "the column's composer");
    expect(columnInput()?.value).toBe("half a thought, finished");
    await m.unmount();
  });

  test("a value set by one input event (paste, autofill, an IME commit, Playwright's fill) reaches the draft", async () => {
    // No focus, no keys: only the value and the one `input` event a paste sends.
    const pasteInto = async (el: HTMLTextAreaElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (!setter) throw new Error("no value setter");
      await settle(() => {
        setter.call(el, value);
        el.dispatchEvent(
          new window.InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }),
        );
      });
    };
    const m = await mountShell();
    await pasteInto(columnInput() as HTMLTextAreaElement, "pasted in the column");
    await collapseChat();
    await waitFor(() => floatInput() !== null, "the float");
    expect(floatInput()?.value).toBe("pasted in the column");
    await pasteInto(floatInput() as HTMLTextAreaElement, "pasted in the float");
    await click(openConversation());
    await waitFor(() => columnInput() !== null, "the column's composer");
    expect(columnInput()?.value).toBe("pasted in the float");
    // And through the rail's own reopen, from the float, straight after the paste.
    await collapseChat();
    await waitFor(() => floatInput() !== null, "the float again");
    await pasteInto(floatInput() as HTMLTextAreaElement, "pasted, then reopened");
    await click(q('[data-column-control="chat-reopen"]'));
    await waitFor(() => columnInput() !== null, "the column's composer again");
    expect(columnInput()?.value).toBe("pasted, then reopened");
    await m.unmount();
  });

  test("a draft survives the chat tab being swapped for another and back", async () => {
    const m = await mountShell();
    await typeInto(columnInput() as HTMLTextAreaElement, "kept");
    await click(
      qa('[data-pane="chat"] [role="tab"]').find((t) => t.textContent === "Notes") ?? null,
    );
    expect(columnInput()).toBeNull();
    await click(
      qa('[data-pane="chat"] [role="tab"]').find((t) => t.textContent?.startsWith("Chat")) ?? null,
    );
    await waitFor(() => columnInput() !== null, "the column's composer");
    expect(columnInput()?.value).toBe("kept");
    await m.unmount();
  });
});

describe("closing the float", () => {
  test("leaves nothing in the centre, and the rail's chat icon brings it back", async () => {
    const m = await mountShell();
    await collapseChat();
    await waitFor(() => float() !== null, "the float");
    expect(showIcon()).toBeNull();
    await click(closeFloat());
    await waitFor(() => float() === null, "the float closed");
    expect(qa('[data-slot="composer-input"]').length).toBe(0);
    expect(showIcon()?.closest("[data-slot=column-rail]")).not.toBeNull();
    // Focus is handed to the control that brings it back, not dropped.
    expect(document.activeElement).toBe(showIcon());
    await click(showIcon());
    await waitFor(() => float() !== null, "the float back");
    expect(showIcon()).toBeNull();
    await m.unmount();
  });

  test("is remembered across a reload, and an agent message does not reopen it", async () => {
    localStorage.setItem(LAYOUT_KEY, CHAT_SHUT);
    const m = await mountShell();
    await waitFor(() => float() !== null, "the float");
    await click(closeFloat());
    await waitFor(() => float() === null, "the float closed");
    await m.unmount();
    const again = await mountShell();
    await waitFor(() => !!showIcon(), "the rail's chat icon after a reload");
    expect(float()).toBeNull();
    await agentSays("Something new.");
    await waitFor(() => mark() !== null, "the unseen mark");
    await settle();
    expect(float()).toBeNull();
    expect(showIcon()).not.toBeNull();
    await again.unmount();
  });

  test("lasts only until the column is next opened: the next collapse floats it again", async () => {
    const m = await mountShell();
    await collapseChat();
    await waitFor(() => float() !== null, "the float");
    await click(closeFloat());
    await click(q('[data-column-control="chat-reopen"]'));
    await waitFor(() => !ws().columns.collapsed.chat, "the chat open");
    expect(showIcon()).toBeNull();
    expect(columnInput()).not.toBeNull();
    await collapseChat();
    await waitFor(() => float() !== null, "the float again");
    expect(showIcon()).toBeNull();
    await m.unmount();
  });

  test("reopened by any route, the column clears it and stores that", async () => {
    const routes: Array<[string, () => Promise<void>]> = [
      ["Ctrl+]", () => ctrlBracket()],
      ["the column API", () => settle(() => ws().columns.expand("chat"))],
      [
        "the unseen mark",
        async () => {
          await agentSays("Something new.");
          await waitFor(() => mark() !== null, "the mark");
          await click(mark());
        },
      ],
    ];
    for (const [route, reopen] of routes) {
      localStorage.clear();
      localStorage.setItem(LAYOUT_KEY, CHAT_SHUT);
      localStorage.setItem("story-studio:panes:float", "closed");
      const m = await mountShell();
      await waitFor(() => !!showIcon(), `the closed float (${route})`);
      await reopen();
      await waitFor(() => !ws().columns.collapsed.chat, `the chat open (${route})`);
      expect(localStorage.getItem("story-studio:panes:float")).toBe("open");
      await m.unmount();
    }
  });

  test("survives a reload while the column stays collapsed", async () => {
    localStorage.setItem(LAYOUT_KEY, CHAT_SHUT);
    const m = await mountShell();
    await waitFor(() => float() !== null, "the float");
    await click(closeFloat());
    await waitFor(() => float() === null, "the float closed");
    await m.unmount();
    for (const n of [1, 2]) {
      const again = await mountShell();
      await waitFor(() => !!showIcon(), `the rail's chat icon after reload ${n}`);
      expect(ws().columns.collapsed.chat).toBe(true);
      expect(float()).toBeNull();
      expect(localStorage.getItem("story-studio:panes:float")).toBe("closed");
      await again.unmount();
    }
  });
});

describe("the rail's unseen mark", () => {
  test("works with the float showing, and reopening clears it", async () => {
    localStorage.setItem(LAYOUT_KEY, CHAT_SHUT);
    const m = await mountShell();
    await waitFor(() => float() !== null, "the float");
    expect(mark()).toBeNull();
    await agentSays("A reply.");
    await waitFor(() => mark() !== null, "the mark");
    await click(openConversation());
    await waitFor(() => !ws().columns.collapsed.chat, "the chat open");
    expect(mark()).toBeNull();
    await m.unmount();
  });
});

describe("the toasts", () => {
  test("sit above the float, positioned by the centre's body and not over the composer", async () => {
    const m = await mountShell();
    await collapseChat();
    await waitFor(() => float() !== null, "the float");
    await settle(() => {
      ws().announce("Saved", "All of it.");
    });
    await waitFor(() => !!q('[data-slot="toasts"]'), "a toast");
    const toasts = q('[data-slot="toasts"]') as Element;
    // Before the float in the document, and not inside it.
    expect(
      toasts.compareDocumentPosition(float() as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect((float() as Element).contains(toasts)).toBe(false);
    // Their positioned container is the centre's body, which the float is not in:
    // anchored to its foot, the stack ends where the float begins.
    const body = toasts.parentElement as Element;
    expect(body.getAttribute("data-slot")).toBe("centre-body");
    expect(body.classList.contains("relative")).toBe(true);
    expect(body.contains(float())).toBe(false);
    await m.unmount();
  });
});

/** Ctrl+] from wherever focus is, as the shell's window listener hears it. */
const ctrlBracket = () =>
  settle(() => {
    (document.activeElement ?? document.body).dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "]", ctrlKey: true, bubbles: true }),
    );
  });
async function sentNamed(text: string) {
  for (let i = 0; i < 80; i++) {
    const said = (await chatLog()).find((c) => c.text === text);
    if (said) return said;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}
const sendFrom = (where: string) =>
  click(qa(`${where} button`).find((b) => b.textContent?.includes("Send")) ?? null);

describe("focus between the column and the float", () => {
  test("Ctrl+] from the column's composer collapses it and typing goes on in the float", async () => {
    const m = await mountShell();
    await typeInto(columnInput() as HTMLTextAreaElement, "still typing");
    await ctrlBracket();
    await waitFor(() => ws().columns.collapsed.chat, "the chat shut");
    await waitFor(() => document.activeElement === floatInput(), "focus in the float");
    expect(floatInput()?.value).toBe("still typing");
    await m.unmount();
  });

  test("Ctrl+] from the float reopens the column with focus in its composer and the draft intact", async () => {
    const m = await mountShell();
    await collapseChat();
    await waitFor(() => floatInput() !== null, "the float");
    await typeInto(floatInput() as HTMLTextAreaElement, "carried over");
    await ctrlBracket();
    await waitFor(() => !ws().columns.collapsed.chat, "the chat open");
    await waitFor(() => document.activeElement === columnInput(), "focus in the column");
    expect(columnInput()?.value).toBe("carried over");
    await m.unmount();
  });

  test("focusComposer focuses the float and leaves the column shut", async () => {
    const m = await mountShell();
    await collapseChat();
    await waitFor(() => floatInput() !== null, "the float");
    await settle(() => ws().focusComposer?.());
    await waitFor(() => document.activeElement === floatInput(), "focus in the float");
    expect(ws().columns.collapsed.chat).toBe(true);
    await m.unmount();
  });
});

describe("the draft through the float's closed state", () => {
  test("float → closed → shown again keeps the draft, with focus in the float", async () => {
    const m = await mountShell();
    await collapseChat();
    await waitFor(() => floatInput() !== null, "the float");
    await typeInto(floatInput() as HTMLTextAreaElement, "put aside");
    await click(closeFloat());
    await click(showIcon());
    await waitFor(() => document.activeElement === floatInput(), "focus in the float");
    expect(floatInput()?.value).toBe("put aside");
    await m.unmount();
  });

  test("float → closed → column reopened keeps the draft, in the one composer", async () => {
    const m = await mountShell();
    await collapseChat();
    await waitFor(() => floatInput() !== null, "the float");
    await typeInto(floatInput() as HTMLTextAreaElement, "still here");
    await click(closeFloat());
    await click(q('[data-column-control="chat-reopen"]'));
    await waitFor(() => columnInput() !== null, "the column's composer");
    expect(qa('[data-slot="composer-input"]').length).toBe(1);
    expect(columnInput()?.value).toBe("still here");
    await m.unmount();
  });
});

describe("what the float sends and shows", () => {
  test("pointed-at documents ride along from the float exactly as from the column", async () => {
    daemon.session.addContext(join(docs, "solo.md"));
    daemon.session.addContext(join(docs, "sibling.md"));
    const m = await mountShell();
    const pointed = {
      from: "test.view",
      docs: [
        { path: join(docs, "solo.md"), name: "Solo" },
        { path: join(docs, "sibling.md"), name: "Sibling" },
      ],
    };
    await settle(() => ws().pointDocs?.(pointed));
    await typeInto(columnInput() as HTMLTextAreaElement, "from the column");
    await sendFrom('[data-pane="chat"]');
    const fromColumn = await sentNamed("from the column");
    await settle(() => ws().pointDocs?.(pointed));
    await collapseChat();
    await waitFor(
      () => !!q('[data-slot="floating-composer"] [data-slot="pointed-chip"]'),
      "the chip afloat",
    );
    await typeInto(floatInput() as HTMLTextAreaElement, "from the float");
    await sendFrom('[data-slot="floating-composer"]');
    const fromFloat = await sentNamed("from the float");
    expect(fromColumn?.about).toBeDefined();
    expect(fromFloat?.about).toEqual(fromColumn?.about);
    await m.unmount();
  });

  test("the agent's line is plain text: its markdown marks are not shown", async () => {
    const m = await mountShell();
    await collapseChat();
    await waitFor(() => float() !== null, "the float");
    await agentSays("**Done.** See [the map](./map.md) and `maren.md`.");
    await waitFor(
      () => (q('[data-slot="float-line"]')?.textContent ?? "").includes("Done."),
      "the line",
    );
    expect(q('[data-slot="float-line"]')?.textContent).toBe("AgentDone. See the map and maren.md.");
    await m.unmount();
  });
});

describe("the closed state stored by an earlier build", () => {
  test("is read from its older, doubly prefixed key, and written back bare", async () => {
    localStorage.setItem(LAYOUT_KEY, CHAT_SHUT);
    localStorage.setItem("story-studio:story-studio:panes:float", "closed");
    const m = await mountShell();
    await waitFor(() => !!showIcon(), "the rail's chat icon");
    expect(float()).toBeNull();
    await click(showIcon());
    expect(localStorage.getItem("story-studio:panes:float")).toBe("open");
    await m.unmount();
  });
});
