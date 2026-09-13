// The notes on the open document (E45).
//
// ⛔ A LIST, NOT ONLY MARGIN MARKS. Notes are highlighted in the text AND
// gathered here, because the use Cole described is a PASS: go through a
// document flagging things, then decide what to do with the batch. A gutter
// icon answers "is there a note on this line"; only a list answers "what have I
// flagged", which is the question that makes the batch sendable later.
//
// ⛔ AND IT IS WHERE AN ORPHAN CAN LIVE. A note whose text was deleted has no
// line to sit beside — in a margin-only design it would silently vanish, which
// is the one outcome the anchoring is built to prevent. Here it keeps its place
// in the list, marked, still readable, still deletable.
import { cn } from "cn";
import {
  CheckIcon,
  MessageSquarePlusIcon,
  PencilIcon,
  Trash2Icon,
  UndoDotIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/ui/button";
import type { PlacedNote } from "../../backend/protocol";

/** How a note found its place, said plainly — or nothing, when it is certain. */
const UNCERTAIN: Partial<Record<PlacedNote["how"], { label: string; title: string }>> = {
  nearest: {
    label: "moved?",
    title:
      "This text appears more than once and its surroundings changed. This is the closest match — it may be the wrong one.",
  },
  orphaned: {
    label: "text gone",
    title: "The text this note was made on is no longer in this version.",
  },
};

function Note({
  note,
  onGoTo,
  onEdit,
  onResolve,
  onRemove,
}: {
  note: PlacedNote;
  onGoTo: (n: PlacedNote) => void;
  onEdit: (id: string, body: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const uncertain = UNCERTAIN[note.how];
  const anchored = note.from !== null;
  // ⛔ EDITING CHANGES WHAT A NOTE SAYS, NEVER WHAT IT IS ABOUT (E46). The quote
  // stays put: a note you rewrote is still about the passage you made it on, and
  // re-quoting on edit would silently move it to wherever the caret happened to be.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div
      className={cn(
        "group/note rounded-md border border-edge bg-bg px-2 py-1.5 text-xs",
        note.resolved && "opacity-60",
      )}
    >
      <div className="flex items-start gap-1.5">
        <button
          type="button"
          onClick={() => onGoTo(note)}
          disabled={!anchored}
          title={anchored ? "Show this in the document" : "This note has no place in the text"}
          className={cn(
            "min-w-0 flex-1 truncate text-left font-mono text-[11px] text-ink-dim",
            anchored && "hover:text-ink hover:underline",
            !anchored && "cursor-default line-through",
          )}
        >
          {note.quote.replace(/\s+/gu, " ").trim() || "—"}
        </button>
        {uncertain && (
          <span
            title={uncertain.title}
            className="shrink-0 rounded-sm bg-attention/15 px-1 text-[10px] text-attention"
          >
            {uncertain.label}
          </span>
        )}
      </div>
      {draft === null ? (
        <p className="mt-1 whitespace-pre-wrap text-ink">{note.body}</p>
      ) : (
        <form
          className="mt-1 flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim()) onEdit(note.id, draft);
            setDraft(null);
          }}
        >
          <textarea
            // biome-ignore lint/a11y/noAutofocus: the human just asked to edit this note
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className={cn(
              "w-full resize-none rounded-md border border-edge bg-bg px-2 py-1.5 text-xs text-ink",
              "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
            )}
            onKeyDown={(e) => {
              if (e.key === "Escape") setDraft(null);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey))
                e.currentTarget.form?.requestSubmit();
            }}
          />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ink-faint">⌘↩ to save · esc to cancel</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDraft(null)}
              className="ml-auto h-5 px-1.5 text-[11px]"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!draft.trim()}
              className="h-5 px-1.5 text-[11px]"
            >
              Save
            </Button>
          </div>
        </form>
      )}
      <div className="mt-1 flex items-center gap-1 text-[10px] text-ink-faint">
        <span>{note.who === "agent" ? "Agent" : "You"}</span>
        <span>·</span>
        <span>v{note.version}</span>
        {note.editedAt !== undefined && <span title="This note was rewritten">· edited</span>}
        <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover/note:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={() => setDraft(note.body)}
            title="Rewrite this note"
            aria-label="Edit note"
            className="rounded-sm p-0.5 hover:bg-surface-raised hover:text-ink"
          >
            <PencilIcon aria-hidden className="size-3" />
          </button>
          <button
            type="button"
            onClick={() => onResolve(note.id, !note.resolved)}
            title={note.resolved ? "Put this note back" : "Mark this note dealt with"}
            aria-label={note.resolved ? "Reopen note" : "Resolve note"}
            className="rounded-sm p-0.5 hover:bg-surface-raised hover:text-ink"
          >
            {note.resolved ? (
              <UndoDotIcon aria-hidden className="size-3" />
            ) : (
              <CheckIcon aria-hidden className="size-3" />
            )}
          </button>
          <button
            type="button"
            onClick={() => onRemove(note.id)}
            title="Delete this note"
            aria-label="Delete note"
            className="rounded-sm p-0.5 hover:bg-surface-raised hover:text-danger"
          >
            <Trash2Icon aria-hidden className="size-3" />
          </button>
        </span>
      </div>
    </div>
  );
}

