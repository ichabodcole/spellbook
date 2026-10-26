// The status strip under the centre: segments separated by dividers ("v2 by you",
// "saved", "420 words"). It renders what it is given; the spell computes the
// values (debounce a word count where it is computed, not here).
import { Fragment } from "react";
import { cn } from "../lib/cn.ts";
import { Separator } from "./separator.tsx";

/** `low` segments give way first when the strip is narrow. */
export type StatusSegment = {
  /** Keys the segment; defaults to its label, then its value. */
  id?: string;
  label?: string;
  value: string;
  priority?: "low";
  /** Stays at full strength when the strip is faded. */
  loud?: boolean;
};

export function StatusStrip({
  segments,
  fade,
}: {
  segments: StatusSegment[];
  /** The class that fades a segment (a quiet reading mode); `loud` ones are spared. */
  fade?: string;
}) {
  return (
    <div
      data-slot="status-strip"
      className="@container flex min-w-0 items-center gap-2.5 overflow-hidden text-xs whitespace-nowrap text-ink-dim"
    >
      {segments.map((s, i) => (
        <Fragment key={s.id ?? s.label ?? s.value}>
          {i > 0 && (
            <Separator
              orientation="vertical"
              className={cn("my-1.5 h-3", s.priority === "low" && "hidden @[44rem]:block", fade)}
            />
          )}
          <span
            className={cn(
              "items-baseline gap-1",
              s.priority === "low" ? "hidden @[44rem]:flex" : "flex",
              !s.loud && fade,
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
