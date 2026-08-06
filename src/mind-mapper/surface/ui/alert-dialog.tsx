// Vendored shadcn-style alert dialog on Base UI primitives (grow-with-use,
// same port discipline as context-menu.tsx: Radix swapped for
// @base-ui/react, state-function className props narrowed to plain strings,
// dep-free cn()). Only the parts the delete flow consumes today — no
// Action/Cancel wrappers: the house Button already carries the variant
// vocabulary, and a variant must replace a recipe, never fight one.

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import type * as React from "react";
import { cn } from "../lib/utils";

// Base UI's className props also accept state-functions; the vendored layer
// deliberately narrows to plain strings (cn stays dependency-free).
type Vendored<C extends React.ElementType> = Omit<React.ComponentProps<C>, "className"> & {
  className?: string;
};

const AlertDialog = AlertDialogPrimitive.Root;

const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

function AlertDialogContent({
  className,
  children,
  ...props
}: Vendored<typeof AlertDialogPrimitive.Popup>) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-background/70 backdrop-blur-sm" />
      <AlertDialogPrimitive.Popup
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-xl",
          className,
        )}
        {...props}
      >
        {children}
      </AlertDialogPrimitive.Popup>
    </AlertDialogPrimitive.Portal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-4 flex justify-end gap-2", className)} {...props} />;
}

function AlertDialogTitle({ className, ...props }: Vendored<typeof AlertDialogPrimitive.Title>) {
  return (
    <AlertDialogPrimitive.Title
      className={cn("text-sm font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function AlertDialogDescription({
  className,
  ...props
}: Vendored<typeof AlertDialogPrimitive.Description>) {
  return (
    <AlertDialogPrimitive.Description
      className={cn("text-xs leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
};
