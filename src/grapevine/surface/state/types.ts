// The daemon's wire shapes as the watch surface consumes them. Mirrors the
// header comment of `src/grapevine/backend/daemon.ts` (⚠ the backend BUILDS as
// of backend convergence Phase 6 — it moved out of the deployed skill folder
// and ships as `dist/daemon.js` behind a launcher — and the surface still holds
// a COPY of the contract rather than an import: nothing under `surface/`
// imports the backend, which is exactly what let the whole backend move.)

export type MessageKind = "message" | "topic" | "announcement" | "status";

export type Message = {
  id: number;
  channel: string;
  from: string;
  text: string;
  ts: number;
  kind?: MessageKind;
  in_reply_to?: number | null;
  // A kind:"status" frame is one of two things. With `event` it is a
  // channel-level lifecycle fact (the daemon's archive/unarchive frame, added
  // 2026-09-06) and the feed renders it as a system note; without one it is
  // disposition metadata about another message and has no special rendering.
  event?: "archived" | "unarchived";
  // Disposition metadata about ANOTHER message (V1.9). Present on a status
  // frame minted by `mark`; never on a lifecycle frame. Read only to
  // DISQUALIFY a frame from the channel-note rendering — see isChannelNote.
  disposition?: string;
};

/** One row of the channel rail, derived from GET /channels (inventory C4–C8). */
export type ChannelRow = {
  name: string;
  subscribers: number;
  archived: boolean;
  isNew: boolean;
};

/** The wire shape of one entry in GET /channels — only the fields read. */
export type ChannelWire = {
  name: string;
  subscribers?: number;
  archived?: boolean;
};

export type Mode = "lurk" | "join";
