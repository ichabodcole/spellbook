// The ratified mini-seam shape (vine msgs 3–6): tier → node styling,
// provenance → edge styling, pending → staging overlay. No positions in the
// data — layout belongs to the surface.

export type Tier = "canon" | "thread" | "story-local" | "background";
export type NodeKind = "cast" | "place" | "concept" | "thread";
export type Provenance = "asserted" | "derived";

// Round 4 (K1) — doc kind honesty: the closed DocKind union died with the
// ingest defaults. `kind` is a free-form string when someone asserted one,
// null when nobody has (wire-normalized from the '' rest sentinel) — and
// null renders as ABSENCE, never an "unclassified" chip.

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
  kind: string | null;
  // K1: who asserted the kind — "user" | "agent" when kind is set, null on
  // legacy/untyped rows (honestly unattributed). ALWAYS carried on
  // /state.docs[]; the /doc/:id envelope does NOT carry it.
  kindAuthor: "user" | "agent" | null;
  // Absent when the doc has never been marked.
  mark?: DocMark & { stale: boolean };
};

// Content-on-demand half of seam v2: GET /doc/:id → {id, title, kind,
// content} — its OWN envelope, not DocMeta + content (no kindAuthor, no
// mark; K1 loosened kind to string | null here too).
export type Doc = {
  id: string;
  title: string;
  kind: string | null;
  content: string;
};

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

// Round 4 (A1) — an agent-authored conversational shortcut pinned to a node
// or a PENDING proposal (engine-owned metadata, actions.ts): a click SEEDS
// the composer with `seed` + the target as ground, never auto-sends.
export type ActionSlot = {
  id: string;
  label: string;
  seed: string;
};

export type MapNode = {
  id: string;
  title: string;
  kind: NodeKind;
  tier: Tier;
  synopsis: string;
  pending?: boolean;
  // Round 6 (PROC) — a CLIENT-ONLY overlay (like `pending`): true on the
  // synthetic node of a pending `author:"user"` proposal, so the canvas can
  // render it in a distinct "curating" state (the agent will refine the raw
  // human input). Derived off the wire's `author` (pendingOverlay.ts) — no
  // schema change; real nodes never carry it. Leaves when the proposal
  // ratifies (curated node appears) or is deleted.
  processing?: boolean;
  sources?: SourceRef[];
  // Round 4 (A1): absent = none (additive-optional on the wire).
  actions?: ActionSlot[];
  // Round 7 (TAGS): freeform agent-curated tags (the node_tags twin of
  // actions) — absent = none (the actions-attach shape, additive-optional).
  // Real nodes carry them off the wire; the surface's synthetic pending nodes
  // (pendingOverlay) copy them from the proposal so a pending card shows chips.
  tags?: string[];
  // Round 5 (SG1) — node-anchored submap containment. On real nodes the wire
  // ALWAYS carries both (state.ts): anchorNodeId null = top-level, a string =
  // this node lives inside that parent's submap; submapChildCount is
  // server-derived (GROUP-BY over the FULL nodes table, present on EVERY node
  // in EVERY response incl. scoped ones — the badge must not lie in a submap
  // view). Optional here because the synthetic pending nodes the surface mints
  // (pendingOverlay / zoneView) default them: a proposal stays top-level until
  // ratified (SG1), so consumers read `anchorNodeId ?? null` / `submapChildCount ?? 0`.
  anchorNodeId?: string | null;
  submapChildCount?: number;
};

// The lens — addressable view-state (vine msg 15). FocusOwner reuses
// glamour's vocabulary; the spike wires the human trigger only, but V1 gives
// the agent write access (your selection steers my context, my focus steers
// your attention).
export type FocusOwner = "user" | "agent" | null;

// Round 3 (Claim V2): one lens row, two modes — node XOR doc, enforced by
// construction server-side (the upsert writes every column; POST /lens
// validates the XOR). The wire ALWAYS carries docId (null on a node lens /
// clear); depth is a node-lens knob only (null on a doc lens) — consumers
// default it to 1 where a node-lens number is needed.
export type Lens = {
  owner: FocusOwner;
  nodeId: string | null;
  depth: number | null;
  docId: string | null;
};

