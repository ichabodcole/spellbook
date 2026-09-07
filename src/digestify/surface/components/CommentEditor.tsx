import { useEffect, useRef, useState } from "react";
import { EDITOR_ANCHOR_CHARS, truncate } from "../state/comments";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

type Props = {
  anchor: string;
  initialText: string;
  onSave: (text: string) => void;
  onCancel: () => void;
};

/**
 * The inline comment box, used for BOTH creating and editing — one component,
 * as the old page had one `buildEditor`.
 *
 * ⚠ Save trims, and the two empty-save paths differ: creating with an empty
 * body creates nothing, while EDITING to empty is a NO-OP that restores the
 * original chip. Deleting is Delete's job. Both callers implement that; this
 * component only reports the trimmed text (template.html 1339–1348, 1375–1386).
 */
export function CommentEditor({ anchor, initialText, onSave, onCancel }: Props) {
  const [text, setText] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);

  return (
    <div className="my-3 rounded-lg border border-edge border-t-[3px] border-t-brand bg-surface p-3.5 shadow-[var(--elevation-soft)]">
      <div className="mb-1.5 text-[13px] text-ink-dim">
        {"on: "}
        <i>{`"${truncate(anchor, EDITOR_ANCHOR_CHARS)}"`}</i>
      </div>
      <Textarea
        ref={ref}
        placeholder="Comment..."
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        className="field-sizing-fixed min-h-12.5 w-full rounded-lg border-edge px-2.5 py-2 text-base text-ink"
      />
      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          size="sm"
          className="rounded-full px-3 py-1.5 text-xs font-extrabold"
          onClick={() => onSave(text.trim())}
        >
          Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="rounded-full px-3 py-1.5 text-xs font-extrabold text-brand-ink"
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
