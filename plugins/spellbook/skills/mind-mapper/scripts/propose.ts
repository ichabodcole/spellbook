// P2 — `propose-node`/`propose-edge` CLI verb backing. Inserts a pending
// proposals row, emits proposal.added. The draft is opaque JSON to the
// daemon — it doesn't validate the agent's extraction, only stores it
// (dumb daemon, Claim A).

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";
import { SLUG_RE } from "./project.ts";
import type { Proposal } from "./state.ts";
import { parseTags } from "./tags.ts";

interface ProposeInput {
  draft: unknown;
  // Claim E: evidence grounds in EITHER a doc or a conversation message,
  // never both — mutual exclusion enforced at intake.
  evidence: { docId?: string; messageId?: string; span?: string };
  suggestedTier?: string;
  // Claim D: who sketched this proposal. Omitted → "agent" (the historical
  // default — every pre-author row was an agent proposal).
  author?: "user" | "agent";
  // Round 3 (Claim Z1): stage this proposal in a zone. Omitted → main queue
  // (zone_id null). Must name an existing zone — a dangling zone_id would
  // orphan the proposal out of every view.
  zone?: string;
  // Round 7 (TAGS): freeform tags to attach at propose time — written to the
  // target-keyed node_tags row keyed by this proposal's id (so they carry
  // pre-ratify and re-home on ratify). Omitted → no tags.
  tags?: string[];
  // Round 12 (SEAM 1): the staging ACT this proposal belongs to. `/proposals/
  // batch` MINTS one per call; a single propose takes one only when the caller
  // supplies it (joining a batch it is repairing). Omitted → null = unbatched,
  // which is the honest answer for a lone proposal.
  batchId?: string;
}

// ── Round 12 · SEAM 2 — edge endpoints by TITLE ─────────────────────────────
//
// F5.2: an edge to an ALREADY-RATIFIED node needs its uuid, so the agent
// fetched /state, built a title→id map, and generated the batch through a
// bespoke script — four times in one drive, and the second time is where the
// edges got dropped. A `title:<exact title>` endpoint deletes that whole
// category of scripting.
//
// The prefix can NEVER collide with a real endpoint: node ids and proposal ids
// are UUIDs, which contain no ":" — and the prefixed-ref grammar is already the
// house idiom (message.ground's `doc:<id>`).
//
// Resolution happens at INTAKE (here, in the shared build step, so the single
// `/proposals` edge path and `/proposals/batch` get it from ONE site) and the
// RESOLVED id is what gets stored. Two reasons: (a) the error lands in the same
// turn as the mistake instead of at the human's ruling act — the edgeDraftWarning
// lesson, which named "three verbs from the mistake" as the worst outcome; and
// (b) the stored draft then holds a real id, so a later retitle can't silently
// re-point a pending edge. Ratify keeps exactly ONE resolution vocabulary
// (ids/proposal ids) — a second `title:` site there would be two vocabularies
// free to drift.
const TITLE_REF_PREFIX = "title:";

function isTitleRef(ref: unknown): ref is string {
  return typeof ref === "string" && ref.startsWith(TITLE_REF_PREFIX);
}

// EXACT, case-sensitive, RATIFIED NODES ONLY. Ambiguity is an error that NAMES
// the candidates (the "ratify node proposal <id> first" model — the best error
// in the system per drive #10), never a silent first-match. Fuzzy lookup is
// `search`'s job and always was; this is a reference syntax, not a search.
function resolveTitleRef(db: Database, ref: string): string {
  const title = ref.slice(TITLE_REF_PREFIX.length);
  if (title === "") {
    throw new Error(
      'empty title reference — expected "title:<exact node title>" (exact, case-sensitive, ratified nodes only)',
    );
  }
  const rows = db.query("SELECT id FROM nodes WHERE title = ?").all(title) as Array<{ id: string }>;
  if (rows.length === 0) {
    throw new Error(
      `no ratified node is titled "${title}" — title refs match EXACTLY (case-sensitive) and resolve against ratified nodes ONLY, never pending proposals (name those by local ref or proposal id); use \`search\` to find the node, or pass its id`,
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `title "${title}" matches ${rows.length} nodes: ${rows.map((r) => r.id).join(", ")} — titles are not unique; pass one of those ids instead`,
    );
  }
  return (rows[0] as { id: string }).id;
}

