/**
 * The map's PHYSICS mode (E34) — Obsidian's shape, on `d3-force`.
 *
 * Cole asked for both modes because "the modes tend to be useful in different
 * ways", and they are: the columns answer "what KIND of page is this, and what
 * cites it"; the physics answers "what clusters, and what sits alone" — a
 * question a deterministic layout cannot show, because it puts the answer in
 * the column order rather than in the distance between nodes.
 *
 * `d3-force` is already in the tree (mind-mapper's GraphCanvas), so this costs
 * no new dependency — recorded in house-style all the same, because the rule is
 * that the ruling comes BEFORE the install.
 */
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from "d3-force";
import { useCallback, useEffect, useRef, useState } from "react";

export type Point = { x: number; y: number };
type Body = { id: string; x?: number; y?: number; fx?: number | null; fy?: number | null };
type Spring = { source: string | Body; target: string | Body };

/** A node's radius: hubs are bigger, because inbound citations are what a map is for. */
export const bodyRadius = (linksIn: number): number => 5 + Math.min(11, Math.sqrt(linksIn) * 2.4);

export function useForceLayout(
  nodes: { path: string; linksIn: number }[],
  edges: { from: string; to: string }[],
  size: { width: number; height: number },
  enabled: boolean,
): {
  positions: ReadonlyMap<string, Point>;
  onDragStart: (path: string, at: Point) => void;
  onDragMove: (at: Point) => void;
  onDragEnd: () => void;
  dragging: string | null;
} {
  const [positions, setPositions] = useState<ReadonlyMap<string, Point>>(new Map());
  const sim = useRef<Simulation<Body, undefined> | null>(null);
  const bodies = useRef<Map<string, Body>>(new Map());
  const [dragging, setDragging] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || nodes.length === 0) {
      sim.current?.stop();
      sim.current = null;
      return;
    }
    // Keep a node where it already is when the simulation is rebuilt, so
    // toggling modes does not throw the map in the air.
    const previous = bodies.current;
    const list: Body[] = nodes.map((n) => ({ id: n.path, ...(previous.get(n.path) ?? {}) }));
    bodies.current = new Map(list.map((b) => [b.id, b]));
    const ids = new Set(list.map((b) => b.id));
    const springs: Spring[] = edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ source: e.from, target: e.to }));
    const simulation = forceSimulation<Body>(list)
      // Tuned against the real wiki (46 documents): at -220 with a 110 link
      // distance the cluster was tight enough that every label overlapped its
      // neighbours, which makes the mode pretty and unreadable. The map is for
      // reading names, so the nodes get room.
      .force("charge", forceManyBody<Body>().strength(-520))
      .force(
        "link",
        forceLink<Body, Spring>(springs)
          .id((d) => d.id)
          .distance(150)
          .strength(0.14),
      )
      .force("center", forceCenter(size.width / 2, size.height / 2))
      .force(
        "collide",
        forceCollide<Body>().radius((d) => {
          const n = nodes.find((x) => x.path === d.id);
          return bodyRadius(n?.linksIn ?? 0) + 34;
        }),
      );
    simulation.on("tick", () => {
      setPositions(new Map(list.map((b) => [b.id, { x: b.x ?? 0, y: b.y ?? 0 }])));
    });
    sim.current = simulation;
    return () => {
      simulation.stop();
    };
  }, [nodes, edges, size.width, size.height, enabled]);

  const onDragStart = useCallback((path: string, at: Point) => {
    const body = bodies.current.get(path);
    if (!body) return;
    setDragging(path);
    body.fx = at.x;
    body.fy = at.y;
    sim.current?.alphaTarget(0.3).restart();
  }, []);

  const onDragMove = useCallback(
    (at: Point) => {
      if (!dragging) return;
      const body = bodies.current.get(dragging);
      if (!body) return;
      body.fx = at.x;
      body.fy = at.y;
    },
    [dragging],
  );

  const onDragEnd = useCallback(() => {
    if (!dragging) return;
    const body = bodies.current.get(dragging);
    if (body) {
      body.fx = null;
      body.fy = null;
    }
    sim.current?.alphaTarget(0);
    setDragging(null);
  }, [dragging]);

  return { positions, onDragStart, onDragMove, onDragEnd, dragging };
}
