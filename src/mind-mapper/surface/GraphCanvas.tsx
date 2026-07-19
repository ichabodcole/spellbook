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
import {
  ArrowUpFromLine,
  CircleDashed,
  Crosshair,
  HelpCircle,
  Lightbulb,
  ListTree,
  MapPin,
  ScrollText,
  User,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapNode, NodeKind, StubMap, Tier } from "./types";
import { Button } from "./ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";

export type GraphCanvasProps = {
  map: StubMap;
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  onNodeCommand: (command: NodeCommand, node: MapNode) => void;
  // Search coupling (t-934fc210): null = no search active; otherwise the ids
  // that match — everything else dims.
  highlightIds?: string[] | null;
  // Imperative "look here": bump seq to pan/zoom the canvas to a node. The
  // same primitive an agent-side "look here" verb will drive in V1.
  focusRequest?: { nodeId: string; seq: number } | null;
  // T9 human authoring — drag a handle-to-handle connection to sketch an
  // edge claim (the caller proposes it; nothing lands until ratified).
  onConnect?: (source: string, target: string) => void;
  // T9 human authoring — double-click empty pane to sketch a node claim.
  // Placement honesty (ratified): the click point is NOT carried — the
  // schema has no positions, layout decides where the sketch lands.
  onPaneDoubleClick?: () => void;
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

// The node command vocabulary (context menu; born plural per t-609741be —
// future commands include agent actions). Promote appears in zone context
// only (Claim Z3).
export type NodeCommand = "Focus" | "Explain" | "Questions" | "Subtopics" | "Promote";

type IdeaNodeData = {
  node: MapNode;
  onCommand: (command: NodeCommand) => void;
  dimmed?: boolean;
  promotable?: boolean;
};

function IdeaNode({ data, selected }: NodeProps<Node<IdeaNodeData>>) {
  const n = data.node;
  const Icon = KIND_ICON[n.kind];
  const steeping = n.tier === "background";
  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <div
          className={`w-[190px] rounded-lg border bg-surface px-3 py-2 shadow-lg transition-all ${TIER_CARD[n.tier]} ${
            n.pending ? "border-dashed" : ""
          } ${steeping ? "opacity-60 blur-[0.3px]" : ""} ${
            selected ? "ring-2 ring-ink shadow-xl" : ""
          } ${data.dimmed ? "opacity-20" : ""}`}
        >
          <Handle type="target" position={Position.Top} className="!bg-edge !border-0" />
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest">
            <Icon size={11} aria-hidden />
            <span>{TIER_LABEL[n.tier]}</span>
            {n.pending && (
              <span className="ml-auto rounded-sm border border-dashed border-pending px-1 normal-case tracking-normal text-pending">
                proposed
              </span>
            )}
          </div>
          <div className="mt-1 font-story text-[15px] leading-tight text-ink">{n.title}</div>
          <Handle type="source" position={Position.Bottom} className="!bg-edge !border-0" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuLabel>{n.title}</ContextMenuLabel>
        <ContextMenuItem onClick={() => data.onCommand("Focus")}>
          <Crosshair /> Focus
        </ContextMenuItem>
        {data.promotable && (
          <ContextMenuItem onClick={() => data.onCommand("Promote")}>
            <ArrowUpFromLine /> Promote to main
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => data.onCommand("Explain")}>
          <ScrollText /> Explain
        </ContextMenuItem>
        <ContextMenuItem onClick={() => data.onCommand("Questions")}>
          <HelpCircle /> Questions
        </ContextMenuItem>
        <ContextMenuItem onClick={() => data.onCommand("Subtopics")}>
          <ListTree /> Subtopics
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
  focusRequest,
  onConnect,
  onPaneDoubleClick,
  panelTopRight,
  promotable,
  panelBelowBar,
}: GraphCanvasProps) {
  // React Flow is used semi-controlled: this component owns node state (so
  // drag + click-select work), reports selection upward (deduped — an
  // unconditional setState here is an infinite render loop), and applies
  // external deselects (chip ×) back onto node state, guarded the same way.
  const [nodes, setNodes] = useState<Node<IdeaNodeData>[]>([]);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>("tree");
  const edges = useMemo(() => toFlowEdges(map), [map]);
  const lastReported = useRef<string>("");

  // Commands dispatch through a ref so a new callback identity never forces
  // a node-state rebuild (layout depends on the map + mode alone).
  const commandRef = useRef(onNodeCommand);
  commandRef.current = onNodeCommand;

  useEffect(() => {
    setNodes(layout(layoutMode, map, (command, node) => commandRef.current(command, node)));
  }, [map, layoutMode]);

  useEffect(() => {
    const want = [...selectedIds].sort().join(",");
    setNodes((nds) => {
      const have = nds
        .filter((n) => n.selected)
        .map((n) => n.id)
        .sort()
        .join(",");
      if (have === want) return nds;
      return nds.map((n) => ({ ...n, selected: selectedIds.includes(n.id) }));
    });
  }, [selectedIds]);

  // Search dim (and the zone view's promotable flag) are render-time
  // overlays on node data — node STATE (positions, selection) stays
  // untouched by keystrokes and view context alike.
  const renderNodes = useMemo(() => {
    const keep = highlightIds ? new Set(highlightIds) : null;
    if (!keep && !promotable) return nodes;
    return nodes.map((n) => ({
      ...n,
      data: {
        ...n.data,
        ...(keep && { dimmed: !keep.has(n.id) }),
        ...(promotable && { promotable: true }),
      },
    }));
  }, [nodes, highlightIds, promotable]);

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
      if (key === lastReported.current) return;
      lastReported.current = key;
      onSelect(ids);
    },
    [onSelect],
  );

  return (
    <ReactFlow
      nodes={renderNodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onInit={(instance) => {
        instanceRef.current = instance;
      }}
      onNodesChange={(changes) => setNodes((nds) => applyNodeChanges(changes, nds))}
      onSelectionChange={handleSelectionChange}
      // T9: a completed handle-to-handle drag reports the sketch upward;
      // React Flow never adds the edge itself here — the pending overlay
      // renders it when the proposal.added round-trip lands (one source of
      // truth, same as messages).
      onConnect={(conn) => {
        if (conn.source && conn.target && conn.source !== conn.target) {
          onConnect?.(conn.source, conn.target);
        }
      }}
      // T9: double-click sketches a node — but only on the empty pane
      // (React Flow has no pane-scoped double-click callback, so this DOM
      // handler checks the event target; node/edge double-clicks pass by).
      onDoubleClick={(e) => {
        if (e.target instanceof Element && e.target.classList.contains("react-flow__pane")) {
          onPaneDoubleClick?.();
        }
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
