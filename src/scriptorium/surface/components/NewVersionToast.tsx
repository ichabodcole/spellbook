// "New version: v3 · …", with Activate and Show diff.
//
// ⛔ IT WATCHES THE FACT, NOT THE ACTION, the same shape as ActiveVersionToast
// (E42): a version appearing on the open document that is not the active one,
// whoever made it. The agent's `version-new` is the case that needs it most:
// it never activates, so before this its versions sat in the menu unannounced.
//
// The buttons are SHORTCUTS for conversational acts. The human can still ask
// the agent to activate or compare; the toast only saves the round trip.
//
// Scope: the OPEN document only. A version made on another document is said in
// the chat (the daemon posts "Agent created v…"), and is announced here when
// the human next opens that document, since they have not seen it yet. Its
// toast withdraws if the open document changes, because Show diff acts on the
// open document's compare view.
import { useEffect, useRef } from "react";

import type { ClientMsg, DiffSide, DocView } from "../../backend/protocol";
import {
  createVersionWatch,
  newVersionActs,
  newVersionToast,
  type VersionAct,
  type VersionTarget,
  versionName,
  withdrawn,
} from "../state/newVersions";
import type { ToastAction } from "./Toasts";

export function NewVersionToast({
  doc,
  connected,
  announce,
  dismiss,
  send,
  setMode,
  setAgainst,
}: {
  doc: DocView | null;
  connected: boolean;
  announce: (title: string, description?: string, actions?: ToastAction[]) => number;
  dismiss: (id: number) => void;
  send: (msg: ClientMsg) => void;
  setMode: (mode: "compare") => void;
  setAgainst: (side: DiffSide) => void;
}) {
  // The versions SEEN per document, for this page's life (`createVersionWatch`).
  // A reconnect keeps it, so a version made while disconnected is announced on
  // the way back (Cole, 2026-09-28); a reload starts a new one, and stays quiet.
  const watch = useRef(createVersionWatch());
  // The toasts this raised, so each can withdraw once it stops being true.
  const raised = useRef<{ id: number; target: VersionTarget }[]>([]);
  // The latest wiring, read at click time rather than at announce time.
  const wiring = useRef({ send, setMode, setAgainst });
  wiring.current = { send, setMode, setAgainst };

  useEffect(() => {
    if (!connected) watch.current.disconnected();
  }, [connected]);

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
        if ("send" in act) w.send(act.send);
        else if ("mode" in act) w.setMode(act.mode);
        else w.setAgainst(act.against);
      }
    };
    for (const version of fresh) {
      const target = { doc: doc.slug, n: version.n };
      const name = versionName(doc, version.n);
      const { title, description } = newVersionToast(doc, version);
      const id = announce(title, description, [
        {
          label: "Activate",
          ariaLabel: `Activate ${name}`,
          onAct: () => apply(newVersionActs("activate", target)),
        },
        {
          label: "Show diff",
          ariaLabel: `Compare v${doc.active} with ${name}, without activating it`,
          onAct: () => apply(newVersionActs("diff", target)),
        },
      ]);
      raised.current.push({ id, target });
    }
  }, [doc, announce, dismiss]);

  return null;
}
