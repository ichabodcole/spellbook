// mind-mapper surface — the game board. Context rail (source docs) | map
// canvas ⇆ doc viewer split | conversation sidebar. P1: the surface now
// consumes a REAL persisted project via useProjectState (GET /state seed +
// WS /events patches, seams vine msgs 3–6/13) instead of the spike's one-shot
// stub fetch; doc content still comes from GET /doc/:id (unchanged envelope).
// Conversation stays local-only until P2 wires it to the real bus
// (plan/circe.md P2.3) — there's no agent behind it yet either way.

import { useEffect, useMemo, useRef, useState } from "react";
import { ContextRail } from "./ContextRail";
import { ConversationPanel } from "./ConversationPanel";
import { DocViewer } from "./DocViewer";
import { FocusBar } from "./FocusBar";
import { GraphCanvas } from "./GraphCanvas";
import { MapKey } from "./MapKey";
import { NodeDetail } from "./NodeDetail";
import { ProjectPicker } from "./ProjectPicker";
import { ReviewQueue } from "./ReviewQueue";
import { SearchPalette } from "./SearchPalette";
import type { IngestFilePost, IngestJsonPost } from "./state/intake";
import { ingestBlank, ingestFiles, ingestText } from "./state/intake";
import { pendingEdgesFrom, pendingNodesFrom } from "./state/pendingOverlay";
import { useProjectState } from "./state/useProjectState";
import type { Doc, Lens, MapNode, Message, ProjectState, Ruling, WireMessage } from "./types";
import { Button } from "./ui/button";

// Wire → display adapter (types.ts note): the wire's `kind` is a free-form
// string (server default "turn"); the display Message narrows it to the two
// styles MessageBubble actually renders.
function toDisplayMessage(m: WireMessage): Message {
  return {
    id: m.id,
    who: m.role,
    kind: m.kind === "info" ? "info" : "result",
    text: m.text,
    ground: m.ground ?? [],
  };
}

