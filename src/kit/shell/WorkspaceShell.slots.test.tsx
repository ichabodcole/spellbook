// The panes' own slots, through the shell. The context sidebar and Notes carry
// slots the shell composes them without: where a new thing goes for an app with
// no workspace (`askLocation`), the pre-move question (`beforeMove`, its timeout
// and its unchecked note), the refusal `notice`, and Notes' `addUnavailable`;
// the outside-change toast has its "See the difference". Each must reach its
// pane unchanged, and with none given the shell behaves as before. Over a REAL
// workspace daemon, so a slot the shell drops on the way turns this red.

import "../lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LocationAsk } from "../context/AskLocation.tsx";
import { type Daemon, LINK_REFUSED, SESSION_ENDED } from "../context/daemonClient.ts";
import type { PendingMove } from "../context/preMove.ts";
import { useDaemon } from "../context/useDaemon.ts";
import {
  cleanup,
  installDom,
  mount,
  nativeGlobal,
  removeDom,
  settle,
  waitFor,
} from "../lib/testDom.ts";
import { laidOut } from "../lib/testLayout.ts";
import { fixtureApp, fixtureDaemon } from "../workspace/fixtures/app";
import type { DocView, PublicState } from "../workspace/protocol";
import type { WorkspaceDaemon } from "../workspace/server";
import { seedDocs, tempRoot } from "../workspace/testing";
import { WorkspaceShell, type WorkspaceShellProps } from "./WorkspaceShell.tsx";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
let seen: Daemon | null = null;

