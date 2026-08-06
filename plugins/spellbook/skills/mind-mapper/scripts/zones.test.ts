// Round 3 (Claim Z1) — zones: slug-id staging pens for proposals. Create/
// list/delete + the delete cascade (a zone's proposals go with it — the
// disposable-sandbox property) + the not-empty confirm guard + thin events.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { type BusEvent, createEventBus } from "./events.ts";
import { proposeEdge, proposeNode } from "./propose.ts";
import { ratify, ZonedError } from "./ratify.ts";
import { readState } from "./state.ts";
import {
  createZone,
  deleteZone,
  listZones,
  moveProposalToZone,
  promote,
  UnknownZoneError,
  ZoneNotEmptyError,
} from "./zones.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-zones-test-"));
  const docsDir = join(dir, "docs");
  mkdirSync(docsDir);
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, docsDir, db };
}

test("createZone derives a slug id from the name, emits thin zone.created", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const received: BusEvent[] = [];
    bus.subscribe(0, (e) => received.push(e));
    const zone = createZone(db, bus, "Messy Ideas!");
    expect(zone).toEqual({ id: "messy-ideas", name: "Messy Ideas!" });
    expect(received).toEqual([
      {
        seq: 1,
        epoch: bus.epoch,
        kind: "zone.created",
        payload: { id: "messy-ideas", name: "Messy Ideas!" },
      },
    ]);
    expect(listZones(db)).toEqual([{ id: "messy-ideas", name: "Messy Ideas!" }]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createZone rejects a duplicate slug and a name that yields no slug", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Messy");
    expect(() => createZone(db, bus, "messy")).toThrow(/already exists/);
    expect(() => createZone(db, bus, "!!!")).toThrow(/valid slug/);
    expect(() => createZone(db, bus, "  ")).toThrow(/requires a name/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("propose --zone tags the proposal; unknown zone is an intake error", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Messy");
    const received: BusEvent[] = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e));
    const proposal = proposeNode(db, bus, {
      draft: { title: "Wisp" },
      evidence: {},
      zone: "messy",
    });
    expect(proposal.zoneId).toBe("messy");
    // proposal.added carries the tag — payload-tagging is the mechanism
    // (events can never be zone-scoped; consumers filter by zoneId).
    expect(received[0]?.kind).toBe("proposal.added");
    expect((received[0]?.payload as { zoneId: string }).zoneId).toBe("messy");

    expect(() =>
      proposeNode(db, bus, { draft: { title: "X" }, evidence: {}, zone: "nope" }),
    ).toThrow(/unknown zone/);
    expect(() =>
      proposeNode(db, bus, { draft: { title: "X" }, evidence: {}, zone: "Not A Slug" }),
    ).toThrow(/valid zone slug/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteZone without yes throws ZoneNotEmptyError carrying the count; empty zone deletes clean", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Messy");
    createZone(db, bus, "Empty");
    proposeNode(db, bus, { draft: { title: "A" }, evidence: {}, zone: "messy" });
    proposeNode(db, bus, { draft: { title: "B" }, evidence: {}, zone: "messy" });

    expect(() => deleteZone(db, bus, "messy", false)).toThrow(ZoneNotEmptyError);
    try {
      deleteZone(db, bus, "messy", false);
    } catch (e) {
      expect((e as ZoneNotEmptyError).proposals).toBe(2);
    }

    expect(deleteZone(db, bus, "empty", false)).toEqual({ id: "empty" });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteZone --yes cascades the zone's proposals, leaves main-queue rows, emits thin zone.deleted", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Messy");
    proposeNode(db, bus, { draft: { title: "Zoned" }, evidence: {}, zone: "messy" });
    const main = proposeNode(db, bus, { draft: { title: "Main" }, evidence: {} });

    const received: BusEvent[] = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e));
    expect(deleteZone(db, bus, "messy", true)).toEqual({ id: "messy" });
    expect(received).toEqual([
      {
        seq: received[0]?.seq ?? 0,
        epoch: bus.epoch,
        kind: "zone.deleted",
        payload: { id: "messy" },
      },
    ]);

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.zones).toEqual([]);
    expect(state.proposals.map((p) => p.id)).toEqual([main.id]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("promote moves (not duplicates): clears zoneId, keeps draft/evidence, emits thin proposal.promoted", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Messy");
    db.run("INSERT INTO docs (id, title, kind, path) VALUES (?, ?, ?, ?)", [
      "ramble-01",
      "Ramble",
      "ramble",
      "docs/ramble-01.md",
    ]);
    const proposal = proposeNode(db, bus, {
      draft: { title: "Wisp", synopsis: "a flicker" },
      evidence: { docId: "ramble-01", span: "a flicker at dusk" },
      zone: "messy",
    });

    const received: BusEvent[] = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e));
    expect(promote(db, bus, proposal.id)).toEqual({ id: proposal.id });
    expect(received.map((e) => ({ kind: e.kind, payload: e.payload }))).toEqual([
      { kind: "proposal.promoted", payload: { id: proposal.id } },
    ]);

    const state = readState(db, { id: "default", title: "Default" });
    const promoted = state.proposals.find((p) => p.id === proposal.id);
    // A move: same row, zoneId cleared, everything else untouched.
    expect(promoted).toMatchObject({
      id: proposal.id,
      zoneId: null,
      status: "pending",
      draft: { title: "Wisp", synopsis: "a flicker" },
      evidence: { docId: "ramble-01", messageId: null, span: "a flicker at dusk" },
    });
    // The zone keeps no tombstone: one proposal total, now unzoned.
    expect(state.proposals).toHaveLength(1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("promote guards: unknown, non-pending, and not-zoned proposals all error clearly", () => {
  const { dir, docsDir, db } = tempDb();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Messy");
    expect(() => promote(db, bus, "nope")).toThrow(/unknown proposal/);

    const main = proposeNode(db, bus, { draft: { title: "Main" }, evidence: {} });
    expect(() => promote(db, bus, main.id)).toThrow(/not in a zone/);

    const zoned = proposeNode(db, bus, { draft: { title: "Z" }, evidence: {}, zone: "messy" });
    promote(db, bus, zoned.id);
    ratify(db, bus, docsDir, { proposalId: zoned.id, ruling: "reject" });
    expect(() => promote(db, bus, zoned.id)).toThrow(/already rejected/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edge promotion mirrors ratify's endpoint order: the error names the unpromoted endpoint", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Messy");
    const nodeA = proposeNode(db, bus, { draft: { title: "A" }, evidence: {}, zone: "messy" });
    const nodeB = proposeNode(db, bus, { draft: { title: "B" }, evidence: {}, zone: "messy" });
    const edge = proposeEdge(db, bus, {
      draft: { source: nodeA.id, target: nodeB.id, label: "links" },
      evidence: {},
      zone: "messy",
    });

    // Both endpoints still zoned — the error names one of them explicitly.
    expect(() => promote(db, bus, edge.id)).toThrow(new RegExp(`${nodeA.id}.*promote it first`));
    promote(db, bus, nodeA.id);
    expect(() => promote(db, bus, edge.id)).toThrow(new RegExp(`${nodeB.id}.*promote it first`));
    promote(db, bus, nodeB.id);
    expect(promote(db, bus, edge.id)).toEqual({ id: edge.id });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ratify refuses a still-zoned proposal: promote first (zone delete is the only in-zone disposal)", () => {
  const { dir, docsDir, db } = tempDb();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Messy");
    const zoned = proposeNode(db, bus, { draft: { title: "Z" }, evidence: {}, zone: "messy" });
    // Both accept AND reject are refused in-zone — ratification (either way)
    // is a main-queue act. R1: the refusal is TYPED (ZonedError carrying the
    // zoneId) so the wire can 409 {error:"zoned", zoneId} for menus.
    let thrown: unknown;
    try {
      ratify(db, bus, docsDir, { proposalId: zoned.id, ruling: "canon" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ZonedError);
    expect((thrown as ZonedError).zoneId).toBe("messy");
    expect((thrown as ZonedError).message).toMatch(/in zone messy — promote first/);
    expect(() => ratify(db, bus, docsDir, { proposalId: zoned.id, ruling: "reject" })).toThrow(
      ZonedError,
    );

    promote(db, bus, zoned.id);
    const result = ratify(db, bus, docsDir, { proposalId: zoned.id, ruling: "thread" });
    expect(result.status).toBe("ratified");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteZone returns null for unknown or non-slug ids (server 404s first)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    expect(deleteZone(db, bus, "nope", true)).toBeNull();
    expect(deleteZone(db, bus, "../evil", true)).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Round 5 (IC-c) — moveProposalToZone: the zone IN-door (inverse of promote).
test("moveProposalToZone moves a pending main proposal INTO a zone and re-emits the full proposal", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Messy Ideas");
    const proposal = proposeNode(db, bus, { draft: { title: "Wisp" }, evidence: {} });
    expect(proposal.zoneId).toBeNull(); // starts in main

    // Subscribe at the CURRENT cursor so the original proposal.added (zoneId
    // null, from proposeNode) doesn't replay and mask the re-emit.
    const received: BusEvent[] = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e));
    const result = moveProposalToZone(db, bus, proposal.id, "messy-ideas");
    expect(result).toEqual({ id: proposal.id, zoneId: "messy-ideas" });

    // The row is now tagged; a full proposal.added re-emit carries the zoneId.
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals.find((p) => p.id === proposal.id)?.zoneId).toBe("messy-ideas");
    const emit = received.find((e) => e.kind === "proposal.added");
    expect((emit?.payload as { zoneId: string }).zoneId).toBe("messy-ideas");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("moveProposalToZone with null delegates to promote (moves to main, thin proposal.promoted)", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Messy Ideas");
    const proposal = proposeNode(db, bus, {
      draft: { title: "Wisp" },
      evidence: {},
      zone: "messy-ideas",
    });
    expect(proposal.zoneId).toBe("messy-ideas");

    const received: BusEvent[] = [];
    bus.subscribe(0, (e) => received.push(e));
    const result = moveProposalToZone(db, bus, proposal.id, null);
    expect(result).toEqual({ id: proposal.id, zoneId: null });
    expect(readState(db, { id: "default", title: "Default" }).proposals[0]?.zoneId).toBeNull();
    expect(received.map((e) => e.kind)).toContain("proposal.promoted");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("moveProposalToZone: unknown proposal → null, unknown zone → UnknownZoneError, non-pending → error", () => {
  const { dir, docsDir, db } = tempDb();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Messy Ideas");

    expect(moveProposalToZone(db, bus, "no-such-proposal", "messy-ideas")).toBeNull();

    const proposal = proposeNode(db, bus, { draft: { title: "Wisp" }, evidence: {} });
    expect(() => moveProposalToZone(db, bus, proposal.id, "ghost-zone")).toThrow(UnknownZoneError);

    // Ratify it, then a move must refuse a non-pending proposal.
    ratify(db, bus, docsDir, { proposalId: proposal.id, ruling: "canon" });
    expect(() => moveProposalToZone(db, bus, proposal.id, "messy-ideas")).toThrow(
      /already ratified/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
