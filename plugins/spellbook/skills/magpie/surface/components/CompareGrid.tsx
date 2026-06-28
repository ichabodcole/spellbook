// surface/components/CompareGrid.tsx
// STUB — side-by-side comparison of candidate cutouts (one per removal model /
// retry) for the focused element, previewed against the chosen backdrop. The
// candidate-cutout shape is mocked out (see Element // TODO(mock) markers).
import type { ClientToServer, MagpieState } from "../state/types";

export function CompareGrid({
  state,
  send: _send,
}: {
  state: MagpieState;
  send: (m: ClientToServer) => void;
}) {
  // TODO(mock): grid of candidate cutouts for the focused element, each
  // rendered over `state.backdrop`; click picks the winner (element.update with
  // chosenCutoutId). Awaiting the candidate-cutout model from the mock track.
  return (
    <section
      className="card flex items-center justify-center min-h-0 h-full text-center p-6"
      data-backdrop={state.backdrop}
    >
      <p className="text-faint text-sm">
        {/* TODO(mock): candidate cutouts to compare */}
        Compare grid — candidate cutouts appear here once removal runs.
      </p>
    </section>
  );
}
