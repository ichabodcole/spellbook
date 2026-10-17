// The conversation column's parts, rendered in a DOM from fixtures: what each
// shows, and what a click or a typed line sends out.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { cleanup, installDom, mount, removeDom, settle, typeInto } from "../lib/testDom.ts";
import { createToastStore, type ToastAction } from "../ui/toast-store.ts";
import type {
  DocView,
  Message,
  PlacedNote,
  TaskView,
  Version,
  VersionView,
  Waiting,
} from "../workspace/protocol";
import { FINISHED, isFinished } from "../workspace/session";
import { WAITING_LABEL as DAEMON_LABEL } from "../workspace/waiting";
import { type Attachable, ChatComposer, NO_AGENT_NOTICE } from "./ChatComposer.tsx";
import { ChatSidebar } from "./ChatSidebar.tsx";
import { NewVersionToasts } from "./NewVersionToasts.tsx";
import { NoteAtSelection, placeCard } from "./NoteAtSelection.tsx";
import { NotesPanel } from "./NotesPanel.tsx";
import { OutsideChangeToasts } from "./OutsideChangeToasts.tsx";
import { FINISHED_STATUSES, isFinishedStatus, TasksPanel } from "./TasksPanel.tsx";
import { SHOW_TASKS_ACTION, TaskToasts } from "./TaskToasts.tsx";
import {
  badgeFor,
  UNHEARD_LABEL,
  WAITING_LABEL,
  WaitingBadge,
  WaitingDot,
} from "./WaitingBadge.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => [...document.querySelectorAll(sel)];
const button = (text: string | RegExp, within: ParentNode = document) =>
  [...within.querySelectorAll("button")].find((b) =>
    typeof text === "string"
      ? (b.textContent ?? "").includes(text)
      : text.test(b.textContent ?? ""),
  ) ?? null;
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

const at = (n: number) => new Date(Date.UTC(2026, 8, 30, 10, n)).toISOString();

describe("what the surface shares with the daemon", () => {
  test("the finished statuses are the daemon's", () => {
    expect([...FINISHED_STATUSES].sort()).toEqual([...FINISHED].sort());
    for (const s of ["open", "running", "done", "failed", "cancelled"] as const)
      expect(isFinishedStatus(s)).toBe(isFinished(s));
  });
  test("the waiting words are the daemon's", () => {
    expect(WAITING_LABEL).toEqual(DAEMON_LABEL);
  });
  test("the kit's HTML sinks are the chat body and the rendered document, each fed by the markdown renderer", () => {
    const src = join(import.meta.dir, "..");
    const sinks: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
          const text = readFileSync(full, "utf8");
          if (/\bdangerouslySetInnerHTML\s*=/.test(text)) sinks.push(full.slice(src.length + 1));
        }
      }
    };
    walk(src);
    // Spellbook: the document pane is ported after chat, so until `document/`
    // exists the chat body is the only sink. Once it lands, both are required.
    const hasDocument = existsSync(join(src, "document"));
    expect(sinks.sort()).toEqual(
      hasDocument
        ? ["chat/ChatMessageView.tsx", "document/MarkdownView.tsx"]
        : ["chat/ChatMessageView.tsx"],
    );
    const text = readFileSync(join(src, "chat", "ChatMessageView.tsx"), "utf8");
    expect(text).toContain("renderMarkdown(text");
    expect(text).toContain("__html: html");
    if (!hasDocument) return;
    const rendered = readFileSync(join(src, "document", "MarkdownView.tsx"), "utf8");
    expect(rendered).toContain("renderDocument(text, widgets)");
    expect(rendered).toContain("__html: html");
  });
});

describe("badgeFor", () => {
  const w = (badge: Waiting["badge"], acknowledged?: true): Waiting => ({
    messageId: "m1",
    since: at(0),
    badge,
    ...(acknowledged ? { acknowledged } : {}),
  });
  test("no agent listening reads unheard, unless the agent's own snooze holds", () => {
    expect(badgeFor(w("working"), true)).toBe("working");
    expect(badgeFor(w("stalled"), true)).toBe("stalled");
    expect(badgeFor(w("working"), false)).toBe("unheard");
    expect(badgeFor(w("stalled"), false)).toBe("unheard");
    expect(badgeFor(w("working", true), false)).toBe("working");
  });
});

describe("WaitingBadge and WaitingDot", () => {
  test("the badge pulses while working and is still when stalled", async () => {
    const m = await mount(
      <>
        <WaitingBadge badge="working" />
        <WaitingBadge badge="stalled" />
        <WaitingDot badge="stalled" />
      </>,
    );
    const [working, stalled] = qa("p[data-badge]");
    expect(working?.innerHTML).toContain("animate-pulse");
    expect(stalled?.innerHTML).not.toContain("animate-pulse");
    expect(stalled?.textContent).toContain("may be stuck");
    expect(q('span[role="img"]')?.getAttribute("aria-label")).toBe(WAITING_LABEL.stalled);
    await m.unmount();
  });
});

describe("ChatComposer", () => {
  const sel: Attachable = {
    doc: "plan",
    name: "plan.md",
    version: 2,
    fromLine: 4,
    toLine: 6,
    text: "the  passage\nitself",
  };
  function Host({
    attachable,
    sent,
    dropped,
  }: {
    attachable: Attachable | null;
    sent: unknown[];
    dropped: number[];
  }) {
    const [draft, setDraft] = useState("");
    return (
      <ChatComposer
        attachable={attachable}
        connected
        draft={draft}
        onDraft={setDraft}
        onDrop={() => dropped.push(1)}
        onSend={(t, w) => sent.push([t, w])}
      />
    );
  }

  test("sends what was typed, with the selection riding along when one is held", async () => {
    const sent: unknown[] = [];
    const m = await mount(<Host attachable={sel} sent={sent} dropped={[]} />);
    const chip = q('[data-slot="selection-chip"]');
    expect(chip?.textContent).toContain("plan.md · v2 · lines 4–6");
    expect(chip?.textContent).toContain("the passage itself");
    await typeInto(q("textarea") as HTMLTextAreaElement, "what do you think?");
    await click(button("Send"));
    expect(sent).toEqual([["what do you think?", true]]);
    expect((q("textarea") as HTMLTextAreaElement).value).toBe("");
    await m.unmount();
  });

  test("with no selection, nothing rides along and there is no chip", async () => {
    const sent: unknown[] = [];
    const m = await mount(<Host attachable={null} sent={sent} dropped={[]} />);
    expect(q('[data-slot="selection-chip"]')).toBeNull();
    await typeInto(q("textarea") as HTMLTextAreaElement, "hello");
    await click(button("Send"));
    expect(sent).toEqual([["hello", false]]);
    await m.unmount();
  });

  test("the chip's X drops the selection, and Send waits for words", async () => {
    const dropped: number[] = [];
    const m = await mount(<Host attachable={sel} sent={[]} dropped={dropped} />);
    expect((button("Send") as HTMLButtonElement).disabled).toBe(true);
    await click(q('[aria-label="Clear the selection"]'));
    expect(dropped).toEqual([1]);
    await m.unmount();
  });

  test("Cmd+Enter sends and a plain Enter does not", async () => {
    const sent: unknown[] = [];
    const m = await mount(<Host attachable={null} sent={sent} dropped={[]} />);
    const area = q("textarea") as HTMLTextAreaElement;
    await typeInto(area, "line one");
    await settle(() => {
      area.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(sent).toEqual([]);
    await settle(() => {
      area.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
      );
    });
    expect(sent).toEqual([["line one", false]]);
    await m.unmount();
  });

  test("a disconnected composer cannot send", async () => {
    const m = await mount(
      <ChatComposer
        attachable={null}
        connected={false}
        draft="x"
        onDraft={() => {}}
        onDrop={() => {}}
        onSend={() => {}}
      />,
    );
    expect((q("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect((button("Send") as HTMLButtonElement).disabled).toBe(true);
    await m.unmount();
  });
});

describe("ChatSidebar", () => {
  const msgs: Message[] = [
    { id: "m1", from: "human", type: "message", text: "start the render", ts: at(0) },
    { id: "m2", from: "system", type: "info", text: "Agent created v2.", ts: at(1) },
    { id: "m3", from: "agent", type: "result", text: "Done: **4 cues**", ts: at(2) },
  ];

  test("shows the log in order, and the waiting badge only on the message it is about", async () => {
    const waiting: Waiting = { messageId: "m1", since: at(0), badge: "working" };
    const m = await mount(
      <ChatSidebar
        messages={msgs}
        waiting={waiting}
        attachable={null}
        connected
        onSend={() => {}}
        onDropSelection={() => {}}
      />,
    );
    const rows = qa('[role="log"] > div');
    expect(rows.map((r) => r.getAttribute("data-from"))).toEqual(["human", "system", "agent"]);
    expect(rows[0]?.querySelector("[data-badge]")).not.toBeNull();
    expect(rows[2]?.querySelector("[data-badge]")).toBeNull();
    expect(rows[2]?.innerHTML).toContain("<strong>4 cues</strong>");
    await m.unmount();
  });

  test("an empty log says so, and sending goes out through onSend", async () => {
    const sent: unknown[] = [];
    const m = await mount(
      <ChatSidebar
        messages={[]}
        waiting={null}
        attachable={null}
        connected
        onSend={(t, w) => sent.push([t, w])}
        onDropSelection={() => {}}
      />,
    );
    expect(q('[role="log"]')?.textContent).toContain("Nothing said yet");
    await typeInto(q("textarea") as HTMLTextAreaElement, "hi");
    await click(button("Send"));
    expect(sent).toEqual([["hi", false]]);
    // An agent is listening by default: no notice.
    expect(q('[data-slot="no-agent"]')).toBeNull();
    await m.unmount();
  });

  test("with no agent listening, the composer says so before sending, and the badge waits for one", async () => {
    const sent: unknown[] = [];
    const waiting: Waiting = { messageId: "m1", since: at(0), badge: "working" };
    const m = await mount(
      <ChatSidebar
        messages={msgs.slice(0, 1)}
        waiting={waiting}
        attachable={null}
        connected
        agentListening={false}
        onSend={(t, w) => sent.push([t, w])}
        onDropSelection={() => {}}
      />,
    );
    // Up front: before anything is typed.
    expect(q('[data-slot="no-agent"]')?.textContent).toBe(NO_AGENT_NOTICE);
    const badge = q('[role="log"] [data-badge]');
    expect(badge?.getAttribute("data-badge")).toBe("unheard");
    expect(badge?.textContent).toContain(UNHEARD_LABEL);
    // A claim of work nobody is there to do must not pulse.
    expect(badge?.querySelector(".animate-pulse")).toBeNull();
    // Still sendable: the message waits for an agent, it is not refused.
    await typeInto(q("textarea") as HTMLTextAreaElement, "anyone?");
    await click(button("Send"));
    expect(sent).toEqual([["anyone?", false]]);
    await m.unmount();
  });

  test("the notice is not shown while disconnected or ended: the page cannot know", async () => {
    for (const props of [{ connected: false }, { connected: false, ended: true }]) {
      const m = await mount(
        <ChatSidebar
          messages={[]}
          waiting={null}
          attachable={null}
          agentListening={false}
          onSend={() => {}}
          onDropSelection={() => {}}
          {...props}
        />,
      );
      expect(q('[data-slot="no-agent"]')).toBeNull();
      await m.unmount();
    }
  });
});

const note = (id: string, extra: Partial<PlacedNote> = {}): PlacedNote => ({
  id,
  version: 1,
  quote: "a quoted passage",
  before: "",
  after: "",
  at: 0,
  body: `body of ${id}`,
  by: "human",
  createdAt: at(0),
  resolved: false,
  from: 10,
  to: 26,
  how: "context",
  fromLine: 2,
  toLine: 2,
  ...extra,
});

describe("NotesPanel", () => {
  type Calls = {
    add: unknown[];
    goto: string[];
    edit: unknown[];
    resolve: unknown[];
    remove: string[];
  };
  const calls = (): Calls => ({ add: [], goto: [], edit: [], resolve: [], remove: [] });
  const panel = (
    c: Calls,
    notes: PlacedNote[],
    selection: { from: number; to: number; text: string } | null,
    focusedId: string | null = null,
  ) => (
    <NotesPanel
      notes={notes}
      focusedId={focusedId}
      selection={selection}
      onAdd={(from, to, body) => c.add.push([from, to, body])}
      onGoTo={(n) => c.goto.push(n.id)}
      onEdit={(id, body) => c.edit.push([id, body])}
      onResolve={(id, r) => c.resolve.push([id, r])}
      onRemove={(id) => c.remove.push(id)}
    />
  );

  test("lists the notes with their quote, body, author and version", async () => {
    const c = calls();
    const m = await mount(panel(c, [note("n1"), note("n2", { by: "agent", version: 3 })], null));
    const rows = qa('[data-slot="note"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("a quoted passage");
    expect(rows[0]?.textContent).toContain("body of n1");
    expect(rows[0]?.textContent).toContain("You");
    expect(rows[1]?.textContent).toContain("Agent");
    expect(rows[1]?.textContent).toContain("v3");
    await m.unmount();
  });

  test("an empty list says how to make a note", async () => {
    const m = await mount(panel(calls(), [], null));
    expect(document.body.textContent).toContain("Select some text in the document");
    await m.unmount();
  });

  test("the quote jumps to its anchor, unless the note has none", async () => {
    const c = calls();
    const m = await mount(
      panel(c, [note("n1"), note("n2", { from: null, to: null, how: "orphaned" })], null),
    );
    const quotes = qa(
      '[data-slot="note"] button[title*="document"], [data-slot="note"] button[title*="no place"]',
    );
    await click(quotes[0] ?? null);
    expect(c.goto).toEqual(["n1"]);
    expect((quotes[1] as HTMLButtonElement).disabled).toBe(true);
    expect(qa('[data-slot="note"]')[1]?.textContent).toContain("text gone");
    await m.unmount();
  });

  test("resolve hides a note until asked for, and reopening sends the opposite", async () => {
    const c = calls();
    const m = await mount(panel(c, [note("n1"), note("n2", { resolved: true })], null));
    expect(qa('[data-slot="note"]')).toHaveLength(1);
    await click(document.querySelector('[aria-label="Resolve note"]'));
    expect(c.resolve).toEqual([["n1", true]]);
    await click(button("Show 1 resolved"));
    expect(qa('[data-slot="note"]')).toHaveLength(2);
    await click(document.querySelector('[aria-label="Reopen note"]'));
    expect(c.resolve.at(-1)).toEqual(["n2", false]);
    await m.unmount();
  });

  test("a focused note is shown even when it is resolved and the resolved are hidden", async () => {
    const m = await mount(panel(calls(), [note("n1", { resolved: true })], null, "n1"));
    expect(qa('[data-slot="note"]')).toHaveLength(1);
    expect(q('[data-slot="note"]')?.getAttribute("data-focused")).toBe("true");
    await m.unmount();
  });

  test("editing keeps what the note is about, and delete is immediate", async () => {
    const c = calls();
    const m = await mount(panel(c, [note("n1")], null));
    await click(q('[aria-label="Edit note"]'));
    const area = q('[data-slot="note"] textarea') as HTMLTextAreaElement;
    expect(area.value).toBe("body of n1");
    await typeInto(area, "a better body");
    await click(button("Save"));
    expect(c.edit).toEqual([["n1", "a better body"]]);
    await click(q('[aria-label="Delete note"]'));
    expect(c.remove).toEqual(["n1"]);
    await m.unmount();
  });

  test("a new note is written about the held selection, and shows the quote first", async () => {
    const c = calls();
    const selection = { from: 5, to: 20, text: "the chosen  words" };
    const m = await mount(panel(c, [], selection));
    expect(document.body.textContent).toContain("the chosen words");
    await typeInto(q('textarea[aria-label="New note"]') as HTMLTextAreaElement, "why this?");
    await click(button("Add note"));
    expect(c.add).toEqual([[5, 20, "why this?"]]);
    await m.unmount();
  });

  test("with no selection a note cannot be written", async () => {
    const m = await mount(panel(calls(), [], null));
    expect((q('textarea[aria-label="New note"]') as HTMLTextAreaElement).disabled).toBe(true);
    expect(document.body.textContent).toContain("No selection");
    await m.unmount();
  });
});

describe("NoteAtSelection", () => {
  test("places the card inside the window whichever corner was clicked", () => {
    const vp = { width: 1000, height: 800 };
    expect(placeCard({ x: 990, y: 10 }, 100, vp)).toEqual({ left: 1000 - 320 - 12, top: 22 });
    expect(placeCard({ x: 5, y: 790 }, 100, vp)).toEqual({ left: 12, top: 790 - 100 - 12 });
    expect(placeCard({ x: 300, y: 300 }, 100, vp)).toEqual({ left: 300, top: 312 });
  });

  test("a click with a selection offers to add a note, in two steps", async () => {
    const added: unknown[] = [];
    let closed = 0;
    const m = await mount(
      <NoteAtSelection
        at={{ x: 100, y: 100, from: 3, to: 9, noteIds: [] }}
        quote="some words"
        existing={[]}
        onClose={() => closed++}
        onAdd={(f, t, b) => added.push([f, t, b])}
        onShowNote={() => {}}
        onDeleteNote={() => {}}
      />,
    );
    await click(button("Add note"));
    await typeInto(q("textarea") as HTMLTextAreaElement, "look at this");
    await click(button("Add note"));
    expect(added).toEqual([[3, 9, "look at this"]]);
    expect(closed).toBe(1);
    await m.unmount();
  });

  test("an existing note leads the menu, can be shown or deleted, and an empty range offers no new one", async () => {
    const shown: string[] = [];
    const deleted: string[] = [];
    const m = await mount(
      <NoteAtSelection
        at={{ x: 100, y: 100, from: 5, to: 5, noteIds: ["n1"] }}
        quote=""
        existing={[{ id: "n1", label: "what about it" }]}
        onClose={() => {}}
        onAdd={() => {}}
        onShowNote={(id) => shown.push(id)}
        onDeleteNote={(id) => deleted.push(id)}
      />,
    );
    expect(button("Add note")).toBeNull();
    await click(button("what about it"));
    await click(q('[aria-label^="Delete note"]'));
    expect(shown).toEqual(["n1"]);
    expect(deleted).toEqual(["n1"]);
    await m.unmount();
  });

  test("Escape closes it, and nothing is drawn with no click", async () => {
    let closed = 0;
    const m = await mount(
      <NoteAtSelection
        at={{ x: 1, y: 1, from: 0, to: 3, noteIds: [] }}
        quote="q"
        existing={[]}
        onClose={() => closed++}
        onAdd={() => {}}
        onShowNote={() => {}}
        onDeleteNote={() => {}}
      />,
    );
    await settle(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(closed).toBe(1);
    await m.render(
      <NoteAtSelection
        at={null}
        quote=""
        existing={[]}
        onClose={() => {}}
        onAdd={() => {}}
        onShowNote={() => {}}
        onDeleteNote={() => {}}
      />,
    );
    expect(q('[data-slot="note-at-selection"]')).toBeNull();
    await m.unmount();
  });
});

const task = (id: string, extra: Partial<TaskView> = {}): TaskView => ({
  id,
  title: `task ${id}`,
  by: "agent",
  status: "open",
  createdAt: at(0),
  updatedAt: at(0),
  ...extra,
});

describe("TasksPanel", () => {
  type Calls = { cancel: string[]; remove: string[]; clear: number[]; create: string[] };
  const calls = (): Calls => ({ cancel: [], remove: [], clear: [], create: [] });
  const panel = (c: Calls, tasks: TaskView[]) => (
    <TasksPanel
      tasks={tasks}
      onCancel={(id) => c.cancel.push(id)}
      onRemove={(id) => c.remove.push(id)}
      onClear={() => c.clear.push(1)}
      onCreate={(t) => c.create.push(t)}
    />
  );
  const row = (id: string) =>
    qa('[data-slot="task"]').find((r) => (r.textContent ?? "").includes(`task ${id}`));

  test("shows who made each task and its status", async () => {
    const m = await mount(
      panel(calls(), [
        task("a", { by: "human" }),
        task("b", {
          by: "daemon",
          kind: "render",
          status: "running",
          progress: 0.5,
          detail: "step 2 of 4",
        }),
        task("c", { status: "done", outcome: "4 cues" }),
      ]),
    );
    expect(row("a")?.textContent).toContain("You");
    expect(row("b")?.textContent).toContain("Workspace");
    expect(row("b")?.textContent).toContain("render");
    expect(row("b")?.textContent).toContain("step 2 of 4");
    expect(row("c")?.textContent).toContain("4 cues");
    expect(row("c")?.getAttribute("data-status")).toBe("done");
    await m.unmount();
  });

  test("a running task shows its progress as a bar; one without progress shows none", async () => {
    const m = await mount(
      panel(calls(), [
        task("a", { status: "running", progress: 0.25 }),
        task("b", { status: "running" }),
        task("c", { status: "open", progress: 0.9 }),
      ]),
    );
    const bar = row("a")?.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("25");
    expect((bar?.firstElementChild as HTMLElement | undefined)?.style.width).toBe("25%");
    expect(row("b")?.querySelector('[role="progressbar"]')).toBeNull();
    expect(row("c")?.querySelector('[role="progressbar"]')).toBeNull();
    await m.unmount();
  });

  test("any unfinished task can be cancelled, and a finished one only forgotten", async () => {
    const c = calls();
    const m = await mount(
      panel(c, [task("a"), task("b", { status: "running" }), task("c", { status: "failed" })]),
    );
    await click(row("a")?.querySelector('button[aria-label^="Cancel task"]') ?? null);
    await click(row("b")?.querySelector('button[aria-label^="Cancel task"]') ?? null);
    expect(c.cancel).toEqual(["a", "b"]);
    expect(row("c")?.querySelector('button[aria-label^="Cancel task"]')).toBeNull();
    await click(row("c")?.querySelector('button[aria-label^="Remove task"]') ?? null);
    expect(c.remove).toEqual(["c"]);
    await m.unmount();
  });

  test("a delegated task names the task it came from, or says it was delegated", async () => {
    const m = await mount(
      panel(calls(), [
        task("parent", { title: "Render the chapter", status: "running" }),
        task("child", { parent: "parent" }),
        task("orphan", { parent: "gone" }),
        task("plain"),
      ]),
    );
    expect(row("child")?.querySelector('[data-slot="task-parent"]')?.textContent).toContain(
      "part of Render the chapter",
    );
    expect(row("orphan")?.querySelector('[data-slot="task-parent"]')?.textContent).toContain(
      "delegated from another task",
    );
    expect(row("plain")?.querySelector('[data-slot="task-parent"]')).toBeNull();
    await m.unmount();
  });

  test("clearing forgets what is finished, and says how many", async () => {
    const c = calls();
    const m = await mount(
      panel(c, [task("a"), task("b", { status: "done" }), task("c", { status: "cancelled" })]),
    );
    await click(button("Clear 2 finished"));
    expect(c.clear).toEqual([1]);
    await m.unmount();
  });

  test("the human can ask the agent for something", async () => {
    const c = calls();
    const m = await mount(panel(c, []));
    expect(document.body.textContent).toContain("Work the agent has started shows up here");
    await typeInto(q('input[aria-label="New task"]') as HTMLInputElement, "  outline chapter 2 ");
    await click(q('[aria-label="Add task"]'));
    expect(c.create).toEqual(["outline chapter 2"]);
    await m.unmount();
  });
});

describe("TaskToasts", () => {
  test("announces a task that finishes, not ones that were already finished", async () => {
    const said: string[][] = [];
    const announce = (title: string, description?: string) => {
      said.push([title, description ?? ""]);
    };
    const before = [task("a", { status: "done" }), task("b", { status: "running" })];
    const m = await mount(<TaskToasts tasks={before} announce={announce} />);
    expect(said).toEqual([]);
    await m.render(
      <TaskToasts
        tasks={[task("a", { status: "done" }), task("b", { status: "done", outcome: "4 cues" })]}
        announce={announce}
      />,
    );
    expect(said).toEqual([["Done: task b", "4 cues"]]);
    await m.render(
      <TaskToasts
        tasks={[task("a", { status: "done" }), task("b", { status: "done", outcome: "4 cues" })]}
        announce={announce}
      />,
    );
    expect(said).toHaveLength(1);
    await m.unmount();
  });

  test("a quiet task (a batch's child) is never announced: its parent speaks for it", async () => {
    const said: string[] = [];
    const announce = (title: string) => {
      said.push(title);
    };
    const m = await mount(
      <TaskToasts
        tasks={[task("a", { status: "running", quiet: true }), task("b", { status: "running" })]}
        announce={announce}
      />,
    );
    await m.render(
      <TaskToasts
        tasks={[
          task("a", { status: "done", quiet: true }),
          task("b", { status: "failed", quiet: true }),
          task("c", { status: "done" }),
        ]}
        announce={announce}
      />,
    );
    expect(said).toEqual(["Done: task c"]);
    await m.unmount();
  });

  test("a failure is announced with its reason, and a cancellation is not announced at all", async () => {
    const said: string[][] = [];
    const announce = (title: string, description?: string) => {
      said.push([title, description ?? ""]);
    };
    const m = await mount(
      <TaskToasts
        tasks={[task("a", { status: "running" }), task("b", { status: "open" })]}
        announce={announce}
      />,
    );
    await m.render(
      <TaskToasts
        tasks={[
          task("a", { status: "failed", detail: "the provider refused" }),
          task("b", { status: "cancelled" }),
        ]}
        announce={announce}
      />,
    );
    expect(said).toEqual([["Failed: task a", "the provider refused"]]);
    await m.unmount();
  });

  type Said = { title: string; actions?: ToastAction[] };
  const recorder = () => {
    const said: Said[] = [];
    const announce = (title: string, _d?: string, actions?: ToastAction[]) => {
      said.push({ title, ...(actions ? { actions } : {}) });
    };
    return { said, announce };
  };

  test("a task the agent starts is announced with a button to the Tasks tab", async () => {
    const { said, announce } = recorder();
    let shown = 0;
    const onShowTasks = () => {
      shown++;
    };
    const m = await mount(<TaskToasts tasks={[]} announce={announce} onShowTasks={onShowTasks} />);
    expect(said).toEqual([]);
    await m.render(
      <TaskToasts
        tasks={[task("a", { status: "running", title: "Map the rivers" })]}
        announce={announce}
        onShowTasks={onShowTasks}
      />,
    );
    expect(said.map((s) => s.title)).toEqual(["Agent started: Map the rivers"]);
    const action = said[0]?.actions?.[0];
    expect(action?.label).toBe(SHOW_TASKS_ACTION.label);
    expect(action?.ariaLabel).toBe(SHOW_TASKS_ACTION.ariaLabel);
    action?.onAct();
    expect(shown).toBe(1);
    // The same snapshot again, and progress on it, say nothing more.
    await m.render(
      <TaskToasts
        tasks={[task("a", { status: "running", title: "Map the rivers", detail: "step 2" })]}
        announce={announce}
        onShowTasks={onShowTasks}
      />,
    );
    expect(said).toHaveLength(1);
    await m.unmount();
  });

  test("tasks under way before a reload raise nothing; a human's open task picked up later does", async () => {
    const { said, announce } = recorder();
    const m = await mount(
      <TaskToasts
        tasks={[
          task("a", { status: "running" }),
          task("b", { status: "done" }),
          task("h", { status: "open", by: "human" }),
        ]}
        announce={announce}
      />,
    );
    expect(said).toEqual([]);
    await m.render(
      <TaskToasts
        tasks={[
          task("a", { status: "running" }),
          task("b", { status: "done" }),
          task("h", { status: "running", by: "human" }),
        ]}
        announce={announce}
      />,
    );
    // No `onShowTasks`: the toast still names the task, without a button.
    expect(said).toEqual([{ title: "Agent started: task h" }]);
    await m.unmount();
  });

  test("a start already on screen (the column open on Chat or Tasks) raises no toast", async () => {
    const { said, announce } = recorder();
    const m = await mount(<TaskToasts tasks={[]} announce={announce} startsInView />);
    await m.render(
      <TaskToasts tasks={[task("a", { status: "running" })]} announce={announce} startsInView />,
    );
    expect(said).toEqual([]);
    // Seen while in view: it is not announced later when the view changes.
    await m.render(<TaskToasts tasks={[task("a", { status: "running" })]} announce={announce} />);
    expect(said).toEqual([]);
    await m.unmount();
  });

  test("a daemon task's start is not announced, and one started and settled at once is announced by its outcome", async () => {
    const { said, announce } = recorder();
    const m = await mount(<TaskToasts tasks={[]} announce={announce} />);
    await m.render(
      <TaskToasts
        tasks={[
          task("r", { status: "running", by: "daemon", kind: "render" }),
          task("q", { status: "done", outcome: "quick" }),
        ]}
        announce={announce}
      />,
    );
    expect(said.map((s) => s.title)).toEqual(["Done: task q"]);
    await m.unmount();
  });
});

const version = (n: number, by: Version["by"] = "agent"): VersionView => ({
  n,
  by,
  createdAt: at(n),
  path: `/s/docs/note/v${n}.md`,
});
const doc = (versions: VersionView[], active: number, slug = "note"): DocView => ({
  slug,
  name: `${slug}.md`,
  original: `/w/${slug}.md`,
  entryId: null,
  rel: null,
  ext: ".md",
  versions,
  active,
  hash: "h",
  dirty: false,
  outsideChanged: false,
  notes: [],
});

describe("NewVersionToasts", () => {
  function Host({
    d,
    connected = true,
    store,
    onActivate,
    onShowDiff,
  }: {
    d: DocView | null;
    connected?: boolean;
    store: ReturnType<typeof createToastStore>;
    onActivate: (doc: string, v: number) => void;
    onShowDiff?: (doc: string, v: number) => void;
  }) {
    return (
      <NewVersionToasts
        doc={d}
        connected={connected}
        announce={store.announce}
        dismiss={store.dismiss}
        onActivate={onActivate}
        onShowDiff={onShowDiff}
      />
    );
  }

  test("announces a version the agent made, with Activate and Show diff, and says nothing on first sight", async () => {
    const store = createToastStore();
    const acts: string[] = [];
    const m = await mount(
      <Host
        d={doc([version(1)], 1)}
        store={store}
        onActivate={(d, v) => acts.push(`activate ${d} ${v}`)}
        onShowDiff={(d, v) => acts.push(`diff ${d} ${v}`)}
      />,
    );
    expect(store.snapshot()).toHaveLength(0);
    await m.render(
      <Host
        d={doc([version(1), version(2)], 1)}
        store={store}
        onActivate={(d, v) => acts.push(`activate ${d} ${v}`)}
        onShowDiff={(d, v) => acts.push(`diff ${d} ${v}`)}
      />,
    );
    const [toast] = store.snapshot();
    expect(toast?.title).toBe("New version: v2");
    expect(toast?.description).toContain("the agent");
    expect(toast?.actions?.map((a) => a.label)).toEqual(["Activate", "Show diff"]);
    toast?.actions?.[0]?.onAct();
    toast?.actions?.[1]?.onAct();
    expect(acts).toEqual(["activate note 2", "diff note 2"]);
    store.dispose();
    await m.unmount();
  });

  test("without an app's answer for diffs, only Activate is offered", async () => {
    const store = createToastStore();
    const m = await mount(<Host d={doc([version(1)], 1)} store={store} onActivate={() => {}} />);
    await m.render(
      <Host d={doc([version(1), version(2)], 1)} store={store} onActivate={() => {}} />,
    );
    expect(store.snapshot()[0]?.actions?.map((a) => a.label)).toEqual(["Activate"]);
    store.dispose();
    await m.unmount();
  });

  test("the toast withdraws once its version becomes the active one", async () => {
    const store = createToastStore();
    const m = await mount(<Host d={doc([version(1)], 1)} store={store} onActivate={() => {}} />);
    await m.render(
      <Host d={doc([version(1), version(2)], 1)} store={store} onActivate={() => {}} />,
    );
    expect(store.snapshot()).toHaveLength(1);
    await m.render(
      <Host d={doc([version(1), version(2)], 2)} store={store} onActivate={() => {}} />,
    );
    expect(store.snapshot()).toHaveLength(0);
    store.dispose();
    await m.unmount();
  });

  test("a version made while disconnected is announced on the way back", async () => {
    const store = createToastStore();
    const m = await mount(<Host d={doc([version(1)], 1)} store={store} onActivate={() => {}} />);
    await m.render(
      <Host d={doc([version(1)], 1)} connected={false} store={store} onActivate={() => {}} />,
    );
    await m.render(
      <Host d={doc([version(1), version(2)], 1)} connected store={store} onActivate={() => {}} />,
    );
    expect(store.snapshot().map((t) => t.title)).toEqual(["New version: v2"]);
    store.dispose();
    await m.unmount();
  });
});

describe("OutsideChangeToasts", () => {
  const changed = (over: Partial<DocView> = {}): DocView => ({
    ...doc([version(1, "human")], 1),
    outsideChanged: true,
    ...over,
  });
  function Host({
    d,
    store,
    onReload,
  }: {
    d: DocView | null;
    store: ReturnType<typeof createToastStore>;
    onReload: (doc: string) => void;
  }) {
    return (
      <OutsideChangeToasts
        doc={d}
        announce={store.announce}
        dismiss={store.dismiss}
        onReload={onReload}
      />
    );
  }

  test("the flag going up raises one toast with Reload and Keep, and a repeat snapshot adds none", async () => {
    const store = createToastStore();
    const m = await mount(<Host d={doc([version(1)], 1)} store={store} onReload={() => {}} />);
    expect(store.snapshot()).toHaveLength(0);
    await m.render(<Host d={changed({ dirty: true })} store={store} onReload={() => {}} />);
    await m.render(<Host d={changed({ dirty: true })} store={store} onReload={() => {}} />);
    const [toast] = store.snapshot();
    expect(store.snapshot()).toHaveLength(1);
    expect(toast?.title).toBe("note.md changed on disk");
    expect(toast?.description).toContain("unsaved edits");
    expect(toast?.actions?.map((a) => a.label)).toEqual(["Reload", "Keep"]);
    store.dispose();
    await m.unmount();
  });

  test("a flag up on first sight is news: the decision is still waiting", async () => {
    const store = createToastStore();
    const m = await mount(<Host d={changed()} store={store} onReload={() => {}} />);
    expect(store.snapshot()).toHaveLength(1);
    expect(store.snapshot()[0]?.description).toContain("since this version was made");
    store.dispose();
    await m.unmount();
  });

  test("Reload asks for the document's file, and Keep only dismisses", async () => {
    const store = createToastStore();
    const reloaded: string[] = [];
    const m = await mount(<Host d={changed()} store={store} onReload={(d) => reloaded.push(d)} />);
    store.snapshot()[0]?.actions?.[0]?.onAct();
    expect(reloaded).toEqual(["note"]);
    store.snapshot()[0]?.actions?.[1]?.onAct();
    expect(store.snapshot()).toHaveLength(0);
    expect(reloaded).toEqual(["note"]);
    // The flag is still up, and it is not raised again until it has come down.
    await m.render(<Host d={changed()} store={store} onReload={() => {}} />);
    expect(store.snapshot()).toHaveLength(0);
    store.dispose();
    await m.unmount();
  });

  test("the toast withdraws when the flag comes down, and a new conflict is news again", async () => {
    const store = createToastStore();
    const m = await mount(<Host d={changed()} store={store} onReload={() => {}} />);
    expect(store.snapshot()).toHaveLength(1);
    await m.render(
      <Host d={changed({ outsideChanged: false })} store={store} onReload={() => {}} />,
    );
    expect(store.snapshot()).toHaveLength(0);
    await m.render(<Host d={changed()} store={store} onReload={() => {}} />);
    expect(store.snapshot()).toHaveLength(1);
    store.dispose();
    await m.unmount();
  });
});
