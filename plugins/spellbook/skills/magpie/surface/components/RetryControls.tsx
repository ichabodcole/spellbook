// surface/components/RetryControls.tsx
// STUB — controls to re-run background removal for the focused element (pick a
// backend, tweak settings, retry). Backends are stubbed (see scripts/backend.ts);
// the settings surface is being designed in parallel.
import type { ClientToServer, MagpieState } from "../state/types";

export function RetryControls({
  state,
  send: _send,
}: {
  state: MagpieState;
  send: (m: ClientToServer) => void;
}) {
  // TODO(mock): backend picker (REMOVAL_BACKENDS) + settings + a retry button
  // that fires element.retry for the focused element. Placeholder for now.
  void state;
  return (
    <div className="card p-3 flex flex-col gap-2">
      <span className="section-title">Retry</span>
      <p className="text-faint text-xs">
        {/* TODO(mock): backend picker + settings + retry */}
        removal-model retry controls land here
      </p>
    </div>
  );
}
