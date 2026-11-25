// A side column's own chrome, shared by the shell's columns and its top bar:
// the small icon button, and the rail a collapsed column is drawn as.

import { type ReactNode, useId } from "react";
import { cn } from "../lib/cn.ts";
import { DisabledReason, disabledReasonProps, QUIET_GROUP } from "../ui/index.ts";

/** The floating composer's input, and the column's: where focus is handed. */
export const FLOAT_INPUT = '[data-slot="floating-composer"] [data-slot="composer-input"]';
export const COLUMN_INPUT = '[data-pane="chat"] [data-slot="composer-input"]';

/** A small icon button for a column's own chrome: collapse, reopen. */
export function ColumnButton({
  label,
  onClick,
  control,
  disabled,
  disabledReason,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /**
   * Why it is off, when `disabled`: it then stays focusable, with this as its
   * description and tooltip (`disabledReason.tsx`), rather than leaving the
   * tab order with nothing said.
   */
  disabledReason?: string;
  /** Names the control so focus can be handed to it when its twin goes away. */
  control?: string;
  className?: string;
  children: ReactNode;
}) {
  const whyId = useId();
  const why = disabled ? disabledReason : undefined;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (!why) onClick();
        }}
        disabled={disabled && !why}
        {...disabledReasonProps(why, whyId)}
        data-column-control={control}
        aria-label={label}
        title={why ?? label}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-faint outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40 aria-disabled:opacity-40 aria-disabled:cursor-not-allowed [&_svg]:size-3.5",
          className,
        )}
      >
        {children}
      </button>
      <DisabledReason reason={why} id={whyId} />
    </>
  );
}

/**
 * A collapsed column's rail: the reopen button alone, on a row as tall as the pane
 * headings beside it, so the icons line up across the window. The column's body
 * stays mounted (hidden and inert) beside it.
 */
export function Rail({
  quiet,
  below,
  children,
}: {
  quiet: boolean;
  /** Under the button, centred on the rail: a mark asking for attention. */
  below?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-slot="column-rail" className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex h-9 shrink-0 items-center justify-center border-b",
          quiet ? `${QUIET_GROUP} border-transparent` : "border-edge",
        )}
      >
        {children}
      </div>
      {below && <div className="flex shrink-0 justify-center">{below}</div>}
    </div>
  );
}
