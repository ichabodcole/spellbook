import type { RefObject } from "react";

type Props = {
  left: number;
  top: number;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
};

/**
 * The "Comment" button that follows a text selection.
 *
 * ⛔ IT ACTS ON `mousedown`, NOT ON CLICK, AND THAT IS LOAD-BEARING. By the time
 * a click event arrives the mouse-down has already collapsed the selection, so
 * the anchor text would be gone. `preventDefault` keeps the selection alive and
 * `stopPropagation` keeps the document-level `mouseup` handler — the one that
 * dismisses stale buttons — from firing on this very click.
 *
 * Positioned in PAGE coordinates (scroll offsets included) so it lands on the
 * selection in a scrolled document.
 */
export function FloatingCommentButton({ left, top, buttonRef, onOpen }: Props) {
  return (
    <button
      type="button"
      ref={buttonRef}
      style={{ left: `${left}px`, top: `${top}px` }}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
      className="comment-dots absolute z-100 inline-flex cursor-pointer items-center gap-1.5 rounded-full border-0 bg-brand-ink px-3 py-2 text-xs font-extrabold text-white shadow-[var(--elevation-popover)]"
    >
      Comment
    </button>
  );
}