beforeEach(async () => {
  root = tempRoot("shell-slots");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  localStorage.clear();
  seen = null;
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    app: { ...fixtureApp, homeWorkspace: false },
  });
  await daemon.start();
});
afterEach(async () => {
  await daemon.stop().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

type Slots = Partial<Omit<WorkspaceShellProps, "daemon" | "centre">>;

/**
 * The shell over the daemon, with `slots` handed to it. `ownNotice` wires the
 * notice as an app would, off the daemon's last refusal. `outside` flags every
 * document as changed on disk, as the daemon does for an open document whose
 * file another program rewrote while it had edits.
 */
function Host({
  slots = {},
  ownNotice = false,
  outside = false,
}: {
  slots?: Slots;
  ownNotice?: boolean;
  outside?: boolean;
}) {
  const d = useDaemon({
    url: `${daemon.url}/ws`,
    WebSocket: nativeGlobal<typeof WebSocket>("WebSocket"),
    minDelayMs: 20,
    maxDelayMs: 60,
  });
  seen = d;
  const shown: Daemon =
    outside && d.state
      ? {
          ...d,
          state: {
            ...d.state,
            docs: d.state.docs.map((x) => ({ ...x, outsideChanged: true })),
          } as PublicState,
        }
      : d;
  const notice = ownNotice
    ? { notice: d.lastError ? `${d.lastError}. To go on: add a folder that exists` : null }
    : {};
  return (
    <div style={{ width: 1200, height: 700 }}>
      <WorkspaceShell
        daemon={shown}
        centre={<div data-testid="centre" />}
        {...(ownNotice ? { onDismissNotice: d.clearError } : {})}
        {...notice}
        {...slots}
      />
    </div>
  );
}

const q = (sel: string) => document.querySelector(sel);
const qa = (sel: string) => [...document.querySelectorAll(sel)];
const contextPane = () => q('[data-pane="context"]') as HTMLElement;
const chatPane = () => q('[data-pane="chat"]') as HTMLElement;
const text = () => document.body.textContent ?? "";
const click = async (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  await settle(() => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};
const rightClick = async (el: Element | null) => {
  if (!el) throw new Error("nothing to right-click");
  await settle(() => {
    el.dispatchEvent(
      new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 9 }),
    );
  });
};
const byLabel = (l: string) => q(`[aria-label="${l}"]`);
const buttonWith = (t: string, within: ParentNode = document.body) =>
  [...within.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(t)) ?? null;
const menuItem = (t: string) =>
  qa('[role^="menuitem"]').find((e) => (e.textContent ?? "").includes(t)) ?? null;
const option = (t: string) =>
  qa('[data-slot="move-to-dialog"] [role="option"]').find(
    (e) => (e.textContent ?? "").trim() === t,
  ) ?? null;
const confirmDialog = () => q('[data-slot="confirm-dialog"]') as HTMLElement | null;
const alertIn = (pane: Element) => pane.querySelector('[role="alert"]');
const pause = (ms: number) => settle(() => new Promise<void>((r) => setTimeout(r, ms)));

async function shellUp() {
  await waitFor(() => seen?.connection === "open" && !!seen.state, "the snapshot");
  await waitFor(() => !!q('[data-pane="context"]'), "the shell");
}
/** `solo.md` and the folder `set` in the context, each where it lives; before the mount. */
function addDocs() {
  daemon.session.addContext(join(docs, "solo.md"));
  daemon.session.addContext(join(docs, "set"));
}
const rowsUp = () => waitFor(() => !!buttonWith("solo.md", contextPane()), "the docs' rows");
async function openDoc(path: string): Promise<DocView> {
  await settle(() => {
    seen?.send({ op: "open", path });
  });
  const slug = () => seen?.state?.docs.find((d) => d.original === path)?.slug;
  await waitFor(() => !!slug() && seen?.state?.openDoc === slug(), "the document to open");
  return seen?.state?.docs.find((d) => d.original === path) as DocView;
}
/** "Move to…" `row` into `into`, from the row's own menu. */
async function moveTo(row: string, into: string) {
  await rightClick(buttonWith(row, contextPane()));
  await waitFor(() => menuItem("Move to") !== null, "the menu");
  await click(menuItem("Move to"));
  await waitFor(() => option(into) !== null, `the Move to dialog offering ${into}`);
  // A modal: while it is open, the shell behind it is inert (`inertOutside`).
  expect((q('[data-pane="context"]')?.closest("body > *") as HTMLElement | null)?.inert).toBe(true);
  await click(option(into));
}
/** A refusal from the daemon itself: a folder that is not there cannot be added. */
async function refuse() {
  await settle(() => {
    seen?.send({ op: "context.add", path: join(root, "not-there") });
  });
}

describe("askLocation reaches the context sidebar", () => {
  test("New document asks the app's slot where, and the daemon makes it there", async () => {
    const asks: LocationAsk[] = [];
    addDocs();
    const m = await mount(
      <Host
        slots={{
          askLocation: async (a) => {
            asks.push(a);
            return join(docs, "set");
          },
        }}
      />,
    );
    await shellUp();
    await rowsUp();
    await click(byLabel("New document…"));
    await waitFor(() => asks.length === 1, "the ask");
    expect(asks[0]?.what).toBe("document");
    await waitFor(() => seen?.done?.of === "doc.create", "the new document");
    expect(seen?.done?.path.startsWith(join(docs, "set"))).toBe(true);
    await m.unmount();
  });

  test("absent, the list offers no New document that asks", async () => {
    addDocs();
    const m = await mount(<Host />);
    await shellUp();
    await rowsUp();
    expect(byLabel("New document…")).toBeNull();
    await m.unmount();
  });
});

describe("beforeMove reaches the context sidebar", () => {
  test("a move waits for the app's words, and goes when the human confirms", async () => {
    const asked: PendingMove[] = [];
    addDocs();
    const m = await mount(
      <Host
        slots={{
          beforeMove: (mv) => {
            asked.push(mv);
            return { title: "Move it?", message: "It breaks 2 links." };
          },
        }}
      />,
    );
    await shellUp();
    await rowsUp();
    await moveTo("solo.md", "set");
    await waitFor(() => confirmDialog() !== null, "the slot's dialog");
    expect(asked).toEqual([{ path: join(docs, "solo.md"), into: join(docs, "set") }]);
    expect(confirmDialog()?.textContent).toContain("It breaks 2 links.");
    expect(existsSync(join(docs, "solo.md"))).toBe(true);
    await click(buttonWith("Confirm", confirmDialog() as ParentNode));
    await waitFor(() => existsSync(join(docs, "set", "solo.md")), "the move on disk");
    await m.unmount();
  });

  test("beforeMoveTimeoutMs and uncheckedMoveNote: an unanswered check asks with the app's note", async () => {
    addDocs();
    const m = await mount(
      <Host
        slots={{
          beforeMove: () => new Promise(() => {}),
          beforeMoveTimeoutMs: 40,
          uncheckedMoveNote: (mv) => `Links into ${mv.path} were not checked.`,
        }}
      />,
    );
    await shellUp();
    await rowsUp();
    const started = Date.now();
    await moveTo("solo.md", "set");
    // The sidebar's own default is 5 s: well inside it, the shell's 40 ms has spoken.
    await waitFor(() => confirmDialog() !== null, "the unchecked question");
    expect(Date.now() - started).toBeLessThan(4000);
    expect(confirmDialog()?.textContent).toContain(
      `Links into ${join(docs, "solo.md")} were not checked.`,
    );
    await click(buttonWith("Cancel", confirmDialog() as ParentNode));
    await waitFor(() => confirmDialog() === null, "the dialog to close");
    expect(existsSync(join(docs, "solo.md"))).toBe(true);
    await m.unmount();
  });

  test("absent, the move goes at once, with no dialog", async () => {
    addDocs();
    const m = await mount(<Host />);
    await shellUp();
    await rowsUp();
    await moveTo("solo.md", "set");
    await waitFor(() => existsSync(join(docs, "set", "solo.md")), "the move on disk");
    expect(confirmDialog()).toBeNull();
    await m.unmount();
  });
});

describe("the refusal notice reaches the context sidebar, and is shown once", () => {
  test("a refusal shows as the app's notice, with its hint, and is not toasted too", async () => {
    addDocs();
    const m = await mount(<Host ownNotice />);
    await shellUp();
    await refuse();
    await waitFor(() => !!alertIn(contextPane()), "the notice");
    const refusal = seen?.lastError as string;
    expect(refusal).toBeTruthy();
    expect(alertIn(contextPane())?.textContent).toContain(
      `${refusal}. To go on: add a folder that exists`,
    );
    // Long enough for the shell's toast to have come, had it been raised.
    await pause(60);
    expect(q('[data-slot="toasts"]')?.textContent ?? "").not.toContain(refusal);
    expect(text()).not.toContain("The workspace refused that");
    // Dismissed through the app's slot: the daemon client lets the refusal go.
    await click(alertIn(contextPane())?.querySelector('[aria-label="Dismiss"]') ?? null);
    await waitFor(() => seen?.lastError === null, "the refusal to clear");
    await waitFor(() => !alertIn(contextPane()), "the notice to go");
    await m.unmount();
  });

  test("a notice the app gives is shown as it is", async () => {
    let dismissed = 0;
    addDocs();
    const m = await mount(
      <Host slots={{ notice: "Something the app says", onDismissNotice: () => dismissed++ }} />,
    );
    await shellUp();
    await waitFor(() => !!alertIn(contextPane()), "the notice");
    expect(alertIn(contextPane())?.textContent).toContain("Something the app says");
    await click(byLabel("Dismiss"));
    expect(dismissed).toBe(1);
    await m.unmount();
  });

  test("absent, the shell toasts the refusal and clears it, and the sidebar shows none", async () => {
    addDocs();
    const m = await mount(<Host />);
    await shellUp();
    await refuse();
    await waitFor(() => text().includes("The workspace refused that"), "the toast");
    await waitFor(() => seen?.lastError === null, "the shell to clear the refusal");
    expect(alertIn(contextPane())).toBeNull();
    await m.unmount();
  });
});

describe("the refusal rule's edges", () => {
  /** A collapsed context column, as a reload of a viewer's saved layout brings it back. */
  const collapseContext = () =>
    localStorage.setItem(
      "spellbook:react-resizable-panels:panes:context:centre:chat",
      JSON.stringify({ context: 3, centre: 72, chat: 25 }),
    );
  const toastsText = () => q('[data-slot="toasts"]')?.textContent ?? "";
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  /** A link outside the context: refused under its own title. */
  const refuseLink = () =>
    settle(() => {
      seen?.send({ op: "link.open", target: join(docs, "solo.md"), from: "chat" });
    });

  test("with the context column collapsed, an owned refusal is toasted under its title, once", async () => {
    daemon.session.addContext(join(docs, "set"));
    collapseContext();
    const m = await mount(<Host ownNotice />);
    await shellUp();
    await waitFor(() => !!q('[data-column-control="context-reopen"]'), "the collapsed column");
    await refuseLink();
    await waitFor(() => !!seen?.lastError, "the refusal");
    const refusal = seen?.lastError as string;
    expect(seen?.lastErrorTitle).toBe(LINK_REFUSED);
    await waitFor(() => toastsText().includes(refusal), "the toast");
    expect(toastsText()).toContain(LINK_REFUSED);
    await pause(60);
    expect(count(toastsText(), refusal)).toBe(1);
    // Still the app's: the shell leaves it for the notice to let go.
    expect(seen?.lastError).toBe(refusal);
    await m.unmount();
  });

  test("with the column open, an owned refusal is the notice alone, shown once", async () => {
    daemon.session.addContext(join(docs, "set"));
    const m = await mount(<Host ownNotice />);
    await shellUp();
    await refuseLink();
    await waitFor(() => !!alertIn(contextPane()), "the notice");
    const refusal = seen?.lastError as string;
    await pause(60);
    expect(toastsText()).not.toContain(refusal);
    expect(count(text(), refusal)).toBe(1);
    await m.unmount();
  });

  test("a link refusal has no timer: it closes on Escape, or when another document opens", async () => {
    daemon.session.addContext(join(docs, "set"));
    const m = await mount(<Host ownNotice />);
    await shellUp();
    // Escape lets it go.
    await refuseLink();
    await waitFor(() => !!alertIn(contextPane()), "the notice");
    // An Escape something else already took (a dialog, a menu) is not the notice's.
    await settle(() => {
      const taken = new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      taken.preventDefault();
      document.dispatchEvent(taken);
    });
    await pause(60);
    expect(seen?.lastError).toBeTruthy();
    await settle(() => {
      document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() => seen?.lastError === null, "Escape to clear it");
    await waitFor(() => !alertIn(contextPane()), "the notice to go");
    // Opening another document lets it go too.
    await refuseLink();
    await waitFor(() => !!alertIn(contextPane()), "the notice again");
    await openDoc(join(docs, "set", "a.md"));
    await waitFor(() => seen?.lastError === null, "the open to clear it");
    // An ordinary refusal is not a link's: an open does not take it away.
    await refuse();
    await waitFor(() => !!seen?.lastError, "the daemon's own refusal");
    await openDoc(join(docs, "set", "part", "b.md"));
    expect(seen?.lastError).toBeTruthy();
    await m.unmount();
  });

  /** With the column seeded collapsed: an owned refusal raised and toasted, and its text. */
  async function toastedWhileCollapsed(): Promise<string> {
    await waitFor(() => !!q('[data-column-control="context-reopen"]'), "the collapsed column");
    await refuseLink();
    await waitFor(() => !!seen?.lastError, "the refusal");
    const refusal = seen?.lastError as string;
    await waitFor(() => toastsText().includes(refusal), "the toast");
    return refusal;
  }

  test("the column reopened, the toast goes: the notice alone shows the refusal", async () => {
    // Laid out as a browser would, so the library can reopen the column at runtime.
    const stub = laidOut(1200);
    try {
      daemon.session.addContext(join(docs, "set"));
      collapseContext();
      const m = await mount(<Host ownNotice />);
      await shellUp();
      const refusal = await toastedWhileCollapsed();
      await click(q('[data-column-control="context-reopen"]'));
      await waitFor(() => !!q('[data-column-control="context-collapse"]'), "the column to reopen");
      await waitFor(() => !toastsText().includes(refusal), "the toast to go");
      expect(alertIn(contextPane())?.textContent).toContain(refusal);
      expect(count(text(), refusal)).toBe(1);
      await m.unmount();
    } finally {
      stub.undo();
    }
  });

  test("the same refusal again after its toast has gone is toasted again", async () => {
    daemon.session.addContext(join(docs, "set"));
    collapseContext();
    const m = await mount(<Host ownNotice />);
    await shellUp();
    const refusal = await toastedWhileCollapsed();
    const first = seen?.lastErrorSeq ?? 0;
    // The toast goes (as it does when it expires); the notice still holds the refusal.
    await click(q('[data-slot="toasts"] [aria-label="Dismiss"]'));
    await waitFor(() => !toastsText().includes(refusal), "the toast gone");
    expect(seen?.lastError).toBe(refusal);
    // The same link, refused word for word: a new refusal, so a new toast.
    await refuseLink();
    await waitFor(() => (seen?.lastErrorSeq ?? 0) > first, "the second refusal");
    expect(seen?.lastError).toBe(refusal);
    await waitFor(() => toastsText().includes(refusal), "the toast again");
    expect(count(toastsText(), refusal)).toBe(1);
    await m.unmount();
  });

  test("the refusal let go while collapsed, its toast goes with it", async () => {
    daemon.session.addContext(join(docs, "set"));
    collapseContext();
    const m = await mount(<Host ownNotice />);
    await shellUp();
    const refusal = await toastedWhileCollapsed();
    await settle(() => seen?.clearError());
    await waitFor(() => !toastsText().includes(refusal), "the toast to go");
    await m.unmount();
  });

  test("a notice of null still owns the refusals: no toast, and lastError is kept", async () => {
    const m = await mount(<Host slots={{ notice: null }} />);
    await shellUp();
    await refuse();
    await waitFor(() => !!seen?.lastError, "the refusal");
    await pause(60);
    expect(text()).not.toContain("The workspace refused that");
    expect(seen?.lastError).toBeTruthy();
    await m.unmount();
  });

  test("a session that has ended is still the shell's toast, under an owned notice", async () => {
    const m = await mount(<Host ownNotice />);
    await shellUp();
    await nativeGlobal<typeof fetch>("fetch")(`${daemon.url}/cmd`, {
      method: "POST",
      body: JSON.stringify({ op: "close" }),
    });
    await waitFor(() => seen?.connection === "ended", "the end");
    await settle(() => {
      seen?.send({ op: "context.add", path: join(docs, "solo.md") });
    });
    await waitFor(() => toastsText().includes("Session ended"), "the shell's toast");
    expect(toastsText()).toContain(SESSION_ENDED);
    await waitFor(() => seen?.lastError === null, "the shell to clear it");
    await m.unmount();
  });
});

describe("notesAddUnavailable reaches Notes", () => {
  const notesTab = () =>
    qa('[data-pane="chat"] [role="tab"]').find((b) => /^Notes/.test(b.textContent ?? "")) ?? null;

  test("its words stand in place of the form", async () => {
    addDocs();
    const m = await mount(<Host slots={{ notesAddUnavailable: "Notes are read-only here." }} />);
    await shellUp();
    await openDoc(join(docs, "solo.md"));
    await click(notesTab());
    await waitFor(
      () => (chatPane().textContent ?? "").includes("Notes are read-only here."),
      "the words",
    );
    expect(chatPane().querySelector("form")).toBeNull();
    await m.unmount();
  });

  test("absent, Notes offers its form", async () => {
    addDocs();
    const m = await mount(<Host />);
    await shellUp();
    await openDoc(join(docs, "solo.md"));
    await click(notesTab());
    await waitFor(() => !!chatPane().querySelector("form"), "the form");
    await m.unmount();
  });
});

describe("onShowOutsideDiff reaches the outside-change toast", () => {
  test("See the difference hands the app the changed document, not another one", async () => {
    const shown: DocView[] = [];
    addDocs();
    const m = await mount(<Host slots={{ onShowOutsideDiff: (d) => shown.push(d) }} />);
    await shellUp();
    // Another document first, so the changed one is not the first in the list.
    await openDoc(join(docs, "set", "a.md"));
    const doc = await openDoc(join(docs, "solo.md"));
    expect(seen?.state?.docs[0]?.slug).not.toBe(doc.slug);
    // Edited in the session, then rewritten on disk by another program: the
    // daemon flags the outside change itself.
    await settle(() => {
      seen?.send({
        op: "edit",
        doc: doc.slug,
        version: doc.active,
        text: "# Solo\n\nedited here\n",
      });
    });
    await pause(1500);
    writeFileSync(join(docs, "solo.md"), "# Solo\n\nrewritten by another program\n");
    await waitFor(
      () => !!seen?.state?.docs.find((d) => d.slug === doc.slug)?.outsideChanged,
      "the daemon to flag the outside change",
      15000,
    );
    await waitFor(() => !!buttonWith("See the difference"), "the toast's button");
    await click(buttonWith("See the difference"));
    expect(shown.map((d) => d.slug)).toEqual([doc.slug]);
    expect(shown[0]?.original).toBe(join(docs, "solo.md"));
    await m.unmount();
  }, 30000);

  test("absent, the toast offers Reload and Keep only", async () => {
    addDocs();
    const m = await mount(<Host outside />);
    await shellUp();
    await openDoc(join(docs, "solo.md"));
    await waitFor(() => !!buttonWith("Reload"), "the toast");
    expect(buttonWith("See the difference")).toBeNull();
    await m.unmount();
  });
});