// Conversation shapes follow glamour's Message idiom (who/kind/ground) so a
// reader of one surface can read the other; ground holds node ids. This is
// the SURFACE-internal display shape — MessageBubble/ConversationPanel
// render this, not the wire shape below. See toDisplayMessage (App.tsx).
export type Message = {
  id: string;
  who: "user" | "agent";
  kind: "info" | "result";
  // R11 SEAM 3 — the CHANNEL this message arrived through, carried verbatim
  // from the wire's `kind` (the lead's pre-ruling: the channel rides on kind).
  // Distinct from `kind` above, which is the display axis (an italic agent
  // aside vs a normal reply). Open vocabulary — state/messageChannel.ts owns
  // the literals and every fallback.
  channel: string;
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

// Round 3 (Claim Z1) — a named staging pen for proposals. Ids are SLUGS
// derived from the name (conversational referenceability); no rename.
export type Zone = {
  id: string;
  name: string;
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
  // Round 3 (Claim Z1, as ruled): ALWAYS carried — null means main queue.
  // The store is INCLUSIVE (zoned rows present, tagged): snapshot merge and
  // event upsert obey ONE rule, and every VIEW segregates at render
  // (main = zoneId == null; a zone view = its own id). Payload-tagging is
  // the mechanism because events are project-scoped, never zone-scoped.
  zoneId: string | null;
  // Round 4 (A1): actions attach to PENDING proposals too (Cole's
  // constraint) — absent = none. Ratify RE-HOMES them onto the minted node
  // (no actions.set is emitted for that move: the thin ratified event's
  // snapshot refetch is what carries the slots to their new home).
  actions?: ActionSlot[];
  // Round 7 (TAGS): tags attach to PENDING proposals too (the target-keyed
  // node_tags table, same lifecycle as actions) — absent = none. Carried from
  // CREATION (propose-time tags ride proposal.added) AND on a zone-move
  // re-emit (readProposalById), so the chip render must read them on first
  // paint from the snapshot, not assume they only arrive via tags.set. Ratify
  // RE-HOMES them onto the minted node (no tags.set is emitted for that move).
  tags?: string[];
  // Round 6 (EF, finding #8): the minted node id once this proposal has
  // ratified (R5 wire — `proposals.result_node_id`; an undocumented-but-
  // emitted surface per Contract 9's as-built note). Absent while pending.
  // The pending overlay re-points a still-pending edge's endpoint from a
  // ratified node-proposal's OLD id to this, so the edge follows its endpoint
  // to the real node instead of dangling and vanishing.
  resultNodeId?: string;
};

// R11 SEAM 5 — the `Job` wire type is GONE from the surface. Jobs survive as an
// ENGINE/agent primitive (the jobs table + /jobs routes + `job` CLI verb are
// untouched, and are the seed of multi-agent work distribution) — but the human
// never opens a jobs panel, so the surface mirrors none of that state. Reviving
// a surface view means re-adding this type from Contract 9 R9, not un-deleting a
// dead mirror. Same for `/ingest`: still a route + CLI verb, no longer a tray.

export type ProjectState = {
  project: ProjectMeta;
  docs: DocMeta[];
  nodes: MapNode[];
  edges: MapEdge[];
  // Round 3 (Claim Z1): the store's zones, in creation order.
  zones: Zone[];
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
  // R4 B1: release mode only, spread AT THE HANDLER like presence (the
  // engine's exported ProjectState under-reports the wire — grep server.ts,
  // not state.ts). Absent in dev mode / on a pre-stamp dist / from an old
  // daemon = render NO footer.
  buildInfo?: { commit: string; builtAt: string; stale: boolean };
};

// GET /search wire hit (search.ts; prospero's one-endpoint ruling, vine msg
// 36). Round 3 (Claim S1): kind:"proposal" = a PENDING proposal matched over
// its parsed draft; those hits carry zoneId (null = main queue) so the
// palette can switch to the zone view before focusing. `kind:"vector"` is
// reserved for V2 — treat unknown kinds as off-board, never a crash.
export type SearchHit = {
  kind: "node" | "doc" | "message" | "proposal";
  id: string;
  title: string;
  snippet?: string;
  score: number;
  zoneId?: string | null;
};

export type ServerEventKind =
  | "doc.added"
  | "doc.deleted"
  // Round 4 (K1) — {docId, kind, author}: kind wire-normalized (null, never
  // ''), author null only when kind is null (a clear un-attributes).
  | "doc.kind"
  | "doc.marked"
  | "node.ratified"
  | "edge.ratified"
  | "proposal.added"
  | "message.posted"
  | "lens.set"
  | "presence.changed"
  // Round 3 (Claims Z1/Z2) — zone.created {id, name}; zone.deleted {id}
  // (THIN: consumers drop that zone's proposals locally — a scoped drop,
  // never a wholesale replace); proposal.promoted {id} (THIN: the inclusive
  // store clears zoneId on the row).
  | "zone.created"
  | "zone.deleted"
  | "proposal.promoted"
  // Round 6 (DEL/REJECT) — three THIN retract/decline events (payload {id}).
  // node.deleted: the ratified node is gone — the reducer drops it AND (the
  // server force-cascade the thin payload can't carry) locally drops edges
  // touching it + re-homes its anchored children to top-level. proposal.deleted:
  // hard-remove the proposal row (the litter-clearing path). proposal.rejected:
  // decline-with-history — flip the row to "rejected" so it leaves the canvas /
  // queue WITHOUT a refetch (reject previously emitted nothing — finding #3).
  | "node.deleted"
  | "proposal.deleted"
  | "proposal.rejected"
  // Round 5 (SG1) — {nodeId, anchorNodeId}: a THIN event (like the ratified
  // pair). The reducer flips the node's anchorNodeId locally; submapChildCount
  // recovers via the ratified-events snapshot-refetch doctrine (a re-anchor
  // changes a parent's child count, which only a fresh /state carries).
  | "node.anchored"
  // Round 4 (A1) — {targetId, actions}: the FULL new array (wholesale
  // metadata replace — deliberately not a per-entity patch; the entity is
  // the node/proposal, the slots are metadata riding it).
  | "actions.set"
  // Round 7 (TAGS) — {targetId, tags}: the FULL new array (wholesale metadata
  // replace, the actions.set precedent — freeform tags ride a node/pending
  // proposal, not an entity of their own). Empty array clears to wire absence.
  | "tags.set"
  // Round 9 (Job Queue, SEAM B) — still on the bus (jobs are an agent
  // primitive), but R11 removed the surface's jobs view, so no reducer case
  // handles them: they fall to the default branch, which advances the cursor
  // (the ephemeral-event cursor clause) and changes nothing.
  | "job.added"
  | "job.updated"
  | "job.claimed"
  | "job.deleted"
  // Ephemeral kinds (Contract 9 amendment): fire-once signals, no state
  // row — but every emit consumed a seq, so they still route THROUGH
  // applyEvent (default case advances the cursor) and useProjectState
  // surfaces them separately via the {payload, seq} idiom.
  | "agent.activity"
  // Fire-once viewport nudge (payload {nodeId}) — NOT a lens change.
  | "look.here";

// Claim C's active-attention signal (POST /activity → agent.activity event).
// R4 ACT1 (supersedes Claim C's TTL clause): the server TTL is state-aware —
// received → stalled (daemon-synthesized ONLY, persists until an agent write
// or explicit set resolves it; POST /activity rejects it), thinking → idle
// unchanged. A daemon restart honestly clears to no-signal (in-memory).
export type AgentActivityState = "received" | "thinking" | "idle" | "stalled";

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
