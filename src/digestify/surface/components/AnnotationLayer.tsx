import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { anchorNeedle, BLOCK_SELECTOR } from "../state/comments";
import type { Comment } from "../state/types";
import { CommentChip } from "./CommentChip";
import { CommentEditor } from "./CommentEditor";
import { FloatingCommentButton } from "./FloatingCommentButton";

type Props = {
  docRef: React.RefObject<HTMLElement | null>;
  comments: Comment[];
  /** False once the review is submitted — the selection handler is a no-op. */
  active: boolean;
  onAdd: (anchor: string, text: string) => string;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
};

/**
 * Text selection → floating button → inline editor → chip, over a document this
 * component did not render.
 *
 * ⛔ WHY PORTALS INTO HAND-MADE HOST NODES. The document body is sanitised
 * markdown injected with `dangerouslySetInnerHTML`, so React owns none of it,
 * and a comment is anchored to ONE ELEMENT INSIDE it — the nearest `p`, `li`,
 * `blockquote`, `pre` or heading to the end of the selection. The alternatives
 * were both worse: rebuilding the document as React elements means re-parsing
 * the sanitiser's output and becoming a second HTML sink, and anchoring to a
 * top-level block index would move every chip inside a list or a quote to after
 * the whole list or quote. So an empty `<div>` host is inserted after the
 * anchor block, exactly where the old page inserted its chip, and React
 * portals into it. React never re-renders the surrounding subtree (its `__html`
 * never changes), so the hosts survive every render.
 *
 * The SAME host is reused when a chip is edited, which is what keeps an edited
 * comment in its place instead of jumping to the end.
 */
export function AnnotationLayer({ docRef, comments, active, onAdd, onEdit, onDelete }: Props) {
  const hosts = useRef(new Map<string, HTMLElement>());
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const [editor, setEditor] = useState<{
    anchor: string;
    commentId: string | null;
    host: HTMLElement;
  } | null>(null);
  const [floating, setFloating] = useState<{
    anchor: string;
    range: Range;
    left: number;
    top: number;
  } | null>(null);
  const floatingRef = useRef<HTMLButtonElement>(null);

  /** A text node resolves to its parent, then to the nearest block; the whole
   *  document is the fallback, exactly as the old page had it. */
  const nearestBlock = useCallback(
    (node: Node): Element | null => {
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
      return el?.closest(BLOCK_SELECTOR) ?? docRef.current;
    },
    [docRef],
  );

  const hostAfter = useCallback((block: Element): HTMLElement => {
    const host = document.createElement("div");
    block.parentNode?.insertBefore(host, block.nextSibling);
    return host;
  }, []);

  /**
   * Re-anchor the comments restored from a draft, once, after the document is
   * in the DOM. Each chip lands after the FIRST block whose text contains the
   * anchor's first 60 characters — which works for a relaunch against the same
   * markdown. An anchor that cannot be located leaves its chip appended at the
   * bottom of the document as an orphan rather than dropping it.
   *
   * ⛔ A PASSIVE EFFECT, NOT A LAYOUT ONE, AND THE FIRST DRAFT GOT THIS WRONG.
   * React attaches a ref AFTER running that fiber's layout effect, and it walks
   * children first — so this component's layout effect runs BEFORE the parent
   * `<main ref={docRef}>` has its ref, `docRef.current` is null, and the whole
   * restore returns early. Silent: a fresh session looks identical, and only a
   * relaunch with a saved comment shows the loss. Caught by driving L15, not by
   * reading.
   */
  useEffect(() => {
    const doc = docRef.current;
    if (!doc) return;
    for (const comment of comments) {
      if (hosts.current.has(comment.id)) continue;
      const needle = anchorNeedle(comment.anchor);
      let target: Element | null = null;
      for (const block of doc.querySelectorAll(BLOCK_SELECTOR)) {
        if (block.textContent?.includes(needle)) {
          target = block;
          break;
        }
      }
      hosts.current.set(
        comment.id,
        target ? hostAfter(target) : hostAfter(doc.lastElementChild ?? doc),
      );
    }
    rerender();
    // Restore runs once, against the comments present at mount. Later comments
    // get their host from the create path.
  }, [comments, docRef, hostAfter, rerender]);

  useEffect(() => {
    if (!active) return;
    const onMouseUp = (ev: MouseEvent) => {
      // Don't dismiss the floating button if the user clicked it.
      const btn = floatingRef.current;
      if (btn && ev.target instanceof Node && btn.contains(ev.target)) return;
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : "";
      setFloating(null);
      const doc = docRef.current;
      if (!text || !sel || !doc || !sel.anchorNode || !doc.contains(sel.anchorNode)) return;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      setFloating({
        anchor: text,
        range: range.cloneRange(),
        left: rect.left + window.scrollX,
        top: rect.bottom + window.scrollY + 6,
      });
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, [active, docRef]);

  const openEditor = useCallback(() => {
    if (!floating) return;
    const block = nearestBlock(floating.range.endContainer);
    if (!block) return;
    setEditor({ anchor: floating.anchor, commentId: null, host: hostAfter(block) });
    setFloating(null);
  }, [floating, hostAfter, nearestBlock]);

  const closeEditor = useCallback(
    (keepHost: boolean) => {
      if (editor && !keepHost && editor.commentId === null) editor.host.remove();
      setEditor(null);
    },
    [editor],
  );

  const saveEditor = useCallback(
    (text: string) => {
      if (!editor) return;
      if (editor.commentId === null) {
        // Creating: an empty body creates nothing and the host goes away.
        if (!text) {
          editor.host.remove();
          setEditor(null);
          return;
        }
        hosts.current.set(onAdd(editor.anchor, text), editor.host);
        setEditor(null);
        rerender();
        return;
      }
      // Editing: an empty body is a NO-OP — the original chip returns. Use
      // Delete to remove a comment.
      if (text) onEdit(editor.commentId, text);
      setEditor(null);
    },
    [editor, onAdd, onEdit, rerender],
  );

  const remove = useCallback(
    (id: string) => {
      hosts.current.get(id)?.remove();
      hosts.current.delete(id);
      onDelete(id);
    },
    [onDelete],
  );

  return (
    <>
      {comments.map((comment) => {
        const host = hosts.current.get(comment.id);
        // While this comment is being edited the editor occupies its host.
        if (!host || editor?.commentId === comment.id) return null;
        return createPortal(
          <CommentChip
            comment={comment}
            onEdit={() => setEditor({ anchor: comment.anchor, commentId: comment.id, host })}
            onDelete={() => remove(comment.id)}
          />,
          host,
          comment.id,
        );
      })}

      {editor
        ? createPortal(
            <CommentEditor
              anchor={editor.anchor}
              initialText={
                editor.commentId === null
                  ? ""
                  : (comments.find((c) => c.id === editor.commentId)?.text ?? "")
              }
              onSave={saveEditor}
              onCancel={() => closeEditor(false)}
            />,
            editor.host,
          )
        : null}

      {floating
        ? createPortal(
            <FloatingCommentButton
              left={floating.left}
              top={floating.top}
              buttonRef={floatingRef}
              onOpen={openEditor}
            />,
            document.body,
          )
        : null}
    </>
  );
}