// Rewrite an edge draft's source/target when (and only when) they are title
// refs. Returns the draft UNTOUCHED otherwise, so a draft with no title ref is
// stored byte-identically to pre-R12 (opacity is unchanged for every key the
// daemon doesn't already read — ratify has always read source/target, which is
// exactly what edgeDraftWarning advises about).
function resolveEdgeTitleRefs(db: Database, draft: unknown): unknown {
  if (draft === null || typeof draft !== "object") return draft;
  const d = draft as Record<string, unknown>;
  if (!isTitleRef(d.source) && !isTitleRef(d.target)) return draft;
  return {
    ...d,
    ...(isTitleRef(d.source) ? { source: resolveTitleRef(db, d.source) } : {}),
    ...(isTitleRef(d.target) ? { target: resolveTitleRef(db, d.target) } : {}),
  };
}

// Round 5 (CLI1): validate + compute the row and the wire object, but do NOT
// insert or emit — the single-propose path inserts+emits immediately, the
// batch path defers both (all inserts inside ONE db.transaction(), all emits
// AFTER commit so a rollback leaks no proposal.added). Splitting here is what
// lets both paths share one intake contract without the batch smuggling a
// mid-transaction emit.
function buildProposal(
  db: Database,
  kind: "node" | "edge",
  input: ProposeInput,
): { proposal: Proposal; insert: () => void } {
  const id = crypto.randomUUID();
  // The draft stays OPAQUE (Claim A) but not ABSENT — a missing draft used
  // to surface as a raw "NOT NULL constraint failed: proposals.draft_json";
  // name the expected shape at intake instead.
  if (input.draft === undefined || input.draft === null) {
    throw new Error(
      'propose requires a draft — expected {"draft": {title, synopsis, ...}, "evidence": {docId|messageId, span}, "suggestedTier"?}',
    );
  }
  // SEAM 2: resolve `title:<...>` endpoints NOW (pure read + throw, before any
  // write) so the stored draft carries real ids and the caller sees them in the
  // response it already reads.
  const draft = kind === "edge" ? resolveEdgeTitleRefs(db, input.draft) : input.draft;
  const draftJson = JSON.stringify(draft);
  // The draft stays opaque (Claim A), but evidence.docId becomes a filesystem
  // path component at ratify time — reject non-slug ids at intake so a bad
  // one fails loud here, not as a file write later. SLUG_RE guards docId
  // ONLY: a messageId is a UUID that never touches the filesystem.
  if (input.evidence.docId !== undefined && input.evidence.messageId !== undefined) {
    throw new Error("evidence must ground in a doc OR a message, not both");
  }
  if (input.evidence.docId !== undefined && !SLUG_RE.test(input.evidence.docId)) {
    throw new Error(`evidence.docId is not a valid doc slug: ${input.evidence.docId}`);
  }
  // A dangling message reference would make the proposal un-navigable the
  // moment it renders — fail loud at intake, not at surface click time.
  if (input.evidence.messageId !== undefined) {
    const exists = db
      .query("SELECT 1 FROM messages WHERE id = ?")
      .get(input.evidence.messageId) as unknown;
    if (exists === null) {
      throw new Error(`evidence.messageId does not exist: ${input.evidence.messageId}`);
    }
  }
  if (input.author !== undefined && input.author !== "user" && input.author !== "agent") {
    throw new Error(`author must be user or agent, got: ${String(input.author)}`);
  }
  // Zone intake guard (Round 3): same fail-loud-at-intake spirit as docId —
  // an unknown zone is a usage error here, never a dangling row later.
  if (input.zone !== undefined) {
    if (!SLUG_RE.test(input.zone)) {
      throw new Error(`zone is not a valid zone slug: ${input.zone}`);
    }
    if (!db.query("SELECT 1 FROM zones WHERE id = ?").get(input.zone)) {
      throw new Error(`unknown zone: ${input.zone}`);
    }
  }
  // TAGS: validate here (pure — the parse guard throws before any write), so a
  // bad shape fails intake, not mid-transaction. Empty/absent → no row.
  const tags = input.tags !== undefined ? parseTags(input.tags) : [];
  const tagsJson = tags.length > 0 ? JSON.stringify(tags) : null;

  const evidenceDocId = input.evidence.docId ?? null;
  const evidenceMessageId = input.evidence.messageId ?? null;
  const evidenceSpan = input.evidence.span ?? null;
  const suggestedTier = input.suggestedTier ?? null;
  // Written explicitly on every NEW row — the column stays nullable only so
  // the fresh-install shape equals the migrated shape (Claim D); the wire
  // never carries null (readState normalizes pre-column rows).
  const author = input.author ?? "agent";
  const zoneId = input.zone ?? null;
  // SEAM 1: the daemon does NOT mint one here — minting is the BATCH route's
  // act (a batch is a call, and only the call knows its own extent). A single
  // propose is unbatched unless the caller names the act it belongs to.
  if (input.batchId !== undefined && (typeof input.batchId !== "string" || input.batchId === "")) {
    throw new Error(
      `batchId must be a non-empty string (the id returned by \`propose-batch\`), got: ${JSON.stringify(input.batchId)}`,
    );
  }
  const batchId = input.batchId ?? null;

  // propose emits the FULL proposal object, so proposal.added carries zoneId
  // for free — payload-tagging is the mechanism (events are project-scoped
  // and can never be zone-scoped; consumers filter by the tag).
  const proposal: Proposal = {
    id,
    kind,
    draft,
    evidence: { docId: evidenceDocId, messageId: evidenceMessageId, span: evidenceSpan },
    suggestedTier,
    status: "pending",
    resultNodeId: null,
    author,
    zoneId,
    batchId,
    ...(tags.length > 0 ? { tags } : {}),
  };
  const insert = () => {
    db.run(
      "INSERT INTO proposals (id, kind, draft_json, evidence_doc_id, evidence_message_id, evidence_span, suggested_tier, status, author, zone_id, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)",
      [
        id,
        kind,
        draftJson,
        evidenceDocId,
        evidenceMessageId,
        evidenceSpan,
        suggestedTier,
        author,
        zoneId,
        batchId,
      ],
    );
    // TAGS: the target-keyed row rides the SAME insert closure (so a batch
    // writes it inside the one db.transaction() — atomic with the proposal).
    if (tagsJson !== null) {
      db.run("INSERT INTO node_tags (target_id, tags_json) VALUES (?, ?)", [id, tagsJson]);
    }
  };
  return { proposal, insert };
}