// The neighborhood the lens admits: BFS over edges (undirected) from the
// focus node, out to `depth` hops.
function lensSet(map: ProjectState, nodeId: string, depth: number): Set<string> {
  const adjacent = new Map<string, string[]>();
  for (const e of map.edges) {
    adjacent.set(e.source, [...(adjacent.get(e.source) ?? []), e.target]);
    adjacent.set(e.target, [...(adjacent.get(e.target) ?? []), e.source]);
  }
  const seen = new Set([nodeId]);
  let frontier = [nodeId];
  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const n of adjacent.get(id) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

// The doc being read: content fetched on demand, highlight = the span that
// sent us here (from a node's source link; rail opens carry none).
type OpenDoc = { doc: Doc; highlight?: string };

const DEFAULT_LENS: Lens = { owner: null, nodeId: null, depth: 1 };

export function App() {
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const { state, error, lookHere } = useProjectState(projectId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // A peripheral write (send/ingest) failing degrades into this dismissible
  // notice, never into the conversation — the browser has no business
  // pretending to be the agent (that's genuinely a P2/P3-era distinction:
  // there's a real agent behind /send now, so a locally-fabricated "agent"
  // message would misrepresent who actually said it).
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [openDoc, setOpenDoc] = useState<OpenDoc | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);
  // The user's own Focus clicks stay local-only (no lens-write endpoint from
  // the surface yet); the agent's incoming lens.set events are synced below.
  const [lens, setLens] = useState<Lens>(DEFAULT_LENS);
  const [search, setSearch] = useState<{ open: boolean; query: string }>({
    open: false,
    query: "",
  });
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string; seq: number } | null>(null);

  // Once the daemon resolves the default project, mirror its id into the
  // picker so switching projects re-mounts useProjectState explicitly rather
  // than riding an implicit undefined.
  useEffect(() => {
    if (state && !projectId) setProjectId(state.project.id);
  }, [state, projectId]);

  // P3.3 — the agent half of the lens contract (spike's own comment flagged
  // this unwired: types.ts note, FocusBar's agent tint). Every INCOMING
  // server lens value (initial load or a later lens.set event) adopts into
  // local `lens` state; an agent-owned one additionally bumps focusRequest
  // so the canvas actually re-centers (a "look-here", not just a repaint) —
  // a user-owned incoming value (e.g. restored from a prior session) just
  // updates the FocusBar without yanking the viewport. Outbound (the human's
  // own Focus clicks) stays local-only — there's no lens-write endpoint from
  // the surface yet, only rendering the agent's writes.
  const lastServerLensRef = useRef<Lens | null>(null);
  useEffect(() => {
    if (!state?.lens || state.lens === lastServerLensRef.current) return;
    const incoming = state.lens;
    lastServerLensRef.current = incoming;
    setLens(incoming);
    if (incoming.owner === "agent" && incoming.nodeId) {
      const nodeId = incoming.nodeId;
      setFocusRequest((r) => ({ nodeId, seq: (r?.seq ?? 0) + 1 }));
    }
  }, [state?.lens]);

  // Agent look-here: a fire-once viewport nudge — re-centers the canvas
  // without touching the lens (distinct from lens.set by design; the
  // plan-alignment review found the original lens.set reuse never moved the
  // viewport and clobbered lens state).
  useEffect(() => {
    if (!lookHere) return;
    setFocusRequest((r) => ({ nodeId: lookHere.nodeId, seq: (r?.seq ?? 0) + 1 }));
  }, [lookHere]);

  // Summon the palette with cmd/ctrl-K or "/" (when not already typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setSearch({ open: true, query: "" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Ratified nodes/edges never carry `pending` themselves (only the
  // proposals table is staging-tier) — the board's pending overlay is
  // derived per proposal and merged in, not read off the entities directly.
  const mapWithPending = useMemo(() => {
    if (!state) return state;
    return {
      ...state,
      nodes: [...state.nodes, ...pendingNodesFrom(state.proposals)],
      edges: [...state.edges, ...pendingEdgesFrom(state.proposals)],
    };
  }, [state]);

  const selection = useMemo(
    () => (mapWithPending ? mapWithPending.nodes.filter((n) => selectedIds.includes(n.id)) : []),
    [mapWithPending, selectedIds],
  );

  const projectQs = projectId ? `?project=${encodeURIComponent(projectId)}` : "";

  // P3.2 — the daemon's `search` verb (FTS5), debounced. Ruled shape (vine
  // msg 36, resolving circe/daedalus's divergent guesses): ONE endpoint,
  // typed hits — `GET /search?q=` -> `{hits: [{kind:"node"|"doc"|"message",
  // id, title, snippet?, score}]}`. The palette's contract is find-a-node —
  // it consumes kind==="node" hits only (in the server's ranked order) and
  // resolves each id against the already-loaded state.nodes for the full
  // MapNode (tier, synopsis) the row needs to render; a hit alone doesn't
  // carry those. A failed/not-yet-landed /search degrades to the spike's
  // client-side substring filter rather than breaking the palette — a
  // peripheral fetch failure never takes the board down (the P1/P2 reflex).
  const [remoteNodeIds, setRemoteNodeIds] = useState<string[] | null>(null);
  useEffect(() => {
    const q = search.query.trim();
    if (!search.open || !q) {
      setRemoteNodeIds(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/search${projectQs}${projectQs ? "&" : "?"}q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!r.ok) throw new Error(`search ${r.status}`);
          return r.json();
        })
        .then((body: { hits?: Array<{ kind: string; id: string }> }) => {
          if (cancelled) return;
          const ids = Array.isArray(body.hits)
            ? body.hits.filter((h) => h.kind === "node").map((h) => h.id)
            : null;
          setRemoteNodeIds(ids);
        })
        .catch(() => {
          if (!cancelled) setRemoteNodeIds(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, projectQs]);

  // Scoped to ratified nodes only (pending drafts aren't yet real ideas to
  // search for) — same scoping the client-side fallback always had.
  const matches = useMemo(() => {
    if (!state || !search.open || !search.query.trim()) return null;
    if (remoteNodeIds) {
      const byId = new Map(state.nodes.map((n) => [n.id, n]));
      return remoteNodeIds.map((id) => byId.get(id)).filter((n): n is MapNode => Boolean(n));
    }
    const q = search.query.trim().toLowerCase();
    const inTitle = state.nodes.filter((n) => n.title.toLowerCase().includes(q));
    const inSynopsis = state.nodes.filter(
      (n) => !n.title.toLowerCase().includes(q) && n.synopsis.toLowerCase().includes(q),
    );
    return [...inTitle, ...inSynopsis];
  }, [state, search, remoteNodeIds]);

  const pickSearchResult = (node: MapNode) => {
    setSearch({ open: false, query: "" });
    setSelectedIds([node.id]);
    setFocusRequest((r) => ({ nodeId: node.id, seq: (r?.seq ?? 0) + 1 }));
  };

  // What the lens admits onto the canvas; the full (pending-merged) map when
  // nothing is focused.
  const visibleMap = useMemo(() => {
    if (!mapWithPending || !lens.owner || !lens.nodeId) return mapWithPending;
    const keep = lensSet(mapWithPending, lens.nodeId, lens.depth);
    return {
      ...mapWithPending,
      nodes: mapWithPending.nodes.filter((n) => keep.has(n.id)),
      edges: mapWithPending.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }, [mapWithPending, lens]);
  const detailNode = selection.length > 0 ? selection[selection.length - 1] : null;

  // A dismissed detail card comes back when attention moves to another node.
  const detailNodeId = detailNode?.id;
  useEffect(() => {
    if (detailNodeId) setDetailOpen(true);
  }, [detailNodeId]);

  // The real conversation — POST /send stores the row and emits
  // message.posted; the reducer applies it back into state.conversation on
  // the WS round-trip (no local optimistic append, so there is exactly one
  // source of truth for what was actually said).
  const sendMessage = (text: string, ground: string[]) =>
    fetch(`/send${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "user",
        kind: "turn",
        text,
        ground: ground.length ? ground : undefined,
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`send ${r.status}`);
      })
      .catch((e) =>
        setNotice(`couldn't send that (${e instanceof Error ? e.message : String(e)}).`),
      );

  const ingestJson: IngestJsonPost = (body) =>
    fetch(`/ingest${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`ingest ${r.status}`);
      })
      .catch((e) =>
        setNotice(`couldn't add that document (${e instanceof Error ? e.message : String(e)}).`),
      );

  const ingestForm: IngestFilePost = (form) =>
    fetch(`/ingest${projectQs}`, { method: "POST", body: form })
      .then((r) => {
        if (!r.ok) throw new Error(`ingest ${r.status}`);
      })
      .catch((e) =>
        setNotice(`couldn't add that document (${e instanceof Error ? e.message : String(e)}).`),
      );

  // Review-queue ruling — one keystroke per the contract, no draft to
  // compose. Ratify write-path landing (daedalus's P3 engine card) determines
  // the exact response shape; the request shape is the ratified contract.
  const ruleProposal = (id: string, ruling: Ruling) =>
    fetch(`/proposals/${id}/ruling${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruling }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`ruling ${r.status}`);
      })
      .catch((e) =>
        setNotice(`couldn't rule on that (${e instanceof Error ? e.message : String(e)}).`),
      );

  // A doc that won't open degrades to the notice bar — it must never take
  // the board down with it.
  const openDocById = (docId: string, highlight?: string) => {
    fetch(`/doc/${docId}${projectQs}`)
      .then((r) => {
        if (!r.ok) throw new Error(`doc ${docId}: ${r.status}`);
        return r.json();
      })
      .then((doc) => setOpenDoc({ doc: doc as Doc, highlight }))
      .catch((e) =>
        setNotice(`couldn't open that document (${e instanceof Error ? e.message : String(e)}).`),
      );
  };

  const switchProject = (id: string) => {
    setProjectId(id);
    setSelectedIds([]);
    setOpenDoc(null);
    setLens(DEFAULT_LENS);
    lastServerLensRef.current = null;
  };

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg text-attention">
        something broke: {error} — is the daemon up? (cli.ts open)
      </main>
    );
  }
  if (!state) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg text-ink-faint">
        unrolling the map…
      </main>
    );
  }

  const messages = state.conversation.map(toDisplayMessage);
  const pendingCount = state.proposals.filter((p) => p.status === "pending").length;

  return (
    <div className="flex h-screen flex-col bg-bg text-ink">
      <header className="flex items-baseline gap-3 border-b border-edge bg-surface px-4 py-2">
        <h1 className="font-story text-lg text-ink">Mind Mapper</h1>
        <ProjectPicker currentId={projectId} onSelect={switchProject} />
        {pendingCount > 0 && (
          <Button
            variant="outline"
            size="auto"
            className="px-2 py-0.5 text-xs text-pending"
            onClick={() => setReviewOpen((o) => !o)}
          >
            review · {pendingCount}
          </Button>
        )}
        <span className="ml-auto text-xs text-ink-faint">
          {state.docs.length} docs · {state.nodes.length} ideas · {state.edges.length} relations
        </span>
      </header>
      {notice && (
        <div className="flex items-center justify-between border-b border-edge bg-attention/10 px-4 py-1.5 text-xs text-attention">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="px-1"
          >
            ×
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <ContextRail
          docs={state.docs}
          openDocId={openDoc?.doc.id ?? null}
          onOpen={(docId) => openDocById(docId)}
          onIngestFiles={(files) => {
            ingestFiles(files, ingestForm);
          }}
          onIngestText={(title, text) => {
            ingestText(title, text, ingestJson);
          }}
          onIngestBlank={(title) => {
            ingestBlank(title, ingestJson);
          }}
        />
        <div className="relative min-w-0 flex-1">
          <GraphCanvas
            // Remount on lens change so the viewport re-fits the new
            // neighborhood (layout recomputes on map change regardless).
            key={`${lens.owner ?? "all"}:${lens.nodeId ?? ""}:${lens.depth}`}
            map={visibleMap ?? mapWithPending ?? state}
            selectedIds={selectedIds}
            onSelect={setSelectedIds}
            onNodeCommand={(command, node) => {
              if (command === "Focus") setLens({ owner: "user", nodeId: node.id, depth: 1 });
              else sendMessage(`${command} — ${node.title}`, [node.id]);
            }}
            highlightIds={matches ? matches.map((n) => n.id) : null}
            focusRequest={focusRequest}
          />
          {search.open && (
            <SearchPalette
              matches={matches ?? []}
              query={search.query}
              onQuery={(query) => setSearch({ open: true, query })}
              onPick={pickSearchResult}
              onClose={() => setSearch({ open: false, query: "" })}
            />
          )}
          <FocusBar
            lens={lens}
            title={state.nodes.find((n) => n.id === lens.nodeId)?.title ?? ""}
            count={visibleMap?.nodes.length ?? 0}
            onDepth={(depth) => setLens((l) => ({ ...l, depth }))}
            onZoomOut={() => setLens(DEFAULT_LENS)}
          />
          <MapKey />
          {detailNode && detailOpen && (
            <div className={`absolute right-4 z-10 ${lens.owner ? "top-14" : "top-4"}`}>
              <NodeDetail
                node={detailNode}
                docs={state.docs}
                onVerb={(verb, node) => sendMessage(`${verb} — ${node.title}`, [node.id])}
                onOpenSource={(s) => openDocById(s.docId, s.span)}
                onFocus={(node) => setLens({ owner: "user", nodeId: node.id, depth: 1 })}
                onClose={() => setDetailOpen(false)}
              />
            </div>
          )}
        </div>
        {openDoc && (
          <DocViewer
            key={`${openDoc.doc.id}:${openDoc.highlight ?? ""}`}
            doc={openDoc.doc}
            highlight={openDoc.highlight}
            onClose={() => setOpenDoc(null)}
          />
        )}
        {reviewOpen && (
          <ReviewQueue
            proposals={state.proposals}
            docs={state.docs}
            onRule={ruleProposal}
            onClose={() => setReviewOpen(false)}
          />
        )}
        <ConversationPanel
          nodes={state.nodes}
          selection={selection}
          onDeselect={(id) => setSelectedIds((ids) => ids.filter((x) => x !== id))}
          messages={messages}
          onSend={(text) =>
            sendMessage(
              text,
              selection.map((n) => n.id),
            )
          }
        />
      </div>
    </div>
  );
}
