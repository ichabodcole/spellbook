// mind-mapper surface — the game board. Context rail (source docs) | map
// canvas ⇆ doc viewer split | conversation sidebar. P1: the surface now
// consumes a REAL persisted project via useProjectState (GET /state seed +
// WS /events patches, seams vine msgs 3–6/13) instead of the spike's one-shot
// stub fetch; doc content still comes from GET /doc/:id (unchanged envelope).
// Conversation stays local-only until P2 wires it to the real bus
// (plan/circe.md P2.3) — there's no agent behind it yet either way.

import { Loader, Moon, Sun } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { CardGrid } from "./CardGrid";
import { ContextRail } from "./ContextRail";
import { type ComposerSeed, ConversationPanel, type ScrollRequest } from "./ConversationPanel";
import { DocViewer } from "./DocViewer";
import { FilterControl } from "./FilterControl";
import { FocusBar } from "./FocusBar";
import { GraphCanvas } from "./GraphCanvas";
import { IngestionTray } from "./IngestionTray";
import { MapKey } from "./MapKey";
import type { NodeCommand } from "./NodeContextMenu";
import { NodeDetail } from "./NodeDetail";
import { ProjectPicker } from "./ProjectPicker";
import { ReviewQueue } from "./ReviewQueue";
import { SearchPalette } from "./SearchPalette";
import { SpotlightToggle } from "./SpotlightToggle";
import { SubmapAppendModal } from "./SubmapAppendModal";
import { SubmapBreadcrumb } from "./SubmapBreadcrumb";
import { SubmapGroupModal } from "./SubmapGroupModal";
import { type AgentBadge, badgeFor, badgeHasClientTtl } from "./state/activity";
import { buildFooterText } from "./state/buildInfo";
import {
  type CitedBy,
  type NodeCitedBy,
  parseCitedBody,
  parseNodeCitedBody,
} from "./state/deleteFlow";
import { docLensNodeIds } from "./state/docLens";
import { EMPTY_FILTER, filterFacets, filterMap, type MapFilter } from "./state/filter";
import { groundBundle } from "./state/groundBundle";
import { processingItems } from "./state/ingestionQueue";
import type { IngestFilePost, IngestJsonPost } from "./state/intake";
import { ingestBlank, ingestFiles, ingestText } from "./state/intake";
import { directedSet, lensSet } from "./state/neighborhood";
import { menuInfoFor, rulingErrorMessage } from "./state/nodeMenu";
import { pendingEdgesFrom, pendingNodesFrom, resultNodeIdMap } from "./state/pendingOverlay";
import { dotState, type PresenceDot } from "./state/presence";
import { shouldDismissSearch } from "./state/searchDismiss";
import { type PaletteRow, paletteRows } from "./state/searchRows";
import { computeSpotlight } from "./state/spotlight";
import { breadcrumbTrail, submapView } from "./state/submap";
import { type BatchRuling, buildSubmapAppend, pendingNodeProposalIds } from "./state/submapAppend";
import { ratifiedSelection, submapChildTargets } from "./state/submapGroup";
import { existingTags } from "./state/tags";
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
import { selectedPendingProposalIds } from "./state/zoneGroup";
import { mainProposals, zoneMapFrom, zoneOf } from "./state/zoneView";
import type {
  ActionSlot,
  Doc,
  DocMeta,
  Lens,
  MapNode,
  Message,
  MessageSourceRef,
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
import { ZoneGroupModal } from "./ZoneGroupModal";
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
// R4 ACT1: the backstop applies to the PULSE only — a stalled badge has no
// timer behind it and must persist until an agent write resolves it.
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
  // R4 S1 (ratified): the palette is permanent chrome — the `open` flag
  // died; only the query is state. ⌘K / "/" focus the always-present input
  // through this ref (its own clickable twin — the summon house rule).
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ nodeId: string; seq: number } | null>(null);
  // R5 SL — the spotlight toggle (its own dim channel, distinct from search).
  // The lit sets are DERIVED below from this flag + selection + board; the
  // flag is the only state (toggling off restores by construction).
  const [spotlightOn, setSpotlightOn] = useState(false);
  // T5 — the two-stage delete flow (Claim A): stage 1 confirms intent,
  // stage 2 (citedBy set, populated from the 409) shows provenance counts
  // before force. The SAME dialog escalates — never two dialogs.
  const [deleteTarget, setDeleteTarget] = useState<{
    doc: DocMeta;
    citedBy: CitedBy | null;
  } | null>(null);
  // R6 DEL — the board's delete flow (nodes + proposals), sibling of the doc
  // flow above. `kind` is decided at open time from the target id (a pending/
  // rejected proposal id vs a real ratified node id). Only the node path has a
  // cited-guard: `citedBy` (edges + children) escalates the SAME dialog to its
  // provenance stage before a force delete; a proposal delete is single-stage
  // (thin, no guard — the litter-clearing path).
  const [deleteNode, setDeleteNode] = useState<{
    node: MapNode;
    kind: "node" | "proposal";
    citedBy: NodeCitedBy | null;
  } | null>(null);
  // R6 QUEUE — the ingestion tray toggle (ReviewQueue's idiom).
  const [ingestOpen, setIngestOpen] = useState(false);
  // R6 SUBMAP-CREATE — the group-ratified-nodes-under-a-parent modal: the
  // selected ratified nodes gathered when the affordance is clicked.
  const [submapGroup, setSubmapGroup] = useState<{ nodes: MapNode[] } | null>(null);
  // R7 SUBMAPPEND — the pending-group variant: ≥2 selected PENDING proposals to
  // ratify-batch into a submap (the ids gathered when the affordance is clicked).
  const [submapAppend, setSubmapAppend] = useState<{ pendingIds: string[] } | null>(null);
  // IC-a/IC-b — the free-text (dictation-first) add-node modal. `connectFrom`
  // null = a plain add (pane right-click → one node proposal); a node id = a
  // drag-connect-to-blank (onConnectEnd) → a node+edge batch anchored to that
  // source. Replaces the retired T9 structured title/synopsis form.
  const [addNode, setAddNode] = useState<{ text: string; connectFrom: string | null } | null>(null);
  // T8 — agent activity → the conversation panel's badge. R4 ACT1 makes it
  // tri-state: the thinking pulse, or the STATIC stalled branch (a
  // daemon-synthesized "agent may be stuck" that must never look alive).
  const [agentBadge, setAgentBadge] = useState<AgentBadge>(null);
  // T11 — imperative scroll-to-message request for the conversation panel.
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null);
  // V1 — map|grid view. App-local render state (finding 6: the grid is a
  // rendering, not board state — not stored, not synced).
  const [view, setView] = useState<BoardView>("map");
  // FILTER (R7) — the faceted filter (Status / Tier / Tags). View-local like
  // `view` (a filter is a rendering, not board state — not stored, not synced);
  // both map + grid consume the filteredMap it drives.
  const [filter, setFilter] = useState<MapFilter>(EMPTY_FILTER);
  // Z3 — which board is showing: null = main, else a zone id. View-local
  // like `view` (the store is inclusive; a tab switch is free — no refetch).
  const [activeZone, setActiveZone] = useState<string | null>(null);
  // SG2 — which submap is showing: null = top-level, else the anchor node id.
  // View-local, parallel to activeZone (the inclusive snapshot holds the whole
  // tree; drilling in/out is a client filter, no refetch). Reset on zone
  // switch (submap navigation is a main-board act) and when the anchor node
  // vanishes (below).
  const [activeAnchor, setActiveAnchor] = useState<string | null>(null);
  // R7 SUBMAPPEND — a drill-in that must WAIT for a freshly-minted parent. The
  // pending-group ratify-batch mints the parent node, but the surface's local
  // state gains it only when the node.ratified snapshot refetch lands — so
  // drilling in immediately would set activeAnchor to a node that isn't in
  // state yet, and the SG2 re-home effect below would bounce it straight back
  // to top-level. Park the target here; an effect flushes it once the node
  // arrives (the pendingFocus idiom).
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  // IC-c — the group-selected-into-a-zone modal: the pending main-queue
  // proposal ids being moved, gathered when the affordance is clicked.
  const [zoneGroup, setZoneGroup] = useState<{ pendingIds: string[] } | null>(null);
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

  // Badge lifecycle (per-clear-trigger effect discipline): activity events
  // map through badgeFor (state/activity.ts) — received/thinking light the
  // pulse and arm the client TTL backstop; idle clears; stalled sets its
  // OWN badge with NO client TTL (it arrived with no server timer behind it
  // and persists until an agent write resolves it — decaying it to blank
  // would hide a stuck agent). The timeout's functional guard means a timer
  // that outlives a state change can only ever clear the pulse it was armed
  // for, never a stalled badge that superseded it.
  useEffect(() => {
    if (!agentActivity) return;
    const badge = badgeFor(agentActivity.state);
    setAgentBadge(badge);
    if (!badgeHasClientTtl(badge)) return;
    const t = setTimeout(
      () => setAgentBadge((b) => (b === "thinking" ? null : b)),
      THINKING_TTL_MS,
    );
    return () => clearTimeout(t);
  }, [agentActivity]);

  // A reply IS done-thinking, whatever the activity stream said last — and
  // it clears a stalled badge too (an agent write resolves auto-state
  // server-side; this is the local mirror of that ruling).
  const lastMessage = state?.conversation[state.conversation.length - 1];
  useEffect(() => {
    if (lastMessage?.role === "agent") setAgentBadge(null);
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

  // SG2 — the anchor node gone (deleted, or un-anchored so it's no longer a
  // submap root under us — an agent's `node anchor --clear`) re-homes the view
  // to the top level rather than stranding it on a submap that no longer
  // exists. A node whose children all left still has a valid (empty) submap;
  // only the anchor node's own disappearance re-homes.
  useEffect(() => {
    if (activeAnchor && state && !state.nodes.some((n) => n.id === activeAnchor)) {
      setActiveAnchor(null);
    }
  }, [state, activeAnchor]);

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

  // Summon = focus, not open (R4 S1): cmd/ctrl-K or "/" (when not already
  // typing) puts the caret in the permanent input; select() means typing
  // replaces a leftover query instead of appending to it. R5 (bug #11):
  // Escape is the dismiss counterpart, lifted here so it works whether or not
  // the input holds focus — shouldDismissSearch guards it off the nodeForm /
  // composer / dialog Escape (each owns its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName ?? null;
      const typing =
        e.target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(e.target.tagName);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === "Escape") {
        const isSearchInput = document.activeElement === searchInputRef.current;
        if (shouldDismissSearch(activeTag, isSearchInput, Boolean(searchQuery))) {
          setSearchQuery("");
          searchInputRef.current?.blur();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchQuery]);

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
    // EF (finding #8): re-point a still-pending edge whose endpoint node
    // proposal has ratified, so it follows to the real node instead of
    // dangling. The map is built over the FULL proposal set — a pending main
    // edge can name a proposal that ratified from anywhere.
    const resolve = resultNodeIdMap(state.proposals);
    return {
      ...state,
      nodes: [...state.nodes, ...pendingNodesFrom(main)],
      edges: [...state.edges, ...pendingEdgesFrom(main, resolve)],
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

  // SG2 — the submap slice: filter the board to the active anchor's children
  // (or the top-level un-anchored nodes when null). Slots between zone and
  // lens (mapWithPending → zoneMapFrom → submapView → visibleMap); the derive
  // is pure + tested (state/submap.ts), client-side because a server ?anchor=
  // scope would hide the ancestors the breadcrumb walk needs (ratified).
  const submapMap = useMemo(
    () => (boardMap ? { ...boardMap, ...submapView(boardMap, activeAnchor) } : boardMap),
    [boardMap, activeAnchor],
  );

  // The breadcrumb walks the FULL board's anchors (not the filtered submap
  // slice, which only holds one level) so every ancestor resolves.
  const breadcrumb = useMemo(
    () => (boardMap ? breadcrumbTrail(boardMap.nodes, activeAnchor) : []),
    [boardMap, activeAnchor],
  );

  const selection = useMemo(
    () => (submapMap ? submapMap.nodes.filter((n) => selectedIds.includes(n.id)) : []),
    [submapMap, selectedIds],
  );

  // SL — the lit sets, derived only while the toggle is on and ≥2 are
  // selected (computeSpotlight returns null otherwise). Over the submap slice
  // so pending/zone/submap context is respected, same as SC.
  const spotlightSets = useMemo(
    () => (spotlightOn && submapMap ? computeSpotlight(submapMap, selectedIds) : null),
    [spotlightOn, submapMap, selectedIds],
  );

  // Keep the pressed state honest: if the selection drops below two, the
  // spotlight has nothing to intersect — turn the toggle off so it doesn't
  // silently re-engage when a later pair happens to get selected.
  useEffect(() => {
    if (spotlightOn && selectedIds.length < 2) setSpotlightOn(false);
  }, [spotlightOn, selectedIds]);

  // R4 R1 — the ratify-anywhere menu info, derived view-blind over the
  // INCLUSIVE store (state/nodeMenu.ts): one map serves canvas and grid,
  // main board and zone alike.
  const nodeMenus = useMemo(
    () => (state ? menuInfoFor(state.nodes, state.proposals) : undefined),
    [state],
  );

  // One command handler for both views (map + grid share the chassis).
  const handleNodeCommand = (command: NodeCommand, node: MapNode) => {
    if (command === "Focus") setLens({ owner: "user", nodeId: node.id, depth: 1, docId: null });
    else if (command === "Select connected") {
      // SC — union the node's depth-1 neighbors (incl. itself) into the
      // selection, computed over the ACTIVE submap slice so pending/zone/submap
      // context is respected. Nodes only (edges-in-selection is a follow-on).
      if (submapMap) setSelectedIds([...lensSet(submapMap, node.id, 1)]);
    } else if (command === "Select children") {
      // DIRSELECT — OUTGOING depth-1 siblings (both-edges count too), over the
      // active submap slice like Select connected.
      if (submapMap) setSelectedIds([...directedSet(submapMap, node.id, "children")]);
    } else if (command === "Select parents") {
      if (submapMap) setSelectedIds([...directedSet(submapMap, node.id, "parents")]);
    } else if (command === "Enter submap") enterSubmap(node.id);
    else if (command === "Promote") promoteProposal(node.id);
    else if (command === "Delete") openDelete(node);
    else seedComposer(`${command} — ${node.title}`, node.id);
  };

  // R6 DEL — open the delete dialog, deciding node-vs-proposal by the target
  // id: a rendered node whose id names a proposal in the inclusive store is a
  // pending synthetic (proposal delete, thin); anything else is a real ratified
  // node (node delete, with the cited-guard). The two id spaces are disjoint —
  // a ratified node's minted id never equals a proposal id.
  const openDelete = (node: MapNode) => {
    const kind = state?.proposals.some((p) => p.id === node.id) ? "proposal" : "node";
    setDeleteNode({ node, kind, citedBy: null });
  };

  // R4 A1 — an action-slot click seeds the composer with the slot's seed
  // text and narrows selection to the target (so it rides `ground` on send).
  // NEVER auto-sends: the human appends intent or sends as-is (the C3 house
  // rule — structured verbs seed, they don't speak for you).
  const handleAction = (action: ActionSlot, node: MapNode) => seedComposer(action.seed, node.id);

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
    const q = searchQuery.trim();
    if (!q) {
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
  }, [searchQuery, projectQs]);

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
    if (!state || !searchQuery.trim()) return null;
    if (remoteHits) return paletteRows(remoteHits, state.nodes, pendingAll);
    const q = searchQuery.trim().toLowerCase();
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
  }, [state, searchQuery, remoteHits, pendingAll]);

  const pickSearchResult = (row: PaletteRow) => {
    // A pick clears the query (the result list collapses; the dim lifts)
    // and yields focus back toward the board — the input itself stays.
    setSearchQuery("");
    searchInputRef.current?.blur();
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
    if (!submapMap || !lens.owner) return submapMap;
    const keep = lens.docId
      ? docLensNodeIds(submapMap.nodes, lens.docId)
      : lens.nodeId
        ? lensSet(submapMap, lens.nodeId, lens.depth ?? 1)
        : null;
    if (!keep) return submapMap;
    return {
      ...submapMap,
      nodes: submapMap.nodes.filter((n) => keep.has(n.id)),
      edges: submapMap.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }, [submapMap, lens]);

  // FILTER (R7, finding #8) — TERMINAL to the board chain, AFTER visibleMap
  // (filtering before the lens BFS would distort the neighborhood — ruled). It
  // HIDES non-matching nodes (distinct from spotlight's DIM); both views consume
  // it. A filter change is a map change, so it rides R6 mergeLayout (positions +
  // selection preserved). The facet OPTIONS derive from the PRE-filter map so an
  // option never vanishes as you select it.
  const filteredMap = useMemo(
    () => (visibleMap ? filterMap(visibleMap, filter) : visibleMap),
    [visibleMap, filter],
  );
  const filterFacetOptions = useMemo(
    () => (visibleMap ? filterFacets(visibleMap) : { statuses: [], tiers: [], tags: [] }),
    [visibleMap],
  );

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
  // compose. R4 R1: the same handler now serves the ratify-anywhere menus,
  // so refusals surface body.error verbatim (promoteProposal precedent) —
  // and the typed zoned 409 renders its promote-first teaching
  // (rulingErrorMessage, state/nodeMenu.ts).
  const ruleProposal = (id: string, ruling: Ruling) =>
    fetch(`/proposals/${id}/ruling${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruling }),
    })
      .then(async (r) => {
        if (r.ok) return;
        const body = (await r.json().catch(() => null)) as unknown;
        throw new Error(rulingErrorMessage(r.status, body));
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

  // IC-c — move a PENDING proposal INTO a zone (POST /proposals/:id/zone, the
  // inverse of promote). Used by the group-selected-into-a-zone flow.
  const proposalZoneMove = (id: string, zoneId: string) =>
    fetch(`/proposals/${id}/zone${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zoneId }),
    }).then((r) => {
      if (!r.ok) throw new Error(`zone-move ${r.status}`);
    });

  // IC-c — commit the group modal into an EXISTING zone: move each selected
  // pending proposal in, then switch the board to that zone (attention follows
  // the work) and clear the modal + selection.
  const commitGroupInto = (zoneId: string) => {
    if (!zoneGroup) return;
    Promise.all(zoneGroup.pendingIds.map((id) => proposalZoneMove(id, zoneId)))
      .then(() => {
        setActiveZone(zoneId);
        setActiveAnchor(null);
        setSelectedIds([]);
        setZoneGroup(null);
      })
      .catch((e) => {
        setZoneGroup(null);
        setNotice(`couldn't group those (${e instanceof Error ? e.message : String(e)}).`);
      });
  };

  // IC-c — commit the group modal into a NEW zone: create it (the daemon
  // derives the slug id and returns the Zone), then move each proposal in.
  const commitGroupNewZone = (name: string) => {
    const n = name.trim();
    if (!n) return;
    fetch(`/zones${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: n }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: unknown } | null;
          throw new Error(typeof body?.error === "string" ? body.error : `zone ${r.status}`);
        }
        return (await r.json()) as Zone;
      })
      .then((zone) => commitGroupInto(zone.id))
      .catch((e) => {
        setZoneGroup(null);
        setNotice(`couldn't create that zone (${e instanceof Error ? e.message : String(e)}).`);
      });
  };

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
  // both name elements of the board being left. It also drops any open submap:
  // submap navigation is a main-board act (zones and submaps are orthogonal,
  // but the surface keeps one drill-context at a time to stay legible).
  const switchZone = (zoneId: string | null) => {
    if (zoneId === activeZone) return;
    setActiveZone(zoneId);
    setActiveAnchor(null);
    setSelectedIds([]);
    setLens(DEFAULT_LENS);
  };

  // SG2 — drill into / navigate submaps. Clears view-local attention like a
  // zone switch (selection + lens name the board being left). enterSubmap
  // gates on the node actually HAVING a submap — a childless drill would
  // strand the user on a board holding only the context node.
  const switchAnchor = (anchor: string | null) => {
    if (anchor === activeAnchor) return;
    setActiveAnchor(anchor);
    setSelectedIds([]);
    setLens(DEFAULT_LENS);
  };
  const enterSubmap = (nodeId: string) => {
    const node = state?.nodes.find((n) => n.id === nodeId);
    if (!node || (node.submapChildCount ?? 0) === 0) return;
    switchAnchor(nodeId);
  };

  // R7 SUBMAPPEND — flush the deferred drill-in once the freshly-minted parent
  // node has landed in state (the ratify-batch snapshot refetch). Drilling in
  // earlier would set activeAnchor to a not-yet-present node and the SG2 re-home
  // effect would bounce it back to top-level. Inlines switchAnchor's body (the
  // stable setStates) rather than calling it — no submapChildCount gate
  // (enterSubmap's) because the children's anchorNodeId flips ride the same
  // snapshot, and no dep churn from a per-render closure.
  useEffect(() => {
    if (!pendingAnchor || !state) return;
    if (state.nodes.some((n) => n.id === pendingAnchor)) {
      setActiveAnchor(pendingAnchor);
      setSelectedIds([]);
      setLens(DEFAULT_LENS);
      setPendingAnchor(null);
    }
  }, [pendingAnchor, state]);

  // IC-b — the drag-connect batch: one node proposal + one edge proposal from
  // the drag's source to the new node, in a single txn (propose-batch, local
  // ref resolves the pending endpoint). author:"user" — this is a human
  // sketch, not the casting loop's bulk write. No zone tagging (batch can't;
  // the affordance is gated to the main board upstream), so this always lands
  // in the main queue.
  const proposeBatchConnect = (source: string, title: string) =>
    fetch(`/proposals/batch${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodes: [{ ref: "new", draft: { title }, author: "user" }],
        edges: [{ draft: { source, target: "new" }, author: "user" }],
      }),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`propose ${r.status}`);
      })
      .catch((e) =>
        setNotice(`couldn't sketch that (${e instanceof Error ? e.message : String(e)}).`),
      );

  // IC-a/IC-b — the free-text add-node modal's submit. A drag-connect (connectFrom
  // set) fans a node+edge batch; a plain add sketches one node. The free text
  // becomes the node's title (the agent's proposal.added is its refine signal —
  // no separate message). No optimistic append — the pending overlay renders it
  // when proposal.added round-trips (one source of truth, same as messages).
  const submitAddNode = () => {
    if (!addNode) return;
    const text = addNode.text.trim();
    if (!text) return;
    if (addNode.connectFrom) proposeBatchConnect(addNode.connectFrom, text);
    else proposeAsUser("node", { title: text });
    setAddNode(null);
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

  // R6 DEL — the NODE delete's fetch half (the 409-body parse is pure,
  // state/deleteFlow.ts). Unforced first, always; a recognizable node-cited
  // 409 (edges + children) escalates the SAME dialog to its provenance stage;
  // anything else degrades to the notice bar. On force the daemon cascades
  // (drop touching edges, re-parent children) and emits node.deleted, which
  // the reducer reconciles locally.
  const requestNodeDelete = (force: boolean) => {
    if (!deleteNode) return;
    const id = deleteNode.node.id;
    const forceQs = projectQs ? `${projectQs}&force=1` : "?force=1";
    fetch(`/nodes/${id}${force ? forceQs : projectQs}`, { method: "DELETE" })
      .then(async (r) => {
        if (r.ok) {
          setDeleteNode(null);
          return;
        }
        if (r.status === 409) {
          const cited = parseNodeCitedBody(await r.json().catch(() => null));
          if (cited) {
            setDeleteNode((t) => (t ? { ...t, citedBy: cited } : t));
            return;
          }
        }
        throw new Error(`delete ${r.status}`);
      })
      .catch((e) => {
        setDeleteNode(null);
        setNotice(`couldn't delete that idea (${e instanceof Error ? e.message : String(e)}).`);
      });
  };

  // R6 DEL — the PROPOSAL delete (thin, no guard): the litter-clearing path
  // shared by the dialog's proposal branch AND the ingestion tray's per-item
  // discard. Emits proposal.deleted; the reducer drops the row.
  const deleteProposal = (id: string) =>
    fetch(`/proposals/${id}${projectQs}`, { method: "DELETE" })
      .then((r) => {
        if (!r.ok) throw new Error(`delete ${r.status}`);
        setDeleteNode((t) => (t?.node.id === id ? null : t));
      })
      .catch((e) =>
        setNotice(`couldn't discard that (${e instanceof Error ? e.message : String(e)}).`),
      );

  // TAGS (R7) — wholesale-replace a target's tags (PUT /tags/:targetId; the
  // body IS the bare array, setTags parses it directly). Target = a node id OR
  // a pending proposal's synthetic id (the synthetic-node-id-IS-proposal-id
  // convention). No optimistic edit — tags.set round-trips through the reducer
  // (one source of truth, same as every write here); a failure degrades to the
  // notice bar, never the board.
  const setNodeTags = (targetId: string, tags: string[]) =>
    fetch(`/tags/${targetId}${projectQs}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tags),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`tags ${r.status}`);
      })
      .catch((e) =>
        setNotice(`couldn't update tags (${e instanceof Error ? e.message : String(e)}).`),
      );

  // R6 SUBMAP-CREATE — anchor a node under a parent (the FIRST /nodes/* write
  // the surface makes; SG1's post-ratify, real-nodes-only act). One call per
  // child; the daemon emits node.anchored, the reducer flips each child's
  // anchorNodeId locally.
  const anchorNode = (id: string, parentId: string) =>
    fetch(`/nodes/${id}/anchor${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId }),
    }).then((r) => {
      if (!r.ok) throw new Error(`anchor ${r.status}`);
    });

  // R6 SUBMAP-CREATE — commit the group modal: anchor every selected node
  // EXCEPT the chosen parent under it, then drill into the new submap so the
  // human SEES the grouped children in their home (switchAnchor, not
  // enterSubmap — the local anchorNodeId flips populate the view immediately;
  // the parent's submapChildCount badge backfills on the next snapshot, the
  // known thin-node.anchored count tolerance).
  const commitSubmapGroup = (parentId: string) => {
    if (!submapGroup) return;
    const children = submapChildTargets(
      submapGroup.nodes.map((n) => n.id),
      parentId,
    );
    Promise.all(children.map((id) => anchorNode(id, parentId)))
      .then(() => {
        setSubmapGroup(null);
        setSelectedIds([]);
        switchAnchor(parentId);
      })
      .catch((e) => {
        setSubmapGroup(null);
        setNotice(`couldn't group those (${e instanceof Error ? e.message : String(e)}).`);
      });
  };

  // R7 SUBMAPPEND — commit the pending-group modal: the surface's FIRST
  // ratify-batch call. Ratify every selected pending proposal at ONE top-level
  // ruling and nest the non-parent children under the chosen parent (pending OR
  // an existing real node — the batch's idMap resolves either). Then drill into
  // the parent's new submap (its minted node id from idMap, or its own id when
  // the parent was already a real node). One round-trip, no per-proposal tier.
  const commitSubmapAppend = (parentRef: string, ruling: BatchRuling) => {
    if (!submapAppend) return;
    const { ids, anchors } = buildSubmapAppend(submapAppend.pendingIds, parentRef);
    fetch(`/proposals/ratify-batch${projectQs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ruling, ids, anchors }),
    })
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: unknown } | null;
          throw new Error(typeof body?.error === "string" ? body.error : `ratify ${r.status}`);
        }
        return (await r.json()) as { idMap?: Record<string, string> };
      })
      .then((res) => {
        // A pending parent's real node id lives in idMap; an existing-node
        // parent isn't in idMap and drills in under its own id. Park it — the
        // deferred-drill effect flushes once the minted node lands in state (a
        // just-minted parent isn't in local state until the refetch, so an
        // immediate drill would bounce off the SG2 re-home guard).
        const parentNodeId = res.idMap?.[parentRef] ?? parentRef;
        setSubmapAppend(null);
        setSelectedIds([]);
        setPendingAnchor(parentNodeId);
      })
      .catch((e) => {
        setSubmapAppend(null);
        setNotice(`couldn't nest those (${e instanceof Error ? e.message : String(e)}).`);
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
  // IC-c — the pending main-queue proposals currently selected (pure, tested):
  // the only things a "group into zone" move can carry, and the gate for the
  // affordance. Only offered on the main board (a zone view's synthetics are
  // already zoned).
  const selectedPending =
    activeZone === null ? selectedPendingProposalIds(state.proposals, selectedIds) : [];
  // R6 SUBMAP-CREATE — the selected RATIFIED nodes (real-nodes-only, the mirror
  // of selectedPending). ≥2 gates the "group under a node" affordance; main
  // board only (a zone view holds proposals, so this is empty there anyway).
  const ratifiedSel =
    activeZone === null ? ratifiedSelection(state.nodes, state.proposals, selectedIds) : [];
  // R7 SUBMAPPEND — the selected PENDING NODE proposals (main-queue, node-kind;
  // edges have no anchor). ≥2 gates the "ratify & nest as a submap" affordance,
  // main board only (a zoned proposal can't ratify while zoned).
  const selectedPendingNodes =
    activeZone === null ? pendingNodeProposalIds(state.proposals, selectedIds) : [];
  // R6 QUEUE — the raw items being curated (pure derive over the inclusive
  // store; decoupled from the active board view).
  const processing = processingItems(state.proposals);
  // T8 — layer 1 (my socket) and layer 2 (agent tails) stay separate;
  // dotState is the pure rule. `presence` is defensive-read: a pre-V1.x
  // daemon simply reads as no-agent, never crashes.
  const dot = dotState(status, state.presence?.agents ?? 0);
  // TAGS (R7) — the client-derived existing-tag set for NodeDetail's reuse
  // autocomplete (finding #4: the engine keeps no registry; this is the union
  // of every node's + proposal's tags off the snapshot we already hold).
  const allTags = existingTags(state.nodes, state.proposals);

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
        {/* R6 QUEUE — the ingestion tray toggle: raw human input awaiting
            curation. Shown only when something's ingesting (like review). */}
        {processing.length > 0 && (
          <Button
            variant="outline"
            size="auto"
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-pending"
            onClick={() => setIngestOpen((o) => !o)}
          >
            <Loader size={11} className="animate-pulse" aria-hidden />
            ingesting · {processing.length}
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
      {/* Z3 — the zone tab strip. R5 IC-c: ALWAYS rendered now (was gated on
          zones existing), so the FIRST zone is mintable from the UI too — the
          `+ zone` affordance closes the drive-3 first-zone-agent-only gap. */}
      <ZoneTabs
        zones={state.zones}
        active={activeZone}
        onSwitch={switchZone}
        onCreate={createZone}
        onDelete={(zone) => setZoneDelete({ zone, notEmpty: null })}
      />
      {/* SG2 — the submap breadcrumb: a strip (like the tabs) only while a
          submap is open; renders null otherwise. */}
      <SubmapBreadcrumb trail={breadcrumb} onNavigate={switchAnchor} />
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
              map={filteredMap ?? submapMap ?? state}
              selectedIds={selectedIds}
              onSelect={setSelectedIds}
              promotable={activeZone !== null}
              onNodeCommand={handleNodeCommand}
              highlightIds={palette ? palette.rows.map((r) => r.node.id) : null}
              spotlight={spotlightSets}
              menus={nodeMenus}
              onRule={ruleProposal}
              onAction={handleAction}
              focusRequest={focusRequest}
              onConnect={(source, target) => proposeAsUser("edge", { source, target })}
              // IC-b — the dead-drag path (drop on empty pane). Off inside a
              // zone: a batch can't tag the zone, so a sketch would silently
              // escape to main (placement dishonesty) — undefined disables it.
              onConnectToBlank={
                activeZone === null
                  ? (src) => setAddNode({ text: "", connectFrom: src })
                  : undefined
              }
              // IC-a — right-click the pane to add a node (free-text modal).
              onAddNode={() => setAddNode({ text: "", connectFrom: null })}
              // SG2 — double-click a node to enter its submap.
              onEnterSubmap={enterSubmap}
              panelTopRight={
                <>
                  {selectedPending.length > 0 && (
                    <Button
                      variant="outline"
                      size="auto"
                      className="px-2 py-1 text-[10px] uppercase tracking-wide text-pending"
                      title="Group the selected proposals into a zone"
                      onClick={() => setZoneGroup({ pendingIds: selectedPending })}
                    >
                      group · {selectedPending.length}
                    </Button>
                  )}
                  {/* R6 SUBMAP-CREATE — group ≥2 selected RATIFIED nodes under
                      one of them as a submap (real-nodes-only; the mirror of the
                      pending "group into zone" above). */}
                  {ratifiedSel.length >= 2 && (
                    <Button
                      variant="outline"
                      size="auto"
                      className="px-2 py-1 text-[10px] uppercase tracking-wide"
                      title="Group the selected ideas under one as a submap"
                      onClick={() => setSubmapGroup({ nodes: ratifiedSel })}
                    >
                      submap · {ratifiedSel.length}
                    </Button>
                  )}
                  {/* R7 SUBMAPPEND — ratify ≥2 selected PENDING proposals into a
                      submap in one ratify-batch call (the pending mirror of the
                      ratified "submap" affordance above). */}
                  {selectedPendingNodes.length >= 2 && (
                    <Button
                      variant="outline"
                      size="auto"
                      className="px-2 py-1 text-[10px] uppercase tracking-wide text-pending"
                      title="Ratify the selected proposals and nest them as a submap"
                      onClick={() => setSubmapAppend({ pendingIds: selectedPendingNodes })}
                    >
                      nest · {selectedPendingNodes.length}
                    </Button>
                  )}
                  <SpotlightToggle
                    active={spotlightOn}
                    enabled={selectedIds.length >= 2}
                    onToggle={() => setSpotlightOn((s) => !s)}
                  />
                  <FilterControl filter={filter} facets={filterFacetOptions} onFilter={setFilter} />
                  <ViewToggle view={view} onView={setView} />
                </>
              }
              panelBelowBar={Boolean(lens.owner)}
            />
          ) : (
            <>
              {/* V1 — the SAME visibleMap + matches the canvas gets: lens
                  narrows and search dims the grid by construction. */}
              <CardGrid
                map={filteredMap ?? submapMap ?? state}
                highlightIds={palette ? palette.rows.map((r) => r.node.id) : null}
                selectedIds={selectedIds}
                onSelect={setSelectedIds}
                menus={nodeMenus}
                onRule={ruleProposal}
                onAction={handleAction}
                promotable={activeZone !== null}
                onNodeCommand={handleNodeCommand}
              />
              {/* The toggle keeps its canvas-Panel perch in grid view too —
                  switching never moves the control out from under the
                  pointer. Same FocusBar dodge as the map view's Panel row:
                  the bar must never cover the way out of a view. */}
              <div
                className={`absolute right-4 z-10 flex items-center gap-1.5 ${lens.owner ? "top-14" : "top-4"}`}
              >
                <FilterControl filter={filter} facets={filterFacetOptions} onFilter={setFilter} />
                <ViewToggle view={view} onView={setView} />
              </div>
            </>
          )}
          {addNode && (
            <div className="absolute left-1/2 top-1/3 z-20 w-72 -translate-x-1/2 rounded-lg border border-edge bg-surface/95 p-3 shadow-xl backdrop-blur">
              <p className="mb-2 text-[10px] uppercase tracking-widest text-ink-faint">
                {addNode.connectFrom ? "sketch a connected idea" : "sketch an idea"}
              </p>
              {/* IC-a: a single free-text field (dictation-first) — say it in
                  your own words; the agent's refine (its proposal.added) is the
                  next move, no structured title/synopsis form. Cmd/Ctrl+Enter
                  sketches, Escape cancels. */}
              <Textarea
                autoFocus
                value={addNode.text}
                onChange={(e) => setAddNode({ ...addNode, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setAddNode(null);
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    submitAddNode();
                  }
                }}
                placeholder="what's the idea?…"
                aria-label="New idea"
                className="min-h-16 p-1.5 text-xs"
              />
              {/* Placement honesty (ratified): the sketch lands where layout
                  puts it, not where you clicked — no position rides the schema. */}
              <div className="mt-2 flex items-center justify-between gap-1.5">
                <p className="text-[10px] italic text-ink-faint">lands as a pending sketch.</p>
                <div className="flex gap-1.5">
                  <Button
                    variant="ghost"
                    size="auto"
                    className="px-2 py-1"
                    onClick={() => setAddNode(null)}
                  >
                    cancel
                  </Button>
                  <Button
                    size="auto"
                    className="px-2 py-1"
                    onClick={submitAddNode}
                    disabled={!addNode.text.trim()}
                  >
                    sketch
                  </Button>
                </div>
              </div>
            </div>
          )}
          {zoneGroup && (
            <ZoneGroupModal
              count={zoneGroup.pendingIds.length}
              zones={state.zones}
              onPickExisting={commitGroupInto}
              onCreateNew={commitGroupNewZone}
              onCancel={() => setZoneGroup(null)}
            />
          )}
          {submapGroup && (
            <SubmapGroupModal
              nodes={submapGroup.nodes}
              onPickParent={commitSubmapGroup}
              onCancel={() => setSubmapGroup(null)}
            />
          )}
          {submapAppend && (
            <SubmapAppendModal
              proposals={pendingAll.filter((n) => submapAppend.pendingIds.includes(n.id))}
              existingNodes={state.nodes}
              onCommit={commitSubmapAppend}
              onCancel={() => setSubmapAppend(null)}
            />
          )}
          {/* R4 S1 — the palette renders permanently at its perch (the
              icon button died; the input is its own clickable twin) and
              keeps the FocusBar top-14 dodge the button carried. */}
          <SearchPalette
            rows={palette?.rows ?? []}
            offBoard={palette?.offBoard ?? { docs: 0, messages: 0 }}
            query={searchQuery}
            onQuery={setSearchQuery}
            onPick={pickSearchResult}
            inputRef={searchInputRef}
            belowBar={Boolean(lens.owner)}
          />
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
                existingTags={allTags}
                onSetTags={setNodeTags}
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
            nodes={state.nodes}
            proposals={state.proposals}
            // BACKLINKS — route a clicked reference back to the map: select +
            // followFocus (zone/submap-aware), the inverse of the node→doc
            // onOpenSource jump (the search-pick precedent).
            onNavigate={(id) => {
              setSelectedIds([id]);
              followFocus(id);
            }}
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
        {ingestOpen && (
          <IngestionTray
            items={processing}
            onDelete={deleteProposal}
            onClose={() => setIngestOpen(false)}
          />
        )}
        <ConversationPanel
          nodes={state.nodes}
          docs={state.docs}
          disabled={status === "closed"}
          agentBadge={agentBadge}
          scrollRequest={scrollRequest}
          composerSeed={composerSeed}
          selection={selection}
          onDeselect={(id) => setSelectedIds((ids) => ids.filter((x) => x !== id))}
          messages={messages}
          // R4 G1 — the single choke point: selection ∪ open doc (the
          // ratified open-doc-is-rail-selection mapping), bundled by the
          // pure tested helper. groundRefs.ts already renders the doc: ref
          // back as a chip on the round-trip.
          onSend={(text) =>
            sendMessage(
              text,
              groundBundle(
                selection.map((n) => n.id),
                openDoc?.doc.id ?? null,
              ),
            )
          }
        />
      </div>
      {/* R4 B1 — the build-stamp footer: release mode only (buildInfo is
          spread at the /state handler; absent = dev mode / pre-stamp dist /
          old daemon = no footer at all). A full-width strip, not a board
          overlay — nothing for the coverage audit to cover. */}
      {state.buildInfo && (
        <footer
          className={`border-t border-edge bg-surface px-4 py-0.5 text-[9px] ${
            state.buildInfo.stale ? "text-attention" : "text-ink-faint"
          }`}
        >
          {buildFooterText(state.buildInfo)}
        </footer>
      )}
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
      {deleteNode && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setDeleteNode(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {deleteNode.citedBy
                  ? `"${deleteNode.node.title}" is still cited`
                  : `delete "${deleteNode.node.title}"?`}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {deleteNode.kind === "proposal"
                  ? "This removes the proposal from the board. (Reject keeps it as history; delete is a hard remove.)"
                  : deleteNode.citedBy
                    ? `${deleteNode.citedBy.edges} relation${
                        deleteNode.citedBy.edges === 1 ? "" : "s"
                      } and ${deleteNode.citedBy.children} submap child${
                        deleteNode.citedBy.children === 1 ? "" : "ren"
                      } reference it. Deleting drops those relations and re-homes the children to the top level — the children survive (they're real ideas).`
                    : "The idea is removed from the map. Relations touching it and any submap children go with the force step if it's still cited."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button
                variant="ghost"
                size="auto"
                className="px-2.5 py-1"
                onClick={() => setDeleteNode(null)}
              >
                cancel
              </Button>
              <Button
                size="auto"
                className="px-2.5 py-1 text-attention"
                onClick={() => {
                  if (deleteNode.kind === "proposal") deleteProposal(deleteNode.node.id);
                  else requestNodeDelete(Boolean(deleteNode.citedBy));
                }}
              >
                {deleteNode.citedBy ? "delete anyway" : "delete"}
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
