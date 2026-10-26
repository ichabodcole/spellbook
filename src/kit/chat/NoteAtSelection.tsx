// Right-click a passage, write a note about it, without leaving the text.
//
// WHY THIS EXISTS WHEN THE PANEL ALREADY DOES. Making a note is something you do
// mid-read, dozens of times; reading them back is something you do once. The
// fast path belongs where your eyes already are, and the panel keeps the slow one.
//
// ANCHORED TO THE CLICK, CLAMPED TO THE WINDOW. A popup that opens off-screen
// when you right-click near the bottom edge is worse than a centred dialog, so the
// position is measured against the viewport rather than trusted.
//
// The centre pane decides when to show it (it knows where the pointer was and what
// the selection maps to); this is the card.
//
// IT OPENS ON EVERY RIGHT-CLICK IN THE TEXT, NOT ONLY ON A SELECTION. Which menu
// came up used to depend on whether something was selected, which read as
// inconsistent. With only a caret it offers a link at the caret (a note needs a
// passage, so Add note is there but disabled, saying why), and it carries the
// edits the browser's menu gave: Cut, Copy and Paste. The browser's menu
// (spelling, translate, the OS's own entries) stays one gesture away: right-click
// again while this is open, or Shift-right-click. The footer says so.
import {
  ClipboardPasteIcon,
  CopyIcon,
  LinkIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  ScissorsIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { linkShortcutLabel, onMac } from "../lib/platform.ts";
import { Button } from "../ui/button.tsx";
import { type BadgeKind, WaitingDot } from "./WaitingBadge.tsx";

export type At = {
  x: number;
  y: number;
  from: number;
  to: number;
  noteIds: string[];
  /** What the human selected, as their view showed it: sent with a note, for the daemon to check. */
  seen?: string;
};

/**
 * The basic edits, each offered only when given: the pane gives Cut and Copy
 * only over a selection, and Cut and Paste only where the text can be edited.
 */
export type MenuEdits = { cut?: () => void; copy?: () => void; paste?: () => void };

/** The footer's line: how to reach the browser's own menu from here. */
export const NATIVE_MENU_HINT = "Right-click again for the browser menu";

/** A shortcut as this platform writes it: `X` is Cmd-X on a Mac, Ctrl X elsewhere. */
function editShortcut(key: string, mac: boolean = onMac()): string {
  return mac ? `⌘${key}` : `Ctrl ${key}`;
}

const ITEM =
  "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink hover:bg-bg focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none";

const CARD_W = 320;
const MARGIN = 12;

/** Keep the card inside the window, whichever corner was clicked. */
export function placeCard(
  at: Pick<At, "x" | "y">,
  height: number,
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const left = Math.min(Math.max(MARGIN, at.x), viewport.width - CARD_W - MARGIN);
  const below = at.y + MARGIN;
  const top = below + height + MARGIN < viewport.height ? below : at.y - height - MARGIN;
  return { left, top: Math.max(MARGIN, top) };
}

export function NoteAtSelection({
  at,
  quote,
  existing,
  onClose,
  onAdd,
  onShowNote,
  onDeleteNote,
  onAddLink,
  edits,
  linkRefusal,
  noteRefusal,
}: {
  at: At | null;
  /** The selected text, shown so the note is never written about the wrong passage. */
  quote: string;
  /**
   * The notes under the pointer, labelled: usually none or one. `waiting` when
   * the note is still owed an answer, so the passage says so too.
   */
  existing: { id: string; label: string; waiting?: BadgeKind }[];
  onClose: () => void;
  onAdd: (from: number, to: number, body: string) => void;
  onShowNote: (id: string) => void;
  onDeleteNote: (id: string) => void;
  /**
   * Turn the selection into a link, or with no selection (`from === to`) insert
   * one at the caret. Offered only when given: the pane leaves it out where a
   * link cannot be written (no editor, an ended session).
   */
  onAddLink?: (at: At) => void;
  /** Cut, Copy and Paste: see `MenuEdits`. */
  edits?: MenuEdits;
  /**
   * Why the link act cannot be taken here (the caret or the selection is inside
   * an existing link): shown disabled, with this as its reason.
   */
  linkRefusal?: string;
  /** Why no note can be added even over a passage (the session has ended). */
  noteRefusal?: string;
}) {
  // Two steps on purpose: the MENU is where other acts on a passage will go
  // (ask the agent, copy the quote), so it does not fold into the composer.
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
    setPos(
      placeCard(at, card.current.offsetHeight, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
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

  const passage = at.from < at.to;
  const editActs = [
    edits?.cut && { label: "Cut", key: "X", icon: ScissorsIcon, run: edits.cut },
    edits?.copy && { label: "Copy", key: "C", icon: CopyIcon, run: edits.copy },
    edits?.paste && { label: "Paste", key: "V", icon: ClipboardPasteIcon, run: edits.paste },
  ].filter((a) => !!a);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    onAdd(at.from, at.to, body);
    onClose();
  };

  return (
    <div
      ref={card}
      data-slot="note-at-selection"
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
            aria-label="New note"
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
        <div className="flex flex-col p-1">
          {/* EXISTING NOTES FIRST. Right-clicking a passage that is ALREADY noted
              is far more often "what did I say about this?" than "let me say
              something else", so the reading act leads. */}
          {existing.map((n) => (
            <div key={n.id} className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => {
                  onShowNote(n.id);
                  onClose();
                }}
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-ink",
                  "hover:bg-bg focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
                )}
              >
                <MessagesSquareIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate">{n.label}</span>
                {n.waiting && <WaitingDot of="note" badge={n.waiting} />}
              </button>
              {/* IMMEDIATE, LIKE THE PANEL'S. Deleting a note asks nowhere else,
                  and one delete that confirms while its twin does not is worse
                  than either rule applied consistently. Always visible, unlike the
                  panel's: a menu is a list of acts, and an act hidden until hover
                  is one most people will never find. */}
              <button
                type="button"
                onClick={() => {
                  onDeleteNote(n.id);
                  onClose();
                }}
                aria-label={`Delete note: ${n.label}`}
                title="Delete this note"
                className={cn(
                  "shrink-0 rounded-sm p-1.5 text-ink-faint",
                  "hover:bg-bg hover:text-danger focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
                )}
              >
                <Trash2Icon aria-hidden className="size-3.5" />
              </button>
            </div>
          ))}
          {existing.length > 0 && <div className="my-1 h-px bg-edge" aria-hidden />}
          {/* WITH NO PASSAGE, STILL THERE, AND SAYING WHY NOT. A note is about a
              passage; hiding the act would leave the human wondering where it
              went, and the reason is the way to it. */}
          <button
            type="button"
            disabled={!passage || noteRefusal !== undefined}
            title={!passage ? "A note is about a passage: select some text first" : noteRefusal}
            onClick={() => setWriting(true)}
            className={cn(ITEM, "disabled:pointer-events-none disabled:text-ink-faint")}
          >
            <MessageSquarePlusIcon aria-hidden className="size-3.5 text-ink-faint" />
            Add note
            {(!passage || noteRefusal !== undefined) && (
              <span data-slot="why" className="ml-auto text-[10px] text-ink-faint">
                {passage ? "session ended" : "select text first"}
              </span>
            )}
          </button>
          {onAddLink && (
            <button
              type="button"
              disabled={linkRefusal !== undefined}
              title={linkRefusal}
              onClick={() => {
                onAddLink(at);
                onClose();
              }}
              className={cn(ITEM, "disabled:pointer-events-none disabled:text-ink-faint")}
            >
              <LinkIcon aria-hidden className="size-3.5 text-ink-faint" />
              {passage ? "Add link" : "Insert a link"}
              <span
                data-slot={linkRefusal ? "why" : undefined}
                className="ml-auto text-[10px] text-ink-faint"
              >
                {linkRefusal ? "not here" : linkShortcutLabel()}
              </span>
            </button>
          )}
          {editActs.length > 0 && <div className="my-1 h-px bg-edge" aria-hidden />}
          {editActs.map(({ label, key, icon: Icon, run }) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                onClose();
                run();
              }}
              className={ITEM}
            >
              <Icon aria-hidden className="size-3.5 text-ink-faint" />
              {label}
              <span className="ml-auto text-[10px] text-ink-faint">{editShortcut(key)}</span>
            </button>
          ))}
          <p
            data-slot="native-menu-hint"
            title="Shift-right-click opens the browser menu straight away"
            className="mt-1 border-t border-edge px-2 pt-1.5 pb-0.5 text-[10px] text-ink-faint"
          >
            {NATIVE_MENU_HINT}
          </p>
        </div>
      )}
    </div>
  );
}
