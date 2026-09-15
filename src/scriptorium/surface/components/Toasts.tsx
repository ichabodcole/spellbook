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

export type Toast = { id: number; title: string; description?: string };

/** How long an announcement stays up before it withdraws itself. */
const TOAST_MS = 6000;

export function useToasts(): {
  toasts: Toast[];
  announce: (title: string, description?: string) => void;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const announce = useCallback(
    (title: string, description?: string) => {
      const id = next.current++;
      setToasts((prev) => [...prev, { id, title, ...(description ? { description } : {}) }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_MS),
      );
    },
    [dismiss],
  );

  // Timers outlive the component otherwise, and fire into a dead setState.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return { toasts, announce, dismiss };
}

export function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    // `pointer-events-none` on the stack so an announcement never swallows a
    // click meant for the document underneath; each toast takes its own back.
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-md border border-edge",
            "bg-surface-raised px-3 py-2 text-sm text-ink shadow-lg",
          )}
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t.title}</p>
            {t.description && <p className="mt-0.5 text-xs text-ink-dim">{t.description}</p>}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss"
            className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink"
          >
            <XIcon aria-hidden className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
