// Vendored shadcn-style popover on Base UI primitives (grow-with-use, same
// port discipline as context-menu.tsx / alert-dialog.tsx: Radix swapped for
// @base-ui/react, state-function className props narrowed to plain strings,
// dep-free cn()). The filter control (drive7 #3) uses this rather than a
// DropdownMenu because its content is stay-open facet chips — a Menu.Item
// closes on click, which is exactly the wrong grammar for a multi-toggle
// facet list. Popover ships the outside-click + Escape dismiss + focus
// management the hand-rolled dropdown lacked, without auto-closing on a click
// inside. Only the parts the surface consumes today.

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type * as React from "react";
import { cn } from "../../../kit/lib/cn";

// Base UI's className props also accept state-functions; the vendored layer
// deliberately narrows to plain strings (cn stays dependency-free).
type Vendored<C extends React.ElementType> = Omit<React.ComponentProps<C>, "className"> & {
  className?: string;
};

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

function PopoverContent({
  className,
  children,
  sideOffset = 6,
  align = "end",
  ...props
}: Vendored<typeof PopoverPrimitive.Popup> & {
  sideOffset?: number;
  align?: "start" | "center" | "end";
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner sideOffset={sideOffset} align={align} className="outline-none">
        <PopoverPrimitive.Popup
          className={cn(
            "z-50 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none",
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverContent, PopoverTrigger };
