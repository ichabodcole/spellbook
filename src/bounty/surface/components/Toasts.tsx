import type { Toast } from "../state/types";

/**
 * Bottom-right stack, newest last. Each toast auto-dismisses after 5 s and
 * there is no manual dismiss — the hook owns the timer. Text is a text node.
 */
export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed right-4 bottom-4 z-100 flex flex-col gap-1.5">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="max-w-88 animate-toast-in rounded-md border border-mammoth bg-surface-raised px-3.5 py-2 text-[0.85rem] text-ink shadow-[0_6px_20px_var(--color-scrim)]"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
