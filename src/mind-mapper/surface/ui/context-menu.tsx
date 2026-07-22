// Vendored shadcn-style context menu on Base UI primitives (adoption card
// t-609741be; alb-frontend components.json conventions — new-york,
// cssVariables — carried over, Radix swapped for @base-ui/react). Only the
// parts the surface consumes today; grow with use.

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import type * as React from "react";
import { cn } from "../lib/utils";

// Base UI's className props also accept state-functions; the vendored layer
// deliberately narrows to plain strings (cn stays dependency-free).
type Vendored<C extends React.ElementType> = Omit<React.ComponentProps<C>, "className"> & {
  className?: string;
};

const ContextMenu = ContextMenuPrimitive.Root;

const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

function ContextMenuContent({
  className,
  children,
  ...props
}: Vendored<typeof ContextMenuPrimitive.Popup>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="outline-none">
        <ContextMenuPrimitive.Popup
          className={cn(
            // max-w bounds a long node title in the label header (MENU(b),
            // finding #3) — the menu used to span the page; min-w keeps the
            // verb rows from collapsing.
            "z-50 min-w-[10rem] max-w-xs overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-lg",
            className,
          )}
          {...props}
        >
          {children}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuItem({ className, ...props }: Vendored<typeof ContextMenuPrimitive.Item>) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(
        "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator({
  className,
  ...props
}: Vendored<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function ContextMenuLabel({
  className,
  ...props
}: Vendored<typeof ContextMenuPrimitive.GroupLabel>) {
  // Base UI mandates GroupLabel inside a Group; shadcn's Label is standalone,
  // so the vendored layer supplies the wrapper.
  return (
    <ContextMenuPrimitive.Group>
      <ContextMenuPrimitive.GroupLabel
        className={cn(
          "px-2 py-1.5 text-[10px] uppercase tracking-widest text-muted-foreground",
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Group>
  );
}

export {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
};
