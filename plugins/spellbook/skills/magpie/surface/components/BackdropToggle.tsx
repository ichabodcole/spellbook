// surface/components/BackdropToggle.tsx
// The preview-backdrop switcher (white / gray / black / transparent) cutouts are
// previewed against. Wired to the real backdrop.set gesture — this one is small
// enough to land real; the visual treatment may evolve with the mock track.
import type { Backdrop, ClientToServer, MagpieState } from "../state/types";

const BACKDROPS: readonly Backdrop[] = ["white", "gray", "black", "transparent"];

export function BackdropToggle({
  state,
  send,
}: {
  state: MagpieState;
  send: (m: ClientToServer) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-faint">backdrop</span>
      {BACKDROPS.map((b) => (
        <button
          type="button"
          key={b}
          className={state.backdrop === b ? "chip bg-accent/25 border-accent/50" : "chip"}
          onClick={() => send({ type: "backdrop.set", backdrop: b })}
        >
          {b}
        </button>
      ))}
    </div>
  );
}
