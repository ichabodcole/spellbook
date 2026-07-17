// The ratified mini-seam shape (vine msgs 3–6): tier → node styling,
// provenance → edge styling, pending → staging overlay. No positions in the
// data — layout belongs to the surface.

export type Tier = "canon" | "thread" | "story-local" | "background";
export type NodeKind = "cast" | "place" | "concept" | "thread";
export type Provenance = "asserted" | "derived";

export type DocKind = "ramble" | "story" | "bible";

export type DocMeta = {
  id: string;
  title: string;
  kind: DocKind;
};

// Content-on-demand half of seam v2: GET /doc/:id returns meta + content.
export type Doc = DocMeta & { content: string };

// span is a VERBATIM excerpt (stub-grade anchoring — the viewer
// find-and-highlights it; offsets belong to the real source-log).
export type SourceRef = {
  docId: string;
  span?: string;
};

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
// docId (the sources table's doc_id column is NOT NULL); a proposal's
// evidence columns are nullable until the agent actually attaches one
// (propose.ts's evidenceDocId/evidenceSpan default to null).
export type ProposalEvidence = {
  docId: string | null;
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
};

export type ServerEventKind =
  | "doc.added"
  | "node.ratified"
  | "edge.ratified"
  | "proposal.added"
  | "message.posted"
  | "lens.set"
  // Fire-once viewport nudge (payload {nodeId}) — NOT a lens change; the
  // reducer ignores it and useProjectState surfaces it as lookHere.
  | "look.here";

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
