import { Check, Pointer } from "lucide-react";

// Human → agent: request a fresh status. Icon button (t12) — resting Pointer
// swaps to a Check (positive tint) for ~1.5s after a poke. On an attention card
// it takes the amber override so it reads in-key with the card.
const BASE =
  "inline-flex items-center justify-center rounded-control-sm border p-1.5 transition-colors";
const TONE = {
  default:
    "border-edge-strong text-ink-2 hover:border-accent/60 hover:text-accent-ink-2 hover:bg-accent/10",
  attention: "border-attention-strong/60 text-attention-ink bg-attention-strong/10",
} as const;

export function Nudge({
  poked,
  onPoke,
  tone = "default",
}: {
  poked: boolean;
  onPoke: () => void;
  tone?: keyof typeof TONE;
}) {
  return (
    <button
      type="button"
      onClick={onPoke}
      title="Nudge — request a fresh status"
      aria-label="Nudge — request a fresh status"
      className={`${BASE} ${TONE[tone]}`}
    >
      {poked ? (
        <Check className="w-4 h-4 text-positive-ink" aria-hidden="true" />
      ) : (
        <Pointer className="w-4 h-4" aria-hidden="true" />
      )}
    </button>
  );
}
