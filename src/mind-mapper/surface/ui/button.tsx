// Vendored shadcn-style button (t-e56a8727 sweep). Variants are a plain
// lookup, not cva — the dep cap holds (vine msg 29/33). Variant recipes are
// designed so call sites never need conflicting utility overrides: the
// dep-free cn() does not conflict-resolve, so a variant must replace a
// recipe, never fight one (that's what the "card" variant and "auto" size
// exist for).

import type * as React from "react";
import { cn } from "../lib/utils";

type ButtonVariant = "outline" | "ghost" | "card";
type ButtonSize = "sm" | "icon" | "icon-xs" | "auto";

const VARIANT: Record<ButtonVariant, string> = {
  outline:
    "rounded-md border border-border bg-secondary text-muted-foreground hover:border-ring hover:text-foreground",
  ghost: "rounded-md text-muted-foreground hover:text-foreground",
  card: "w-full rounded-lg border border-border bg-transparent text-left hover:border-ring",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5",
  icon: "h-7 w-7",
  "icon-xs": "h-4 w-4",
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
        "inline-flex items-center justify-center gap-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...props}
    />
  );
}

export { Button };
