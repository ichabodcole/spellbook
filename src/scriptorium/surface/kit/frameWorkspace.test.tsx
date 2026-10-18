// The frame's workspace, cell by cell, over a hand-made daemon whose snapshots
// the test sets and whose sent ops it reads: the held selection and what the
// daemon is told of it (E66's switch rule, a reconnect, the version's file),
// and the chosen note (a version switch, a second click, a resolve, the reveal
// it asks for, letting go). The same wiring on a real daemon, in a page, is
// `Frame.document.test.tsx`.

import "../../../kit/lib/registerDom.ts";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { useMemo } from "react";
import type { Daemon } from "../../../kit/context/daemonClient";
import type { HeldSelection } from "../../../kit/context/selection";
import { cleanup, installDom, mount, removeDom, settle } from "../../../kit/lib/testDom";
import { createToastStore } from "../../../kit/ui/toast-store";
import type { DocView, PlacedNote, PublicState } from "../../../kit/workspace/protocol";
import { type FrameWorkspace, useFrameWorkspace } from "./frameWorkspace";

beforeAll(installDom);
afterEach(cleanup);
afterAll(removeDom);

const ORIGINAL = "/w/notes/lantern.md";
const versionPath = (n: number) => `/home/sessions/s1/docs/lantern/v${n}.md`;

function note(over: Partial<PlacedNote> = {}): PlacedNote {
  return {
    id: "n1",
    version: 1,
    quote: "lantern",
    before: "The ",
    after: " by",
    at: 4,
    body: "Which?",
    by: "human",
    createdAt: "2026-10-18T00:00:00Z",
    resolved: false,
    from: 4,
    to: 11,
    how: "exact",
    fromLine: 1,
    toLine: 1,
    ...over,
  } as PlacedNote;
}

function doc(over: Partial<DocView> & { slug?: string } = {}): DocView {
  const slug = over.slug ?? "lantern";
  return {
    slug,
    name: `${slug}.md`,
    original: slug === "lantern" ? ORIGINAL : `/w/notes/${slug}.md`,
    active: 1,
    versions: [1, 2].map((n) => ({ n, path: versionPath(n) })),
    notes: [],
    dirty: false,
    ...over,
  } as unknown as DocView;
}

function state(open: DocView | null, docs: DocView[] = open ? [open] : []): PublicState {
  return { docs, openDoc: open?.slug ?? null } as unknown as PublicState;
}

/** Every op the hook sent, oldest first. */
let sent: Record<string, unknown>[] = [];
const selects = () => sent.filter((o) => o.op === "select").map((o) => o.selection);

// One `send` and one `onFrame` for every snapshot, as the real client keeps
// them: a fresh function per render would re-run every effect that names them,
// and hide an effect that forgot what it should have re-run on.
const send = (op: Record<string, unknown>) => {
  sent.push(op);
  return 1;
};
const onFrame = () => () => {};

function daemonWith(s: PublicState, connection: Daemon["connection"] = "open"): Daemon {
  return { state: s, connection, send, onFrame, lastError: null } as unknown as Daemon;
}

/** The hook's value after each render, newest last. */
let seen: FrameWorkspace[] = [];
const now = () => seen.at(-1) as FrameWorkspace;

function Probe({ daemon }: { daemon: Daemon }) {
  const toasts = useMemo(() => createToastStore(), []);
  seen.push(useFrameWorkspace({ daemon, toasts, theme: "dark", setTheme: () => {} }));
  return null;
}

async function start(d: Daemon) {
  sent = [];
  seen = [];
  return mount(<Probe daemon={d} />);
}

const sel = (over: Partial<HeldSelection> = {}): HeldSelection => ({
  doc: "lantern",
  version: 1,
  from: 4,
  to: 11,
  fromLine: 1,
  toLine: 1,
  text: "lantern",
  ...over,
});

