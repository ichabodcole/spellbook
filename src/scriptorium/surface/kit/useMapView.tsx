/**
 * The map's wiring into the flagged frame: "Show the map of this set" in a
 * set's menu (a `menuActions` entry, the shipped words), which chooses the set
 * and makes the document pane's app view (`appView`) active; the graph asked
 * for once per showing (`link.graph`, `within` the set's root), as the shipped
 * overlay asks once per opening; and a node's click, which opens its document
 * and leaves the map, since the map is a way IN, not a place to stay.
 *
 * Kept out of `./Frame.tsx` on purpose, so the frame's edit is three lines.
 */

import { NetworkIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { Daemon } from "../../../kit/context/daemonClient";
import type { MenuActions } from "../../../kit/context/menuActions";
import { singleDoc } from "../../../kit/context/model";
import type { AppView } from "../../../kit/document/DocumentPane";
import type { ContextEntry, LinkGraph } from "../../../kit/workspace/protocol";
import type { DocSummary } from "../../backend/protocol";
import { MapView } from "./MapView";
import { mapGraph } from "./mapGraph";

/** The menu entry's id, and the app view's (`data-view`). */
export const MAP_VIEW = "scriptorium.map";
const MAP_LABEL = "Show the map of this set";

type Showing = { entry: ContextEntry; graph: LinkGraph | null; error?: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useMapView(
  daemon: Pick<Daemon, "request" | "send">,
  docMeta: Readonly<Record<string, DocSummary>>,
): {
  /** The pane's app view, once a set has been mapped; until then the pane offers none. */
  appView: AppView | undefined;
  /** The set's menu entry, for a set's row; none for anything else (`menuActions`). */
  menuActions: MenuActions;
} {
  const [showing, setShowing] = useState<Showing | null>(null);
  const [active, setActive] = useState(false);
  const { request, send } = daemon;

  const show = useCallback(
    (entry: ContextEntry) => {
      setShowing({ entry, graph: null });
      setActive(true);
      // Only the answer for the set still shown is kept: a second set chosen
      // while the first is read wins.
      const keep = (next: Omit<Showing, "entry">) =>
        setShowing((now) => (now?.entry.id === entry.id ? { entry, ...next } : now));
      request({ op: "link.graph", within: entry.root }).then(
        (frame) => keep({ graph: frame as unknown as LinkGraph }),
        (e) => keep({ graph: null, error: messageOf(e) }),
      );
    },
    [request],
  );

  // docMeta changes on its own snapshots; the join follows it without asking again.
  const graph = useMemo(
    () => (showing?.graph ? mapGraph(showing.graph, docMeta) : null),
    [showing?.graph, docMeta],
  );

  const appView = useMemo<AppView | undefined>(() => {
    if (!showing) return undefined;
    return {
      id: MAP_VIEW,
      label: `Map of ${showing.entry.label}`,
      icon: <NetworkIcon aria-hidden className="size-3.5" />,
      active,
      onActive: setActive,
      render: () => (
        <MapView
          graph={graph}
          {...(showing.error !== undefined ? { error: showing.error } : {})}
          label={showing.entry.label}
          onOpenDoc={(path) => {
            send({ op: "open", path });
            setActive(false);
          }}
          onClose={() => setActive(false)}
        />
      ),
    };
  }, [showing, active, graph, send]);

  const menuActions = useCallback<MenuActions>(
    ({ kind, entry }) =>
      // A set's row: a document listed on its own has no set to map.
      kind === "entry" && entry && !singleDoc(entry)
        ? [{ id: MAP_VIEW, label: MAP_LABEL, icon: <NetworkIcon />, onSelect: () => show(entry) }]
        : [],
    [show],
  );

  return { appView, menuActions };
}
