// Saying something to the agent.
//
// THE SELECTION RIDES ALONG, AND THE HUMAN CAN SEE THAT IT WILL. `say` carries a
// `withSelection` flag and the agent's tail delivers what it attaches. The whole
// point of a co-present editor is that "this bit" means something, so the passage
// is shown as a chip before the message goes, and can be dropped. Selecting is
// the opt-in; the chip's X is the opt-out.
//
// WHAT IS SENT IS A POINTER, NOT A COPY. The message carries the document, the
// version, the line range and the active version's path, so the agent reads the
// file rather than trusting a quotation that was true a moment ago. The quoted
// text travels too, but as what the human SAW, not as the source.
//
// The draft belongs to the caller: moving the composer (a remount) cannot drop
// what the human was typing, and there is never a second draft to disagree with
// the first. The chip is the held selection, not a copy of it.
//
// ONE COMPOSER, DRAWN IN ONE OF TWO PLACES. With the conversation column open it
// sits at the foot of the column; with that column collapsed it floats at the
// foot of the centre (`floating`), because talking to the agent never needs the
// column. The shell holds the draft and draws it in one place at a time.
import { CornerDownLeftIcon, ListTreeIcon, XIcon } from "lucide-react";
import { cn } from "../lib/cn.ts";
import { Button } from "../ui/button.tsx";
import { linesLabel } from "./ChatMessageView.tsx";

/** The held selection as the chip shows it. */
export type Attachable = {
  doc: string;
  /** The document's display name. */
  name: string;
  version: number;
  fromLine: number;
  toLine: number;
  text: string;
};

/** A ref as the chip's second row shows it. */
export type ChipRef = {
  path: string;
  name: string;
  role: string;
  /** `tree`: the file tree's selection, which stays after send and is marked so. */
  from?: "tree" | "added" | "pointed";
};

const NO_REFS: readonly ChipRef[] = [];

/** What the composer says while no agent is listening, before anything is sent. */
export const NO_AGENT_NOTICE =
  "No agent is following this session yet. Messages wait here until one picks it up.";

/** Everything the composer is drawn from, so a caller drawing it twice lists it once. */
export type ChatComposerProps = Parameters<typeof ChatComposer>[0];

