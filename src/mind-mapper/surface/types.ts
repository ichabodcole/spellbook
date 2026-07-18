// The ratified mini-seam shape (vine msgs 3–6): tier → node styling,
// provenance → edge styling, pending → staging overlay. No positions in the
// data — layout belongs to the surface.

export type Tier = "canon" | "thread" | "story-local" | "background";
export type NodeKind = "cast" | "place" | "concept" | "thread";
export type Provenance = "asserted" | "derived";

export type DocKind = "ramble" | "story" | "bible";

// Claim B: the latest mark on a doc (append-only trail server-side; the wire
// carries only the live one). `stale` is computed server-side at /state read
// time (doc file mtime > marked mtime; missing file → stale) and NEVER rides
// the doc.marked event — the reducer supplies `stale: false` for a
// just-made mark (it was minted against the current file by construction).
export type DocMark = {
  author: string;
  note: string | null;
  status: string;
  ts: number;
};

export type DocMeta = {
  id: string;
  title: string;
  kind: DocKind;
  // Absent when the doc has never been marked.
  mark?: DocMark & { stale: boolean };
};

// Content-on-demand half of seam v2: GET /doc/:id returns meta + content.
export type Doc = DocMeta & { content: string };

// span is a VERBATIM excerpt (stub-grade anchoring — the viewer
// find-and-highlights it; offsets belong to the real source-log).
//
// Claim E: a source grounds in EITHER a doc or a conversation message, never
// both (mutual exclusion enforced at propose intake) — a proper either-shape
// union, not an all-optional bag. Doc entries stay byte-identical to the
// pre-union shape, so every existing consumer is untouched; message entries
// are the new branch (state.ts merges the message_sources sibling table).
export type DocSourceRef = {
  docId: string;
  span?: string | null;
};

export type MessageSourceRef = {
  messageId: string;
  span?: string | null;
};

export type SourceRef = DocSourceRef | MessageSourceRef;

export function isDocSource(s: SourceRef): s is DocSourceRef {
  return "docId" in s;
}

export type MapNode = {
  id: string;
  title: string;
  kind: NodeKind;
  tier: Tier;
  synopsis: string;
  pending?: boolean;
  sources?: SourceRef[];
};

// The lens — addressable view-state (vine msg 15). FocusOwner reuses
// glamour's vocabulary; the spike wires the human trigger only, but V1 gives
// the agent write access (your selection steers my context, my focus steers
// your attention).
export type FocusOwner = "user" | "agent" | null;

export type Lens = {
  owner: FocusOwner;
  nodeId: string | null;
  depth: number;
};

// Conversation shapes follow glamour's Message idiom (who/kind/ground) so a
// reader of one surface can read the other; ground holds node ids. This is
// the SURFACE-internal display shape — MessageBubble/ConversationPanel
// render this, not the wire shape below. See toDisplayMessage (App.tsx).
export type Message = {
  id: string;
  who: "user" | "agent";
  kind: "info" | "result";
  text: string;
  ground: string[];
};

// The real wire shape (server.ts POST /send + state.ts readState, vine msg
// 25) — `role`/`kind` free-form (kind defaults to "turn" server-side, not
// constrained to "info"|"result"), `ground` nullable. Distinct from the
// display Message above; App.tsx's toDisplayMessage adapts one to the other
// rather than forcing MessageBubble to know about the wire's looser shape.
export type WireMessage = {
  id: string;
  seq: number;
  role: "user" | "agent";
  kind: string;
  text: string;
  ground: string[] | null;
  ts: number;
};

export type MapEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  provenance: Provenance;
  pending?: boolean;
  // Seam v3 (vine msg 37): absent = directed claim; "both" = one mutual
  // claim, rendered as a single line with no arrowheads (the hand-drawn
  // Hollowbrook Mermaid map's ---|old friends| vocabulary). A reverse PAIR
  // (A→B and B→A, different labels) is deliberately NOT a schema case —
  // each perspective is its own claim.
  direction?: "both";
};

export type StubMap = {
  docs: DocMeta[];
  nodes: MapNode[];
  edges: MapEdge[];
};

// V1 wire (seams vine msgs 3–6, daedalus's ratify at msg 6): GET /state
// returns this full snapshot; WS /events emits per-entity ServerEvents that
// the reducer applies onto it. `cursor` is the last-applied event seq — a
// gap (event.seq !== cursor + 1) means refetch /state wholesale, never patch
// around the hole.
export type ProjectMeta = {
  id: string;
  title: string;
};

export type ProposalKind = "node" | "edge";
export type ProposalStatus = "pending" | "ratified" | "rejected";
export type Ruling = "canon" | "thread" | "story-local" | "reject";

// Distinct from SourceRef: a ratified node's sources always carry a real
// ground (doc or message); a proposal's evidence columns are nullable until
// the agent actually attaches one (propose.ts defaults all three to null).
// Claim E: docId and messageId are mutually exclusive at intake — at most
// one is ever non-null on the wire.
export type ProposalEvidence = {
  docId: string | null;
  messageId: string | null;
  span: string | null;
};

// draft is the agent-authored candidate object (a MapNode- or MapEdge-shaped
// partial, per `kind`) — the review queue renders it verbatim, never a
// compose-in-UI form (the ratified review-queue contract).
export type Proposal = {
  id: string;
  kind: ProposalKind;
  draft: Record<string, unknown>;
  evidence: ProposalEvidence;
  suggestedTier: Tier;
  status: ProposalStatus;
  // Claim D: who sketched it. The wire ALWAYS carries "user"|"agent" — the
  // nullable column normalizes to "agent" in readState, never reaches here.
  author: "user" | "agent";
};

export type ProjectState = {
  project: ProjectMeta;
  docs: DocMeta[];
  nodes: MapNode[];
  edges: MapEdge[];
  proposals: Proposal[];
  conversation: WireMessage[];
  // null until a lens has ever been set for this project (no row yet) —
  // daedalus's readState (state.ts) returns null, not a default object; the
  // surface supplies the spike's zoomed-out default when it sees null.
  lens: Lens | null;
  cursor: number;
  // Claim C: agents-only standing presence (agent = open SSE tail; the
  // browser WS is the human side and deliberately never counts).
  presence: { agents: number };
};

export type ServerEventKind =
  | "doc.added"
  | "doc.deleted"
  | "doc.marked"
  | "node.ratified"
  | "edge.ratified"
  | "proposal.added"
  | "message.posted"
  | "lens.set"
  | "presence.changed"
  // Ephemeral kinds (Contract 9 amendment): fire-once signals, no state
  // row — but every emit consumed a seq, so they still route THROUGH
  // applyEvent (default case advances the cursor) and useProjectState
  // surfaces them separately via the {payload, seq} idiom.
  | "agent.activity"
  // Fire-once viewport nudge (payload {nodeId}) — NOT a lens change.
  | "look.here";

// Claim C's active-attention signal (POST /activity → agent.activity event);
// non-idle arms a server-side ~60s TTL that emits a synthetic "idle".
export type AgentActivityState = "received" | "thinking" | "idle";

export type ServerEvent = {
  seq: number;
  // Random per daemon boot (events.ts) — the browser doesn't need it: every
  // reconnect refetches /state fresh, which always carries the current
  // epoch's cursor, so a stale watermark across a restart never happens here
  // the way it can for the agent's long-lived CLI tail. Carried for type
  // honesty with the real wire, not consumed.
  epoch?: string;
  kind: ServerEventKind;
  payload: unknown;
};