function insertProposal(
  db: Database,
  bus: EventBus,
  kind: "node" | "edge",
  input: ProposeInput,
): Proposal {
  const { proposal, insert } = buildProposal(db, kind, input);
  insert();
  bus.emit("proposal.added", proposal as unknown as Record<string, unknown>);
  return proposal;
}

// Round 5 (CLI1) — batch propose. Mints a UUID per node, registers each under
// its LOCAL ref (an opaque author-chosen string like "n1", never persisted —
// disjoint from the minted UUIDs), then resolves each edge endpoint via
// `refToId.get(x) ?? x`: a local ref becomes the freshly-minted node id, while
// a real node/proposal id (or an unresolvable ref — ratify owns dangling-ref
// errors) passes through unchanged. Opacity holds: a missing endpoint key
// stays missing (spread injects `undefined`, which JSON.stringify drops), so
// the stored edge draft is byte-identical to a single-propose of the same
// draft. All validation runs BEFORE the transaction (pure reads + throws), all
// inserts run INSIDE it, all emits AFTER commit — a throw at any stage leaves
// zero rows and leaks zero events.
interface BatchNodeInput {
  ref: string;
  draft: unknown;
  suggestedTier?: string;
  evidence?: { docId?: string; messageId?: string; span?: string };
  author?: "user" | "agent";
  // Round 7 (TAGS): a batched node may carry propose-time tags (written to its
  // node_tags row inside the batch's one transaction). Edges carry no tags
  // (an edge has no target-keyed metadata to re-home).
  tags?: string[];
}
interface BatchEdgeInput {
  draft: unknown;
  suggestedTier?: string;
  evidence?: { docId?: string; messageId?: string; span?: string };
  author?: "user" | "agent";
}
interface BatchInput {
  nodes?: BatchNodeInput[];
  edges?: BatchEdgeInput[];
  // Round 12 (SEAM 1): omit and the daemon MINTS one (the normal path — the
  // agent gets a queryable act for free, with zero bookkeeping, which is the
  // whole F5.1 ask). Supply one to EXTEND an existing act — the repair case
  // drive #10 needed: "I forgot the edges; add them to that batch."
  batchId?: string;
}

