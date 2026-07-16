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
// reader of one surface can read the other; ground holds node ids.
export type Message = {
  id: number;
  who: "user" | "agent";
  kind: "info" | "result";
  text: string;
  ground: string[];
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
