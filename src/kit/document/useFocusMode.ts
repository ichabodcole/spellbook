// THE PANE'S FOCUS: the editor's handle, kept for the pane and handed on to
// the app's `editor` ref, and the forwarding of focus that lands on the
// shell's centre pane to the editor. A hook of `DocumentPane`'s, called where
// this section sat in it, so the hooks keep their order.

import { type Ref, type RefObject, useEffect, useRef } from "react";
import type { EditorHandle } from "./DocumentView.tsx";

export function useFocusMode({
  rootRef,
  editor,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  editor: Ref<EditorHandle> | undefined;
}) {
  const editorHandle = useRef<EditorHandle | null>(null);
  const setEditor = (h: EditorHandle | null) => {
    editorHandle.current = h;
    if (typeof editor === "function") editor(h);
    else if (editor) (editor as { current: EditorHandle | null }).current = h;
  };
  // Only focus that lands on the pane ITSELF is forwarded. A press on the rendered
  // view must never arrive here, or in split the editor would take focus and
  // collapse the passage being selected: the rendered scroller is focusable by
  // script for exactly that reason (see `MarkdownView`).
  useEffect(() => {
    const pane = rootRef.current?.closest<HTMLElement>('[data-pane="centre"]');
    if (!pane) return;
    const onFocus = (e: FocusEvent) => {
      if (e.target === pane) editorHandle.current?.focus();
    };
    pane.addEventListener("focus", onFocus);
    return () => pane.removeEventListener("focus", onFocus);
    // rootRef is the pane's own useRef, the same object for its life, so this
    // still runs once on mount, as it did inside DocumentPane.
  }, [rootRef]);
  return { editorHandle, setEditor };
}
