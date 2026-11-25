// THE SHELL'S REVEAL: opening a search result or a backlink at its match, and
// following a link to a heading, each shown once its document is on screen. A
// hook of `ShellBody`'s, called where this section sat in it, right after
// `useHeldSelection`, so the hooks keep their order (see the effect-order
// comment below).

import { useCallback, useEffect, useRef, useState } from "react";
import type { Daemon } from "../context/daemonClient.ts";
import { baseName } from "../context/model.ts";
import type { Reveal } from "../context/selection.ts";
import type { ToastStore } from "../ui/toast-store.ts";
import type { DocView, SearchResult, ServerOp } from "../workspace/protocol";

export function useReveal({
  daemon,
  toasts,
  send,
  openDoc,
  requestReveal,
}: {
  daemon: Daemon;
  toasts: ToastStore;
  send: Daemon["send"];
  openDoc: DocView | null;
  requestReveal: (target: Omit<Reveal, "seq">) => void;
}) {
  // A match in the document already on screen is shown at once. Otherwise the
  // document is opened first, and the match is shown when it is the one on screen:
  // a reveal asked for before that would be spent by the switch itself.
  const [pendingShow, setPendingShow] = useState<{
    path: string;
    from: number;
    to: number;
    /** A heading's line, for a link followed to a heading: see `Reveal`. */
    heading?: { from: number; to: number };
    /** The document on screen when it was asked for: leaving for any other one cancels it. */
    since: string | null;
  } | null>(null);
  // The same for a backlink, which knows where its link sits in the source.
  const openAt = useCallback(
    (path: string, at?: { from: number; to: number }) => {
      if (openDoc && openDoc.original === path) {
        setPendingShow(null);
        if (at)
          requestReveal({ doc: openDoc.slug, version: openDoc.active, from: at.from, to: at.to });
        return;
      }
      setPendingShow(
        at ? { path, from: at.from, to: at.to, since: openDoc?.original ?? null } : null,
      );
      send({ op: "open", path });
    },
    [send, requestReveal, openDoc],
  );
  const openResult = useCallback(
    (r: SearchResult) => {
      // A match in an image's description opens the image, which shows it.
      if (r.image) {
        setPendingShow(null);
        send({ op: "open", path: r.image });
        return;
      }
      openAt(
        r.path,
        r.kind === "text" && r.from !== undefined && r.to !== undefined
          ? { from: r.from, to: r.to }
          : undefined,
      );
    },
    [openAt, send],
  );
  // Declared after the effect that clears a reveal when the document changes, so
  // that on the render a document comes on screen the clear runs first.
  useEffect(() => {
    if (!pendingShow) return;
    if (openDoc?.original !== pendingShow.path) {
      // Another document came on screen instead: the request is stale.
      if ((openDoc?.original ?? null) !== pendingShow.since) setPendingShow(null);
      return;
    }
    setPendingShow(null);
    requestReveal({
      doc: openDoc.slug,
      version: openDoc.active,
      from: pendingShow.from,
      to: pendingShow.to,
      ...(pendingShow.heading ? { heading: pendingShow.heading } : {}),
    });
  }, [pendingShow, openDoc, requestReveal]);

  // ── following a link to a heading ────────────────────────────────────────
  // The daemon opened the document and says where the link's heading is in the
  // version it opened (kit-heading-links-build). The human followed their own
  // link, so the caret goes to the heading's start, nothing selected, and its
  // line is marked; a heading not found opens the document at the top, and
  // says which heading was not there. Shown once the document is on screen, as
  // a search result is.
  const openDocRef = useRef(openDoc);
  openDocRef.current = openDoc;
  const { onFrame: onDaemonFrame } = daemon;
  const { announce: announceToast } = toasts;
  useEffect(
    () =>
      onDaemonFrame((frame) => {
        if (frame.op !== "link.target") return;
        const f = frame as Extract<ServerOp, { op: "link.target" }>;
        if (f.state !== "in-context" || !f.heading || f.refused) return;
        const { found, anchor } = f.heading;
        if (!found)
          announceToast(
            "Heading not found",
            `No heading “${anchor}” in ${baseName(f.path)}; opened at the top.`,
          );
        setPendingShow({
          path: f.path,
          from: found?.from ?? 0,
          to: found?.from ?? 0,
          ...(found ? { heading: { from: found.from, to: found.to } } : {}),
          since: openDocRef.current?.original ?? null,
        });
      }),
    [onDaemonFrame, announceToast],
  );
  return { setPendingShow, openAt, openResult };
}
