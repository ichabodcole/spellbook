import { CHIP_ANCHOR_CHARS, truncate } from "../state/comments";
import type { Comment } from "../state/types";

type Props = { comment: Comment; onEdit: () => void; onDelete: () => void };

/**
 * A saved annotation, sitting after the block it is anchored to.
 *
 * Both user strings are TEXT NODES — JSX children, never HTML. The anchor is
 * truncated for DISPLAY only; the full text is what is stored and submitted.
 */
export function CommentChip({ comment, onEdit, onDelete }: Props) {
  return (
    <div
      data-comment-id={comment.id}
      className="my-2 inline-block max-w-full rounded-[10px] border border-note-edge bg-note px-3 py-2 text-[13px] shadow-[0_8px_18px_color-mix(in_srgb,var(--color-brand)_14%,transparent)]"
    >
      <span className="text-ink-dim italic">
        {`"${truncate(comment.anchor, CHIP_ANCHOR_CHARS)}"`}
      </span>
      {": "}
      <span className="break-words whitespace-pre-wrap">{comment.text}</span>
      <div className="mt-1.5 flex gap-1">
        <ChipAction onClick={onEdit}>Edit</ChipAction>
        <ChipAction onClick={onDelete}>Delete</ChipAction>
      </div>
    </div>
  );
}

function ChipAction({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded border-0 bg-transparent px-1.5 py-0.5 text-[11px] font-extrabold tracking-[0.04em] text-brand-ink uppercase opacity-55 hover:bg-[color-mix(in_srgb,var(--color-brand-ink)_8%,transparent)] hover:opacity-100"
    >
      {children}
    </button>
  );
}
