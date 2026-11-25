// WHAT THE DAEMON SAID: its refusals (toasted, or left to an app's own notice
// with a stand-in toast while the context column is collapsed), a link that did
// not open closing on Escape, a session that has ended, and what the daemon has
// done for this viewer (a document made, a row moved). A hook of `ShellBody`'s,
// called where this section sat in it, after `useReveal` and the open image's
// backlinks, so the hooks keep their order.

import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import type { Collapsed } from "../context/columns.ts";
import { type Daemon, LINK_REFUSED, SESSION_ENDED } from "../context/daemonClient.ts";
import type { ToastStore } from "../ui/toast-store.ts";
import type { useReveal } from "./useReveal.ts";

export function useDaemonNotices({
  daemon,
  toasts,
  send,
  notice,
  setPendingShow,
  collapsedRef,
  collapsed,
}: {
  daemon: Daemon;
  toasts: ToastStore;
  send: Daemon["send"];
  notice: string | null | undefined;
  setPendingShow: ReturnType<typeof useReveal>["setPendingShow"];
  collapsedRef: RefObject<Collapsed>;
  collapsed: Collapsed;
}) {
  const { lastError, lastErrorTitle, lastErrorSeq, clearError, done } = daemon;
  const endedToastAt = useRef(0);
  // A refusal (the open failed) cancels a reveal that was waiting on it.
  useEffect(() => {
    if (lastError) setPendingShow(null);
  }, [lastError, setPendingShow]);
  // An app that shows refusals in the sidebar's notice keeps them there: one
  // place per refusal, cleared when the human dismisses it. While the context
  // column is collapsed its notice is out of sight, so the refusal is toasted
  // as well, and left for the app to clear: the human always sees a refusal.
  const noticeOwned = notice !== undefined;
  /** The toast standing in for the notice while the column is collapsed. */
  const ownedToast = useRef<number | null>(null);
  const { dismiss: dismissToast } = toasts;
  const letOwnedToastGo = useCallback(() => {
    if (ownedToast.current === null) return;
    dismissToast(ownedToast.current);
    ownedToast.current = null;
  }, [dismissToast]);
  // Keyed on `lastErrorSeq` as well as the words: a refusal repeated word for word
  // is a new one, so this runs again (its toast may have expired).
  // biome-ignore lint/correctness/useExhaustiveDependencies: lastErrorSeq is the refusal's identity, and a repeat must re-run this
  useEffect(() => {
    if (!lastError) return;
    if (noticeOwned && lastError !== SESSION_ENDED) {
      if (collapsedRef.current.context) {
        letOwnedToastGo();
        ownedToast.current = toasts.announce(
          lastErrorTitle ?? "The workspace refused that",
          lastError,
        );
      }
      return;
    }
    if (lastError === SESSION_ENDED) {
      // One toast per burst: a held key or a double click is one answer, not five.
      if (Date.now() - endedToastAt.current > 2500) toasts.announce("Session ended", lastError);
      endedToastAt.current = Date.now();
    } else toasts.announce(lastErrorTitle ?? "The workspace refused that", lastError);
    clearError();
  }, [lastError, lastErrorSeq, lastErrorTitle, clearError, toasts, noticeOwned, letOwnedToastGo]);
  // A link that did not open closes on Escape (or when another document
  // opens: `daemonClient`), never on a timer. Escape a dialog or menu took
  // first (`defaultPrevented`) is theirs.
  const linkRefused = lastError !== null && lastErrorTitle === LINK_REFUSED;
  useEffect(() => {
    if (!linkRefused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) clearError();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [linkRefused, clearError]);
  // The stand-in goes once the notice is in sight (the column reopened) or the
  // refusal is let go: a refusal is never shown twice at once.
  useEffect(() => {
    if (!lastError || !collapsed.context) letOwnedToastGo();
  }, [lastError, collapsed.context, letOwnedToastGo]);
  // A new document or folder this viewer made arrives in rename mode; a new
  // document also opens.
  // A move this viewer made, once the daemon has done it: the sidebar puts the
  // focus on the row where it now is.
  const moved = useMemo(
    () => (done?.of === "move" ? { path: done.path, seq: done.seq } : null),
    [done],
  );
  const created = useMemo(
    () =>
      done &&
      (done.of === "doc.create" || done.of === "folder.create" || done.of === "bundle.create")
        ? { path: done.path, seq: done.seq }
        : null,
    [done],
  );
  // A new document opens, and so does a new bundle (as its main file), unless
  // its maker stays where it is and only asks for it to be named.
  useEffect(() => {
    if (done?.stay === "rename") return;
    if (done?.of === "doc.create" || done?.of === "bundle.create")
      send({ op: "open", path: done.path });
  }, [done, send]);
  return { moved, created };
}
