// E18 — the status strip under the editor, modelled on Operator's
// `StatusBar.vue`: version + author, updated, saved/unsaved, words and
// characters, separated by dividers. It renders what it is given; the values
// come from DocumentPane (the counts debounced, per Operator's `useContentStats`).
import { cn } from "cn";
import { Fragment } from "react";
import { Separator } from "@/ui/separator";

/** `low` segments give way first when the centre pane is narrow (verify pass: the strip clipped). */
export type StatusSegment = {
  label?: string;
  value: string;
  priority?: "low";
};

export function StatusStrip({ segments }: { segments: StatusSegment[] }) {
  return (
    <div
      data-slot="status-strip"
      className="@container flex h-7 shrink-0 items-center gap-2.5 overflow-hidden border-t border-edge bg-surface px-3 text-xs whitespace-nowrap text-ink-dim"
    >
      {segments.map((s, i) => (
        <Fragment key={`${s.label ?? ""}:${i}`}>
          {i > 0 && (
            <Separator
              orientation="vertical"
              className={cn("my-1.5", s.priority === "low" && "hidden @[44rem]:block")}
            />
          )}
          <span
            className={cn(
              "flex items-baseline gap-1",
              s.priority === "low" && "hidden @[44rem]:flex",
            )}
          >
            {s.label && <span>{s.label}:</span>}
            <span className="text-ink tabular-nums">{s.value}</span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}