describe("the held selection", () => {
  test("another document on screen drops it, in the hook and in the daemon (E66)", async () => {
    const lantern = doc();
    const m = await start(daemonWith(state(lantern)));
    await settle(() => now().workspace?.reportSelection(sel()));
    expect(now().heldHere?.text).toBe("lantern");
    const seq = now().workspace?.clearSeq ?? 0;
    const other = doc({ slug: "harbour" });
    await m.render(<Probe daemon={daemonWith(state(other, [lantern, other]))} />);
    expect(now().workspace?.selection).toBeNull();
    expect(now().workspace?.clearSeq).toBe(seq + 1);
    expect(selects().at(-1)).toBeNull();
    // Coming back does not revive it.
    await m.render(<Probe daemon={daemonWith(state(lantern, [lantern, other]))} />);
    expect(now().workspace?.selection).toBeNull();
    await m.unmount();
  });

  test("it is shown only for the version it was made in, from the very render the version changes", async () => {
    const m = await start(daemonWith(state(doc())));
    await settle(() => now().workspace?.reportSelection(sel()));
    const from = seen.length;
    await m.render(<Probe daemon={daemonWith(state(doc({ active: 2 })))} />);
    // No render after the switch offered the v1 passage as held here.
    expect(seen.slice(from).map((w) => w.heldHere)).toEqual(seen.slice(from).map(() => null));
    await m.unmount();
  });

  test("the daemon is told with the version's file as the path, and told again on a reconnect", async () => {
    const lantern = doc({ active: 2 });
    const m = await start(daemonWith(state(lantern)));
    await settle(() => now().workspace?.reportSelection(sel({ version: 2 })));
    expect(selects().at(-1)).toEqual({
      doc: "lantern",
      version: 2,
      path: versionPath(2),
      fromLine: 1,
      toLine: 1,
      text: "lantern",
    });
    // Not the original, and not another version's file.
    expect((selects().at(-1) as { path: string }).path).not.toBe(ORIGINAL);

    sent = [];
    await m.render(<Probe daemon={daemonWith(state(lantern), "closed")} />);
    expect(selects()).toEqual([]);
    await m.render(<Probe daemon={daemonWith(state(lantern), "open")} />);
    expect(selects()).toHaveLength(1);
    expect((selects()[0] as { text: string }).text).toBe("lantern");
    await m.unmount();
  });
});

describe("the chosen note", () => {
  const withNote = (over: Partial<DocView> = {}, n: Partial<PlacedNote> = {}) =>
    doc({ notes: [note(n)], ...over });

  test("going to a note chooses it and asks to show its passage", async () => {
    const m = await start(daemonWith(state(withNote())));
    await settle(() => now().goToNote(note()));
    expect(now().focusedNote).toBe("n1");
    expect(now().workspace?.focusedNote).toBe("n1");
    expect(now().workspace?.reveal).toMatchObject({ doc: "lantern", version: 1, from: 4, to: 11 });
    await m.unmount();
  });

  test("a second click on it lets it go, and asks to show nothing new", async () => {
    const m = await start(daemonWith(state(withNote())));
    await settle(() => now().goToNote(note()));
    const reveal = now().workspace?.reveal;
    await settle(() => now().goToNote(note()));
    expect(now().focusedNote).toBeNull();
    expect(now().workspace?.reveal).toBe(reveal);
    await m.unmount();
  });

  test("letting go (Escape in the panel) clears it", async () => {
    const m = await start(daemonWith(state(withNote())));
    await settle(() => now().goToNote(note()));
    await settle(() => now().letGoOfNote());
    expect(now().focusedNote).toBeNull();
    await m.unmount();
  });

  test("another version on screen is not where it was chosen", async () => {
    const m = await start(daemonWith(state(withNote())));
    await settle(() => now().goToNote(note()));
    await m.render(<Probe daemon={daemonWith(state(withNote({ active: 2 })))} />);
    expect(now().focusedNote).toBeNull();
    await m.unmount();
  });

  test("resolving it lets it go, and it does not come back when reopened", async () => {
    const m = await start(daemonWith(state(withNote())));
    await settle(() => now().goToNote(note()));
    await m.render(<Probe daemon={daemonWith(state(withNote({}, { resolved: true })))} />);
    await settle(() => {});
    expect(now().focusedNote).toBeNull();
    await m.render(<Probe daemon={daemonWith(state(withNote()))} />);
    expect(now().focusedNote).toBeNull();
    await m.unmount();
  });
});
