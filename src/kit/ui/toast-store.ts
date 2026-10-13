// Transient announcements ("you are now editing v5"): the store, without React.
//
// Hand-written rather than shadcn's toast recipe, which tracks a newer Base UI
// than this kit pins; the store is small and its timing rules are tests.
//
// A toast is for "that happened, carry on". Anything awaiting a decision is a
// bar that persists, not this.

export type ToastAction = {
  /** The button's text: short, a verb ("Activate"). */
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
export const TOAST_MS = 6000;
/**
 * A toast with buttons stays longer: it offers an act, and six seconds is barely
 * time to read it and reach for one. Either kind holds while the pointer is over
 * it or focus is inside it, and restarts its full time when released, so it never
 * vanishes under the hand about to click.
 */
export const ACTION_TOAST_MS = 15000;

export function toastMs(toast: Pick<Toast, "actions">): number {
  return toast.actions?.length ? ACTION_TOAST_MS : TOAST_MS;
}

export type ToastStore = {
  subscribe: (listener: () => void) => () => void;
  /** The current stack. The same array until something changes. */
  snapshot: () => readonly Toast[];
  announce: (title: string, description?: string, actions?: ToastAction[]) => number;
  dismiss: (id: number) => void;
  /** Pause a toast's countdown while it is held; restart it in full on release. */
  hold: (id: number, held: boolean) => void;
  /** Cancel every timer, for when the owner goes away. */
  dispose: () => void;
};

export type ToastTimers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: ToastTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function createToastStore(timers: ToastTimers = realTimers): ToastStore {
  let toasts: readonly Toast[] = [];
  let nextId = 1;
  const listeners = new Set<() => void>();
  const running = new Map<number, unknown>();
  const durations = new Map<number, number>();
  const emit = () => {
    for (const l of [...listeners]) l();
  };

  const stop = (id: number) => {
    if (!running.has(id)) return;
    timers.clear(running.get(id));
    running.delete(id);
  };

  const dismiss = (id: number) => {
    stop(id);
    durations.delete(id);
    if (!toasts.some((t) => t.id === id)) return;
    toasts = toasts.filter((t) => t.id !== id);
    emit();
  };

  const arm = (id: number) => {
    const ms = durations.get(id);
    if (ms === undefined) return;
    stop(id);
    running.set(
      id,
      timers.set(() => dismiss(id), ms),
    );
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => toasts,
    announce(title, description, actions) {
      const id = nextId++;
      const toast: Toast = {
        id,
        title,
        ...(description ? { description } : {}),
        ...(actions?.length ? { actions } : {}),
      };
      toasts = [...toasts, toast];
      durations.set(id, toastMs(toast));
      arm(id);
      emit();
      return id;
    },
    dismiss,
    hold(id, held) {
      if (!durations.has(id)) return;
      if (held) stop(id);
      else arm(id);
    },
    dispose() {
      for (const id of [...running.keys()]) stop(id);
      listeners.clear();
    },
  };
}
