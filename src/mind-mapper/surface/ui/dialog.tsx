// Vendored shadcn-style dialog on Base UI primitives (grow-with-use, same port
// discipline as alert-dialog.tsx / context-menu.tsx: Radix swapped for
// @base-ui/react, state-function className props narrowed to plain strings,
// dep-free cn()). Distinct from alert-dialog: a plain Dialog dismisses on
// outside-click + Escape (an alert dialog deliberately does NOT — it forces a
// choice). The group/nest modals (drive7 #6B) are plain Dialogs: an errant
// canvas click SHOULD close them (Cole's ask), and the selection-snapshot at
// open makes that dismissal safe. Controlled via `open`/`onOpenChange` — a
// menu action opens it, no Trigger needed (the alert-dialog precedent).

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type * as React from "react";
import { cn } from "../lib/utils";

// Base UI's className props also accept state-functions; the vendored layer
// deliberately narrows to plain strings (cn stays dependency-free).
type Vendored<C extends React.ElementType> = Omit<React.ComponentProps<C>, "className"> & {
  className?: string;
};

const Dialog = DialogPrimitive.Root;

const DialogTrigger = DialogPrimitive.Trigger;

function DialogContent({ className, children, ...props }: Vendored<typeof DialogPrimitive.Popup>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-background/70 backdrop-blur-sm" />
      <DialogPrimitive.Popup
        className={cn(
          "fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mb-3 flex flex-col gap-1", className)} {...props} />;
}

function DialogTitle({ className, ...props }: Vendored<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-sm font-semibold text-foreground", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: Vendored<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-xs leading-relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger };
