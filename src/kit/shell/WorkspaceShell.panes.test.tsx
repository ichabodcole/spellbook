// The shell's right column over a REAL workspace daemon: the conversation with a
// selection riding along, notes written about a passage and jumped back to, the
// work queue with its progress and cancel, and the toasts that watch both.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HeldSelection } from "../context/selection.ts";
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
import { fixtureDaemon } from "../workspace/fixtures/app";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { WorkspaceShell, type WorkspaceShellProps } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;

beforeEach(async () => {
  root = tempRoot("shell-panes");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  // Slow enough for a test to see a task running and to cancel it.
  process.env.KIT_FIXTURE_STEP_MS = "250";
  docs = seedDocs(root);
  localStorage.clear();
  // The docs folder is the workspace: each document in it is in the context where it is.
  daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs });
  await daemon.start();
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

let ws: Workspace | null = null;

function Centre() {
  ws = useWorkspace();
  const w = ws;
  return (
    <div data-testid="centre">
      <span data-testid="reveal">{w.reveal ? `${w.reveal.from}-${w.reveal.to}` : "none"}</span>
    </div>
  );
}

function Host({ extra }: { extra?: Partial<Omit<WorkspaceShellProps, "daemon">> }) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell daemon={d} centre={<Centre />} {...extra} />
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
const tab = (label: string | RegExp) =>
  qa('[data-pane="chat"] [role="tab"]').find((b) =>
    typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""),
  ) ?? null;
const chatPane = () => q('[data-pane="chat"]') as HTMLElement;

async function state() {
  const res = await nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/state?full=1`);
  return (await res.json()) as {
    chat: Array<{ from: string; text: string; via?: string; about?: Record<string, unknown> }>;
    docs: Array<{ slug: string; notes: Array<{ body: string; quote: string }> }>;
    tasks: Array<{ id: string; title: string; status: string }>;
    selection: unknown;
  };
}

/** Mount the shell with `solo.md` open, and return its slug. */
async function openSolo(extra?: Parameters<typeof Host>[0]["extra"]) {
  daemon.session.addContext(join(docs, "solo.md"));
  const m = await mount(<Host extra={extra} />);
  await waitFor(() => (q('[data-pane="context"]')?.textContent ?? "").includes("solo.md"), "entry");
  await click(
    qa('[data-pane="context"] button').find((b) => (b.textContent ?? "").includes("solo.md")) ??
      null,
  );
  await waitFor(() => !!ws?.openDoc, "the open document");
  return { m, slug: (ws as Workspace).openDoc?.slug as string };
}

const SELECTION = (slug: string): HeldSelection => ({
  doc: slug,
  version: 1,
  from: 2,
  to: 6,
  fromLine: 1,
  toLine: 1,
  text: "Solo",
});

describe("the right column", () => {
  test("opens on the conversation, with Notes and Tasks beside it, then the app's panels", async () => {
    const m = await mount(
      <Host extra={{ panels: [{ id: "x", label: "Renders", node: <p>renders body</p> }] }} />,
    );
    await waitFor(() => !!q('[data-pane="chat"]'), "the shell");
    expect(qa('[data-pane="chat"] [role="tab"]').map((b) => b.textContent)).toEqual([
      "Chat",
      "Notes",
      "Tasks",
      "Renders",
    ]);
    expect(chatPane().querySelector('[role="log"]')).not.toBeNull();
    await click(tab("Renders"));
    expect(chatPane().textContent).toContain("renders body");
    await m.unmount();
  });

  test("remembers which tab was open", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="chat"]'), "the shell");
    await click(tab("Tasks"));
    await m.unmount();
    const again = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="chat"]'), "the shell again");
    expect(tab("Tasks")?.getAttribute("aria-selected")).toBe("true");
    await again.unmount();
  });
});

describe("the tab list", () => {
  test("is a real tablist with one selected tab and its tabpanel, and arrow keys move", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="chat"]'), "the shell");
    expect(q('[role="tablist"]')).not.toBeNull();
    const tabs = qa('[role="tab"]');
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    const panel = q('[role="tabpanel"]');
    expect(panel?.getAttribute("aria-labelledby")).toBe(tabs[0]?.id);
    expect(tabs[0]?.getAttribute("aria-controls")).toBe(panel?.id);
    await settle(() => {
      tabs[0]?.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
    });
    expect(qa('[role="tab"]')[1]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.id.startsWith("story-studio-tab-")).toBe(true);
    expect(q('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe(tabs[1]?.id);
    await m.unmount();
  });
});

describe("the tab list keys", () => {
  test("Home and End jump to the first and last tab", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="chat"]'), "the shell");
    const press = (key: string) =>
      settle(() => {
        qa('[role="tab"]')[0]?.dispatchEvent(
          new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });
    await press("End");
    expect(qa('[role="tab"]').map((t) => t.getAttribute("aria-selected"))).toEqual([
      "false",
      "false",
      "true",
    ]);
    await press("Home");
    expect(qa('[role="tab"]')[0]?.getAttribute("aria-selected")).toBe("true");
    await m.unmount();
  });
});

describe("the workspace context", () => {
  test("is the same object across renders that change nothing it carries", async () => {
    const seen: Workspace[] = [];
    function Spy() {
      seen.push(useWorkspace());
      return null;
    }
    const m = await mount(<Host extra={{ centre: <Spy /> }} />);
    await waitFor(() => seen.length > 0, "the centre");
    await settle();
    const stable = seen.at(-1);
    await m.render(<Host extra={{ centre: <Spy />, status: <span>changed</span> }} />);
    expect(seen.at(-1)).toBe(stable);
    await m.unmount();
  });
});

describe("the conversation", () => {
  test("a message goes to the agent with the held selection riding along", async () => {
    const { m, slug } = await openSolo();
    await settle(() => ws?.reportSelection(SELECTION(slug)));
    await waitFor(() => !!q('[data-slot="selection-chip"]'), "the chip");
    expect(q('[data-slot="selection-chip"]')?.textContent).toContain("solo.md · v1 · line 1");
    await typeInto(q('[data-pane="chat"] textarea') as HTMLTextAreaElement, "is this right?");
    await click(
      qa('[data-pane="chat"] button').find((b) => b.textContent?.includes("Send")) ?? null,
    );
    await waitFor(() => (chatPane().textContent ?? "").includes("is this right?"), "the message");
    const said = (await state()).chat.find((c) => c.text === "is this right?");
    expect(said?.from).toBe("human");
    expect(said?.about).toMatchObject({
      doc: slug,
      version: 1,
      fromLine: 1,
      toLine: 1,
      text: "Solo",
    });
    // The record shows what was sent.
    expect(chatPane().querySelector('[data-slot="about-chip"]')?.textContent).toContain("solo.md");
    await m.unmount();
  });

  test("pointed-at documents are the chip's other kind: the open one is the subject and the rest ride as refs, one kind at a time", async () => {
    const { m, slug } = await openSolo();
    // Both documents are in the context: the daemon keeps only those.
    daemon.session.addContext(join(docs, "sibling.md"));
    await settle(() => ws?.reportSelection(SELECTION(slug)));
    await waitFor(() => !!q('[data-slot="selection-chip"]'), "the text chip");
    // Pointing at documents drops the text selection: one chip at a time.
    await settle(() =>
      ws?.pointDocs?.({
        from: "test.view",
        docs: [
          { path: join(docs, "solo.md"), name: "Solo" },
          { path: join(docs, "sibling.md"), name: "Sibling" },
        ],
      }),
    );
    await waitFor(() => !!q('[data-slot="pointed-chip"]'), "the documents chip");
    expect(q('[data-slot="selection-chip"]')).toBeNull();
    expect(ws?.selection).toBeNull();
    expect(q('[data-slot="pointed-chip"]')?.textContent).toContain("2 documents");
    expect(q('[data-slot="pointed-chip"]')?.textContent).toContain("Solo, Sibling");
    await typeInto(q('[data-pane="chat"] textarea') as HTMLTextAreaElement, "how are these alike?");
    await click(
      qa('[data-pane="chat"] button').find((b) => b.textContent?.includes("Send")) ?? null,
    );
    await waitFor(() => (chatPane().textContent ?? "").includes("how are these alike?"), "sent");
    const said = (await state()).chat.find((c) => c.text === "how are these alike?");
    // One subject: the open document among them. The other is a ref; no about.docs.
    expect(said?.about).not.toHaveProperty("docs");
    expect(said?.about?.doc).toBe(slug);
    expect(said?.about?.refs).toEqual([{ path: join(docs, "sibling.md"), label: "Sibling" }]);
    expect(said?.about).not.toHaveProperty("text");
    expect(said?.via).toBe("chat");
    expect(chatPane().querySelector('[data-slot="about-chip"]')?.textContent).toContain(
      "with Sibling",
    );
    // A text selection drops them again; and the chip's X drops them.
    await settle(() => ws?.reportSelection(SELECTION(slug)));
    expect(ws?.pointedDocs).toBeNull();
    await settle(() =>
      ws?.pointDocs?.({ from: "test.view", docs: [{ path: join(docs, "solo.md"), name: "Solo" }] }),
    );
    await click(q('[aria-label="Clear the documents"]'));
    expect(ws?.pointedDocs).toBeNull();
    expect(q('[data-slot="pointed-chip"]')).toBeNull();
    await m.unmount();
  });

  test("a labelled pointer with no documents is still held: the chip says the label and the message carries no refs", async () => {
    const { m } = await openSolo();
    await settle(() =>
      ws?.pointDocs?.({ from: "test.view", label: "A board · 2 cards", docs: [] }),
    );
    await waitFor(() => !!q('[data-slot="pointed-chip"]'), "the labelled chip");
    expect(q('[data-slot="pointed-chip"]')?.textContent).toContain("A board · 2 cards");
    expect(q('[data-slot="pointed-chip"]')?.textContent).not.toContain("documents");
    // Its X says what it clears: the label, not "the documents".
    expect(q('[aria-label="Clear A board · 2 cards"]')).not.toBeNull();
    expect(q('[aria-label="Clear the documents"]')).toBeNull();
    await typeInto(q('[data-pane="chat"] textarea') as HTMLTextAreaElement, "about the cards");
    await click(
      qa('[data-pane="chat"] button').find((b) => b.textContent?.includes("Send")) ?? null,
    );
    await waitFor(() => (chatPane().textContent ?? "").includes("about the cards"), "sent");
    const said = (await state()).chat.find((c) => c.text === "about the cards");
    expect(said?.about).not.toHaveProperty("docs");
    expect(said?.about).not.toHaveProperty("refs");
    // Without the label an empty pointer is nothing.
    await settle(() => ws?.pointDocs?.({ from: "test.view", docs: [] }));
    expect(ws?.pointedDocs).toBeNull();
    await m.unmount();
  });

  test("the chip's X drops the selection everywhere, including at the daemon", async () => {
    const { m, slug } = await openSolo();
    await settle(() => ws?.reportSelection(SELECTION(slug)));
    await waitFor(() => !!q('[data-slot="selection-chip"]'), "the chip");
    const fetchHeld = async () => ((await state()).selection as { text?: string } | null)?.text;
    await waitFor(() => true, "tick");
    for (let i = 0; i < 40 && (await fetchHeld()) !== "Solo"; i++) await Bun.sleep(25);
    expect(await fetchHeld()).toBe("Solo");
    const before = ws?.clearSeq ?? 0;
    await click(q('[aria-label="Clear the selection"]'));
    expect(q('[data-slot="selection-chip"]')).toBeNull();
    expect(ws?.selection).toBeNull();
    // A pane that paints the selection is told to unpaint.
    expect(ws?.clearSeq).toBe(before + 1);
    for (let i = 0; i < 40 && (await fetchHeld()) !== undefined; i++) await Bun.sleep(25);
    expect(await fetchHeld()).toBeUndefined();
    // A message sent now carries nothing.
    await typeInto(q('[data-pane="chat"] textarea') as HTMLTextAreaElement, "no passage");
    await click(
      qa('[data-pane="chat"] button').find((b) => b.textContent?.includes("Send")) ?? null,
    );
    await waitFor(() => (chatPane().textContent ?? "").includes("no passage"), "the message");
    const said = (await state()).chat.find((c) => c.text === "no passage");
    // It still points at the open document, but no longer at a passage in it.
    expect(said?.about).toMatchObject({ doc: slug, version: 1 });
    expect(said?.about).not.toHaveProperty("text");
    expect(said?.about).not.toHaveProperty("fromLine");
    await m.unmount();
  });

  test("a reconnect tells the daemon the selection again", async () => {
    const { m, slug } = await openSolo();
    const port = daemon.port;
    const sessionId = daemon.sessionId;
    await settle(() => ws?.reportSelection(SELECTION(slug)));
    const held = async () => ((await state()).selection as { text?: string } | null)?.text;
    for (let i = 0; i < 40 && (await held()) !== "Solo"; i++) await Bun.sleep(25);
    expect(await held()).toBe("Solo");
    await daemon.stop();
    await waitFor(() => ws?.daemon.connection === "closed", "closed");
    // The restored session holds no selection (it is not in the manifest)...
    daemon = fixtureDaemon({ tmp: join(root, "tmp"), workspace: docs, port, restore: sessionId });
    await daemon.start();
    await waitFor(() => ws?.daemon.connection === "open", "open again");
    // ...so the chip on screen is told to the daemon once more.
    for (let i = 0; i < 80 && (await held()) !== "Solo"; i++) await Bun.sleep(25);
    expect(await held()).toBe("Solo");
    expect(ws?.selection?.text).toBe("Solo");
    await m.unmount();
  });

  test("opening another document clears a selection made in the first", async () => {
    const { m, slug } = await openSolo();
    await settle(() => ws?.reportSelection(SELECTION(slug)));
    expect(ws?.selection?.text).toBe("Solo");
    await settle(() => {
      ws?.daemon.send({ op: "context.add", path: join(docs, "sibling.md") });
    });
    await waitFor(
      () => (q('[data-pane="context"]')?.textContent ?? "").includes("sibling.md"),
      "entry",
    );
    await click(
      qa('[data-pane="context"] button').find((b) =>
        (b.textContent ?? "").includes("sibling.md"),
      ) ?? null,
    );
    await waitFor(() => ws?.openDoc?.name === "sibling.md", "the other document");
    expect(ws?.selection).toBeNull();
    await m.unmount();
  });
});

describe("notes", () => {
  test("a note is written about the held selection and lists under Notes", async () => {
    const { m, slug } = await openSolo();
    await settle(() => ws?.reportSelection(SELECTION(slug)));
    await click(tab("Notes"));
    await waitFor(() => (chatPane().textContent ?? "").includes("Solo"), "the quote");
    await typeInto(
      chatPane().querySelector('textarea[aria-label="New note"]') as HTMLTextAreaElement,
      "rename this",
    );
    await click(
      qa('[data-pane="chat"] button').find((b) => b.textContent?.includes("Add note")) ?? null,
    );
    await waitFor(() => qa('[data-slot="note"]').length === 1, "the note");
    expect(q('[data-slot="note"]')?.textContent).toContain("rename this");
    // The tab counts the open notes, and the note consumed the passage.
    expect(tab(/Notes/)?.textContent).toBe("Notes (1)");
    expect(ws?.selection).toBeNull();
    const stored = (await state()).docs.find((d) => d.slug === slug)?.notes;
    expect(stored?.map((n) => n.body)).toEqual(["rename this"]);
    await m.unmount();
  });

  test("a note's quote asks the centre to show its range, once", async () => {
    const { m, slug } = await openSolo();
    await settle(() => ws?.reportSelection(SELECTION(slug)));
    await click(tab("Notes"));
    await typeInto(
      chatPane().querySelector('textarea[aria-label="New note"]') as HTMLTextAreaElement,
      "look",
    );
    await click(
      qa('[data-pane="chat"] button').find((b) => b.textContent?.includes("Add note")) ?? null,
    );
    await waitFor(() => qa('[data-slot="note"]').length === 1, "the note");
    expect(q('[data-testid="reveal"]')?.textContent).toBe("none");
    await click(q('[data-slot="note"] button[title="Show this in the document"]'));
    await waitFor(() => q('[data-testid="reveal"]')?.textContent === "2-6", "the reveal request");
    expect(q('[data-slot="note"]')?.getAttribute("data-focused")).toBe("true");
    // The pane that applied it spends it.
    const seq = ws?.reveal?.seq as number;
    await settle(() => ws?.revealApplied(seq));
    expect(q('[data-testid="reveal"]')?.textContent).toBe("none");
    await m.unmount();
  });

  test("editing, resolving and deleting go to the daemon", async () => {
    const { m, slug } = await openSolo();
    await settle(() => ws?.reportSelection(SELECTION(slug)));
    await click(tab("Notes"));
    await typeInto(
      chatPane().querySelector('textarea[aria-label="New note"]') as HTMLTextAreaElement,
      "first",
    );
    await click(
      qa('[data-pane="chat"] button').find((b) => b.textContent?.includes("Add note")) ?? null,
    );
    await waitFor(() => qa('[data-slot="note"]').length === 1, "the note");
    await click(q('[data-slot="note"] [aria-label="Edit note"]'));
    await typeInto(q('[data-slot="note"] textarea') as HTMLTextAreaElement, "second");
    await click(qa('[data-slot="note"] button').find((b) => b.textContent === "Save") ?? null);
    await waitFor(
      () => (q('[data-slot="note"]')?.textContent ?? "").includes("second"),
      "the edit",
    );
    await click(q('[data-slot="note"] [aria-label="Resolve note"]'));
    await waitFor(() => qa('[data-slot="note"]').length === 0, "the note to hide");
    await click(
      qa('[data-pane="chat"] button').find((b) => /Show 1 resolved/.test(b.textContent ?? "")) ??
        null,
    );
    await click(q('[data-slot="note"] [aria-label="Delete note"]'));
    await waitFor(() => qa('[data-slot="note"]').length === 0, "the note to go");
    expect((await state()).docs.find((d) => d.slug === slug)?.notes).toEqual([]);
    await m.unmount();
  });
});

describe("tasks", () => {
  test("a task the human makes shows in the queue, and can be cancelled", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="chat"]'), "the shell");
    await click(tab("Tasks"));
    await typeInto(
      chatPane().querySelector('input[aria-label="New task"]') as HTMLInputElement,
      "outline chapter 2",
    );
    await click(chatPane().querySelector('[aria-label="Add task"]'));
    await waitFor(() => qa('[data-slot="task"]').length === 1, "the task");
    const row = () => q('[data-slot="task"]');
    expect(row()?.getAttribute("data-by")).toBe("human");
    expect(row()?.textContent).toContain("outline chapter 2");
    // The tab says work is outstanding.
    expect(tab(/Tasks/)?.textContent).toContain("Tasks (1)");
    await click(row()?.querySelector('button[aria-label^="Cancel task"]') ?? null);
    await waitFor(() => row()?.getAttribute("data-status") === "cancelled", "the cancellation");
    expect((await state()).tasks[0]?.status).toBe("cancelled");
    expect(tab("Tasks")).not.toBeNull();
    // A finished one can be forgotten.
    await click(chatPane().querySelector('button[aria-label^="Remove task"]'));
    await waitFor(() => qa('[data-slot="task"]').length === 0, "the task to go");
    await m.unmount();
  });

  test("a running task shows a progress bar that moves, and cancel stops it", async () => {
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="chat"]'), "the shell");
    await click(tab("Tasks"));
    await settle(() => {
      ws?.daemon.send({ op: "kit-fixture.demo", title: "Render the chapter" });
    });
    await waitFor(
      () => !!q('[data-slot="task"][data-status="running"] [role="progressbar"]'),
      "a progress bar",
    );
    const at = () =>
      Number(q('[data-slot="task"] [role="progressbar"]')?.getAttribute("aria-valuenow") ?? -1);
    await waitFor(() => at() >= 25, "some progress");
    expect(q('[data-slot="task"]')?.getAttribute("data-by")).toBe("daemon");
    await click(q('[data-slot="task"] button[aria-label^="Cancel task"]'));
    await waitFor(
      () => q('[data-slot="task"]')?.getAttribute("data-status") === "cancelled",
      "cancelled",
    );
    expect(q('[data-slot="task"] [role="progressbar"]')).toBeNull();
    await m.unmount();
  });

  test("a task that finishes is announced in a toast", async () => {
    process.env.KIT_FIXTURE_STEP_MS = "20";
    const m = await mount(<Host />);
    await waitFor(() => !!q('[data-pane="chat"]'), "the shell");
    await settle(() => {
      ws?.daemon.send({ op: "kit-fixture.demo", title: "Quick render" });
    });
    await waitFor(
      () => (q('[data-slot="toasts"]')?.textContent ?? "").includes("Done: Quick render"),
      "the toast",
    );
    await m.unmount();
  });
});

describe("new versions", () => {
  test("a version the agent makes is announced with Activate, and Show diff only if the app shows diffs", async () => {
    const shown: Array<[string, number]> = [];
    const { m, slug } = await openSolo({ onShowDiff: (d, v) => shown.push([d.slug, v]) });
    await settle(() => {
      daemon.session.newVersion({ doc: slug, by: "agent", label: "tighter" });
      daemon.context.broadcast();
    });
    await waitFor(
      () => (q('[data-slot="toasts"]')?.textContent ?? "").includes("New version: v2"),
      "the toast",
    );
    const toast = q('[data-slot="toasts"]') as HTMLElement;
    expect([...toast.querySelectorAll("button")].map((b) => b.textContent)).toContain("Show diff");
    await click(
      [...toast.querySelectorAll("button")].find((b) => b.textContent === "Show diff") ?? null,
    );
    expect(shown).toEqual([[slug, 2]]);
    // A toast's button is spent once pressed, and Show diff never activated.
    expect(q('[data-slot="toasts"]')).toBeNull();
    expect(ws?.openDoc?.active).toBe(1);
    // Activate is the kit's: it goes to the daemon, which makes the version active.
    await settle(() => {
      daemon.session.newVersion({ doc: slug, by: "agent" });
      daemon.context.broadcast();
    });
    await waitFor(
      () => (q('[data-slot="toasts"]')?.textContent ?? "").includes("New version: v3"),
      "the next toast",
    );
    await click(
      [...(q('[data-slot="toasts"]') as HTMLElement).querySelectorAll("button")].find(
        (b) => b.textContent === "Activate",
      ) ?? null,
    );
    await waitFor(() => ws?.openDoc?.active === 3, "version 3 to become active");
    await m.unmount();
  });
});
