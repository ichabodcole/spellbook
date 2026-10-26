// "Now editing v3".
//
// IT WATCHES THE FACT, NOT THE ACTION. The toast fires on the ACTIVE VERSION
// CHANGING, wherever that came from: branching into a new version, picking one from
// the menu, or the agent activating one while the human is reading. The last is the
// case that most needs saying, and the one an action-fires-its-own-toast design
// would miss entirely.

import { useEffect, useRef } from "react";
import { versionName } from "../chat/newVersions.ts";
import type { DocView } from "../workspace/protocol";

export function ActiveVersionToast({
  doc,
  announce,
}: {
  doc: DocView | null;
  announce: (title: string, description?: string) => void;
}) {
  // The version last SEEN per document, so opening a document, or a reconnect handing
  // us a snapshot, is never announced as a change.
  const seen = useRef(new Map<string, number>());

  useEffect(() => {
    if (!doc) return;
    const was = seen.current.get(doc.slug);
    seen.current.set(doc.slug, doc.active);
    if (was === undefined || was === doc.active) return;
    announce(
      `Now editing ${versionName(doc, doc.active)}`,
      `Your edits and Save go to this version. Was v${was}.`,
    );
  }, [doc, announce]);

  return null;
}
