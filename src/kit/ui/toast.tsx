import { XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { cn } from "../lib/cn";
import { createToastStore, type Toast, type ToastStore } from "./toast-store";

/** A toast store owned by the calling component, cleaned up when it unmounts. */
export function useToastStore(): ToastStore {
  const store = useMemo(() => createToastStore(), []);
  useEffect(() => () => store.dispose(), [store]);
  return store;
}

/** The store's current stack, re-rendering on change. */
export function useToastList(store: ToastStore): readonly Toast[] {
  return useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

/**
 * The stack. It is positioned by its container (a positioned ancestor), not the
 * window: pinned to the window it would sit on whichever column happens to be at
 * the corner and block clicks there. Each toast takes pointer events back; the
 * stack itself passes them through so an announcement never swallows a click
 * meant for what is underneath.
 */
export function Toasts({ store, className }: { store: ToastStore; className?: string }) {
  const toasts = useToastList(store);
  if (toasts.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="toasts"
      className={cn(
        "pointer-events-none absolute right-3 bottom-3 z-50 flex w-80 max-w-[calc(100%-1.5rem)] flex-col gap-2",
        className,
      )}
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} store={store} />
      ))}
    </div>
  );
}

function ToastCard({ toast: t, store }: { toast: Toast; store: ToastStore }) {
  // Held while either the pointer is over it or focus is inside it: tabbing to a
  // button and then moving the mouse away must not start the clock.
  const pointer = useRef(false);
  const focus = useRef(false);
  const update = () => store.hold(t.id, pointer.current || focus.current);

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
      className="pointer-events-auto flex items-start gap-2 rounded-md border border-edge bg-surface-raised px-3 py-2 text-sm text-ink shadow-lg"
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
                  store.dismiss(t.id);
                }}
                className="rounded-sm border border-edge px-2 py-0.5 text-xs font-medium text-ink hover:bg-surface focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => store.dismiss(t.id)}
        aria-label="Dismiss"
        className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink"
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </article>
  );
}
