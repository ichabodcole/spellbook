// Vendored shadcn-style input — the one primitive mind-mapper does not carry,
// written to the same discipline (dep-free cn(), plain className, the same
// fill/border/ring vocabulary as textarea.tsx). watch.html .identity-input.

import type * as React from "react";
import { cn } from "../../../kit/lib/cn";

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "w-full rounded-md border border-border bg-secondary px-2 py-1.5 text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
