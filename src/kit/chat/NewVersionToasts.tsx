// "New version: v3 ...", with Activate and Show diff.
//
// IT WATCHES THE FACT, NOT THE ACTION: a version appearing on the open document
// that is not the active one, whoever made it. The agent's `version.new` is the
// case that needs it most, since it never activates.
//
// The buttons are SHORTCUTS for conversational acts. The human can still ask the
// agent to activate or compare; the toast only saves the round trip. Activate is
// the kit's (the shell sends `activate`). Show diff is the app's: the kit has no
// compare view, so the button is offered only when the app says how to show one.
//
// Scope: the OPEN document only. A version made on another document is said in
// the chat (the daemon posts a line), and is announced here when the human next
// opens that document, since they have not seen it yet. Its toast withdraws if
// the open document changes, because Show diff acts on the open document.
//
// ONE ANNOUNCEMENT, NOT TWO. The agent's `version-new` then `activate` are two
// acts a moment apart: raised at once, this toast was replaced by "Now editing"
// about 40 ms later, and a screen reader read both. So a new version is held for
// `holdMs` before its toast is raised, and dropped if that version itself
// became the active one in the meantime ("Now editing" says it). A switch to
// another document does not drop it: it is raised when its hold is over, from
// the document as last seen, with Activate only (Show diff acts on the open
// document), and stays until its version is settled (`versionSettled`).
import { useEffect, useRef } from "react";
import type { ToastAction } from "../ui/toast-store.ts";
import type { DocView } from "../workspace/protocol";
import {
  createVersionWatch,
  newVersionActs,
  newVersionToast,
  type VersionAct,
  type VersionTarget,
  versionName,
  versionSettled,
  withdrawn,
} from "./newVersions.ts";

/** How long a new version waits before its toast is raised (see the header). */
export const NEW_VERSION_HOLD_MS = 400;

export function NewVersionToasts({
  doc,
  connected,
  announce,
  dismiss,
  onActivate,
  onShowDiff,
  holdMs = NEW_VERSION_HOLD_MS,
}: {
  doc: DocView | null;
  connected: boolean;
  announce: (title: string, description?: string, actions?: ToastAction[]) => number;
  dismiss: (id: number) => void;
  /** Make a version the active one. */
  onActivate: (doc: string, version: number) => void;
  /** Compare the active version with another, without activating. Absent: no Show diff button. */
  onShowDiff?: (doc: string, version: number) => void;
  /** How long a new version is held before its toast is raised; 0 raises it at once. */
  holdMs?: number;
}) {
  // The versions SEEN per document, for this page's life (`createVersionWatch`).
  // A reconnect keeps it, so a version made while disconnected is announced on the
  // way back; a reload starts a new one, and stays quiet.
  const watch = useRef(createVersionWatch());
  // The toasts this raised, so each can withdraw once it stops being true.
  // `elsewhere`: raised while another document was open, so it is not
  // withdrawn for that (see the header).
  const raised = useRef<{ id: number; target: VersionTarget; elsewhere: boolean }[]>([]);
  // The versions held before their toast is raised, each with its timer and
  // its document as last seen open.
  const held = useRef<
    { timer: ReturnType<typeof setTimeout>; target: VersionTarget; seen: DocView }[]
  >([]);
  // The open document as last rendered: what a held version is checked against
  // when it comes due.
  const current = useRef(doc);
  current.current = doc;
  // The latest wiring, read at click time rather than at announce time.
  const wiring = useRef({ onActivate, onShowDiff });
  wiring.current = { onActivate, onShowDiff };

  useEffect(() => {
    if (!connected) watch.current.disconnected();
  }, [connected]);

  useEffect(
    () => () => {
      for (const h of held.current) clearTimeout(h.timer);
      held.current = [];
    },
    [],
  );

  const canDiff = onShowDiff !== undefined;
  useEffect(() => {
    raised.current = raised.current.filter((r) => {
      if (!(r.elsewhere ? versionSettled(r.target, doc) : withdrawn(r.target, doc))) return true;
      dismiss(r.id);
      return false;
    });
    held.current = held.current.filter((h) => {
      if (doc && doc.slug === h.target.doc) h.seen = doc;
      if (!versionSettled(h.target, doc)) return true;
      clearTimeout(h.timer);
      return false;
    });
    if (!doc) return;
    const fresh = watch.current.snapshot(doc);

    const apply = (acts: VersionAct[]) => {
      const w = wiring.current;
      for (const act of acts) {
        if ("activate" in act) w.onActivate(act.activate.doc, act.activate.n);
        else w.onShowDiff?.(act.showDiff.doc, act.showDiff.n);
      }
    };
    /**
     * Raise `target`'s toast: from the open document as it reads now, or, when
     * another one is open, from its document as last seen. A held target whose
     * version settled was dropped above, on the render that showed it.
     */
    const raise = (target: VersionTarget, seen: DocView) => {
      const open = current.current;
      const elsewhere = !open || open.slug !== target.doc;
      const from = elsewhere ? seen : open;
      const version = from.versions.find((v) => v.n === target.n);
      if (!version) return;
      const name = versionName(from, target.n);
      const { title, description } = newVersionToast(from, version);
      const actions: ToastAction[] = [
        {
          label: "Activate",
          ariaLabel: `Activate ${name}`,
          onAct: () => apply(newVersionActs("activate", target)),
        },
      ];
      if (canDiff && !elsewhere)
        actions.push({
          label: "Show diff",
          ariaLabel: `Show diff: compare v${from.active} with ${name}, without activating it`,
          onAct: () => apply(newVersionActs("diff", target)),
        });
      const id = announce(title, description, actions);
      raised.current.push({ id, target, elsewhere });
    };
    for (const version of fresh) {
      const target = { doc: doc.slug, n: version.n };
      if (holdMs <= 0) {
        raise(target, doc);
        continue;
      }
      const entry = {
        timer: setTimeout(() => {
          held.current = held.current.filter((h) => h !== entry);
          raise(target, entry.seen);
        }, holdMs),
        target,
        seen: doc,
      };
      held.current.push(entry);
    }
  }, [doc, announce, dismiss, canDiff, holdMs]);

  return null;
}
