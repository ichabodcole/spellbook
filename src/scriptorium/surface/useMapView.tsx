/**
 * The map's wiring into the flagged frame: "Show the map of this set" in a
 * set's menu (a `menuActions` entry, the shipped words), which chooses the set
 * and makes the document pane's app view (`appView`) active; the graph, asked
 * for every time the view is shown; and a node's click, which opens its
 * document and leaves the map, since the map is a way IN, not a place to stay.
 *
 * ⛔ ONE MOMENT PER SHOWING. One ask (`scriptorium.map`, `within` the set's
 * root) answers the kit's graph and the documents' frontmatter, read together
 * by the daemon (`backend/kit/map.ts`), and the joined map is what is drawn
 * until the next showing. Joining the page's own `docMeta` drew a node's new
 * status beside its old stale mark and tags: that copy is the last state
 * push's, and a change on disk to a document the session does not hold sends
 * none. The shipped overlay is one snapshot per opening; so is this, and each
 * showing, by the menu or by the pane's toggle, asks again.
 *
 * The layout mode (columns or physics) is kept here, so it survives leaving
 * the map and coming back. A set taken out of the context takes its map with
 * it: the view is offered only while its set is still listed.
 *
 * Kept out of `./Frame.tsx` on purpose, so the frame's edit stays small.
 */

import { NetworkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Daemon } from "../../kit/context/daemonClient";
import type { MenuActions } from "../../kit/context/menuActions";
import { singleDoc } from "../../kit/context/model";
import type { AppView } from "../../kit/document/DocumentPane";
import type { ContextEntry, LinkGraph } from "../../kit/workspace/protocol";
import type { DocSummary } from "../backend/kit/frontmatter";
import { type MapMode, MapView } from "./MapView";
import { type MapGraph, mapGraph } from "./mapGraph";

/** The menu entry's id, and the app view's (`data-view`). */
export const MAP_VIEW = "scriptorium.map";
const MAP_LABEL = "Show the map of this set";

type Showing = { entryId: string; graph: MapGraph | null; error?: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `scriptorium.map`'s answer: the graph and its documents' frontmatter, of one moment. */
type MapAnswer = { graph: LinkGraph; docMeta: Record<string, DocSummary> };

export function useMapView(daemon: Pick<Daemon, "request" | "send" | "state">): {
  /** The pane's app view, while a mapped set is listed; otherwise the pane offers none. */
  appView: AppView | undefined;
  /** The set's menu entry, for a set's row; none for anything else (`menuActions`). */
  menuActions: MenuActions;
} {
  const [showing, setShowing] = useState<Showing | null>(null);
  const [active, setActive] = useState(false);
  const [mode, setMode] = useState<MapMode>("columns");
  const { request, send, state } = daemon;
  /** The latest ask: an older answer, for this set or another, is dropped. */
  const asked = useRef(0);

  const fetch = useCallback(
    (entry: ContextEntry) => {
      const seq = ++asked.current;
      setShowing({ entryId: entry.id, graph: null });
      const keep = (next: Omit<Showing, "entryId">) => {
        if (seq === asked.current) setShowing({ entryId: entry.id, ...next });
      };
      request({ op: "scriptorium.map", within: entry.root }).then(
        (frame) => {
          const a = frame as unknown as MapAnswer;
          keep({ graph: mapGraph(a.graph, a.docMeta) });
        },
        (e) => keep({ graph: null, error: messageOf(e) }),
      );
    },
    [request],
  );

  // The mapped set as the context lists it now: its label follows a rename,
  // and a set taken out leaves nothing to show.
  const entry = showing ? state?.context.find((e) => e.id === showing.entryId) : undefined;
  const gone = showing !== null && state !== null && entry === undefined;
  useEffect(() => {
    if (!gone) return;
    asked.current++;
    setShowing(null);
    setActive(false);
  }, [gone]);

  const show = useCallback(
    (e: ContextEntry) => {
      fetch(e);
      setActive(true);
    },
    [fetch],
  );

  const appView = useMemo<AppView | undefined>(() => {
    if (!showing || !entry) return undefined;
    return {
      id: MAP_VIEW,
      label: `Map of ${entry.label}`,
      icon: <NetworkIcon aria-hidden className="size-3.5" />,
      active,
      onActive: (next) => {
        // Every showing asks again: what is drawn is of the moment it is shown.
        if (next) fetch(entry);
        setActive(next);
      },
      render: () => (
        <MapView
          graph={showing.graph}
          {...(showing.error !== undefined ? { error: showing.error } : {})}
          label={entry.label}
          mode={mode}
          onMode={setMode}
          onOpenDoc={(path) => {
            send({ op: "open", path });
            setActive(false);
          }}
          onClose={() => setActive(false)}
        />
      ),
    };
  }, [showing, entry, active, mode, fetch, send]);

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
