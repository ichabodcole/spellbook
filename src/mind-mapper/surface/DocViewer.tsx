// The context canvas — read a source doc beside the map (the proposal's
// map ⇆ context split). Header idiom follows glamour's DetailsFlyout (title,
// kind chip, X). Span highlighting is whitespace-tolerant find-and-mark:
// stub docs are hard-wrapped, so the verbatim excerpt is matched with \s+
// across line breaks (stub-grade anchoring per seam v2 — offsets belong to
// the real source-log).

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Doc } from "./types";
import { Button } from "./ui/button";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The stub docs are prettier-hard-wrapped markdown; reading prose wants real
// paragraphs. Unwrap single newlines, keep paragraph breaks, and drop the
// leading `#` title (the header already shows it). Highlighting happens on
// the normalized text, so the \s+ span match is unaffected.
function normalize(content: string): string {
  const paragraphs = content
    .replace(/\r/g, "")
    .trim()
    .split(/\n{2,}/);
  const body = paragraphs[0]?.startsWith("# ") ? paragraphs.slice(1) : paragraphs;
  return body.map((p) => p.replace(/\n/g, " ")).join("\n\n");
}

function segments(content: string, span?: string): { text: string; mark: boolean }[] {
  if (!span) return [{ text: content, mark: false }];
  const pattern = span.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const match = new RegExp(pattern).exec(content);
  if (!match) return [{ text: content, mark: false }];
  return [
    { text: content.slice(0, match.index), mark: false },
    { text: match[0], mark: true },
    { text: content.slice(match.index + match[0].length), mark: false },
  ];
}

export function DocViewer({
  doc,
  highlight,
  onClose,
}: {
  doc: Doc;
  highlight?: string;
  onClose: () => void;
}) {
  const markRef = useRef<HTMLElement>(null);

  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "center" });
  }, []);

  return (
    <section className="flex min-w-0 flex-1 flex-col border-l border-edge bg-surface">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
        <h2 className="min-w-0 truncate font-story text-sm text-ink">{doc.title}</h2>
        <span className="rounded bg-surface-raised px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-dim">
          {doc.kind}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label="Close document"
          title="Close document"
          className="ml-auto shrink-0"
        >
          <X size={15} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <pre className="whitespace-pre-wrap font-story text-sm leading-relaxed text-ink-dim">
          {segments(normalize(doc.content), highlight).map((seg, i) =>
            seg.mark ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: static 3-segment split
              <mark key={i} ref={markRef} className="rounded-sm bg-canon/25 px-0.5 text-ink">
                {seg.text}
              </mark>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: static 3-segment split
              <span key={i}>{seg.text}</span>
            ),
          )}
        </pre>
      </div>
    </section>
  );
}
