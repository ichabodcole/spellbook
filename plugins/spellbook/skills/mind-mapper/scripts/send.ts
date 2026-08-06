// P2 — `send <text>` CLI verb backing: appends a messages row, emits
// message.posted. Agent identity is the `role` field, not a separate table
// (matches the spike's flat-provenance taste). Claim A: this stores, it
// doesn't interpret — replying is the casting agent's job via a later send.

import type { Database } from "bun:sqlite";
import { type EventBus, MESSAGE_CHANNELS } from "./events.ts";
import type { Message } from "./state.ts";

interface SendInput {
  role: "user" | "agent";
  kind: string;
  text: string;
  ground?: string[];
}

// Round 11 (SEAM 1): a message's `kind` is its CHANNEL — the affordance it
// arrived through. The vocabulary is known but NOT closed: an unknown channel
// stores verbatim and draws an ADVISORY instead of a 400 (propose.ts's
// edgeDraftWarning precedent — a consumer reads specific values, so intake says
// so in the same turn; "tolerant" bounds what we reject, not what we say). This
// is what turns a typo'd channel from "silently rendered as a plain turn" into
// an immediate, self-documenting signal at the moment of sending.
function channelWarning(kind: string): string | undefined {
  if ((MESSAGE_CHANNELS as readonly string[]).includes(kind)) return undefined;
  return `kind "${kind}" is not a known message channel (${MESSAGE_CHANNELS.join(", ")}) — it was stored verbatim, but the surface renders unknown channels generically. Channels are open by design; add it to MESSAGE_CHANNELS if it's real.`;
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
export { channelWarning, sendMessage };
