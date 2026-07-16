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
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  CircleDashed,
  Crosshair,
  HelpCircle,
  Lightbulb,
  ListTree,
  MapPin,
  ScrollText,
  User,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapNode, NodeKind, StubMap, Tier } from "./types";
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
};

const NODE_W = 190;
const NODE_H = 76;

// Literal class strings on purpose — Tailwind's @source scan only sees
// literal text, so tier styling lives in a lookup, never string-built.
const TIER_CARD: Record<Tier, string> = {
  canon: "border-canon text-canon",
  thread: "border-thread-tier text-thread-tier",
  "story-local": "border-story-local text-story-local",
  background: "border-background-tier text-background-tier",
};

const TIER_LABEL: Record<Tier, string> = {
  canon: "canon",
  thread: "thread",
  "story-local": "story-local",
  background: "background",
};

const KIND_ICON: Record<NodeKind, typeof User> = {
  cast: User,
  place: MapPin,
  concept: Lightbulb,
  thread: CircleDashed,
};

// The node command vocabulary (context menu; born plural per t-609741be —
// future commands include agent actions).
export type NodeCommand = "Focus" | "Explain" | "Questions" | "Subtopics";

type IdeaNodeData = {
  node: MapNode;
  onCommand: (command: NodeCommand) => void;
  dimmed?: boolean;
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

function layout(
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
}: GraphCanvasProps) {
  // React Flow is used semi-controlled: this component owns node state (so
  // drag + click-select work), reports selection upward (deduped — an
  // unconditional setState here is an infinite render loop), and applies
  // external deselects (chip ×) back onto node state, guarded the same way.
  const [nodes, setNodes] = useState<Node<IdeaNodeData>[]>([]);
  const edges = useMemo(() => toFlowEdges(map), [map]);
  const lastReported = useRef<string>("");

  // Commands dispatch through a ref so a new callback identity never forces
  // a node-state rebuild (layout depends on the map alone).
  const commandRef = useRef(onNodeCommand);
  commandRef.current = onNodeCommand;

  useEffect(() => {
    setNodes(layout(map, (command, node) => commandRef.current(command, node)));
  }, [map]);

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

  // Search dim is a render-time overlay on node data — node STATE (positions,
  // selection) stays untouched by keystrokes.
  const renderNodes = useMemo(() => {
    if (!highlightIds) return nodes;
    const keep = new Set(highlightIds);
    return nodes.map((n) => ({ ...n, data: { ...n.data, dimmed: !keep.has(n.id) } }));
  }, [nodes, highlightIds]);

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
      fitView
      minZoom={0.3}
      maxZoom={2}
      proOptions={{ hideAttribution: false }}
      nodesDraggable
      nodesConnectable={false}
      selectionOnDrag
      panOnScroll
      multiSelectionKeyCode="Shift"
    >
      <Background gap={24} size={1} color="var(--color-edge)" />
      <Controls position="top-left" showInteractive={false} />
    </ReactFlow>
  );
}
