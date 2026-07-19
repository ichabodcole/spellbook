// mind-mapper surface — the game board. Context rail (source docs) | map
// canvas ⇆ doc viewer split | conversation sidebar. P1: the surface now
// consumes a REAL persisted project via useProjectState (GET /state seed +
// WS /events patches, seams vine msgs 3–6/13) instead of the spike's one-shot
// stub fetch; doc content still comes from GET /doc/:id (unchanged envelope).
// Conversation stays local-only until P2 wires it to the real bus
// (plan/circe.md P2.3) — there's no agent behind it yet either way.

import { Moon, Search, Sun } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CardGrid } from "./CardGrid";
import { ContextRail } from "./ContextRail";
import { type ComposerSeed, ConversationPanel, type ScrollRequest } from "./ConversationPanel";
import { DocViewer } from "./DocViewer";
import { FocusBar } from "./FocusBar";
import { GraphCanvas } from "./GraphCanvas";
import { MapKey } from "./MapKey";
import { NodeDetail } from "./NodeDetail";
import { ProjectPicker } from "./ProjectPicker";
import { ReviewQueue } from "./ReviewQueue";
import { SearchPalette } from "./SearchPalette";
import { type CitedBy, parseCitedBody } from "./state/deleteFlow";
import { docLensNodeIds } from "./state/docLens";
import type { IngestFilePost, IngestJsonPost } from "./state/intake";
import { ingestBlank, ingestFiles, ingestText } from "./state/intake";
import { pendingEdgesFrom, pendingNodesFrom } from "./state/pendingOverlay";
import { dotState, type PresenceDot } from "./state/presence";
import { type PaletteRow, paletteRows } from "./state/searchRows";
import { applyTheme, readAppliedTheme, type Theme } from "./state/theme";
import {
  forgetStoredProject,
  PROJECT_STORAGE_KEY,
  type ProjectSource,
  rememberProject,
  resolveInitialProjectWithSource,
} from "./state/urlProject";
import { useProjectState } from "./state/useProjectState";
import { parseZoneNotEmptyBody, type ZoneNotEmpty } from "./state/zoneFlow";
import { mainProposals, zoneMapFrom, zoneOf } from "./state/zoneView";
import type {
  Doc,
  DocMeta,
  Lens,
  Message,
  MessageSourceRef,
  ProjectState,
  Ruling,
  SearchHit,
  WireMessage,
  Zone,
} from "./types";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { type BoardView, ViewToggle } from "./ViewToggle";
import { ZoneTabs } from "./ZoneTabs";

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

const DEFAULT_LENS: Lens = { owner: null, nodeId: null, depth: 1, docId: null };

// T8 — presence dot rendering (tokens only; the vocabulary reuses existing
// axes: attention = broken, faint = quiet, story-local = alive).
const DOT_CLASS: Record<PresenceDot, string> = {
  unreachable: "bg-attention",
  "connected-no-agent": "bg-ink-faint",
  "agent-here": "bg-story-local",
};

const DOT_TITLE: Record<PresenceDot, string> = {
  unreachable: "daemon unreachable",
  "connected-no-agent": "connected — no agent on this project",
  "agent-here": "an agent is here",
};

// Client-side backstop for the thinking indicator (the server TTL should
// beat this; ~60s means a dropped idle event can't pin the pulse forever).
const THINKING_TTL_MS = 60_000;

