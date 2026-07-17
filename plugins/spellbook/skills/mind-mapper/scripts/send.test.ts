// P2 — send appends a messages row and returns the wire-shaped Message,
// matching the ratified schema: {id, seq, role, kind, text, ground, ts}.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./db.ts";
import { createEventBus } from "./events.ts";
import { sendMessage } from "./send.ts";
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
