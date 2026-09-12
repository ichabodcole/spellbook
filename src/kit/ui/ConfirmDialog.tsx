import { AlertDialog } from "@base-ui/react/alert-dialog";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { cn } from "../lib/cn";

/**
 * ConfirmDialog — "are you sure?", the one dialog every project rebuilds.
 *
 * A title, a sentence about the consequence, and two buttons. Cole's ask
 * (2026-09-11): "this is a very common UI pattern just across apps … ideally if
 * we can share it". It is the most boring thing several surfaces will agree on,
 * which is the kit's own rule for what belongs here (see Dot).
 *
 * ⛔ THE CONFIRM BUTTON'S TONE IS THE CALLER'S, and this is the same rule Dot
 * states for its fill — here it is forced rather than chosen. The kit's L0 set
 * (../theme/base.css) carries only the five neutral roles this file paints
 * with; the tokens for danger and for a primary action are L1, a spell's own
 * vocabulary, where one spell's alias is another spell's brand slot. A kit
 * component that reached for either would ship one spell's palette into every
 * other one. So the structure, the neutrals and the behaviour are here, and
 * `confirmClassName` carries the spell's own tone for the action; a caller
 * that passes nothing gets a neutral button, readable in every theme.
 *
 * (No utility class is named in this file's prose that the code does not
 * place: kit comments are a Tailwind content source for every adopting spell —
 * grimoire/kit-prose-ward.test.ts.)
 *
 * ⚠ A SPELL THAT IMPORTS THIS MUST IMPORT ../theme/base.css TOO. Since every
 * surface opens `@import "tailwindcss" source(none)`, that stylesheet's own
 * `@source` is the ONLY thing that puts src/kit/ in front of Tailwind: without
 * it this component renders unstyled, at HTTP 200, with a green build.
 * grimoire/kit-styling-ward.test.ts holds that pairing — the cell the ward
 * called for when a second spell adopted a kit component.
 */
export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What will happen, in the human's words — one or two sentences. */
  message?: ReactNode;
  /**
   * A consequence that changes the stakes, set apart from the message (a move
   * that leaves a git repository, a deletion that cannot be undone).
   */
  warning?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** The spell's own tone for the action button (L1 is the caller's, see above). */
  confirmClassName?: string;
  /** Runs on confirm. The dialog does NOT close itself: close it here (or let `useConfirm` do it). */
  onConfirm: () => void;
  /** Called when the human backs out — Cancel, Escape, or the backdrop. */
  onCancel?: () => void;
};

const BUTTON =
  "inline-flex h-8 items-center justify-center rounded-md px-3 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ink-faint disabled:opacity-50";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  warning,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmClassName,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) onCancel?.();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 isolate z-50 bg-black/30 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <AlertDialog.Popup
          data-slot="confirm-dialog"
          className="fixed top-1/2 left-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-3 rounded-xl border border-edge bg-surface p-4 text-ink shadow-lg duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <AlertDialog.Title className="text-sm font-semibold text-ink">{title}</AlertDialog.Title>
          {message && (
            <AlertDialog.Description className="text-sm leading-relaxed text-ink-faint">
              {message}
            </AlertDialog.Description>
          )}
          {warning && (
            <p className="rounded-md border border-edge bg-bg px-2.5 py-2 text-xs leading-relaxed text-ink">
              {warning}
            </p>
          )}
          <div className="mt-1 flex justify-end gap-2">
            <AlertDialog.Close
              className={cn(BUTTON, "border border-edge bg-surface text-ink hover:bg-bg")}
            >
              {cancelLabel}
            </AlertDialog.Close>
            <button
              type="button"
              // Closing is the CALLER's: `useConfirm` unmounts the dialog when
              // it settles, and a component caller closes in `onConfirm`.
              // Calling `onOpenChange(false)` here answered the promise twice —
              // false from the close, then true from the confirm.
              onClick={onConfirm}
              className={cn(
                BUTTON,
                confirmClassName ?? "border border-edge bg-ink text-bg hover:opacity-90",
              )}
            >
              {confirmLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** What a call site asks for, minus the plumbing the hook owns. */
export type ConfirmRequest = Omit<
  ConfirmDialogProps,
  "open" | "onOpenChange" | "onConfirm" | "onCancel"
>;

/**
 * The one-line call site: `if (await confirm({title, message})) …`, with the
 * dialog rendered wherever the component puts `{dialog}`. A second ask while
 * one is open answers the first with `false` — the human only ever sees the
 * question in front of them.
 */
export function useConfirm(): {
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<ConfirmRequest | null>(null);
  const answer = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    const reply = answer.current;
    answer.current = null;
    setPending(null);
    reply?.(ok);
  }, []);

  const confirm = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        answer.current?.(false);
        answer.current = resolve;
        setPending(request);
      }),
    [],
  );

  const dialog = pending ? (
    <ConfirmDialog
      {...pending}
      open
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
      onConfirm={() => settle(true)}
    />
  ) : null;

  return { confirm, dialog };
}
