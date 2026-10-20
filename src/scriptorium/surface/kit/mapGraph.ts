/**
 * The map's feed on the kit path: the kit's `LinkGraph` for one set (asked with
 * `link.graph`, `within` the set's root), joined with the flagged daemon's
 * `appState.docMeta`, in the shape the map draws (`MapGraph`). Pure, so the
 * mapping is pinned by a test rather than by eye.
 *
 * What the kit's graph gives and the shipped `graph` message did not, and the
 * other way round:
 *
 * - **`stale` and `tags`** are not on a kit node. They are joined from
 *   `docMeta`, by path. A document `docMeta` does not carry (no frontmatter, or
 *   past its scan cap) is not stale and has no tags: nothing is claimed for it.
 * - **`status`** is the frontmatter's own, as the kit reads it. The shipped
 *   graph wrote `stable` when it was absent; here an absent status stays absent
 *   and the map says nothing about it (E69's rule, applied to status: a missing
 *   field is not read as a value).
 * - **Trust** is not on the map at all, as it is not on the shipped one. So no
 *   node can read "unverified" because `verified` is missing (E69).
 * - **The column** is the node's kind (the matched profile's, else the
 *   frontmatter `type`, which is the shipped column), headed by its label.
 * - **Edges** are folded by the kit: one per pair and relation set, with a
 *   `count`. The map draws one line per folded edge and counts the links in
 *   it. A frontmatter reference arrives as an edge of kind `frontmatter`
 *   (Scriptorium's edge slot) and is drawn dashed, as on the shipped map; a
 *   body link has no edge kind. An edge of any other kind is not drawn.
 * - **What is dropped:** per-edge state (in the set, outside it, a folder,
 *   missing), and the dangling and unsupported lists. `within` already keeps
 *   only the set's own documents, so every edge left is in the set, which is
 *   the only state the shipped map drew. "Leaving the set" and "dangling" were
 *   counts in its header only; they are the link check's to report (`link-check`
 *   names each one, with the line to fix), and a second request per map for two
 *   numbers that offer no act was not worth it.
 */

import type { LinkGraph } from "../../../kit/workspace/protocol";
import type { DocSummary } from "../../backend/kit/frontmatter";

/** One document on the map. */
export type MapNode = {
  path: string;
  /** Its path from the set's root, as the tree shows it. */
  rel: string;
  title: string;
  /** Its column: the kind, when it has one. */
  type?: string;
  /** The column's heading: the kind's label. */
  typeLabel?: string;
  /** Its frontmatter `status`, only when it has one. */
  status?: string;
  stale: boolean;
  tags: string[];
  linksIn: number;
  linksOut: number;
};

/** One folded edge: every link from `from` to `to` with the same relations. */
export type MapEdge = {
  from: string;
  to: string;
  source: "link" | "frontmatter";
  rel: string[];
  /** How many links it folds. */
  count: number;
};

export type MapGraph = {
  nodes: MapNode[];
  edges: MapEdge[];
  /** Links drawn, the folded edges' counts added up. */
  links: number;
  /** Documents in the set the graph left out, past the kit's cut (best connected kept). */
  cut: number;
};

/** The kit's edge kind for Scriptorium's frontmatter references (`backend/kit/links.ts`). */
const FRONTMATTER = "frontmatter";

export function mapGraph(
  graph: LinkGraph,
  docMeta: Readonly<Record<string, DocSummary>>,
): MapGraph {
  const nodes: MapNode[] = graph.nodes
    // A board is not a document of the set's; the map asks without bundles, so this only
    // guards. Its references (cards on it) go with it: they leave from the board.
    .filter((n) => !n.bundle)
    .map((n) => {
      const meta = docMeta[n.path];
      return {
        path: n.path,
        rel: n.shown,
        title: n.title,
        ...(n.kind !== null ? { type: n.kind, typeLabel: n.label ?? n.kind } : {}),
        ...(n.status !== undefined ? { status: n.status } : {}),
        stale: meta?.stale === true,
        tags: meta?.tags ?? [],
        linksIn: n.linksIn,
        linksOut: n.linksOut,
      };
    });
  const at = new Set(nodes.map((n) => n.path));
  const edges: MapEdge[] = [];
  for (const e of graph.edges) {
    if (e.edge !== undefined && e.edge !== FRONTMATTER) continue;
    if (!at.has(e.from) || !at.has(e.to)) continue;
    edges.push({
      from: e.from,
      to: e.to,
      source: e.edge === FRONTMATTER ? "frontmatter" : "link",
      rel: e.rel,
      count: e.count,
    });
  }
  return {
    nodes,
    edges,
    links: edges.reduce((sum, e) => sum + e.count, 0),
    cut: Math.max(0, graph.total.nodes - graph.nodes.length),
  };
}
