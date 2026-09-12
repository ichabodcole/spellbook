// E18 — the status strip under the editor, modelled on Operator's
// `StatusBar.vue`: version + author, updated, saved/unsaved, words and
// characters, separated by dividers. It renders what it is given; the values
// come from DocumentPane (the counts debounced, per Operator's `useContentStats`).
import { cn } from "cn";
import { Fragment, type ReactNode } from "react";
import { Separator } from "@/ui/separator";

/** `low` segments give way first when the centre pane is narrow (verify pass: the strip clipped). */
export type StatusSegment = {
  label?: string;
  value: string;
  priority?: "low";
  /**
   * Rendered INSTEAD of the value — for a segment that is also a control (the
   * version menu, E37). `value` stays required as the plain-text truth of what
   * the segment says, so a node is a richer rendering of it, never a different
   * fact.
   */
  node?: ReactNode;
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
            {s.node ?? <span className="text-ink tabular-nums">{s.value}</span>}
          </span>
        </Fragment>
      ))}
    </div>
  );
}
