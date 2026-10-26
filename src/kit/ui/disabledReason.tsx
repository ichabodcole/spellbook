// A control that cannot act right now, and says why to every reader.
//
// A `disabled` button leaves the tab order, and its `title` is a mouse-only
// tooltip, so a keyboard or screen-reader user never learns why it is off.
// Instead such a control stays focusable with `aria-disabled`, its click does
// nothing, and the reason is its accessible description (`aria-describedby`
// on a hidden note), which a screen reader reads on focus. The `title` stays
// for the pointer.
//
// Style it off with the aria-disabled variant rather than the disabled one.

import type { ReactNode } from "react";

/**
 * The props that keep a control focusable while it cannot act, with its
 * reason as its description; `{}` when `reason` is empty (it can act). `id`
 * names the note `DisabledReason` renders, unique on the page.
 */
export function disabledReasonProps(
  reason: string | null | undefined,
  id: string,
): { "aria-disabled"?: true; "aria-describedby"?: string } {
  return reason ? { "aria-disabled": true, "aria-describedby": id } : {};
}

/** The hidden note a control's `aria-describedby` points at; nothing when it can act. */
export function DisabledReason({
  reason,
  id,
}: {
  reason: string | null | undefined;
  id: string;
}): ReactNode {
  if (!reason) return null;
  return (
    <span id={id} hidden data-slot="disabled-reason">
      {reason}
    </span>
  );
}
