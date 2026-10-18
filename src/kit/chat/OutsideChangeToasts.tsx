// "report.md changed on disk", with Reload and Keep, and, when the host can open
// a comparison, "See the difference" before them.
//
// IT WATCHES THE FLAG, NOT THE ACT: `outsideChanged` going up on the open
// document, whoever's write caused it. Reload is the kit's act (the shell sends
// `revert`, which takes the file's text over the active version). Keep only
// dismisses: the flag stays up and the app's own bar, if it has one, keeps
// offering Save and Revert, so nothing is decided for the human by a toast. The
// toast withdraws itself once the flag comes down (a save or a revert settled it).
//
// A WARNING CARRIES THE ACT THAT ANSWERS IT. Reload and Keep each leave
// something behind, and the toast alone does not say what: "See the difference"
// (the host opens compare against the file on disk) comes first, as it does in
// the document pane's own banner. It is optional, because only a host with a
// document pane has a comparison to open, and like Keep it decides nothing.
import { useEffect, useRef } from "react";
import type { ToastAction } from "../ui/toast-store.ts";
import type { DocView } from "../workspace/protocol";
import { createOutsideWatch, outsideChangeToast } from "./outsideChange.ts";

export function OutsideChangeToasts({
  doc,
  announce,
  dismiss,
  onReload,
  onShowDiff,
}: {
  doc: DocView | null;
  announce: (title: string, description?: string, actions?: ToastAction[]) => number;
  dismiss: (id: number) => void;
  /** Take the file's text over the active version of this document. */
  onReload: (doc: string) => void;
  /** Compare this document with the file on disk. Absent: no "See the difference" button. */
  onShowDiff?: (doc: string) => void;
}) {
  const watch = useRef(createOutsideWatch());
  /** The toast raised for each document, so it can withdraw when the flag comes down. */
  const raised = useRef(new Map<string, number>());
  // The latest wiring, read at click time rather than at announce time.
  const wiring = useRef({ onReload, onShowDiff });
  wiring.current = { onReload, onShowDiff };

  useEffect(() => {
    if (!doc) return;
    const news = watch.current.snapshot(doc);
    if (!doc.outsideChanged) {
      const id = raised.current.get(doc.slug);
      if (id !== undefined) dismiss(id);
      raised.current.delete(doc.slug);
      return;
    }
    if (!news) return;
    const { title, description } = outsideChangeToast(doc);
    const slug = doc.slug;
    const letGo = () => {
      const mine = raised.current.get(slug);
      if (mine !== undefined) dismiss(mine);
      raised.current.delete(slug);
    };
    const id = announce(title, description, [
      ...(wiring.current.onShowDiff
        ? [
            {
              label: "See the difference",
              ariaLabel: `Compare ${doc.name} with the file on disk`,
              onAct: () => {
                wiring.current.onShowDiff?.(slug);
                letGo();
              },
            },
          ]
        : []),
      {
        label: "Reload",
        ariaLabel: `Reload ${doc.name} from the file on disk`,
        onAct: () => wiring.current.onReload(slug),
      },
      {
        label: "Keep",
        ariaLabel: `Keep your version of ${doc.name} for now`,
        onAct: letGo,
      },
    ]);
    raised.current.set(slug, id);
  }, [doc, announce, dismiss]);

  return null;
}
