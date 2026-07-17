// P2 — `send <text>` CLI verb backing: appends a messages row, emits
// message.posted. Agent identity is the `role` field, not a separate table
// (matches the spike's flat-provenance taste). Claim A: this stores, it
// doesn't interpret — replying is the casting agent's job via a later send.

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";
import type { Message } from "./state.ts";

interface SendInput {
  role: "user" | "agent";
  kind: string;
  text: string;
  ground?: string[];
}

function nextSeq(db: Database, projectId: string): number {
  const row = db
    .query("SELECT COALESCE(MAX(seq), 0) as maxSeq FROM messages WHERE project_id = ?")
    .get(projectId) as { maxSeq: number };
  return row.maxSeq + 1;
}

function sendMessage(db: Database, bus: EventBus, projectId: string, input: SendInput): Message {
  const id = crypto.randomUUID();
  const seq = nextSeq(db, projectId);
  const ground = input.ground ?? null;
  const ts = Math.floor(Date.now() / 1000);

  db.run(
    "INSERT INTO messages (id, project_id, seq, role, kind, text, ground_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      projectId,
      seq,
      input.role,
      input.kind,
      input.text,
      ground ? JSON.stringify(ground) : null,
      ts,
    ],
  );
  db.run(
    "INSERT INTO messages_fts (rowid, message_id, content) VALUES (last_insert_rowid(), ?, ?)",
    [id, input.text],
  );

  const message: Message = {
    id,
    seq,
    role: input.role,
    kind: input.kind,
    text: input.text,
    ground,
    ts,
  };
  bus.emit("message.posted", message as unknown as Record<string, unknown>);
  return message;
}

export type { SendInput };
export { sendMessage };
