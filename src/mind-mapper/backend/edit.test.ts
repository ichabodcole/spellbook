// Round 12 (SEAM 4) — `node edit`: a ratified node can finally gain a synopsis
// (F2). Writes exactly what it is given; tier/kind are not editable.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { editNode } from "./edit.ts";
import { ALL_EVENT_KINDS, type BusEvent, createEventBus } from "./events.ts";
import { search } from "./search.ts";
import { readState } from "./state.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-edit-test-"));
  const db = openStore(join(dir, "store.sqlite"));
  db.run(
    "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('n1', 'concept', 'canon', 'Rich Ruth', '')",
  );
  return { dir, db };
}

test("editNode gives a bare canon node a synopsis — the F2 recovery, without re-ratifying", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const node = editNode(db, bus, "n1", { synopsis: "Nashville ambient guitarist." });
    expect(node?.synopsis).toBe("Nashville ambient guitarist.");
    // The human's ratification act is untouched: same id, same tier.
    expect(node?.id).toBe("n1");
    expect(node?.tier).toBe("canon");
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.nodes[0]?.synopsis).toBe("Nashville ambient guitarist.");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edited synopsis is IMMEDIATELY searchable — nodes are not FTS-indexed at all", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    expect(search(db, "ambient")).toHaveLength(0);
    editNode(db, bus, "n1", { synopsis: "Nashville ambient guitarist." });
    // FALSIFIES the plan's sub-question 2: search.ts matches nodes with a live
    // LIKE over the `nodes` table (docs_fts/messages_fts index docs and
    // messages only), so there is no index to re-index — but this pins it, so
    // the day node search moves to FTS this test goes red instead of search
    // silently rotting.
    const hits = search(db, "ambient");
    expect(hits.map((h) => h.id)).toEqual(["n1"]);
    // And a retitle is findable by the new title, not the old one.
    editNode(db, bus, "n1", { title: "Rich Ruth (artist)" });
    expect(search(db, "artist").map((h) => h.id)).toEqual(["n1"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an omitted field is left alone — edit is a patch, never a wholesale replace", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    editNode(db, bus, "n1", { synopsis: "keeps the mill" });
    const node = editNode(db, bus, "n1", { title: "Edda" });
    expect(node).toMatchObject({ title: "Edda", synopsis: "keeps the mill" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("node.edited is in the TOTAL event vocabulary and carries the FULL node entity", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    expect(ALL_EVENT_KINDS).toContain("node.edited");
    db.run("INSERT INTO node_tags (target_id, tags_json) VALUES ('n1', '[\"ambient\"]')");
    db.run("INSERT INTO sources (node_id, doc_id, span) VALUES ('n1', 'ramble-01', null)");
    const seen: BusEvent[] = [];
    bus.subscribe(bus.cursor(), (e) => seen.push(e));
    const node = editNode(db, bus, "n1", { synopsis: "s" });
    expect(seen.map((e) => e.kind)).toEqual(["node.edited"]);
    // Re-read through the single reader: the payload must equal /state.nodes[]
    // exactly, or a replace-by-id consumer drops tags/sources/submap count.
    const fromState = readState(db, { id: "default", title: "Default" }).nodes[0];
    expect(seen[0]?.payload).toEqual(fromState as unknown as Record<string, unknown>);
    expect(node).toEqual(fromState as NonNullable<typeof node>);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown node is null (the server 404s); an empty or ill-shaped patch is a NAMED error", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    expect(editNode(db, bus, "nope", { synopsis: "x" })).toBeNull();
    expect(() => editNode(db, bus, "n1", {})).toThrow(/at least one/);
    // The error names WHY tier/kind are absent, so the agent stops looking.
    expect(() => editNode(db, bus, "n1", {})).toThrow(/tier is the human's ruling/);
    expect(() => editNode(db, bus, "n1", { title: "  " })).toThrow(/non-empty string/);
    expect(() => editNode(db, bus, "n1", { synopsis: 7 as unknown as string })).toThrow(
      /must be a string/,
    );
    // But clearing a synopsis IS legitimate.
    expect(editNode(db, bus, "n1", { synopsis: "" })?.synopsis).toBe("");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed edit writes nothing and emits nothing (validation precedes the write)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const seen: BusEvent[] = [];
    bus.subscribe(bus.cursor(), (e) => seen.push(e));
    expect(() => editNode(db, bus, "n1", { title: "" })).toThrow();
    expect(seen).toEqual([]);
    expect(readState(db, { id: "default", title: "Default" }).nodes[0]?.title).toBe("Rich Ruth");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
