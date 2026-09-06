// Vendored shadcn-style badge, from mind-mapper's. Two shapes: the stock
// outline pill, and the rail's subscriber count (watch.html `.count`) — a
// variant rather than a stacked override, because cn() does not merge.

import type * as React from "react";
import { cn } from "../../../kit/lib/cn";

type BadgeVariant = "outline" | "count";

const VARIANT: Record<BadgeVariant, string> = {
  outline: "rounded-full border border-border bg-secondary px-2 py-0.5 text-xs",
  count: "shrink-0 rounded-full bg-background px-1.5 py-px text-[10px] text-muted-foreground",
};

function Badge({
  className,
  variant = "outline",
  ...props
}: React.ComponentProps<"span"> & { variant?: BadgeVariant }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1", VARIANT[variant], className)}
      {...props}
    />
  );
}

export { Badge };
