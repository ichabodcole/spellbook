// Transient announcements — "you're now editing v5" (E42).
//
// ⛔ HAND-WRITTEN, AND THE REASON IS A VERSION GAP, NOT A PREFERENCE. shadcn's
// `toast` recipe is generated against `@base-ui/react` ^1.8, and this repo
// pins ^1.6 at the ROOT for every spell. Installed, its manager accepted
// `add()` without error and its viewport stayed empty — a silent mismatch.
// Bumping base-ui would touch the shadcn components of five spells for one
// toast, and a visual regression in the other four is exactly what our tests
// do not catch, so the dependency stays put and this is ~50 lines instead.
//
// If a second spell wants toasts, THIS is the thing to lift into `kit/ui`
// beside `ConfirmDialog` — same reasoning Cole gave there: "otherwise we'll end
// up recreating it across projects."
//
// A toast is for "that happened, carry on". Anything awaiting a DECISION is a
// bar that persists (the conflict bar), not this.
import { cn } from "cn";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type ToastAction = {
  /** The button's visible text: short, a verb ("Activate"). */
  label: string;
  /** What a screen reader hears when the label alone is ambiguous. */
  ariaLabel?: string;
  onAct: () => void;
};

export type Toast = {
  id: number;
  title: string;
  description?: string;
  actions?: ToastAction[];
};

/** How long an announcement stays up before it withdraws itself. */
const TOAST_MS = 6000;
/**
 * A toast with buttons stays longer: it offers an act, and six seconds is
 * barely time to read it and reach for one. Either kind holds while the
 * pointer is over it or focus is inside it, and restarts its full time when
 * released, so it never vanishes under the hand about to click.
 */
const ACTION_TOAST_MS = 15000;

export function toastMs(toast: Pick<Toast, "actions">): number {
  return toast.actions?.length ? ACTION_TOAST_MS : TOAST_MS;
}

export function useToasts(): {
  toasts: Toast[];
  announce: (title: string, description?: string, actions?: ToastAction[]) => number;
  dismiss: (id: number) => void;
  hold: (id: number, held: boolean) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const durations = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    durations.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const arm = useCallback(
    (id: number) => {
      const ms = durations.current.get(id);
      if (ms === undefined) return;
      const timer = timers.current.get(id);
      if (timer) clearTimeout(timer);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), ms),
      );
    },
    [dismiss],
  );

  const announce = useCallback(
    (title: string, description?: string, actions?: ToastAction[]) => {
      const id = next.current++;
      const toast: Toast = {
        id,
        title,
        ...(description ? { description } : {}),
        ...(actions?.length ? { actions } : {}),
      };
      setToasts((prev) => [...prev, toast]);
      durations.current.set(id, toastMs(toast));
      arm(id);
      return id;
    },
    [arm],
  );

  /** Pause a toast's countdown while it is held; restart it in full on release. */
  const hold = useCallback(
    (id: number, held: boolean) => {
      if (!held) return arm(id);
      const timer = timers.current.get(id);
      if (timer) clearTimeout(timer);
      timers.current.delete(id);
    },
    [arm],
  );

  // Timers outlive the component otherwise, and fire into a dead setState.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return { toasts, announce, dismiss, hold };
}

export function Toasts({
  toasts,
  onDismiss,
  onHold,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
  onHold?: (id: number, held: boolean) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    // `pointer-events-none` on the stack so an announcement never swallows a
    // click meant for the document underneath; each toast takes its own back.
    //
    // ⛔ POSITIONED BY ITS CONTAINER, NOT THE WINDOW (Cole, 2026-09-28). Pinned
    // bottom-right of the window, the stack sat on the conversation column and
    // its cards blocked clicks on the composer and Send. The document pane
    // draws it (`DocumentPane`'s `toasts` slot) at its own bottom-right, above
    // the floating composer, and the pane is resizable, so only the pane knows
    // where that is. It narrows with a narrow pane rather than spilling out.
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute right-3 bottom-3 z-50 flex w-80 max-w-[calc(100%-1.5rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={onDismiss} onHold={onHold} />
      ))}
    </div>
  );
}

function ToastCard({
  toast: t,
  onDismiss,
  onHold,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
  onHold?: (id: number, held: boolean) => void;
}) {
  // Held while EITHER the pointer is over it or focus is inside it: tabbing to
  // a button and then moving the mouse away must not start the clock.
  const pointer = useRef(false);
  const focus = useRef(false);
  const update = () => onHold?.(t.id, pointer.current || focus.current);

  return (
    // The hold listeners only pause a timer; the buttons inside are the
    // interactive elements, and they take keyboard focus on their own.
    <article
      aria-label={t.title}
      onPointerEnter={() => {
        pointer.current = true;
        update();
      }}
      onPointerLeave={() => {
        pointer.current = false;
        update();
      }}
      onFocus={() => {
        focus.current = true;
        update();
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        focus.current = false;
        update();
      }}
      className={cn(
        "pointer-events-auto flex items-start gap-2 rounded-md border border-edge",
        "bg-surface-raised px-3 py-2 text-sm text-ink shadow-lg",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t.title}</p>
        {t.description && <p className="mt-0.5 text-xs text-ink-dim">{t.description}</p>}
        {t.actions && (
          <div className="mt-2 flex flex-wrap gap-2">
            {t.actions.map((a) => (
              <button
                key={a.label}
                type="button"
                aria-label={a.ariaLabel ?? a.label}
                onClick={() => {
                  a.onAct();
                  onDismiss(t.id);
                }}
                className={cn(
                  "rounded-sm border border-edge px-2 py-0.5 text-xs font-medium text-ink",
                  "hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
                )}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(t.id)}
        aria-label="Dismiss"
        className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink"
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </article>
  );
}
