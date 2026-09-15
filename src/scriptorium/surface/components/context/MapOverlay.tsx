// A set's MAP (E33) — an overlay, on Cole's ruling: "a map is a thing you
// consult, not a thing you sit in", so it opens from a set's menu and closes
// again rather than taking a pane.
//
// TWO MODES, because Cole asked for both and they answer different questions
// (E34): COLUMNS BY TYPE — deterministic, the same corpus drawn the same way
// twice — answers "what KIND of page is this, and what cites it"; PHYSICS
// (`d3-force`, Obsidian's shape) answers "what clusters, and what sits alone",
// which a column layout cannot show because it puts that answer in the column
// order rather than in the distance between nodes.
//
// In BOTH modes, hovering a document mutes everything it is not connected to —
// the same dim idiom mind-mapper's canvas uses for its spotlight.
//
// Body links and frontmatter references are drawn DIFFERENTLY (solid against
// dashed) because they are different claims: a body link is a citation in
// prose, a `related:` key is a claim about the document as a whole. pdocs keeps
// them apart in `backlinks`; so does this.
import { Dialog } from "@base-ui/react/dialog";
import { cn } from "cn";
import { XIcon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from "react";
import type { GraphPayload } from "../../../backend/protocol";
import { bodyRadius, useForceLayout } from "./forceLayout";

const NODE_W = 168;
const NODE_H = 34;
const COL_GAP = 96;
const ROW_GAP = 12;
const PAD = 24;
/** A column taller than this wraps — one type must not outgrow the screen. */
const COLUMN_ROWS = 12;
const SUB_GAP = 14;
/** More nodes than this and the drawing stops being readable; said, not silent. */
const DRAW_CAP = 140;
/** More edges than this and the map reads better with them on hover only. */
const DENSE_EDGES = 150;

type Placed = GraphPayload["nodes"][number] & { x: number; y: number; column: string };

/** Columns by type, each ordered by inbound citations — the hubs rise. */
function layout(nodes: GraphPayload["nodes"]): { placed: Placed[]; width: number; height: number } {
  const byType = new Map<string, GraphPayload["nodes"]>();
  for (const n of nodes.slice(0, DRAW_CAP)) {
    const key = n.type ?? "—";
    const list = byType.get(key) ?? [];
    list.push(n);
    byType.set(key, list);
  }
  const columns = [...byType.entries()].sort((a, b) => b[1].length - a[1].length);
  const placed: Placed[] = [];
  let x = PAD;
  let height = 0;
  for (const [type, list] of columns) {
    const sorted = [...list].sort(
      (a, b) => b.linksIn - a.linksIn || a.title.localeCompare(b.title),
    );
    // A type with 23 documents made one column longer than any screen and left
    // the rest of the map empty beside it (measured on the real wiki's `rule`
    // pages). Tall types WRAP into as many sub-columns as they need.
    const rows = Math.min(sorted.length, COLUMN_ROWS);
    sorted.forEach((n, i) => {
      const sub = Math.floor(i / COLUMN_ROWS);
      placed.push({
        ...n,
        x: x + sub * (NODE_W + SUB_GAP),
        y: PAD + 28 + (i % COLUMN_ROWS) * (NODE_H + ROW_GAP),
        column: type,
      });
    });
    height = Math.max(height, PAD + 28 + rows * (NODE_H + ROW_GAP));
    const subs = Math.ceil(sorted.length / COLUMN_ROWS);
    x += subs * NODE_W + (subs - 1) * SUB_GAP + COL_GAP;
  }
  return { placed, width: x - COL_GAP + PAD, height: height + PAD };
}

/** A curve between two nodes, leaving one's right edge and entering the other's left. */
function edgePath(a: Placed, b: Placed): string {
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const dx = Math.max(40, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function MapOverlay({
  graph,
  label,
  open,
  onOpenChange,
  onOpenDoc,
}: {
  graph: GraphPayload | null;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenDoc: (path: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  /**
   * ⛔ A DENSE MAP DRAWN WHOLE IS A HAIRBALL, and the real wiki is one: 46
   * documents with 508 links between them draws a wall of thread that hides
   * the documents it is supposed to show. Past a threshold the edges wait for
   * a hover — the node is what you read, the links are what you ask for — and
   * the toggle is there for when you want the whole shape at once.
   */
  const [alwaysEdges, setAlwaysEdges] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"columns" | "force">("columns");
  const { placed, width, height } = useMemo(
    () => (graph ? layout(graph.nodes) : { placed: [], width: 0, height: 0 }),
    [graph],
  );
  const at = useMemo(() => new Map(placed.map((p) => [p.path, p])), [placed]);
  const drawn = useMemo(
    () =>
      (graph?.edges ?? []).filter((e) => e.state === "in-bundle" && at.has(e.from) && at.has(e.to)),
    [graph, at],
  );
  const leaving = (graph?.edges ?? []).filter((e) => e.state === "outside").length;
  const dense = drawn.length > DENSE_EDGES;
  const showAll = alwaysEdges ?? !dense;

  /**
   * What the hovered document is connected to — itself included. Everything
   * outside this set is muted rather than hidden: a map that removes nodes
   * while you read it loses the shape you were reading (Cole, E34).
   */
  const connected = useMemo(() => {
    if (!hover) return null;
    const set = new Set<string>([hover]);
    for (const e of drawn) {
      if (e.from === hover) set.add(e.to);
      if (e.to === hover) set.add(e.from);
    }
    return set;
  }, [hover, drawn]);
  const lit = (path: string) => connected === null || connected.has(path);

  // The physics mode's canvas is fixed and scrolls; the columns' is measured.
  const forceSize = { width: 1500, height: 1000 };
  const force = useForceLayout(
    useMemo(() => (graph?.nodes ?? []).map((n) => ({ path: n.path, linksIn: n.linksIn })), [graph]),
    useMemo(() => drawn.map((e) => ({ from: e.from, to: e.to })), [drawn]),
    forceSize,
    mode === "force" && open,
  );
  /** Opening from the map closes it: the map is a way IN, not a place to stay. */
  const openAndClose = (path: string) => {
    onOpenDoc(path);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 data-open:animate-in data-open:fade-in-0" />
        <Dialog.Popup className="fixed inset-6 z-50 flex flex-col overflow-hidden rounded-xl border border-edge bg-surface shadow-2xl outline-none">
          <div className="flex shrink-0 items-center gap-3 border-b border-edge px-4 py-2.5">
            <Dialog.Title className="text-sm font-medium text-ink">Map of {label}</Dialog.Title>
            {graph && (
              <span className="text-xs text-ink-dim">
                {graph.nodes.length} documents · {drawn.length} links inside
                {leaving > 0 && ` · ${leaving} leaving the set`}
                {graph.dangling > 0 && ` · ${graph.dangling} dangling`}
                {graph.nodes.length > DRAW_CAP && ` · drawing the first ${DRAW_CAP}`}
              </span>
            )}
            <div
              role="toolbar"
              aria-label="How to lay the map out"
              className="ml-auto flex items-center gap-0.5 rounded-md bg-surface-raised p-0.5"
            >
              {(["columns", "force"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={cn(
                    "rounded-sm px-2 py-0.5 text-[11px] text-ink-faint outline-none",
                    "hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60",
                    mode === m && "bg-bg text-ink shadow-sm",
                  )}
                >
                  {m === "columns" ? "columns" : "physics"}
                </button>
              ))}
            </div>
            <Dialog.Close className="rounded-md p-1 text-ink-dim hover:bg-surface-raised hover:text-ink">
              <XIcon className="size-4" />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-2">
            {!graph ? (
              <p className="p-6 text-sm text-ink-dim">Reading the set…</p>
            ) : graph.nodes.length === 0 ? (
              <p className="p-6 text-sm text-ink-dim">This set has no documents to map.</p>
            ) : mode === "force" ? (
              <ForceCanvas
                graph={graph}
                edges={drawn}
                size={forceSize}
                force={force}
                hover={hover}
                onHover={setHover}
                lit={lit}
                showAll={showAll}
                onOpen={openAndClose}
              />
            ) : (
              <svg
                width={width}
                height={height}
                role="img"
                aria-label={`${graph.nodes.length} documents and ${drawn.length} links`}
              >
                <title>
                  {graph.nodes.length} documents, {drawn.length} links between them
                </title>
                {drawn.map((e, i) => {
                  const a = at.get(e.from);
                  const b = at.get(e.to);
                  if (!a || !b) return null;
                  const touching = hover === e.from || hover === e.to;
                  const lit = touching || (showAll && hover === null);
                  if (!lit && !showAll) return null;
                  return (
                    <path
                      key={`${e.from}->${e.to}:${i}`}
                      d={edgePath(a, b)}
                      fill="none"
                      stroke={
                        e.source === "frontmatter"
                          ? "var(--color-rubric)"
                          : "var(--color-ink-faint)"
                      }
                      strokeWidth={touching ? 1.6 : 1}
                      strokeDasharray={e.source === "frontmatter" ? "4 3" : undefined}
                      opacity={touching ? 0.95 : showAll ? 0.14 : 0}
                    />
                  );
                })}
                {[...new Set(placed.map((p) => p.column))].map((type) => {
                  const first = placed.find((p) => p.column === type);
                  if (!first) return null;
                  return (
                    <text
                      key={type}
                      x={first.x}
                      y={PAD + 12}
                      className="fill-ink-faint text-[11px] font-medium"
                    >
                      {type}
                    </text>
                  );
                })}
                {placed.map((n) => (
                  // A map is a way INTO a corpus, so every node is reachable by
                  // keyboard: tab to it, Enter or Space opens it.
                  // biome-ignore lint/a11y/useSemanticElements: SVG has no <button>; a <foreignObject> wrapper would cost layout and hit-testing for the same role and keyboard behaviour this element already carries.
                  <g
                    key={n.path}
                    transform={`translate(${n.x}, ${n.y})`}
                    onMouseEnter={() => setHover(n.path)}
                    onMouseLeave={() => setHover(null)}
                    onFocus={() => setHover(n.path)}
                    onBlur={() => setHover(null)}
                    onClick={() => openAndClose(n.path)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault();
                      openAndClose(n.path);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.title} — ${n.status}, ${n.linksIn} citations`}
                    // Everything the hovered document does not touch is MUTED,
                    // never removed: a map that drops nodes while you read it
                    // loses the shape you were reading.
                    opacity={lit(n.path) ? 1 : 0.22}
                    className="cursor-pointer outline-none transition-opacity focus-visible:[&>rect]:stroke-rubric"
                  >
                    <title>
                      {n.rel} · {n.status}
                      {n.stale ? " · stale" : ""} · {n.linksIn} in, {n.linksOut} out
                      {n.tags.length ? ` · ${n.tags.join(", ")}` : ""}
                    </title>
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={6}
                      className={cn(
                        "fill-bg stroke-edge",
                        hover === n.path && "fill-surface-raised stroke-rubric",
                      )}
                      strokeWidth={1}
                    />
                    <circle
                      cx={12}
                      cy={NODE_H / 2}
                      r={3}
                      className={cn(
                        n.stale || n.status === "draft"
                          ? "fill-attention"
                          : n.status === "deprecated"
                            ? "fill-danger"
                            : "fill-ink-faint",
                      )}
                    />
                    <text
                      x={24}
                      y={NODE_H / 2 + 4}
                      className="fill-ink text-[11px]"
                      textLength={n.title.length > 22 ? NODE_W - 36 : undefined}
                      lengthAdjust="spacingAndGlyphs"
                    >
                      {n.title.length > 26 ? `${n.title.slice(0, 25)}…` : n.title}
                    </text>
                  </g>
                ))}
              </svg>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-4 border-t border-edge px-4 py-2 text-[11px] text-ink-dim">
            <span className="flex items-center gap-1.5">
              <svg width="22" height="6" aria-hidden role="img">
                <title>a solid line</title>
                <line
                  x1="0"
                  y1="3"
                  x2="22"
                  y2="3"
                  stroke="var(--color-ink-faint)"
                  strokeWidth="1.5"
                />
              </svg>
              a link in the prose
            </span>
            <span className="flex items-center gap-1.5">
              <svg width="22" height="6" aria-hidden role="img">
                <title>a dashed line</title>
                <line
                  x1="0"
                  y1="3"
                  x2="22"
                  y2="3"
                  stroke="var(--color-rubric)"
                  strokeWidth="1.5"
                  strokeDasharray="4 3"
                />
              </svg>
              a frontmatter reference
            </span>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setAlwaysEdges(e.target.checked)}
                className="size-3 accent-[var(--color-rubric)]"
              />
              draw every link{dense && !showAll ? " (hover a document to see its own)" : ""}
            </label>
            <span className="ml-auto">click a document to open it</span>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The physics canvas. Nodes are circles sized by inbound citations — the hubs
 * grow — and they can be DRAGGED: pinning one and letting the rest settle
 * around it is how a force map is actually read (Obsidian's affordance).
 */
function ForceCanvas({
  graph,
  edges,
  size,
  force,
  hover,
  onHover,
  lit,
  showAll,
  onOpen,
}: {
  graph: GraphPayload;
  edges: GraphPayload["edges"];
  size: { width: number; height: number };
  force: ReturnType<typeof useForceLayout>;
  hover: string | null;
  onHover: (path: string | null) => void;
  lit: (path: string) => boolean;
  showAll: boolean;
  onOpen: (path: string) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const { positions, onDragStart, onDragMove, onDragEnd, dragging } = force;
  /** Pointer coordinates in the canvas's own space. */
  const at = (e: ReactPointerEvent): { x: number; y: number } => {
    const box = svg.current?.getBoundingClientRect();
    return { x: e.clientX - (box?.left ?? 0), y: e.clientY - (box?.top ?? 0) };
  };

  return (
    // The pointer handlers carry a node DRAG; every node inside is a focusable
    // control with its own keyboard path, so the svg itself needs no role.
    <svg
      ref={svg}
      width={size.width}
      height={size.height}
      role="img"
      aria-label={`${graph.nodes.length} documents, arranged by their links`}
      onPointerMove={(e) => dragging && onDragMove(at(e))}
      onPointerUp={onDragEnd}
      onPointerLeave={onDragEnd}
      className={dragging ? "cursor-grabbing" : undefined}
    >
      <title>{graph.nodes.length} documents, arranged by their links</title>
      {edges.map((e, i) => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return null;
        const touching = hover === e.from || hover === e.to;
        if (!touching && !showAll) return null;
        return (
          <line
            key={`${e.from}->${e.to}:${i}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={e.source === "frontmatter" ? "var(--color-rubric)" : "var(--color-ink-faint)"}
            strokeWidth={touching ? 1.6 : 1}
            strokeDasharray={e.source === "frontmatter" ? "4 3" : undefined}
            opacity={touching ? 0.95 : 0.14}
          />
        );
      })}
      {[...graph.nodes]
        // The hovered node is drawn LAST so its label sits above its
        // neighbours' — in a cluster, the one you are pointing at is the one
        // whose name you need.
        .sort((a, b) => (a.path === hover ? 1 : 0) - (b.path === hover ? 1 : 0))
        .map((n) => {
          const p = positions.get(n.path);
          if (!p) return null;
          const r = bodyRadius(n.linksIn);
          return (
            // biome-ignore lint/a11y/useSemanticElements: SVG has no <button>; the role, tabIndex and key handler carry the same behaviour.
            <g
              key={n.path}
              transform={`translate(${p.x}, ${p.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${n.title} — ${n.status}, ${n.linksIn} citations`}
              opacity={lit(n.path) ? 1 : 0.18}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture?.(e.pointerId);
                onDragStart(n.path, at(e));
              }}
              onPointerEnter={() => onHover(n.path)}
              onPointerLeave={() => onHover(null)}
              onFocus={() => onHover(n.path)}
              onBlur={() => onHover(null)}
              onDoubleClick={() => onOpen(n.path)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onOpen(n.path);
              }}
              className="cursor-grab outline-none transition-opacity"
            >
              <title>
                {n.rel} · {n.status}
                {n.stale ? " · stale" : ""} · {n.linksIn} in, {n.linksOut} out
              </title>
              <circle
                r={r}
                className={cn(
                  "stroke-edge",
                  n.stale || n.status === "draft"
                    ? "fill-attention"
                    : n.status === "deprecated"
                      ? "fill-danger"
                      : hover === n.path
                        ? "fill-rubric"
                        : "fill-ink-faint",
                )}
                strokeWidth={hover === n.path ? 2 : 1}
              />
              <text
                x={r + 5}
                y={4}
                className={cn("text-[11px]", hover === n.path ? "fill-ink" : "fill-ink-dim")}
              >
                {n.title.length > 28 ? `${n.title.slice(0, 27)}…` : n.title}
              </text>
            </g>
          );
        })}
    </svg>
  );
}
