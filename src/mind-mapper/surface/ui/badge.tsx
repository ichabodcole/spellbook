// Vendored shadcn-style badge (t-e56a8727 sweep). One outline shape; the
// surface's owner/tier tints stay caller-supplied className, same discipline
// as the context menu.

import type * as React from "react";
import { cn } from "../../../kit/lib/cn";

function Badge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 text-xs",
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