export function NotesPanel({
  notes,
  selection,
  onAdd,
  onGoTo,
  onEdit,
  onResolve,
  onRemove,
}: {
  notes: PlacedNote[];
  /** The editor's current selection, or null — what a new note would be about. */
  selection: { from: number; to: number; text: string } | null;
  onAdd: (from: number, to: number, body: string) => void;
  onGoTo: (n: PlacedNote) => void;
  onEdit: (id: string, body: string) => void;
  onResolve: (id: string, resolved: boolean) => void;
  onRemove: (id: string) => void;
}) {
  const [body, setBody] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const open = notes.filter((n) => !n.resolved);
  const resolved = notes.filter((n) => n.resolved);
  const shown = showResolved ? notes : open;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selection || !body.trim()) return;
    onAdd(selection.from, selection.to, body);
    setBody("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {shown.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-ink-faint">
            Select some text in the document and write a note about it.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {shown.map((n) => (
              <Note
                key={n.id}
                note={n}
                onGoTo={onGoTo}
                onEdit={onEdit}
                onResolve={onResolve}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
        {resolved.length > 0 && (
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="mt-2 w-full rounded-sm px-1 py-1 text-[11px] text-ink-faint hover:text-ink"
          >
            {showResolved ? "Hide" : "Show"} {resolved.length} resolved
          </button>
        )}
      </div>

      <form onSubmit={submit} className="shrink-0 border-t border-edge p-2">
        {/* ⛔ THE QUOTE IS SHOWN BEFORE THE NOTE IS MADE. A note is about a
            passage, and writing one without seeing which passage is how you end
            up with a note on the wrong sentence. */}
        <p className="mb-1 truncate font-mono text-[11px] text-ink-faint">
          {selection ? selection.text.replace(/\s+/gu, " ").trim() : "No selection"}
        </p>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={!selection}
          placeholder={selection ? "What about it?" : "Select text in the document first"}
          rows={2}
          className={cn(
            "w-full resize-none rounded-md border border-edge bg-bg px-2 py-1.5 text-xs text-ink",
            "placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
          onKeyDown={(e) => {
            // ⌘↩ submits, because a note is prose and Enter must make a line.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
          }}
        />
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[10px] text-ink-faint">⌘↩ to add</span>
          <Button
            type="submit"
            size="sm"
            disabled={!selection || !body.trim()}
            className="ml-auto h-6 px-2 text-xs"
          >
            <MessageSquarePlusIcon aria-hidden className="size-3" />
            Add note
          </Button>
        </div>
      </form>
    </div>
  );
}
