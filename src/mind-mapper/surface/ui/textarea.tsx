// Vendored shadcn-style textarea (t-e56a8727 sweep).

import type * as React from "react";
import { cn } from "../lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full rounded-md border border-border bg-background px-3 py-2 text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
