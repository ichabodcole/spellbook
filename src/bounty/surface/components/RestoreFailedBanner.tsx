import type { RestoreFailed } from "../state/types";

/**
 * b16 — the boot restore broke. Deliberately loud and UNDISMISSABLE: it is the
 * explanation for an otherwise inexplicable empty board, so it must outlive a
 * glance. Both values are text nodes (untrusted path/reason strings).
 */
export function RestoreFailedBanner({ info }: { info: RestoreFailed }) {
  return (
    <div
      role="alert"
      className="mb-4 flex max-w-[1200px] flex-wrap items-baseline gap-x-2.5 gap-y-1.5 rounded-md border border-danger bg-danger-bg px-3 py-2.5 text-[0.78rem] leading-normal text-danger"
    >
      <strong className="text-[0.82rem]">The saved board could not be restored.</strong>
      <span>
        This board is empty because the snapshot failed to load — not because it has no cards.
      </span>
      <code className="text-[0.7rem] break-all opacity-90">{info.path}</code>
      <span className="text-[0.7rem] italic break-words opacity-75">{info.reason}</span>
    </div>
  );
}
