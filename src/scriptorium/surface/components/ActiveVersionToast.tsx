// "You're now editing v3" (E42).
//
// ⛔ IT WATCHES THE FACT, NOT THE ACTION. The toast fires on the ACTIVE VERSION
// CHANGING, wherever that came from — branching into a new version, picking one
// from the menu, or the AGENT activating one while the human is reading. The
// last is the case that most needs saying and is the one an
// action-fires-its-own-toast design would miss entirely.
//
// A bar would be wrong here. The conflict bar persists because it is a state
// awaiting a decision; this is "that happened, carry on", which is exactly what
// a toast is for.
import { useEffect, useRef } from "react";

import type { DocView } from "../../backend/protocol";
import { versionName as name } from "../state/newVersions";

export function ActiveVersionToast({
  doc,
  announce,
}: {
  doc: DocView | null;
  announce: (title: string, description?: string) => void;
}) {
  // The version last SEEN per document, so opening a document — or a reconnect
  // handing us a snapshot — is never announced as a change.
  const seen = useRef(new Map<string, number>());

  useEffect(() => {
    if (!doc) return;
    const was = seen.current.get(doc.slug);
    seen.current.set(doc.slug, doc.active);
    if (was === undefined || was === doc.active) return;
    announce(
      `Now editing ${name(doc, doc.active)}`,
      `Your edits and Save go to this version. Was v${was}.`,
    );
  }, [doc, announce]);

  return null;
}
