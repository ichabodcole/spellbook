// P2 — send appends a messages row and returns the wire-shaped Message,
// matching the ratified schema: {id, seq, role, kind, text, ground, ts}.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { createEventBus, MESSAGE_CHANNELS } from "./events.ts";
import { channelWarning, sendMessage } from "./send.ts";
import { readState } from "./state.ts";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "mind-mapper-send-test-"));
  const db = openStore(join(dir, "store.sqlite"));
  return { dir, db };
}

test("sendMessage appends a message and emits message.posted", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const msg = sendMessage(db, bus, "default", {
      role: "user",
      kind: "turn",
      text: "hello",
      ground: ["maren"],
    });
    expect(msg).toMatchObject({ role: "user", kind: "turn", text: "hello", ground: ["maren"] });
    expect(typeof msg.id).toBe("string");
    expect(typeof msg.seq).toBe("number");

    const state = readState(db, { id: "default", title: "Default" });
    expect(state.conversation).toEqual([msg]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sendMessage defaults ground to null when omitted", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const msg = sendMessage(db, bus, "default", { role: "agent", kind: "turn", text: "hi back" });
    expect(msg.ground).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sendMessage assigns increasing per-project seq", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const m1 = sendMessage(db, bus, "default", { role: "user", kind: "turn", text: "one" });
    const m2 = sendMessage(db, bus, "default", { role: "agent", kind: "turn", text: "two" });
    expect(m2.seq).toBe(m1.seq + 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Round 11 · SEAM 1 — the channel rides `kind`: tolerant, but advisory ────

test("channelWarning is silent for every known channel and advises on an unknown one", () => {
  for (const channel of MESSAGE_CHANNELS) expect(channelWarning(channel)).toBeUndefined();
  const warning = channelWarning("cavnas");
  expect(warning).toContain("cavnas");
  // The advisory NAMES the vocabulary — a typo'd channel is discovered at the
  // moment of sending, not by a surface that silently renders it as a turn.
  for (const channel of MESSAGE_CHANNELS) expect(warning).toContain(channel);
});

test("an unknown channel still STORES verbatim — the daemon advises, it does not reject", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const msg = sendMessage(db, bus, "default", { role: "user", kind: "pin", text: "somewhere" });
    expect(msg.kind).toBe("pin");
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.conversation[0]?.kind).toBe("pin");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown ground prefix round-trips verbatim — the named canvas-position door", () => {
  // R11 ruling: canvas position is NOT carried (no consumer). If one appears it
  // rides `ground` as `canvas:<x>,<y>` under the tolerated-prefix grammar — zero
  // schema change. This pins that the door is genuinely open.
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const msg = sendMessage(db, bus, "default", {
      role: "user",
      kind: "canvas",
      text: "a ramble",
      ground: ["maren", "doc:ramble-01", "canvas:120,340"],
    });
    expect(msg.ground).toEqual(["maren", "doc:ramble-01", "canvas:120,340"]);
    const state = readState(db, { id: "default", title: "Default" });
    expect(state.conversation[0]?.ground).toEqual(["maren", "doc:ramble-01", "canvas:120,340"]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sendMessage emits a per-entity patch on the bus, not the whole conversation array", () => {
  const { dir, db } = tempDb();
  try {
    const bus = createEventBus();
    const received: unknown[] = [];
    bus.subscribe(0, (event) => received.push(event));
    const msg = sendMessage(db, bus, "default", { role: "user", kind: "turn", text: "hello" });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ kind: "message.posted", payload: msg });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
