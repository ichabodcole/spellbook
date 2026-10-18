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
  withdrawn,
} from "./newVersions.ts";

export function NewVersionToasts({
  doc,
  connected,
  announce,
  dismiss,
  onActivate,
  onShowDiff,
}: {
  doc: DocView | null;
  connected: boolean;
  announce: (title: string, description?: string, actions?: ToastAction[]) => number;
  dismiss: (id: number) => void;
  /** Make a version the active one. */
  onActivate: (doc: string, version: number) => void;
  /** Compare the active version with another, without activating. Absent: no Show diff button. */
  onShowDiff?: (doc: string, version: number) => void;
}) {
  // The versions SEEN per document, for this page's life (`createVersionWatch`).
  // A reconnect keeps it, so a version made while disconnected is announced on the
  // way back; a reload starts a new one, and stays quiet.
  const watch = useRef(createVersionWatch());
  // The toasts this raised, so each can withdraw once it stops being true.
  const raised = useRef<{ id: number; target: VersionTarget }[]>([]);
  // The latest wiring, read at click time rather than at announce time.
  const wiring = useRef({ onActivate, onShowDiff });
  wiring.current = { onActivate, onShowDiff };

  useEffect(() => {
    if (!connected) watch.current.disconnected();
  }, [connected]);

  const canDiff = onShowDiff !== undefined;
  useEffect(() => {
    raised.current = raised.current.filter((r) => {
      if (!withdrawn(r.target, doc)) return true;
      dismiss(r.id);
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
    for (const version of fresh) {
      const target = { doc: doc.slug, n: version.n };
      const name = versionName(doc, version.n);
      const { title, description } = newVersionToast(doc, version);
      const actions: ToastAction[] = [
        {
          label: "Activate",
          ariaLabel: `Activate ${name}`,
          onAct: () => apply(newVersionActs("activate", target)),
        },
      ];
      if (canDiff)
        actions.push({
          label: "Show diff",
          ariaLabel: `Compare v${doc.active} with ${name}, without activating it`,
          onAct: () => apply(newVersionActs("diff", target)),
        });
      const id = announce(title, description, actions);
      raised.current.push({ id, target });
    }
  }, [doc, announce, dismiss, canDiff]);

  return null;
}
