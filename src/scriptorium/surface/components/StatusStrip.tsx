// E18 — the status strip under the editor, modelled on Operator's
// `StatusBar.vue`: version + author, updated, saved/unsaved, words and
// characters, separated by dividers. It renders what it is given; the values
// come from DocumentPane (the counts debounced, per Operator's `useContentStats`).
import { Fragment } from "react";
import { Separator } from "@/ui/separator";

export type StatusSegment = { label?: string; value: string };

export function StatusStrip({ segments }: { segments: StatusSegment[] }) {
  return (
    <div
      data-slot="status-strip"
      className="flex h-7 shrink-0 items-center gap-2.5 overflow-hidden border-t border-edge bg-surface px-3 text-xs whitespace-nowrap text-ink-faint"
    >
      {segments.map((s, i) => (
        <Fragment key={`${s.label ?? ""}:${i}`}>
          {i > 0 && <Separator orientation="vertical" className="my-1.5" />}
          <span className="flex items-baseline gap-1">
            {s.label && <span>{s.label}:</span>}
            <span className="text-ink-dim tabular-nums">{s.value}</span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}
