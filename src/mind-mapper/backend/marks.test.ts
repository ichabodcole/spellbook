// Claim B (T6) — doc marks: append-only trail, latest-per-doc wins, staleness
// is read-time-computed from the doc file's mtime (never stored, never in the
// event), and doc.marked carries the FULL mark inline.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { isStale, latestPerDoc, markDoc } from "./marks.ts";
import { readState } from "./state.ts";

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-marks-test-"));
  mkdirSync(join(dir, "docs"));
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, db };
}

function addDoc(db: ReturnType<typeof openStore>, dir: string, id: string, content = "prose") {
  writeFileSync(join(dir, "docs", `${id}.md`), content);
  db.run("INSERT INTO docs (id, title, kind, path) VALUES (?, ?, 'ramble', ?)", [
    id,
    id,
    `docs/${id}.md`,
  ]);
}

test("isStale: unknown mtimes read stale; newer file reads stale; unchanged reads fresh", () => {
  expect(isStale(null, 100)).toBe(true);
  expect(isStale(100, null)).toBe(true);
  expect(isStale(100, 200)).toBe(true);
  expect(isStale(100, 100)).toBe(false);
});

test("latestPerDoc keeps the last row per doc in insertion order", () => {
  const row = (docId: string, status: string) => ({
    doc_id: docId,
    author: "agent",
    note: null,
    status,
    doc_mtime: null,
    ts: 1,
  });
  const latest = latestPerDoc([row("a", "read"), row("b", "skimmed"), row("a", "analyzed")]);
  expect(latest.get("a")?.status).toBe("analyzed");
  expect(latest.get("b")?.status).toBe("skimmed");
});

test("markDoc validates the doc exists, requires a status, and guards the slug", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    expect(() =>
      markDoc(db, bus, dir, { docId: "no-such-doc", author: "agent", status: "read" }),
    ).toThrow(/unknown doc/);
    expect(() =>
      markDoc(db, bus, dir, { docId: "../escape", author: "agent", status: "read" }),
    ).toThrow(/invalid doc id/);
    addDoc(db, dir, "ramble-01");
    expect(() =>
      markDoc(db, bus, dir, { docId: "ramble-01", author: "agent", status: "" }),
    ).toThrow(/non-empty status/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doc.marked carries the FULL mark inline — and never a stale field", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    addDoc(db, dir, "ramble-01");
    const received: unknown[] = [];
    bus.subscribe(0, (e) => received.push(e));
    const mark = markDoc(db, bus, dir, {
      docId: "ramble-01",
      author: "agent",
      status: "analyzed",
      note: "two claims proposed",
    });
    expect(received).toHaveLength(1);
    const event = received[0] as { kind: string; payload: Record<string, unknown> };
    expect(event.kind).toBe("doc.marked");
    expect(event.payload).toEqual({ docId: "ramble-01", mark });
    expect((event.payload.mark as Record<string, unknown>).stale).toBeUndefined();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state merges the LATEST mark per doc with read-time staleness", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    addDoc(db, dir, "ramble-01");
    addDoc(db, dir, "ramble-02");
    markDoc(db, bus, dir, { docId: "ramble-01", author: "agent", status: "read" });
    markDoc(db, bus, dir, {
      docId: "ramble-01",
      author: "agent",
      status: "analyzed",
      note: "null result — nothing worth extracting",
    });

    const state = readState(db, { id: "default", title: "Default" }, 0, "", dir);
    const marked = state.docs.find((d) => d.id === "ramble-01");
    expect(marked?.mark).toMatchObject({
      author: "agent",
      status: "analyzed",
      note: "null result — nothing worth extracting",
      stale: false,
    });
    // Never-marked docs carry no mark key at all.
    expect(state.docs.find((d) => d.id === "ramble-02")?.mark).toBeUndefined();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a doc edited after its mark reads stale; a missing file reads stale", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    addDoc(db, dir, "ramble-01");
    addDoc(db, dir, "ramble-02");
    markDoc(db, bus, dir, { docId: "ramble-01", author: "agent", status: "analyzed" });
    markDoc(db, bus, dir, { docId: "ramble-02", author: "agent", status: "analyzed" });

    // Edit ramble-01 with an explicitly-future mtime (write alone can land in
    // the same ms as the mark's snapshot).
    const future = new Date(Date.now() + 5000);
    utimesSync(join(dir, "docs", "ramble-01.md"), future, future);
    // Delete ramble-02's file outright.
    rmSync(join(dir, "docs", "ramble-02.md"));

    const state = readState(db, { id: "default", title: "Default" }, 0, "", dir);
    expect(state.docs.find((d) => d.id === "ramble-01")?.mark?.stale).toBe(true);
    expect(state.docs.find((d) => d.id === "ramble-02")?.mark?.stale).toBe(true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