function batchPropose(
  db: Database,
  bus: EventBus,
  input: BatchInput,
): { batchId: string; refToId: Record<string, string>; proposals: Proposal[] } {
  // Minted BEFORE any build so every member of the call carries the same act,
  // including a batch of only edges. Reuse is NOT rejected: a caller that names
  // an existing id means "same act", and the engine does not own the agent's
  // grouping semantics (the dumb-daemon clause).
  if (input.batchId !== undefined && (typeof input.batchId !== "string" || input.batchId === "")) {
    throw new Error(
      `batchId must be a non-empty string (omit it to have one minted), got: ${JSON.stringify(input.batchId)}`,
    );
  }
  const batchId = input.batchId ?? crypto.randomUUID();
  const refToId = new Map<string, string>();
  const built: Array<{ proposal: Proposal; insert: () => void }> = [];

  for (const n of input.nodes ?? []) {
    if (typeof n.ref !== "string" || n.ref === "") {
      throw new Error('each batch node needs a non-empty string "ref"');
    }
    if (refToId.has(n.ref)) throw new Error(`duplicate batch node ref: ${n.ref}`);
    const b = buildProposal(db, "node", {
      draft: n.draft,
      evidence: n.evidence ?? {},
      suggestedTier: n.suggestedTier,
      author: n.author,
      tags: n.tags,
      batchId,
    });
    refToId.set(n.ref, b.proposal.id);
    built.push(b);
  }

  for (const e of input.edges ?? []) {
    // Resolve local refs against the just-minted node ids; keep the draft
    // otherwise opaque (Contract 8).
    let draft = e.draft;
    if (draft !== null && typeof draft === "object") {
      const d = draft as Record<string, unknown>;
      draft = {
        ...d,
        source: refToId.get(String(d.source)) ?? d.source,
        target: refToId.get(String(d.target)) ?? d.target,
      };
    }
    built.push(
      buildProposal(db, "edge", {
        draft,
        evidence: e.evidence ?? {},
        suggestedTier: e.suggestedTier,
        author: e.author,
        batchId,
      }),
    );
  }

  const run = db.transaction(() => {
    for (const b of built) b.insert();
  });
  run();
  // AFTER commit only — a rollback must never leak a proposal.added.
  for (const b of built) {
    bus.emit("proposal.added", b.proposal as unknown as Record<string, unknown>);
  }
  return { batchId, refToId: Object.fromEntries(refToId), proposals: built.map((b) => b.proposal) };
}

// R3 gate rework (cassandra's cold drive): an edge draft with the WRONG
// endpoint keys (from/to, src/dst…) sails through opaque intake, bypasses
// promote's endpoint-order guard (unknown refs pass by design), and only
// dies at ratify — the worst possible distance from the mistake. This is a
// WARNING, never a reject: draft opacity stays sacred (Contract 8), the
// daemon just names the missing keys next to the accepted proposal so the
// cold agent hears about it in the same turn.
function edgeDraftWarning(draft: unknown): string | null {
  if (draft === null || typeof draft !== "object") {
    return 'edge draft is not an object — expected {"source": "<node-or-proposal-id>", "target": "<node-or-proposal-id>", "label": "..."}; stored as-is (opaque intake), but ratify will fail on it';
  }
  const d = draft as Record<string, unknown>;
  const missing = ["source", "target"].filter((key) => typeof d[key] !== "string");
  if (missing.length === 0) return null;
  return `edge draft has no string ${missing.join("/")} key(s) — endpoints ride "source"/"target" (node or pending node-proposal ids); other keys are NOT rejected (the draft is opaque to the daemon), but ratify will fail to resolve the endpoints`;
}

function proposeNode(db: Database, bus: EventBus, input: ProposeInput): Proposal {
  return insertProposal(db, bus, "node", input);
}

function proposeEdge(db: Database, bus: EventBus, input: ProposeInput): Proposal {
  return insertProposal(db, bus, "edge", input);
}

export type { BatchEdgeInput, BatchInput, BatchNodeInput, ProposeInput };
export {
  batchPropose,
  edgeDraftWarning,
  isTitleRef,
  proposeEdge,
  proposeNode,
  resolveTitleRef,
  TITLE_REF_PREFIX,
};