export function ChatComposer({
  attachable,
  connected,
  heard = true,
  ended = false,
  draft,
  onDraft,
  onDrop,
  onSend,
  pointed = null,
  pointedLabel = null,
  onDropPointed,
  refs = NO_REFS,
  refsUnsent = 0,
  onDropRef,
  floating = false,
}: {
  /**
   * What the message draws on besides its subject: the file tree's selection
   * and the references added by hand. A second, quieter row under the
   * subject's chip, each labelled by its role, each with its own X.
   */
  refs?: readonly ChipRef[];
  /** Held refs past the cap that will not go: said after the row, so it shows no more than is sent. */
  refsUnsent?: number;
  /** A ref's X: it stops riding along (a tree row is deselected in the tree). */
  onDropRef?: (path: string) => void;
  /** Floating at the foot of the centre while the conversation column is collapsed. */
  floating?: boolean;
  /** The pointed chip's heading, in place of the document count (a view's own label). */
  pointedLabel?: string | null;
  /**
   * Whole documents pointed at (their names), or null: the chip's other kind,
   * from a view that shows documents rather than text. One is the subject and
   * the rest ride along as refs; the chip's X drops them.
   */
  pointed?: readonly string[] | null;
  onDropPointed?: () => void;
  /** The current selection, or null: what would ride along. */
  attachable: Attachable | null;
  connected: boolean;
  /** Whether an agent is listening, so a message is heard when it is sent. Default true. */
  heard?: boolean;
  /** The session was closed on purpose: nothing to wait for. */
  ended?: boolean;
  /**
   * The chip's X. It drops the SELECTION, not just the chip: `say` attaches the
   * selection the daemon holds, so hiding the chip while the daemon still held
   * the passage would send it anyway.
   */
  onDrop: () => void;
  onSend: (text: string, withSelection: boolean) => void;
  /** What the human has typed so far, held by the caller. */
  draft: string;
  onDraft: (text: string) => void;
}) {
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || !connected) return;
    onSend(draft, attachable !== null);
    onDraft("");
  };

  return (
    <form
      onSubmit={submit}
      aria-label={floating ? "Message the agent" : undefined}
      className={cn(
        "shrink-0 p-2",
        floating ? "rounded-lg border border-edge bg-surface shadow-lg" : "border-t border-edge",
      )}
    >
      {/* Up front, not after a 30-second wait: the human is told before they send. */}
      {connected && !ended && !heard && (
        <p
          data-slot="no-agent"
          role="status"
          className="mb-1.5 flex items-center gap-1.5 text-[11px] text-ink-dim"
        >
          <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full bg-ink-faint" />
          {NO_AGENT_NOTICE}
        </p>
      )}
      {attachable && (
        <div
          data-slot="selection-chip"
          className="mb-1.5 flex items-start gap-1.5 rounded-md border border-edge bg-bg px-2 py-1"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[10px] text-ink-faint">
              {attachable.name} · v{attachable.version} · {linesLabel(attachable)}
            </p>
            <p className="truncate font-mono text-[11px] text-ink-dim">
              {attachable.text.replace(/\s+/gu, " ").trim()}
            </p>
          </div>
          <button
            type="button"
            onClick={onDrop}
            aria-label="Clear the selection"
            title="Clear the selection: it stops riding along, and stops being highlighted"
            className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink"
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </div>
      )}
      {((pointed && pointed.length > 0) || pointedLabel) && (
        <div
          data-slot="pointed-chip"
          className="mb-1.5 flex items-start gap-1.5 rounded-md border border-edge bg-bg px-2 py-1"
        >
          <div className="min-w-0 flex-1">
            <p className="text-[10px] text-ink-faint">
              {pointedLabel ??
                (pointed?.length === 1 ? "1 document" : `${pointed?.length ?? 0} documents`)}
            </p>
            {pointed && pointed.length > 0 && (
              <p className="truncate text-[11px] text-ink-dim">{pointed.join(", ")}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onDropPointed}
            aria-label={pointedLabel ? `Clear ${pointedLabel}` : "Clear the documents"}
            title={
              pointedLabel
                ? `Clear ${pointedLabel}: it stops riding along`
                : "Clear the documents: they stop riding along"
            }
            className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink"
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </div>
      )}
      {refs.length > 0 && (
        <ul
          data-slot="refs-row"
          aria-label="Also refers to"
          className="mb-1.5 flex flex-wrap items-center gap-1"
        >
          {refs.map((r) => (
            <li
              key={r.path}
              data-slot="ref-chip"
              data-role={r.role}
              data-from={r.from}
              title={r.path}
              className="flex min-w-0 max-w-full items-center gap-1 rounded-sm border border-edge/70 px-1.5 py-0.5 text-[10px] text-ink-faint"
            >
              {/* A tree ref stays selected there, so it goes with every message
                  until it is deselected (the user, 2026-10-14). One added by
                  hand goes once, and keeps the plain look. */}
              {r.from === "tree" && (
                <span
                  data-slot="ref-tree-mark"
                  role="img"
                  aria-label="selected in the file tree"
                  title="Selected in the file tree: it goes with every message until you deselect it there"
                  className="flex shrink-0 items-center"
                >
                  <ListTreeIcon aria-hidden className="size-2.5" />
                </span>
              )}
              <span className="shrink-0">{r.role}</span>
              <span aria-hidden>·</span>
              <span className="truncate text-ink-dim">{r.name}</span>
              <button
                type="button"
                onClick={() => onDropRef?.(r.path)}
                aria-label={`Drop the reference ${r.name}`}
                title={`Drop ${r.name}: it stops riding along`}
                className="shrink-0 rounded-sm text-ink-faint hover:text-ink"
              >
                <XIcon aria-hidden className="size-2.5" />
              </button>
            </li>
          ))}
          {refsUnsent > 0 && (
            <li data-slot="refs-unsent" className="text-[10px] text-attention">
              and {refsUnsent} more not sent
            </li>
          )}
        </ul>
      )}
      <textarea
        data-slot="composer-input"
        aria-label="Message to the agent"
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        // Two rows afloat: it shares the centre with what it is about, and a
        // question that grows past two lines scrolls in place.
        rows={floating ? 2 : 3}
        disabled={!connected}
        placeholder={
          connected ? "Ask the agent…" : ended ? "Session ended" : "Waiting for the daemon…"
        }
        className={cn(
          "w-full resize-none rounded-md border border-edge bg-bg px-2 py-1.5 text-xs text-ink",
          "placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
        onKeyDown={(e) => {
          // Cmd or Ctrl plus Enter sends; Enter makes a line, because a question
          // to an agent is prose and often several sentences.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
        }}
      />
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[10px] text-ink-faint">⌘↩ to send</span>
        {/* The xs size is the 24 px, 12 px-text button this row wants; a class
            beside sm's own height and text would lose to it (kit-caller-class-overrides). */}
        <Button type="submit" size="xs" disabled={!draft.trim() || !connected} className="ml-auto">
          <CornerDownLeftIcon aria-hidden className="size-3" />
          Send
        </Button>
      </div>
    </form>
  );
}
