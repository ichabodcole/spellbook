// mind-mapper spike surface — the game board. Context rail (source docs) |
// map canvas ⇆ doc viewer split | conversation sidebar. The surface consumes
// the map ONLY via GET /state and doc content via GET /doc/:id (seam v2,
// ratified vine msgs 13–14); no agent behind the conversation in Phase 0.

import { useEffect, useMemo, useState } from "react";
import { ContextRail } from "./ContextRail";
import { ConversationPanel } from "./ConversationPanel";
import { DocViewer } from "./DocViewer";
import { FocusBar } from "./FocusBar";
import { GraphCanvas } from "./GraphCanvas";
import { MapKey } from "./MapKey";
import { NodeDetail } from "./NodeDetail";
import { SearchPalette } from "./SearchPalette";
import type { Doc, Lens, MapNode, Message, StubMap } from "./types";

// The neighborhood the lens admits: BFS over edges (undirected) from the
// focus node, out to `depth` hops.
function lensSet(map: StubMap, nodeId: string, depth: number): Set<string> {
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

const SEED_MESSAGES: Message[] = [
  {
    id: 0,
    who: "agent",
    kind: "info",
    text: "No agent behind the board in this spike — what you say is noted with its context.",
    ground: [],
  },
];

export function App() {
  const [map, setMap] = useState<StubMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>(SEED_MESSAGES);
  const [openDoc, setOpenDoc] = useState<OpenDoc | null>(null);
  const [detailOpen, setDetailOpen] = useState(true);
  const [lens, setLens] = useState<Lens>({ owner: null, nodeId: null, depth: 1 });
  const [search, setSearch] = useState<{ open: boolean; query: string }>({
    open: false,
    query: "",
  });
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string; seq: number } | null>(null);

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

  useEffect(() => {
    fetch("/state")
      .then((r) => r.json())
      .then((data) => setMap(data as StubMap))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const selection = useMemo(
    () => (map ? map.nodes.filter((n) => selectedIds.includes(n.id)) : []),
    [map, selectedIds],
  );

  // Search matches, title hits ranked before synopsis hits.
  const matches = useMemo(() => {
    if (!map || !search.open || !search.query.trim()) return null;
    const q = search.query.trim().toLowerCase();
    const inTitle = map.nodes.filter((n) => n.title.toLowerCase().includes(q));
    const inSynopsis = map.nodes.filter(
      (n) => !n.title.toLowerCase().includes(q) && n.synopsis.toLowerCase().includes(q),
    );
    return [...inTitle, ...inSynopsis];
  }, [map, search]);

  const pickSearchResult = (node: MapNode) => {
    setSearch({ open: false, query: "" });
    setSelectedIds([node.id]);
    setFocusRequest((r) => ({ nodeId: node.id, seq: (r?.seq ?? 0) + 1 }));
  };

  // What the lens admits onto the canvas; the full map when nothing is focused.
  const visibleMap = useMemo(() => {
    if (!map || !lens.owner || !lens.nodeId) return map;
    const keep = lensSet(map, lens.nodeId, lens.depth);
    return {
      docs: map.docs,
      nodes: map.nodes.filter((n) => keep.has(n.id)),
      edges: map.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }, [map, lens]);
  const detailNode = selection.length > 0 ? selection[selection.length - 1] : null;

  // A dismissed detail card comes back when attention moves to another node.
  const detailNodeId = detailNode?.id;
  useEffect(() => {
    if (detailNodeId) setDetailOpen(true);
  }, [detailNodeId]);

  const say = (text: string, ground: string[]) =>
    setMessages((ms) => [...ms, { id: ms.length, who: "user", kind: "result", text, ground }]);

  // A doc that won't open degrades to a note in the conversation — it must
  // never take the board down with it.
  const openDocById = (docId: string, highlight?: string) => {
    fetch(`/doc/${docId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`doc ${docId}: ${r.status}`);
        return r.json();
      })
      .then((doc) => setOpenDoc({ doc: doc as Doc, highlight }))
      .catch((e) =>
        setMessages((ms) => [
          ...ms,
          {
            id: ms.length,
            who: "agent",
            kind: "info",
            text: `couldn't open that document (${e instanceof Error ? e.message : String(e)}).`,
            ground: [],
          },
        ]),
      );
  };

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg text-attention">
        something broke: {error} — is the daemon up? (cli.ts open)
      </main>
    );
  }
  if (!map) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg text-ink-faint">
        unrolling the map…
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-bg text-ink">
      <header className="flex items-baseline gap-3 border-b border-edge bg-surface px-4 py-2">
        <h1 className="font-story text-lg text-ink">Mind Mapper</h1>
        <span className="text-xs text-ink-dim">Hollowbrook — Phase 0 spike</span>
        <span className="ml-auto text-xs text-ink-faint">
          {map.docs.length} docs · {map.nodes.length} ideas · {map.edges.length} relations
        </span>
      </header>
      <div className="flex min-h-0 flex-1">
        <ContextRail
          docs={map.docs}
          openDocId={openDoc?.doc.id ?? null}
          onOpen={(docId) => openDocById(docId)}
        />
        <div className="relative min-w-0 flex-1">
          <GraphCanvas
            // Remount on lens change so the viewport re-fits the new
            // neighborhood (layout recomputes on map change regardless).
            key={`${lens.owner ?? "all"}:${lens.nodeId ?? ""}:${lens.depth}`}
            map={visibleMap ?? map}
            selectedIds={selectedIds}
            onSelect={setSelectedIds}
            onNodeCommand={(command, node) => {
              if (command === "Focus") setLens({ owner: "user", nodeId: node.id, depth: 1 });
              else say(`${command} — ${node.title}`, [node.id]);
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
            title={map.nodes.find((n) => n.id === lens.nodeId)?.title ?? ""}
            count={visibleMap?.nodes.length ?? 0}
            onDepth={(depth) => setLens((l) => ({ ...l, depth }))}
            onZoomOut={() => setLens({ owner: null, nodeId: null, depth: 1 })}
          />
          <MapKey />
          {detailNode && detailOpen && (
            <div className={`absolute right-4 z-10 ${lens.owner ? "top-14" : "top-4"}`}>
              <NodeDetail
                node={detailNode}
                docs={map.docs}
                onVerb={(verb, node) => say(`${verb} — ${node.title}`, [node.id])}
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
        <ConversationPanel
          nodes={map.nodes}
          selection={selection}
          onDeselect={(id) => setSelectedIds((ids) => ids.filter((x) => x !== id))}
          messages={messages}
          onSend={(text) =>
            say(
              text,
              selection.map((n) => n.id),
            )
          }
        />
      </div>
    </div>
  );
}