export function App() {
  // T2 project-in-URL: an explicit ?project= (a shared link) beats the
  // remembered last board beats undefined (daemon default resolves it).
  // Round 3 (Claim P1): the SOURCE rides along — a 404 on a stale STORED id
  // degrades quietly to the landing, a 404 on an explicit URL id is said
  // honestly (it was the user's own assertion, not our memory).
  const [initialProject] = useState(() =>
    resolveInitialProjectWithSource(location.search, localStorage.getItem(PROJECT_STORAGE_KEY)),
  );
  const [projectId, setProjectId] = useState<string | undefined>(initialProject.id);
  const [projectSource, setProjectSource] = useState<ProjectSource>(initialProject.source);
  const { state, error, status, needsProject, notFound, lookHere, agentActivity } =
    useProjectState(projectId);
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
  // T5 — the two-stage delete flow (Claim A): stage 1 confirms intent,
  // stage 2 (citedBy set, populated from the 409) shows provenance counts
  // before force. The SAME dialog escalates — never two dialogs.
  const [deleteTarget, setDeleteTarget] = useState<{
    doc: DocMeta;
    citedBy: CitedBy | null;
  } | null>(null);
  // T9 — the double-click node sketch form.
  const [nodeForm, setNodeForm] = useState<{ title: string; synopsis: string } | null>(null);
  // T8 — agent activity → the conversation panel's thinking pulse.
  const [thinking, setThinking] = useState(false);
  // T11 — imperative scroll-to-message request for the conversation panel.
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null);
  // V1 — map|grid view. App-local render state (finding 6: the grid is a
  // rendering, not board state — not stored, not synced).
  const [view, setView] = useState<BoardView>("map");
  // Z3 — which board is showing: null = main, else a zone id. View-local
  // like `view` (the store is inclusive; a tab switch is free — no refetch).
  const [activeZone, setActiveZone] = useState<string | null>(null);
  // Z1 — the two-stage zone-delete flow, deleteFlow's idiom: stage 1
  // confirms intent, stage 2 (notEmpty set, populated from the 409) states
  // the proposal count being discarded before ?yes=1. SAME dialog escalates.
  const [zoneDelete, setZoneDelete] = useState<{
    zone: Zone;
    notEmpty: ZoneNotEmpty | null;
  } | null>(null);
  // Agent-follow across a zone switch: the focus target parks here (with the
  // board it's waiting for) while setActiveZone re-renders the canvas, then
  // flushes as a focusRequest one frame later — the fresh zone map must
  // exist before fitView can find the node.
  const [pendingFocus, setPendingFocus] = useState<{
    nodeId: string;
    zone: string | null;
  } | null>(null);
  // C3 — structured verbs seed the composer, they don't send (the house
  // rule, Claim C3): the verb text lands as the draft, selection narrows to
  // the node so the ground chip previews what will ride onSend. Analyze
  // (doc menu) keeps direct-send — it IS the intent. Focus stays a command.
  const [composerSeed, setComposerSeed] = useState<ComposerSeed | null>(null);
  const seedComposer = (text: string, nodeId: string) => {
    setSelectedIds([nodeId]);
    setComposerSeed((s) => ({ text, seq: (s?.seq ?? 0) + 1 }));
  };
  // T1 — theme. The pre-paint script (index.html) already resolved and
  // stamped the attribute before React booted; state seeds from the DOM so
  // the two never disagree at mount. applyTheme writes attribute + storage.
  const [theme, setTheme] = useState<Theme>(() => readAppliedTheme());
  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    setTheme(next);
  };

  // Thinking pulse lifecycle: non-idle activity lights it (and arms the
  // client TTL backstop), idle clears it. The third clear — any agent
  // message landing — is its own effect below.
  useEffect(() => {
    if (!agentActivity) return;
    if (agentActivity.state === "idle") {
      setThinking(false);
      return;
    }
    setThinking(true);
    const t = setTimeout(() => setThinking(false), THINKING_TTL_MS);
    return () => clearTimeout(t);
  }, [agentActivity]);

  // A reply IS done-thinking, whatever the activity stream said last.
  const lastMessage = state?.conversation[state.conversation.length - 1];
  useEffect(() => {
    if (lastMessage?.role === "agent") setThinking(false);
  }, [lastMessage]);

  // Z3 agent-follow (ratified): a focus target that lives in a zone switches
  // the board to that zone FIRST, then focuses — co-presence over
  // view-stickiness (and symmetrically, a main-graph target switches back to
  // main). Dispatched through a ref so the effects below don't re-run on
  // every state/zone change (the established ref-dispatcher idiom).
  const followFocus = (nodeId: string) => {
    // undefined = a real node (main graph); null = main-queue proposal;
    // string = its zone.
    const zone = state ? (zoneOf(state.proposals, nodeId) ?? null) : null;
    if (zone !== activeZone) {
      setPendingFocus({ nodeId, zone });
      setActiveZone(zone);
    } else {
      setFocusRequest((r) => ({ nodeId, seq: (r?.seq ?? 0) + 1 }));
    }
  };
  const followRef = useRef(followFocus);
  followRef.current = followFocus;

  // The flush half of the zone-switch focus: fires once the board showing is
  // the one the target waits for. The rAF hop lets the canvas commit the
  // fresh map before fitView goes looking for the node (same timing class as
  // the composer-seed caret, R3 C3).
  useEffect(() => {
    if (!pendingFocus || pendingFocus.zone !== activeZone) return;
    const { nodeId } = pendingFocus;
    setPendingFocus(null);
    const raf = requestAnimationFrame(() =>
      setFocusRequest((r) => ({ nodeId, seq: (r?.seq ?? 0) + 1 })),
    );
    return () => cancelAnimationFrame(raf);
  }, [pendingFocus, activeZone]);

  // A zone deleted under us (this surface's flow or an agent's cli zone
  // delete — the reducer's zone.deleted drop is the one truth) re-homes the
  // view to main rather than stranding it on a board that no longer exists.
  useEffect(() => {
    if (activeZone && state && !state.zones.some((z) => z.id === activeZone)) {
      setActiveZone(null);
    }
  }, [state, activeZone]);

  // Once the daemon resolves the default project, mirror its id into the
  // picker so switching projects re-mounts useProjectState explicitly rather
  // than riding an implicit undefined. Also mirrored into the URL + storage
  // (T2) — but ONLY here, where projectId was undefined by construction: an
  // explicit ?project= seeded projectId at mount, so this effect never
  // overrides a shared link.
  useEffect(() => {
    if (state && !projectId) {
      setProjectId(state.project.id);
      rememberProject(state.project.id);
    }
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
      followRef.current(incoming.nodeId);
    }
  }, [state?.lens]);

  // Agent look-here: a fire-once viewport nudge — re-centers the canvas
  // without touching the lens (distinct from lens.set by design; the
  // plan-alignment review found the original lens.set reuse never moved the
  // viewport and clobbered lens state).
  useEffect(() => {
    if (!lookHere) return;
    followRef.current(lookHere.nodeId);
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
  // Z1 (the ratified one-rule): the store is INCLUSIVE, so the MAIN board
  // derives from mainProposals (zoneId == null) — and because snapshot merge
  // and event upsert both feed state.proposals, this single filter is the
  // segregation at both ingestion points.
  const mapWithPending = useMemo(() => {
    if (!state) return state;
    const main = mainProposals(state.proposals);
    return {
      ...state,
      nodes: [...state.nodes, ...pendingNodesFrom(main)],
      edges: [...state.edges, ...pendingEdgesFrom(main)],
    };
  }, [state]);

  // Z3 — the zone board: the SAME canvas fed that zone's proposals,
  // un-dashed by derivation (zoneView.ts owns the rule + its tests).
  const boardMap = useMemo(() => {
    if (!state || !mapWithPending) return mapWithPending;
    if (!activeZone) return mapWithPending;
    // Context endpoints resolve against the MAIN board's nodes INCLUDING its
    // pending synthetics — so a zoned edge whose endpoint was just promoted
    // keeps rendering, with the promoted endpoint wearing its main-queue
    // dashed styling inside the zone (an honest "this one left") — found in
    // the promote drive, where the edge silently vanished instead.
    return { ...state, ...zoneMapFrom(state.proposals, activeZone, mapWithPending.nodes) };
  }, [state, mapWithPending, activeZone]);

  const selection = useMemo(
    () => (boardMap ? boardMap.nodes.filter((n) => selectedIds.includes(n.id)) : []),
    [boardMap, selectedIds],
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
  const [remoteHits, setRemoteHits] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    const q = search.query.trim();
    if (!search.open || !q) {
      setRemoteHits(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/search${projectQs}${projectQs ? "&" : "?"}q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (!r.ok) throw new Error(`search ${r.status}`);
          return r.json();
        })
        .then((body: { hits?: SearchHit[] }) => {
          if (cancelled) return;
          setRemoteHits(Array.isArray(body.hits) ? body.hits : null);
        })
        .catch(() => {
          if (!cancelled) setRemoteHits(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, projectQs]);

  // S1 — proposal hits resolve against the pending synthetic nodes across
  // EVERY zone (the proposal id is the synthetic node id): a zoned hit must
  // be resolvable before the pick switches the board over to it.
  const pendingAll = useMemo(() => (state ? pendingNodesFrom(state.proposals) : []), [state]);

  // S1 — hit kinds survive this memo (searchRows.ts, pure + tested): rows
  // keep node|proposal apart and off-board doc/message matches keep their
  // counts for the honest no-results state. The client-side substring
  // fallback (a failed /search never takes the palette down) stays scoped to
  // ratified nodes, as it always was.
  const palette = useMemo(() => {
    if (!state || !search.open || !search.query.trim()) return null;
    if (remoteHits) return paletteRows(remoteHits, state.nodes, pendingAll);
    const q = search.query.trim().toLowerCase();
    const inTitle = state.nodes.filter((n) => n.title.toLowerCase().includes(q));
    const inSynopsis = state.nodes.filter(
      (n) => !n.title.toLowerCase().includes(q) && n.synopsis.toLowerCase().includes(q),
    );
    return {
      rows: [...inTitle, ...inSynopsis].map(
        (node): PaletteRow => ({ kind: "node", node, zoneId: null }),
      ),
      offBoard: { docs: 0, messages: 0 },
    };
  }, [state, search, remoteHits, pendingAll]);

  const pickSearchResult = (row: PaletteRow) => {
    setSearch({ open: false, query: "" });
    setSelectedIds([row.node.id]);
    // Zoned hits switch to their zone view first (followFocus's rule — the
    // same one lens.set/look.here obey), then the existing focusRequest path
    // lands on the element: proposal id IS the synthetic node id.
    followFocus(row.node.id);
  };

  // What the lens admits onto the active board; the full board when nothing
  // is focused. The lens has no zone dimension (ruled) — it narrows whatever
  // board is showing. V2: the doc branch admits nodes with a source in that
  // doc (+ edges among them, docLens.ts); marks-but-no-nodes renders
  // honestly empty. Grid equality is free: BOTH views consume this memo.
  const visibleMap = useMemo(() => {
    if (!boardMap || !lens.owner) return boardMap;
    const keep = lens.docId
      ? docLensNodeIds(boardMap.nodes, lens.docId)
      : lens.nodeId
        ? lensSet(boardMap, lens.nodeId, lens.depth ?? 1)
        : null;
    if (!keep) return boardMap;
    return {
      ...boardMap,
      nodes: boardMap.nodes.filter((n) => keep.has(n.id)),
      edges: boardMap.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }, [boardMap, lens]);
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
  // `kind` defaults to the ordinary turn; Analyze (Claim G) posts
  // kind:"analyze" — explicit intent, same conversational wire, no new
  // machinery. `ground` carries the prefix grammar (bare = node, doc:<id>).
  const sendMessage = (text: string, ground: string[], kind = "turn") =>
    fetch(`/send${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "user",
        kind,
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

  // T9 — human authoring: both sketches POST to the same /proposals
  // endpoint the agent uses, author:"user" (Claim D). No optimistic
  // append — the pending overlay renders the sketch when proposal.added
  // round-trips (one source of truth, same as messages). Z3: a sketch made
  // while a zone board is showing lands IN that zone (mess is licensed
  // there; a sketch silently escaping to the main queue would lie about
  // where you drew it).
  const proposeAsUser = (kind: "node" | "edge", draft: Record<string, unknown>) =>
    fetch(`/proposals${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        draft,
        evidence: {},
        author: "user",
        ...(activeZone && { zone: activeZone }),
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`propose ${r.status}`);
      })
      .catch((e) =>
        setNotice(`couldn't sketch that (${e instanceof Error ? e.message : String(e)}).`),
      );

  // Z2 — promote: a MOVE to the main review queue. The endpoint-order error
  // (an edge whose endpoint proposal is still zoned) comes back as a plain
  // 400 whose message names the endpoint to promote first — surfaced
  // verbatim, never paraphrased into something vaguer.
  const promoteProposal = (id: string) =>
    fetch(`/proposals/${id}/promote${projectQs}`, { method: "POST" })
      .then(async (r) => {
        if (r.ok) return;
        const body = (await r.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : `promote ${r.status}`);
      })
      .catch((e) =>
        setNotice(`couldn't promote that (${e instanceof Error ? e.message : String(e)}).`),
      );

  // Z1 — zone create (the tab strip's + zone). The daemon derives the slug
  // id from this name and answers zone.created on the bus — no optimistic
  // tab, one source of truth, same as every other write here.
  const createZone = (name: string) =>
    fetch(`/zones${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
      .then(async (r) => {
        if (r.ok) {
          const zone = (await r.json()) as Zone;
          setActiveZone(zone.id);
          return;
        }
        const body = (await r.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : `zone ${r.status}`);
      })
      .catch((e) =>
        setNotice(`couldn't create that zone (${e instanceof Error ? e.message : String(e)}).`),
      );

  // Z1 — the zone-delete fetch half (the 409-body parse is pure,
  // state/zoneFlow.ts). Unforced first, always; a recognizable
  // zone-not-empty 409 escalates the SAME dialog to its count stage;
  // anything else degrades to the notice bar.
  const requestZoneDelete = (yes: boolean) => {
    if (!zoneDelete) return;
    const id = zoneDelete.zone.id;
    const yesQs = projectQs ? `${projectQs}&yes=1` : "?yes=1";
    fetch(`/zones/${id}${yes ? yesQs : projectQs}`, { method: "DELETE" })
      .then(async (r) => {
        if (r.ok) {
          setZoneDelete(null);
          return;
        }
        if (r.status === 409) {
          const notEmpty = parseZoneNotEmptyBody(await r.json().catch(() => null));
          if (notEmpty) {
            setZoneDelete((t) => (t ? { ...t, notEmpty } : t));
            return;
          }
        }
        throw new Error(`zone delete ${r.status}`);
      })
      .catch((e) => {
        setZoneDelete(null);
        setNotice(`couldn't delete that zone (${e instanceof Error ? e.message : String(e)}).`);
      });
  };

  // A tab switch clears view-local attention — selection and the local lens
  // both name elements of the board being left.
  const switchZone = (zoneId: string | null) => {
    if (zoneId === activeZone) return;
    setActiveZone(zoneId);
    setSelectedIds([]);
    setLens(DEFAULT_LENS);
  };

  const submitNodeForm = () => {
    if (!nodeForm) return;
    const title = nodeForm.title.trim();
    if (!title) return;
    const synopsis = nodeForm.synopsis.trim();
    proposeAsUser("node", synopsis ? { title, synopsis } : { title });
    setNodeForm(null);
  };

  // T5 — the delete flow's fetch half (the 409-body parse is pure,
  // state/deleteFlow.ts). Unforced first, always; a recognizable cited-409
  // escalates the SAME dialog to its provenance stage; anything else
  // degrades to the notice bar.
  const requestDelete = (force: boolean) => {
    if (!deleteTarget) return;
    const id = deleteTarget.doc.id;
    const forceQs = projectQs ? `${projectQs}&force=1` : "?force=1";
    fetch(`/doc/${id}${force ? forceQs : projectQs}`, { method: "DELETE" })
      .then(async (r) => {
        if (r.ok) {
          setDeleteTarget(null);
          return;
        }
        if (r.status === 409) {
          const cited = parseCitedBody(await r.json().catch(() => null));
          if (cited) {
            setDeleteTarget((t) => (t ? { ...t, citedBy: cited } : t));
            return;
          }
        }
        throw new Error(`delete ${r.status}`);
      })
      .catch((e) => {
        setDeleteTarget(null);
        setNotice(`couldn't delete that document (${e instanceof Error ? e.message : String(e)}).`);
      });
  };

  // An open viewer for a doc that no longer exists closes — whoever deleted
  // it (this surface's flow or an agent's cli doc delete), the doc.deleted
  // reducer filter is the one truth this watches.
  useEffect(() => {
    if (openDoc && state && !state.docs.some((d) => d.id === openDoc.doc.id)) {
      setOpenDoc(null);
    }
  }, [state, openDoc]);

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
    // An explicit pick supersedes whatever the initial id's origin was — a
    // later 404 on THIS id (project deleted underneath us) reads as honest
    // news, not a stale memory to silently clear.
    setProjectSource("url");
    rememberProject(id);
    setSelectedIds([]);
    setOpenDoc(null);
    setLens(DEFAULT_LENS);
    lastServerLensRef.current = null;
  };

  // Claim P1 — stale STORED id: the project we remembered no longer exists.
  // Forget it and fall back to unscoped resolution (a legacy store re-homes
  // to its default; a projectless store answers needs-project → the landing).
  // Never the error screen — nothing is broken, our memory was just old.
  useEffect(() => {
    if (notFound && projectSource === "stored") {
      forgetStoredProject();
      setProjectSource("none");
      setProjectId(undefined);
    }
  }, [notFound, projectSource]);

  // Claim P1 — pick-or-create landing: the store has no default project (and
  // named none), so there is no board to render yet. Re-homes the same
  // ProjectPicker the header carries; picking or creating re-scopes the hook
  // and the WS opens scoped then (never unscoped on a projectless store).
  if (needsProject) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg text-ink">
        <h1 className="font-story text-xl">Mind Mapper</h1>
        <p className="text-xs text-ink-dim">
          {needsProject.length > 0
            ? "no board is open — pick a project, or start a new one."
            : "nothing here yet — name a project to start the first board."}
        </p>
        <ProjectPicker currentId={undefined} onSelect={switchProject} />
      </main>
    );
  }
  if (notFound) {
    // The stored-id case degrades via the effect above (this renders for at
    // most a frame before projectId flips) — the lasting version of this
    // screen is the explicit-?project= 404, said honestly.
    if (projectSource === "stored") {
      return (
        <main className="flex min-h-screen items-center justify-center bg-bg text-ink-faint">
          unrolling the map…
        </main>
      );
    }
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-bg text-ink">
        <p className="text-xs text-attention">
          project “{projectId}” doesn't exist on this daemon.
        </p>
        <p className="text-xs text-ink-dim">pick another board, or start one:</p>
        <ProjectPicker currentId={undefined} onSelect={switchProject} />
      </main>
    );
  }
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
  // The review badge counts the MAIN queue only (Z1's segregation rule):
  // zoned proposals aren't reviewable until promoted — counting them would
  // advertise rulings the queue can't offer.
  const pendingCount = mainProposals(state.proposals).filter((p) => p.status === "pending").length;
  // T8 — layer 1 (my socket) and layer 2 (agent tails) stay separate;
  // dotState is the pure rule. `presence` is defensive-read: a pre-V1.x
  // daemon simply reads as no-agent, never crashes.
  const dot = dotState(status, state.presence?.agents ?? 0);

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
        <span className="ml-auto flex items-center gap-2 text-xs text-ink-faint">
          <span className="flex items-center gap-1.5" role="status" title={DOT_TITLE[dot]}>
            <span className={`h-2 w-2 rounded-full ${DOT_CLASS[dot]}`} aria-hidden />
            <span className="sr-only">{DOT_TITLE[dot]}</span>
          </span>
          {state.docs.length} docs · {state.nodes.length} ideas · {state.edges.length} relations
          <Button
            variant="ghost"
            size="icon"
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun size={13} /> : <Moon size={13} />}
          </Button>
        </span>
      </header>
      {/* Z3 — the zone tab strip: a second row, only when zones exist (the
          first zone arrives conversationally — equal capabilities — or via
          an agent's `zone create`). */}
      {state.zones.length > 0 && (
        <ZoneTabs
          zones={state.zones}
          active={activeZone}
          onSwitch={switchZone}
          onCreate={createZone}
          onDelete={(zone) => setZoneDelete({ zone, notEmpty: null })}
        />
      )}
      {status === "closed" && (
        <div className="border-b border-edge bg-attention/10 px-4 py-1.5 text-xs text-attention">
          disconnected — the daemon isn't answering; sends are off. retrying…
        </div>
      )}
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
          onAnalyze={(doc) => sendMessage(`Analyze: ${doc.title}`, [`doc:${doc.id}`], "analyze")}
          // V2 — the doc lens's surface shortcut (single-click stays
          // open-viewer, ruled): a local user-owned doc lens; the FocusBar
          // doc pill + visibleMap doc branch take it from here.
          onDocLens={(doc) => setLens({ owner: "user", nodeId: null, depth: null, docId: doc.id })}
          onDelete={(doc) => setDeleteTarget({ doc, citedBy: null })}
        />
        <div className="relative min-w-0 flex-1">
          {view === "map" ? (
            <GraphCanvas
              // Remount on lens change so the viewport re-fits the new
              // neighborhood (layout recomputes on map change regardless).
              // Deliberately NOT keyed on activeZone: a zone switch swaps the
              // map in place, so the agent-follow focusRequest (flushed one
              // frame after the switch) finds a live canvas instance instead
              // of a fresh mount that would swallow it.
              key={`${lens.owner ?? "all"}:${lens.nodeId ?? ""}:${lens.docId ?? ""}:${lens.depth}`}
              map={visibleMap ?? boardMap ?? state}
              selectedIds={selectedIds}
              onSelect={setSelectedIds}
              promotable={activeZone !== null}
              onNodeCommand={(command, node) => {
                if (command === "Focus")
                  setLens({ owner: "user", nodeId: node.id, depth: 1, docId: null });
                else if (command === "Promote") promoteProposal(node.id);
                else seedComposer(`${command} — ${node.title}`, node.id);
              }}
              highlightIds={palette ? palette.rows.map((r) => r.node.id) : null}
              focusRequest={focusRequest}
              onConnect={(source, target) => proposeAsUser("edge", { source, target })}
              onPaneDoubleClick={() => setNodeForm({ title: "", synopsis: "" })}
              panelTopRight={<ViewToggle view={view} onView={setView} />}
              panelBelowBar={Boolean(lens.owner)}
            />
          ) : (
            <>
              {/* V1 — the SAME visibleMap + matches the canvas gets: lens
                  narrows and search dims the grid by construction. */}
              <CardGrid
                map={visibleMap ?? boardMap ?? state}
                highlightIds={palette ? palette.rows.map((r) => r.node.id) : null}
                selectedIds={selectedIds}
                onSelect={setSelectedIds}
              />
              {/* The toggle keeps its canvas-Panel perch in grid view too —
                  switching never moves the control out from under the
                  pointer. Same FocusBar dodge as the map view's Panel row:
                  the bar must never cover the way out of a view. */}
              <div className={`absolute right-4 z-10 ${lens.owner ? "top-14" : "top-4"}`}>
                <ViewToggle view={view} onView={setView} />
              </div>
            </>
          )}
          {nodeForm && (
            <div className="absolute left-1/2 top-1/3 z-20 w-72 -translate-x-1/2 rounded-lg border border-edge bg-surface/95 p-3 shadow-xl backdrop-blur">
              <p className="mb-2 text-[10px] uppercase tracking-widest text-ink-faint">
                sketch an idea
              </p>
              <input
                // biome-ignore lint/a11y/noAutofocus: the form only exists because the user just summoned it
                autoFocus
                value={nodeForm.title}
                onChange={(e) => setNodeForm({ ...nodeForm, title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setNodeForm(null);
                  if (e.key === "Enter") submitNodeForm();
                }}
                placeholder="title…"
                aria-label="New idea title"
                className="w-full rounded border border-edge bg-bg px-1.5 py-1 text-xs text-ink placeholder:text-ink-faint focus:outline-none"
              />
              <Textarea
                value={nodeForm.synopsis}
                onChange={(e) => setNodeForm({ ...nodeForm, synopsis: e.target.value })}
                onKeyDown={(e) => e.key === "Escape" && setNodeForm(null)}
                placeholder="a line about it… (optional)"
                className="mt-1.5 min-h-12 p-1.5 text-xs"
              />
              {/* Placement honesty (ratified): the sketch lands where layout
                  puts it, not where you double-clicked — no position rides
                  the schema. */}
              <div className="mt-2 flex items-center justify-between gap-1.5">
                <p className="text-[10px] italic text-ink-faint">lands as a pending sketch.</p>
                <div className="flex gap-1.5">
                  <Button
                    variant="ghost"
                    size="auto"
                    className="px-2 py-1"
                    onClick={() => setNodeForm(null)}
                  >
                    cancel
                  </Button>
                  <Button
                    size="auto"
                    className="px-2 py-1"
                    onClick={submitNodeForm}
                    disabled={!nodeForm.title.trim()}
                  >
                    sketch
                  </Button>
                </div>
              </div>
            </div>
          )}
          {!search.open && (
            <Button
              size="icon"
              onClick={() => setSearch({ open: true, query: "" })}
              aria-label="Find a node"
              title="Find a node (⌘K or /)"
              // The palette's own perch (left-1/2 top-4) — the button morphs
              // into it on click; drops to top-14 under an active FocusBar,
              // same dodge NodeDetail does. Every keyboard summon gets a
              // clickable twin.
              className={`absolute left-1/2 z-10 -translate-x-1/2 bg-surface/90 backdrop-blur ${
                lens.owner ? "top-14" : "top-4"
              }`}
            >
              <Search size={13} />
            </Button>
          )}
          {search.open && (
            <SearchPalette
              rows={palette?.rows ?? []}
              offBoard={palette?.offBoard ?? { docs: 0, messages: 0 }}
              query={search.query}
              onQuery={(query) => setSearch({ open: true, query })}
              onPick={pickSearchResult}
              onClose={() => setSearch({ open: false, query: "" })}
            />
          )}
          <FocusBar
            lens={lens}
            title={
              lens.docId
                ? (state.docs.find((d) => d.id === lens.docId)?.title ?? lens.docId)
                : (state.nodes.find((n) => n.id === lens.nodeId)?.title ?? "")
            }
            count={visibleMap?.nodes.length ?? 0}
            onDepth={(depth) => setLens((l) => ({ ...l, depth }))}
            onZoomOut={() => setLens(DEFAULT_LENS)}
          />
          <MapKey />
          {detailNode && detailOpen && (
            // The detail card perches BELOW the top-right control row in
            // both views (V1 made that row load-bearing: covering the view
            // toggle would trap the user in a view), and drops further under
            // an active FocusBar.
            <div className={`absolute right-4 z-10 ${lens.owner ? "top-24" : "top-14"}`}>
              <NodeDetail
                node={detailNode}
                docs={state.docs}
                onVerb={(verb, node) => seedComposer(`${verb} — ${node.title}`, node.id)}
                onOpenSource={(s) => openDocById(s.docId, s.span ?? undefined)}
                onOpenMessageSource={(s: MessageSourceRef) =>
                  setScrollRequest((r) => ({
                    messageId: s.messageId,
                    span: s.span,
                    seq: (r?.seq ?? 0) + 1,
                  }))
                }
                onFocus={(node) =>
                  setLens({ owner: "user", nodeId: node.id, depth: 1, docId: null })
                }
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
            proposals={mainProposals(state.proposals)}
            docs={state.docs}
            nodes={state.nodes}
            onRule={ruleProposal}
            onClose={() => setReviewOpen(false)}
          />
        )}
        <ConversationPanel
          nodes={state.nodes}
          docs={state.docs}
          disabled={status === "closed"}
          thinking={thinking}
          scrollRequest={scrollRequest}
          composerSeed={composerSeed}
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
      {deleteTarget && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {deleteTarget.citedBy
                  ? `"${deleteTarget.doc.title}" is still cited`
                  : `delete "${deleteTarget.doc.title}"?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {deleteTarget.citedBy
                  ? `${deleteTarget.citedBy.nodes} node${
                      deleteTarget.citedBy.nodes === 1 ? "" : "s"
                    } and ${deleteTarget.citedBy.proposals} pending proposal${
                      deleteTarget.citedBy.proposals === 1 ? "" : "s"
                    } cite it. The nodes survive (the map is a view, not the doc), but the pending proposals lose this evidence.`
                  : "The document and its file go away. Ideas already ratified from it stay on the map."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="ghost"
                size="auto"
                className="px-2.5 py-1"
                onClick={() => setDeleteTarget(null)}
              >
                cancel
              </Button>
              <Button
                size="auto"
                className="px-2.5 py-1 text-attention"
                onClick={() => requestDelete(Boolean(deleteTarget.citedBy))}
              >
                {deleteTarget.citedBy ? "delete anyway" : "delete"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {zoneDelete && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setZoneDelete(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {zoneDelete.notEmpty
                  ? `"${zoneDelete.zone.name}" isn't empty`
                  : `delete zone "${zoneDelete.zone.name}"?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {zoneDelete.notEmpty
                  ? `${zoneDelete.notEmpty.proposals} proposal${
                      zoneDelete.notEmpty.proposals === 1 ? "" : "s"
                    } go${zoneDelete.notEmpty.proposals === 1 ? "es" : ""} with it — a zone is a disposable sandbox, and deleting it discards everything still inside. Promote what's worth keeping first.`
                  : "The zone and anything still staged inside it go away. Promoted proposals already left for the main queue and stay."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="ghost"
                size="auto"
                className="px-2.5 py-1"
                onClick={() => setZoneDelete(null)}
              >
                cancel
              </Button>
              <Button
                size="auto"
                className="px-2.5 py-1 text-attention"
                onClick={() => requestZoneDelete(Boolean(zoneDelete.notEmpty))}
              >
                {zoneDelete.notEmpty ? "delete anyway" : "delete"}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </div>
  );
}
