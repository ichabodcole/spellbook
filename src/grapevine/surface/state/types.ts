// The daemon's wire shapes as the watch surface consumes them. Mirrors the
// header comment of plugins/spellbook/skills/grapevine/scripts/daemon.ts (the
// backend ships as source and shares nothing, so this is a copy of the
// contract, not an import across the artifact boundary — Contract 3 does not
// fire and no `shared/` folder exists for grapevine).

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
