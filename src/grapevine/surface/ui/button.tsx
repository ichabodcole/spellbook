// Vendored shadcn-style button, from mind-mapper's (src/mind-mapper/surface/
// ui/button.tsx) with grapevine's own variants. Variants are a plain lookup,
// not cva — the dep cap holds. A variant REPLACES a recipe, never fights one:
// the dep-free cn() does not conflict-resolve, so call sites never stack a
// conflicting utility on a recipe (that is what "primary", "accent", "joined"
// and the "auto" size exist for).

import type * as React from "react";
import { cn } from "../../../kit/lib/cn";

type ButtonVariant = "outline" | "ghost" | "primary" | "accent" | "joined";
type ButtonSize = "sm" | "icon" | "auto";

const VARIANT: Record<ButtonVariant, string> = {
  outline:
    "rounded-md border border-border bg-secondary text-muted-foreground hover:border-ring hover:text-foreground",
  ghost: "rounded-md text-muted-foreground hover:text-foreground",
  // The send button: the accent fill (watch.html .compose-send).
  primary: "rounded-lg bg-grape font-semibold text-on-grape hover:bg-grape/90",
  // The identity toggle while lurking (watch.html .identity-toggle).
  accent: "rounded-md border border-ring bg-transparent text-grape-soft hover:bg-grape/10",
  // The identity toggle once joined (watch.html .identity-toggle.joined).
  joined: "rounded-md border border-leaf bg-leaf/10 text-leaf-soft",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5",
  icon: "h-7 w-7",
  auto: "",
};

function Button({
  className,
  variant = "outline",
  size = "sm",
  type = "button",
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center gap-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...props}
    />
  );
}

export { Button };
