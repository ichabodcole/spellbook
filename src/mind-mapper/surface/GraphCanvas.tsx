// The swappable canvas. The contract with the rest of the surface is ONLY the
// props below — React Flow (the first candidate lib, per the spike brief) is
// an implementation detail of this file, so a sigma.js/Cytoscape candidate can
// swap in behind the same seam.

import dagre from "@dagrejs/dagre";
import {
  applyNodeChanges,
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { forceCenter, forceLink, forceManyBody, forceSimulation } from "d3-force";
import { CircleDashed, FolderTree, Lightbulb, Loader, MapPin, User, Wand2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type NodeCommand, NodeContextMenu } from "./NodeContextMenu";
import type { MultiSelectActions } from "./state/multiSelect";
import type { NodeMenuInfo } from "./state/nodeMenu";
import type { BatchRuling } from "./state/submapAppend";
import { TAG_CHIP } from "./state/tags";
import type { ActionSlot, MapNode, NodeKind, Ruling, StubMap, Tier } from "./types";
import { Button } from "./ui/button";

export type GraphCanvasProps = {
  map: StubMap;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onNodeCommand: (command: NodeCommand, node: MapNode) => void;
  // Search coupling (t-934fc210): null = no search active; otherwise the ids
  // that match — everything else dims.
  highlightIds?: string[] | null;
  // R5 SL — the spotlight lens: null = inactive; otherwise the LIT sets (the
  // selected nodes ∪ their shared neighbors, and the joining edges). Its OWN
  // dim channel, separate from search's highlightIds (they'd collide): nodes
  // reuse the opacity-20 idiom, edges get the NEW render overlay below.
  spotlight?: { nodes: Set<string>; edges: Set<string> } | null;
  // Imperative "look here": bump seq to pan/zoom the canvas to a node. The
  // same primitive an agent-side "look here" verb will drive in V1.
  focusRequest?: { nodeId: string; seq: number } | null;
  // T9 human authoring — drag a handle-to-handle connection between two
  // EXISTING nodes to sketch an edge claim (the caller proposes it; nothing
  // lands until ratified).
  onConnect?: (source: string, target: string) => void;
  // R5 IC-b — a drag that ENDS ON THE EMPTY PANE (no target node) sketches a
  // NEW node connected to the source (the pending-endpoint pattern; the caller
  // fans a node+edge proposal in one batch). Fixes the dead drag. Absent =
  // the affordance is off (e.g. inside a zone, where a batch can't tag it).
  onConnectToBlank?: (sourceNodeId: string) => void;
  // R5 IC-a — right-click the empty pane to add a node (free-text modal). The
  // caller opens it; placement honesty holds (no click point carried — layout
  // decides where the sketch lands). Replaces the retired pane double-click.
  onAddNode?: () => void;
  // R5 SG2 — double-click a node to enter its submap (the caller drills the
  // view in; the double-click's old job — sketch a node — moved to onAddNode).
  onEnterSubmap?: (nodeId: string) => void;
  // V1 — App's view control (map|grid) rides the canvas Panel top-right,
  // next to the layout toggle. A slot, not view state: the canvas stays
  // ignorant of the grid's existence (the tree|physics toggle shows only in
  // map view for free — this component is only mounted there).
  panelTopRight?: ReactNode;
  // Round 3 (Claim Z2/Z3) — zone context only: every node here is a zoned
  // proposal, so the context menu gains Promote (a MOVE to the main review
  // queue). The main board never sets this — promotion is meaningless there.
  promotable?: boolean;
  // An active FocusBar spans the canvas top edge and would COVER this Panel
  // row (a control that switches views must never be coverable by what it
  // controls — found live when Playwright couldn't click the toggle under a
  // doc lens). The caller sets this whenever its bar is showing.
  panelBelowBar?: boolean;
  // R4 R1 — per-target menu info (ruling verbs for pending proposals),
  // keyed by the id the rendered node wears (state/nodeMenu.ts). A
  // render-time overlay like `dimmed`, never node state.
  menus?: Map<string, NodeMenuInfo>;
  onRule?: (proposalId: string, ruling: Ruling) => void;
  // R4 A1 — action-slot click (seeds the composer; the caller owns that).
  onAction?: (action: ActionSlot, node: MapNode) => void;
  // drive7 #5A — position-carry-across-ratify: mintedNodeId → proposalId (built
  // from state.proposals[].resultNodeId). A ratified node inherits its
  // proposal's on-screen spot instead of taking a fresh dagre slot that
  // collides. A render-time hint, not node state.
  ratifyAlias?: Map<string, string>;
  // drive7 #6A — the selection-aware menu: per-node multi-actions (valid with
  // that node as the submap parent/anchor over the current selection), the live
  // selection count, and the inline commit handlers. A render-time overlay like
  // `menus`, keyed by node id.
  multiMenus?: Map<string, MultiSelectActions>;
  selectionCount?: number;
  onGroupSubmap?: (parentId: string) => void;
  onNestSubmap?: (parentId: string, tier: BatchRuling) => void;
  onGroupZone?: () => void;
};

const NODE_W = 190;
const NODE_H = 76;

// Literal class strings on purpose — Tailwind's @source scan only sees
// literal text, so tier styling lives in a lookup, never string-built.
// Exported (with KIND_ICON / TIER_LABEL below) as the node-card vocabulary —
// CardGrid (V1) reuses them so a node reads identically in both views; the
// literal-text constraint makes shared lookups the reuse unit.
export const TIER_CARD: Record<Tier, string> = {
  canon: "border-canon text-canon",
  thread: "border-thread-tier text-thread-tier",
  "story-local": "border-story-local text-story-local",
  background: "border-background-tier text-background-tier",
};

export const TIER_LABEL: Record<Tier, string> = {
  canon: "canon",
  thread: "thread",
  "story-local": "story-local",
  background: "background",
};

export const KIND_ICON: Record<NodeKind, typeof User> = {
  cast: User,
  place: MapPin,
  concept: Lightbulb,
  thread: CircleDashed,
};

export type IdeaNodeData = {
  node: MapNode;
  onCommand: (command: NodeCommand) => void;
  dimmed?: boolean;
  promotable?: boolean;
  // R4 R1 — render-time menu overlay + ref-stable ruling dispatcher (the
  // chassis is shared with CardGrid, NodeContextMenu.tsx).
  menu?: NodeMenuInfo;
  onRule?: (proposalId: string, ruling: Ruling) => void;
  onAction?: (action: ActionSlot, node: MapNode) => void;
  // drive7 #6A — the selection-aware menu overlay (render-time, like `menu`).
  multi?: MultiSelectActions | null;
  selectionCount?: number;
  onGroupSubmap?: (parentId: string) => void;
  onNestSubmap?: (parentId: string, tier: BatchRuling) => void;
  onGroupZone?: () => void;
};

function IdeaNode({ data, selected }: NodeProps<Node<IdeaNodeData>>) {
  const n = data.node;
  const Icon = KIND_ICON[n.kind];
  const steeping = n.tier === "background";
  return (
    <NodeContextMenu
      node={n}
      menu={data.menu}
      promotable={data.promotable}
      onCommand={data.onCommand}
      onRule={data.onRule}
      onAction={data.onAction}
      multi={data.multi}
      selectionCount={data.selectionCount}
      onGroupSubmap={data.onGroupSubmap}
      onNestSubmap={data.onNestSubmap}
      onGroupZone={data.onGroupZone}
    >
      <div
        className={`w-[190px] rounded-lg border bg-surface px-3 py-2 shadow-lg transition-all ${TIER_CARD[n.tier]} ${
          n.processing ? "border-dotted" : n.pending ? "border-dashed" : ""
        } ${steeping ? "opacity-60 blur-[0.3px]" : ""} ${
          selected ? "ring-2 ring-ink shadow-xl" : ""
        } ${data.dimmed ? "opacity-20" : ""}`}
      >
        <Handle type="target" position={Position.Top} className="!bg-edge !border-0" />
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest">
          <Icon size={11} aria-hidden />
          <span>{TIER_LABEL[n.tier]}</span>
          {/* PROC (R6) — a raw author:"user" proposal reads as "curating" (the
              agent will refine it), DISTINCT from a plain agent "proposed"
              sketch. A gentle pulse: this is a genuinely in-progress state that
              resolves on ratify/delete (not the stalled-badge false-liveness
              case — that one stays static). */}
          {n.processing ? (
            <span className="ml-auto flex animate-pulse items-center gap-0.5 rounded-sm border border-dotted border-pending px-1 normal-case tracking-normal text-pending">
              <Loader size={9} aria-hidden /> curating
            </span>
          ) : (
            n.pending && (
              <span className="ml-auto rounded-sm border border-dashed border-pending px-1 normal-case tracking-normal text-pending">
                proposed
              </span>
            )
          )}
          {/* SG2 — the "has a submap" folder affordance (double-click / menu
              to enter). Never on a pending proposal (count 0 there); shares the
              ml-auto slot with the proposed badge, which never co-occurs. */}
          {!n.pending && (n.submapChildCount ?? 0) > 0 && (
            <span
              className="ml-auto flex items-center gap-0.5 rounded-sm border border-thread-tier px-1 normal-case tracking-normal text-thread-tier"
              title={`has a submap (${n.submapChildCount} inside)`}
            >
              <FolderTree size={9} aria-hidden />
              {n.submapChildCount}
            </span>
          )}
        </div>
        {/* MENU(b) — clamp a long title to two lines on the fixed-width card
            (NODE_W); it used to overflow the box. */}
        <div className="mt-1 line-clamp-2 font-story text-[15px] leading-tight text-ink">
          {n.title}
        </div>
        {/* TAGS (R7) — a freeform-tag row UNDER the title (a new row, not the
            crowded ml-auto header slot which holds proposed/curating/submap).
            Capped to 3 chips + a "+N" so a heavily-tagged card can't balloon;
            the full set lives in NodeDetail. absent = none = no row. */}
        {n.tags && n.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {n.tags.slice(0, 3).map((t) => (
              <span
                key={t}
                className={`max-w-full truncate rounded-sm px-1 py-px text-[9px] ${TAG_CHIP}`}
              >
                {t}
              </span>
            ))}
            {n.tags.length > 3 && (
              <span className="text-[9px] text-ink-faint">+{n.tags.length - 3}</span>
            )}
          </div>
        )}
        <Handle type="source" position={Position.Bottom} className="!bg-edge !border-0" />
      </div>
    </NodeContextMenu>
  );
}

