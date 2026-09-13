// Right-click a passage, write a note about it, without leaving the text (E46).
//
// ⛔ WHY THIS EXISTS WHEN THE PANEL ALREADY DOES. Cole: "this is a little
// quicker, because the user does not need to switch to notes in the panel to
// add a note, only to read or edit a note." Making a note is something you do
// mid-read, dozens of times; reading them back is something you do once. The
// fast path belongs where your eyes already are, and the panel keeps the slow
// one.
//
// ⛔ ANCHORED TO THE CLICK, CLAMPED TO THE WINDOW. A popup that opens off-screen
// when you right-click near the bottom edge is worse than a centred dialog, so
// the position is measured against the viewport rather than trusted.
import { cn } from "cn";
import { MessageSquarePlusIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/ui/button";

export type At = { x: number; y: number; from: number; to: number };

const CARD_W = 320;
const MARGIN = 12;

/** Keep the card inside the window, whichever corner was clicked. */
function place(at: At, height: number): { left: number; top: number } {
  const left = Math.min(Math.max(MARGIN, at.x), window.innerWidth - CARD_W - MARGIN);
  const below = at.y + MARGIN;
  const top = below + height + MARGIN < window.innerHeight ? below : at.y - height - MARGIN;
  return { left, top: Math.max(MARGIN, top) };
}

export function NoteAtSelection({
  at,
  quote,
  onClose,
  onAdd,
}: {
  at: At | null;
  /** The selected text, shown so the note is never written about the wrong passage. */
  quote: string;
  onClose: () => void;
  onAdd: (from: number, to: number, body: string) => void;
}) {
  // Two steps on purpose: the MENU is where other acts on a passage will go
  // (ask the agent, copy the quote), so it does not collapse into the composer.
  const [writing, setWriting] = useState(false);
  const [body, setBody] = useState("");
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!at) {
      setWriting(false);
      setBody("");
    }
  }, [at]);

  useLayoutEffect(() => {
    if (!at || !card.current) return;
    setPos(place(at, card.current.offsetHeight));
  }, [at]);

  useEffect(() => {
    if (writing) field.current?.focus();
  }, [writing]);

  useEffect(() => {
    if (!at) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => {
      if (card.current && !card.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // `mousedown` rather than click: the editor would otherwise move the caret
    // first and drop the selection the note is about.
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [at, onClose]);

  if (!at) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    onAdd(at.from, at.to, body);
    onClose();
  };

  return (
    <div
      ref={card}
      style={{ left: pos?.left ?? at.x, top: pos?.top ?? at.y, width: CARD_W }}
      className={cn(
        "fixed z-50 rounded-md border border-edge bg-surface-raised shadow-lg",
        // Until it has been measured it must not flash at the wrong corner.
        pos ? "opacity-100" : "opacity-0",
      )}
    >
      {writing ? (
        <form onSubmit={submit} className="flex flex-col gap-1.5 p-2">
          <p className="truncate font-mono text-[11px] text-ink-faint">
            {quote.replace(/\s+/gu, " ").trim()}
          </p>
          <textarea
            ref={field}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="What about it?"
            className={cn(
              "w-full resize-none rounded-md border border-edge bg-bg px-2 py-1.5 text-xs text-ink",
              "placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
            )}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
            }}
          />
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-ink-faint">⌘↩ to add · esc to close</span>
            <Button
              type="submit"
              size="sm"
              disabled={!body.trim()}
              className="ml-auto h-6 px-2 text-xs"
            >
              Add note
            </Button>
          </div>
        </form>
      ) : (
        <div className="p-1">
          <button
            type="button"
            onClick={() => setWriting(true)}
            className={cn(
              "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink",
              "hover:bg-bg focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
            )}
          >
            <MessageSquarePlusIcon aria-hidden className="size-3.5 text-ink-faint" />
            Add note
          </button>
        </div>
      )}
    </div>
  );
}
