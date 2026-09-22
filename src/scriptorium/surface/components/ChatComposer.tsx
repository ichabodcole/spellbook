// Saying something to the agent (E48).
//
// ⛔ THE SELECTION RIDES ALONG, AND THE HUMAN CAN SEE THAT IT WILL. E5/E11 put
// the selection on the wire from the start — `say` has carried a
// `withSelection` flag and the agent's `tail` has delivered it — and for eight
// slices nothing in the surface ever sent one. The whole point of a co-present
// editor is that "this bit" means something, so the passage is shown as a chip
// before the message goes, and can be dropped.
//
// ⛔ WHAT IS SENT IS A POINTER, NOT A COPY. The message carries the doc, the
// version, the line range and the active version's PATH — so the agent reads
// the file rather than trusting a quotation that was true a moment ago. The
// quoted text travels too, but as what the human SAW, not as the source.
import { cn } from "cn";
import { CornerDownLeftIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/ui/button";

export type Attachable = {
  doc: string;
  name: string;
  version: number;
  fromLine: number;
  toLine: number;
  text: string;
};

/** The line range, said the way a human would read it. */
export function linesLabel(a: Attachable): string {
  return a.fromLine === a.toLine ? `line ${a.fromLine}` : `lines ${a.fromLine}–${a.toLine}`;
}

export function ChatComposer({
  attachable,
  connected,
  onDrop,
  onSend,
}: {
  /** The current selection, or null — what would ride along. */
  attachable: Attachable | null;
  connected: boolean;
  /**
   * The chip's X. ⛔ IT DROPS THE SELECTION, NOT THE CHIP: this used to be a
   * local `dropped` flag reset only on send, so after one X every new
   * selection was hidden too, and the daemon — whose held selection is what
   * `say` attaches — never heard about it. The chip is the selection; there
   * is no second piece of state for it to drift from (`state/selection.ts`).
   */
  onDrop: () => void;
  onSend: (text: string, withSelection: boolean) => void;
}) {
  const [text, setText] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !connected) return;
    onSend(text, attachable !== null);
    setText("");
  };

  return (
    <form onSubmit={submit} className="shrink-0 border-t border-edge p-2">
      {attachable && (
        <div className="mb-1.5 flex items-start gap-1.5 rounded-md border border-edge bg-bg px-2 py-1">
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
            aria-label="Send without this selection"
            title="Send without this selection"
            className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink"
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        disabled={!connected}
        placeholder={connected ? "Ask the agent…" : "Waiting for the daemon…"}
        className={cn(
          "w-full resize-none rounded-md border border-edge bg-bg px-2 py-1.5 text-xs text-ink",
          "placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
        onKeyDown={(e) => {
          // ⌘↩ sends; Enter makes a line, because a question to an agent is
          // prose and often several sentences.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
        }}
      />
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[10px] text-ink-faint">⌘↩ to send</span>
        <Button
          type="submit"
          size="sm"
          disabled={!text.trim() || !connected}
          className="ml-auto h-6 px-2 text-xs"
        >
          <CornerDownLeftIcon aria-hidden className="size-3" />
          Send
        </Button>
      </div>
    </form>
  );
}
