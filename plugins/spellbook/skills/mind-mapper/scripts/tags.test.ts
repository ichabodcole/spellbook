// Round 7 (TAGS) — freeform per-target tags: the twin of node_actions. Tags
// ride nodes AND pending proposals; the lifecycle rides the target's owners
// (ratify re-homes onto the minted node, reject/edge-accept/zone-delete clean
// up, promote/zone-move are no-ops that KEEP the tags via the full re-emit).
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { proposeEdge, proposeNode } from "./propose.ts";
import { ratify } from "./ratify.ts";
import { readState } from "./state.ts";
import { clearTags, readTags, setTags, TAGS_BYTE_CAP } from "./tags.ts";
import { createZone, deleteZone, moveProposalToZone, promote } from "./zones.ts";

function tempProject() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-tags-test-"));
  const docsDir = join(dir, "docs");
  mkdirSync(docsDir);
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, docsDir, db };
}

test("setTags on a node: wholesale upsert, tags ride state.nodes[], event carries the full array", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('n1', 'cast', 'canon', 'Maren', '')",
    );
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe(0, (e) => received.push(e as unknown as Record<string, unknown>));

    const result = setTags(db, bus, "n1", ["theme", "wip"]);
    expect(result).toEqual({ targetId: "n1", tags: ["theme", "wip"] });
    expect(received).toEqual([
      {
        seq: 1,
        epoch: bus.epoch,
        kind: "tags.set",
        payload: { targetId: "n1", tags: ["theme", "wip"] },
      },
    ]);

    // Wholesale replace, not merge.
    setTags(db, bus, "n1", ["final"]);
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.nodes[0]?.tags).toEqual(["final"]);
    // A node without tags carries NO tags key (absent = none).
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('n2', 'cast', 'canon', 'Edda', '')",
    );
    const state2 = readState(db, { id: "default", title: "Default" });
    expect("tags" in (state2.nodes.find((n) => n.id === "n2") ?? {})).toBe(false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setTags targets a PENDING proposal; unknown / ratified / rejected targets are null (404)", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    writeFileSync(join(docsDir, "ramble-01.md"), "prose");
    db.run(
      "INSERT INTO docs (id, title, kind, path) VALUES ('ramble-01', 'R', '', 'docs/ramble-01.md')",
    );
    const pending = proposeNode(db, bus, { draft: { title: "P" }, evidence: {} });
    expect(setTags(db, bus, pending.id, ["idea"])?.tags).toEqual(["idea"]);
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.proposals.find((p) => p.id === pending.id)?.tags).toEqual(["idea"]);

    expect(setTags(db, bus, "no-such-target", ["x"])).toBeNull();

    const rejected = proposeNode(db, bus, { draft: { title: "R" }, evidence: {} });
    ratify(db, bus, docsDir, { proposalId: rejected.id, ruling: "reject" });
    expect(setTags(db, bus, rejected.id, ["x"])).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shape validation fails loud; byte cap hard-errors and lands nothing", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('n1', 'cast', 'canon', 'Maren', '')",
    );
    expect(() => setTags(db, bus, "n1", { not: "an array" })).toThrow(/array/);
    expect(() => setTags(db, bus, "n1", [42])).toThrow(/not a string/);

    setTags(db, bus, "n1", ["kept"]);
    const fat = ["x".repeat(TAGS_BYTE_CAP)];
    expect(() => setTags(db, bus, "n1", fat)).toThrow(/byte cap|byte-cap|-byte cap/);
    // The oversized write landed nothing — the previous tags survive.
    expect(readTags(db).get("n1")).toEqual(["kept"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty array and clearTags both delete the row and emit tags.set []", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('n1', 'cast', 'canon', 'Maren', '')",
    );
    setTags(db, bus, "n1", ["a"]);
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e as unknown as Record<string, unknown>));

    expect(setTags(db, bus, "n1", [])).toEqual({ targetId: "n1", tags: [] });
    expect(readTags(db).size).toBe(0);
    expect(received[0]).toMatchObject({ kind: "tags.set", payload: { targetId: "n1", tags: [] } });

    setTags(db, bus, "n1", ["a"]);
    expect(clearTags(db, bus, "n1")).toEqual({ targetId: "n1", tags: [] });
    expect(readTags(db).size).toBe(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("propose-time tags attach to the pending proposal and re-home on ratify", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    // Tags ride the propose call (buildProposal writes the row + attaches to
    // the emitted Proposal).
    const pending = proposeNode(db, bus, {
      draft: { title: "Edda" },
      evidence: {},
      tags: ["character", "canon-candidate"],
    });
    expect(pending.tags).toEqual(["character", "canon-candidate"]);
    expect(readState(db, { id: "default", title: "Default" }).proposals[0]?.tags).toEqual([
      "character",
      "canon-candidate",
    ]);

    // Ratify re-homes onto the fresh node id.
    const result = ratify(db, bus, docsDir, { proposalId: pending.id, ruling: "thread" });
    const tags = readTags(db);
    expect(tags.get(pending.id)).toBeUndefined();
    expect(tags.get(result.nodeId as string)).toEqual(["character", "canon-candidate"]);
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.nodes.find((n) => n.id === result.nodeId)?.tags).toEqual([
      "character",
      "canon-candidate",
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lifecycle: reject deletes tags; an accepted EDGE proposal's tags die; zone delete cascades", () => {
  const { dir, docsDir, db } = tempProject();
  try {
    const bus = createEventBus();
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('a', 'cast', 'canon', 'A', '')",
    );
    db.run(
      "INSERT INTO nodes (id, kind, tier, title, synopsis) VALUES ('b', 'cast', 'canon', 'B', '')",
    );

    // Reject deletes.
    const rejectable = proposeNode(db, bus, { draft: { title: "R" }, evidence: {}, tags: ["x"] });
    ratify(db, bus, docsDir, { proposalId: rejectable.id, ruling: "reject" });
    expect(readTags(db).get(rejectable.id)).toBeUndefined();

    // Edge accept: no node to re-home onto → tags die.
    const edge = proposeEdge(db, bus, {
      draft: { source: "a", target: "b", label: "knows" },
      evidence: {},
    });
    setTags(db, bus, edge.id, ["rel"]);
    ratify(db, bus, docsDir, { proposalId: edge.id, ruling: "canon" });
    expect(readTags(db).get(edge.id)).toBeUndefined();

    // Zone delete cascades the zone's proposals' tags.
    createZone(db, bus, "Pen");
    const zoned = proposeNode(db, bus, { draft: { title: "Z" }, evidence: {}, zone: "pen" });
    setTags(db, bus, zoned.id, ["messy"]);
    deleteZone(db, bus, "pen", true);
    expect(readTags(db).get(zoned.id)).toBeUndefined();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zone-move re-emit keeps tags (the readProposalById clobber catch)", () => {
  const { dir, db } = tempProject();
  try {
    const bus = createEventBus();
    createZone(db, bus, "Sandbox");
    const p = proposeNode(db, bus, { draft: { title: "Wisp" }, evidence: {}, tags: ["keepme"] });

    // Watch the re-emit from the current cursor (the ORIGINAL proposal.added,
    // pre-move, replays from the buffer at 0 and would mask the re-emit — the
    // event-replay-bleed scar).
    const received: Array<Record<string, unknown>> = [];
    bus.subscribe(bus.cursor(), (e) => received.push(e as unknown as Record<string, unknown>));

    // Move INTO the zone → re-emits the FULL proposal via readProposalById.
    const moved = moveProposalToZone(db, bus, p.id, "sandbox");
    expect(moved).toEqual({ id: p.id, zoneId: "sandbox" });

    const reemit = received.find((e) => e.kind === "proposal.added");
    expect(reemit).toBeDefined();
    // The re-emit carries BOTH the new zoneId AND the tags — a partial payload
    // would have dropped tags on an inclusive consumer (the clobber this catches).
    expect((reemit?.payload as { zoneId?: string; tags?: string[] }).zoneId).toBe("sandbox");
    expect((reemit?.payload as { zoneId?: string; tags?: string[] }).tags).toEqual(["keepme"]);

    // And the tags survive a to-main promote (row keys by proposal id).
    promote(db, bus, p.id);
    expect(readTags(db).get(p.id)).toEqual(["keepme"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