const nodeTypes = { idea: IdeaNode };

export type LayoutMode = "tree" | "physics";

function dagreLayout(
  map: StubMap,
  onCommand: (command: NodeCommand, node: MapNode) => void,
): Node<IdeaNodeData>[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 42, ranksep: 64 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of map.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of map.edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return map.nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: "idea",
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { node: n, onCommand: (command) => onCommand(command, n) },
    };
  });
}

const FORCE_CANVAS_W = 1400;
const FORCE_CANVAS_H = 900;
const FORCE_SETTLE_TICKS = 300;

// Settle-then-snapshot (vine msg 54/56, Cole's ruling pending on whether the
// motion itself is the point): runs the simulation to rest synchronously and
// returns final positions, the same one-shot shape dagreLayout already has —
// deliberately NOT wired to a live tick loop yet. `computeForcePositions`
// is kept separate from the Node[] mapping below so a later live-animated
// mode can reuse it per-frame (call with fewer ticks, or none, in a
// requestAnimationFrame loop) without restructuring this function.
export function computeForcePositions(map: StubMap): Map<string, { x: number; y: number }> {
  type SimNode = { id: string; x: number; y: number };
  const nodes: SimNode[] = map.nodes.map((n, i) => {
    // Deterministic starting ring (not Math.random — reasoning-turn
    // reproducibility) so re-toggling the same map settles the same way.
    const angle = (i / Math.max(1, map.nodes.length)) * Math.PI * 2;
    return {
      id: n.id,
      x: FORCE_CANVAS_W / 2 + Math.cos(angle) * 200,
      y: FORCE_CANVAS_H / 2 + Math.sin(angle) * 200,
    };
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const links = map.edges
    .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
    .map((e) => ({ source: e.source, target: e.target }));

  const sim = forceSimulation(nodes)
    .force("charge", forceManyBody().strength(-500))
    .force(
      "link",
      forceLink(links)
        .id((d: unknown) => (d as SimNode).id)
        .distance(150),
    )
    .force("center", forceCenter(FORCE_CANVAS_W / 2, FORCE_CANVAS_H / 2))
    .stop();
  for (let i = 0; i < FORCE_SETTLE_TICKS; i++) sim.tick();

  return new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
}

function forceLayout(
  map: StubMap,
  onCommand: (command: NodeCommand, node: MapNode) => void,
): Node<IdeaNodeData>[] {
  const positions = computeForcePositions(map);
  return map.nodes.map((n) => {
    const pos = positions.get(n.id) ?? { x: 0, y: 0 };
    return {
      id: n.id,
      type: "idea",
      position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      data: { node: n, onCommand: (command) => onCommand(command, n) },
    };
  });
}

function layout(
  mode: LayoutMode,
  map: StubMap,
  onCommand: (command: NodeCommand, node: MapNode) => void,
): Node<IdeaNodeData>[] {
  return mode === "physics" ? forceLayout(map, onCommand) : dagreLayout(map, onCommand);
}

// RENDER (finding #5): the layout effect used to blind-`setNodes(layout(...))`
// on every `map` change — a wholesale replace that races React Flow's async
// ResizeObserver onNodesChange across a rapid proposal.added burst (each event
// is its own render tick), dropping earlier nodes from view. mergeLayout is the
// deterministic fix: for the FULL fresh node set, a KNOWN id keeps its
// on-screen position + selection (drag-safe, and the burst-race can't drop it),
// a NEW id takes the freshly-computed layout position, and a DEPARTED id is
// dropped (simply absent from `fresh`). Data is always the fresh copy
// (pending→ratified, title, submapChildCount, the identity-stable command
// closure). Bonus: a re-layout no longer clobbers a manual drag position.
//
// position-carry-across-ratify (drive7 #5A — DISTINCT from the RENDER race
// above that this same function already fixes): ratify mints a NEW node id
// (proposalId → nodeId), so the ratified node reads to mergeLayout as brand-new
// and takes a fresh dagre slot that collides with whatever's already there
// ("lands under another node"). The lead's diagnosis (alias the proposal's spot
// on the node.ratified event) is CORRECT in cause but INCOMPLETE in mechanism:
// node.ratified only flips the proposal out of "pending" (its synthetic drops
// from the board a render BEFORE the minted node arrives via the async snapshot
// refetch — useProjectState), and `resultNodeId` (the alias) isn't set until
// that refetch either. So the proposal's on-screen position is gone from `prev`
// by the time the minted node first renders — an alias-from-prev alone can't
// find it. The fix carries a `posMemory` (last-known position by id, retained
// even after a node transiently leaves the board) so the vanished synthetic's
// spot survives the two-render gap, plus the `alias` (mintedNodeId → proposalId,
// built from resultNodeId) to recover it. Surface-only: resultNodeId already
// rides /state.proposals[] (R5/R6 wire) — no engine change. Pinned by the
// two-render-sequence test in GraphCanvas.test.ts.
export type XY = { x: number; y: number };

export function mergeLayout(
  prev: Node<IdeaNodeData>[],
  fresh: Node<IdeaNodeData>[],
  carry?: { alias?: Map<string, string>; posMemory?: Map<string, XY> },
): Node<IdeaNodeData>[] {
  const prevById = new Map(prev.map((n) => [n.id, n]));
  return fresh.map((f) => {
    const existing = prevById.get(f.id);
    if (existing) return { ...f, position: existing.position, selected: existing.selected };
    // position-carry-across-ratify: a minted node inherits its proposal's
    // last-known spot (prev if the synthetic is still there, else posMemory,
    // which outlives the transient disappearance).
    const proposalId = carry?.alias?.get(f.id);
    if (proposalId) {
      const pos = prevById.get(proposalId)?.position ?? carry?.posMemory?.get(proposalId);
      if (pos) return { ...f, position: pos };
    }
    return f;
  });
}

function toFlowEdges(map: StubMap): Edge[] {
  // A reverse PAIR (A→B and B→A, two separate claims) must read as two
  // distinct labeled curves. The curves already differ (top/bottom handles),
  // but both labels land at the bezier midpoint and stack — and curvature
  // can't separate them when dagre stacks the nodes vertically. So: bow the
  // pair apart AND nudge each label off-center in opposite directions,
  // deterministically by direction.
  const directed = new Set(map.edges.map((e) => `${e.source}|${e.target}`));
  return map.edges.map((e) => {
    const isPair = directed.has(`${e.target}|${e.source}`);
    const primary = e.source < e.target;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      type: "default",
      ...(isPair && {
        pathOptions: { curvature: primary ? 0.55 : 0.2 },
      }),
      className: e.provenance === "derived" ? "mm-edge-derived" : "mm-edge-asserted",
      animated: Boolean(e.pending),
      // React Flow applies label colors as inline styles — CSS can't win here.
      labelStyle: {
        fill: e.pending
          ? "var(--color-pending)"
          : e.provenance === "derived"
            ? "var(--color-ink-faint)"
            : "var(--color-ink-dim)",
        fontSize: 10,
        fontStyle: e.provenance === "derived" ? "italic" : "normal",
        ...(isPair && {
          transform: primary ? "translate(-28px, -12px)" : "translate(28px, 12px)",
        }),
      },
      labelBgStyle: {
        fill: "var(--color-surface)",
        fillOpacity: 0.9,
        // The bg rect is a sibling of the text, not a parent — it needs the
        // same nudge or the text walks off its plate.
        ...(isPair && {
          transform: primary ? "translate(-28px, -12px)" : "translate(28px, 12px)",
        }),
      },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      style: {
        stroke: e.pending ? "var(--color-pending)" : "var(--color-ink-faint)",
        strokeDasharray: e.provenance === "derived" ? "2 4" : undefined,
        opacity: e.pending ? 0.8 : e.provenance === "derived" ? 0.6 : 0.9,
      },
      // Symmetric claims (direction:"both", seam v3) render arrowless — the
      // Mermaid map's ---|old friends| vocabulary. Directed claims keep the arrow.
      markerEnd:
        e.direction === "both"
          ? undefined
          : { type: MarkerType.ArrowClosed, width: 14, height: 14 },
    };
  });
}

export function GraphCanvas({
  map,
  selectedIds,
  onSelect,
  onNodeCommand,
  highlightIds,
  spotlight,
  focusRequest,
  onConnect,
  onConnectToBlank,
  onAddNode,
  onEnterSubmap,
  panelTopRight,
  promotable,
  panelBelowBar,
  menus,
  onRule,
  onAction,
  ratifyAlias,
  multiMenus,
  selectionCount,
  onGroupSubmap,
  onNestSubmap,
  onGroupZone,
}: GraphCanvasProps) {
  // React Flow is used semi-controlled: this component owns node state (so
  // drag + click-select work), reports selection upward (deduped — an
  // unconditional setState here is an infinite render loop), and applies
  // external deselects (chip ×) back onto node state, guarded the same way.
  const [nodes, setNodes] = useState<Node<IdeaNodeData>[]>([]);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("tree");
  const edges = useMemo(() => toFlowEdges(map), [map]);
  const lastReported = useRef<string>("");
  // When App DRIVES the selection (Focus, search-pick, SC's multi-select),
  // React Flow emits transitional onSelectionChange events (the stale prior
  // selection, then the new one) as it reconciles the controlled `nodes`
  // prop. Feeding those back through onSelect ping-pongs App→RF→App forever
  // ("Maximum update depth") — a MULTI-select set (SC) never settles. So a
  // pending App-driven key gates the reverse channel: transitional reports
  // are ignored until React Flow confirms the exact key we asked for (or a
  // short safety timer elapses, so a missed confirm can't freeze selection).
  const pendingSelect = useRef<string | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // IC-b — drag-connect tracking: onConnectStart records the source node;
  // onConnect (a landed connection) marks it completed; onConnectEnd fires the
  // dead-drag path only when the drag ended UNCOMPLETED on the empty pane.
  const connectSource = useRef<string | null>(null);
  const connectCompleted = useRef(false);
  // drive7 #5A — position memory: last-known position by id, retained even
  // after a node transiently leaves the board (the ratify two-render gap: the
  // pending synthetic drops a render before the minted node arrives). Read via
  // the alias in mergeLayout so a ratified node keeps its spot. Read latest
  // alias through a ref so the layout effect needn't dep on it.
  const posMemory = useRef(new Map<string, XY>());
  const aliasRef = useRef(ratifyAlias);
  aliasRef.current = ratifyAlias;

  // Commands dispatch through a ref so a new callback identity never forces
  // a node-state rebuild (layout depends on the map + mode alone). Rulings
  // ride the same idiom — the dispatcher below stays identity-stable.
  const commandRef = useRef(onNodeCommand);
  commandRef.current = onNodeCommand;
  const ruleRef = useRef(onRule);
  ruleRef.current = onRule;
  const dispatchRule = useCallback(
    (proposalId: string, ruling: Ruling) => ruleRef.current?.(proposalId, ruling),
    [],
  );
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const dispatchAction = useCallback(
    (action: ActionSlot, node: MapNode) => actionRef.current?.(action, node),
    [],
  );
  // #6A multi-select commit dispatchers — same ref-stable idiom so a fresh
  // callback identity never rebuilds node state.
  const groupSubmapRef = useRef(onGroupSubmap);
  groupSubmapRef.current = onGroupSubmap;
  const dispatchGroupSubmap = useCallback(
    (parentId: string) => groupSubmapRef.current?.(parentId),
    [],
  );
  const nestSubmapRef = useRef(onNestSubmap);
  nestSubmapRef.current = onNestSubmap;
  const dispatchNestSubmap = useCallback(
    (parentId: string, tier: BatchRuling) => nestSubmapRef.current?.(parentId, tier),
    [],
  );
  const groupZoneRef = useRef(onGroupZone);
  groupZoneRef.current = onGroupZone;
  const dispatchGroupZone = useCallback(() => groupZoneRef.current?.(), []);

  // RENDER (finding #5): a MAP change merges by id (mergeLayout — an in-flight
  // proposal.added burst can't drop settled nodes, and drags survive); a
  // layout-MODE toggle is a full replace (recompute ALL positions, or tree↔
  // physics would preserve stale positions and do nothing).
  const prevLayoutMode = useRef(layoutMode);
  useEffect(() => {
    const fresh = layout(layoutMode, map, (command, node) => commandRef.current(command, node));
    const modeChanged = prevLayoutMode.current !== layoutMode;
    prevLayoutMode.current = layoutMode;
    setNodes((prev) => {
      // Remember every prior on-screen position (incl. drags) BEFORE merging,
      // so a synthetic node's spot survives the ratify two-render gap
      // (position-carry-across-ratify).
      for (const n of prev) posMemory.current.set(n.id, n.position);
      if (modeChanged) return fresh;
      return mergeLayout(prev, fresh, { alias: aliasRef.current, posMemory: posMemory.current });
    });
  }, [map, layoutMode]);

  // drive7 #5B — Tidy: re-run the active layout and RESET every position (a
  // full replace, the escape hatch after a bulk ratify / import / manual mess
  // piles nodes up). Distinct from a map-change merge, which preserves spots.
  const retidy = useCallback(() => {
    posMemory.current.clear();
    setNodes(layout(layoutMode, map, (command, node) => commandRef.current(command, node)));
  }, [layoutMode, map]);

  useEffect(() => {
    const want = [...selectedIds].sort().join(",");
    // Claim this as the last reported selection BEFORE the setNodes below
    // re-renders: React Flow echoes an external (App-driven) selection back
    // through onSelectionChange, and without this claim a programmatic
    // MULTI-node select (SC) ping-pongs App→RF→App forever ("Maximum update
    // depth"). A genuine user change reports a different key and is honored.
    lastReported.current = want;
    // Arm the reverse-channel gate: ignore React Flow's transitional echoes
    // until it confirms this exact selection. The timer is a safety net.
    pendingSelect.current = want;
    if (pendingTimer.current) clearTimeout(pendingTimer.current);
    pendingTimer.current = setTimeout(() => {
      pendingSelect.current = null;
    }, 300);
    const wanted = new Set(selectedIds);
    setNodes((nds) => {
      // Replace ONLY the nodes whose selected flag actually flips — a
      // wholesale `nds.map(n => ({...n}))` hands React Flow all-new node
      // objects, which it treats as a fresh graph and reconciles by
      // collapsing a multi-selection back to the single active node (SC's
      // programmatic multi-select then oscillates forever). Identity-stable
      // untouched nodes let React Flow hold the full selection.
      let changed = false;
      const next = nds.map((n) => {
        const shouldSelect = wanted.has(n.id);
        if (Boolean(n.selected) === shouldSelect) return n;
        changed = true;
        return { ...n, selected: shouldSelect };
      });
      return changed ? next : nds;
    });
  }, [selectedIds]);

  // Search dim, the SL spotlight dim (its own channel), the zone view's
  // promotable flag, and R1's menu info are render-time overlays on node
  // data — node STATE (positions, selection) stays untouched by keystrokes,
  // spotlight, and view context alike. Search and spotlight OR into the one
  // opacity-20 visual (same look, two independent sources).
  const renderNodes = useMemo(() => {
    const keep = highlightIds ? new Set(highlightIds) : null;
    const lit = spotlight?.nodes ?? null;
    if (!keep && !lit && !promotable && !menus && !multiMenus) return nodes;
    return nodes.map((n) => {
      const searchDim = keep ? !keep.has(n.id) : false;
      const spotDim = lit ? !lit.has(n.id) : false;
      return {
        ...n,
        data: {
          ...n.data,
          ...((keep || lit) && { dimmed: searchDim || spotDim }),
          ...(promotable && { promotable: true }),
          menu: menus?.get(n.id),
          onRule: dispatchRule,
          onAction: dispatchAction,
          multi: multiMenus?.get(n.id) ?? null,
          selectionCount,
          onGroupSubmap: dispatchGroupSubmap,
          onNestSubmap: dispatchNestSubmap,
          onGroupZone: dispatchGroupZone,
        },
      };
    });
  }, [
    nodes,
    highlightIds,
    spotlight,
    promotable,
    menus,
    dispatchRule,
    dispatchAction,
    multiMenus,
    selectionCount,
    dispatchGroupSubmap,
    dispatchNestSubmap,
    dispatchGroupZone,
  ]);

  // R5 SL edge-dim — the NEW plumbing the lens never needed. toFlowEdges bakes
  // opacity by provenance/pending only; this overlay drops every non-lit edge
  // (path + label + label plate) to a faint trace so the joining edges read as
  // the spotlight, and restores untouched when inactive.
  const renderEdges = useMemo(() => {
    const lit = spotlight?.edges ?? null;
    if (!lit) return edges;
    return edges.map((e) => {
      if (lit.has(e.id)) return e;
      return {
        ...e,
        style: { ...e.style, opacity: 0.08 },
        labelStyle: { ...e.labelStyle, opacity: 0.12 },
        labelBgStyle: { ...e.labelBgStyle, fillOpacity: 0.12 },
      };
    });
  }, [edges, spotlight]);

  // Answer a focusRequest with a smooth pan/zoom to the node. lastSeq seeds
  // from the mount-time prop so a remount (the lens keys this component)
  // never replays a stale request.
  const instanceRef = useRef<{ fitView: (opts?: object) => Promise<boolean> } | null>(null);
  const lastSeq = useRef(focusRequest?.seq ?? 0);
  useEffect(() => {
    if (!focusRequest || focusRequest.seq === lastSeq.current) return;
    lastSeq.current = focusRequest.seq;
    instanceRef.current?.fitView({
      nodes: [{ id: focusRequest.nodeId }],
      duration: 500,
      maxZoom: 1.15,
    });
  }, [focusRequest]);

  const handleSelectionChange = useCallback(
    ({ nodes: sel }: { nodes: Node[] }) => {
      const ids = sel.map((n) => n.id);
      const key = [...ids].sort().join(",");
      // Gate on a pending App-driven selection: swallow transitional echoes,
      // and when React Flow confirms the exact key, close the gate WITHOUT
      // re-reporting (App already holds it).
      if (pendingSelect.current !== null) {
        if (key === pendingSelect.current) {
          pendingSelect.current = null;
          if (pendingTimer.current) clearTimeout(pendingTimer.current);
          lastReported.current = key;
        }
        return;
      }
      if (key === lastReported.current) return;
      lastReported.current = key;
      onSelect(ids);
    },
    [onSelect],
  );

  return (
    <ReactFlow
      nodes={renderNodes}
      edges={renderEdges}
      nodeTypes={nodeTypes}
      onInit={(instance) => {
        instanceRef.current = instance;
      }}
      onNodesChange={(changes) => setNodes((nds) => applyNodeChanges(changes, nds))}
      onSelectionChange={handleSelectionChange}
      // IC-b: record the drag's source node and reset the completed flag.
      onConnectStart={(_, params) => {
        connectSource.current = params.nodeId ?? null;
        connectCompleted.current = false;
      }}
      // T9: a completed handle-to-handle drag between two EXISTING nodes
      // reports the sketch upward; React Flow never adds the edge itself here
      // — the pending overlay renders it when the proposal.added round-trip
      // lands (one source of truth, same as messages). Mark completed so the
      // onConnectEnd dead-drag path stands down.
      onConnect={(conn) => {
        connectCompleted.current = true;
        if (conn.source && conn.target && conn.source !== conn.target) {
          onConnect?.(conn.source, conn.target);
        }
      }}
      // IC-b: the dead drag — a connection dropped on the empty pane (no target
      // node). Sketch a NEW node connected to the source. Guard on the pane
      // class so a drop onto a node (already handled by onConnect) passes by.
      onConnectEnd={(event) => {
        const src = connectSource.current;
        connectSource.current = null;
        if (connectCompleted.current || !src || !onConnectToBlank) return;
        const target = event.target;
        if (target instanceof Element && target.classList.contains("react-flow__pane")) {
          onConnectToBlank(src);
        }
      }}
      // SG2: double-click a node → enter its submap (the old pane-double-click
      // sketch job moved to onAddNode / right-click).
      onNodeDoubleClick={(_, node) => onEnterSubmap?.(node.id)}
      // IC-a: right-click the empty pane → add a node (free-text modal).
      onPaneContextMenu={(event) => {
        event.preventDefault();
        onAddNode?.();
      }}
      zoomOnDoubleClick={false}
      fitView
      minZoom={0.3}
      maxZoom={2}
      proOptions={{ hideAttribution: false }}
      nodesDraggable
      nodesConnectable={Boolean(onConnect)}
      selectionOnDrag
      panOnScroll
      multiSelectionKeyCode="Shift"
    >
      <Background gap={24} size={1} color="var(--color-edge)" />
      <Controls position="top-left" showInteractive={false} />
      <Panel
        position="top-right"
        className="flex items-center gap-1.5"
        // Inline, not a margin utility: React Flow's own `.react-flow__panel`
        // rule is UNLAYERED vendor CSS, so it beats any layered Tailwind
        // margin (the same precedence trap as the attribution plate, seat
        // doc R3 T1) — an inline style is the one thing that always wins.
        style={panelBelowBar ? { top: 40 } : undefined}
      >
        {panelTopRight}
        {/* drive7 #5B — Tidy: re-layout everything (resets positions) when the
            board piles up. Icon-only to keep the crowded Panel row short. */}
        <Button
          variant="outline"
          size="auto"
          className="flex items-center gap-1 px-2 py-1 text-[10px] uppercase tracking-wide"
          title="Tidy — re-run the layout and reset positions"
          onClick={retidy}
        >
          <Wand2 size={11} aria-hidden />
          tidy
        </Button>
        <Button
          variant="outline"
          size="auto"
          className="px-2 py-1 text-[10px] uppercase tracking-wide"
          title={layoutMode === "tree" ? "Switch to physics layout" : "Switch to tree layout"}
          onClick={() => setLayoutMode((m) => (m === "tree" ? "physics" : "tree"))}
        >
          {layoutMode === "tree" ? "tree" : "physics"}
        </Button>
      </Panel>
    </ReactFlow>
  );
}
