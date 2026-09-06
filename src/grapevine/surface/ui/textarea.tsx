// Vendored shadcn-style textarea, from mind-mapper's. The fill is `secondary`
// (the raised surface) rather than `background`, because grapevine's inputs
// sit on cards, not on the page ground (watch.html .compose-input).

import type * as React from "react";
import { cn } from "../../../kit/lib/cn";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full rounded-[10px] border border-border bg-secondary px-3.5 py-2.5 text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none disabled:cursor-not-allowed disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
