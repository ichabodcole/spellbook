// Section-header count (t14: fixed-size circular, so "1" and "12" read identical
// — min-w-5 + centered, never hugs the digit). Tint per zone, from @theme.
const TONES = {
  attention: "text-attention-ink bg-attention/20 ring-attention/50",
  active: "text-positive-ink bg-positive-surface/10 ring-positive-surface/30",
  quiet: "text-muted bg-idle/10 ring-idle/30",
} as const;

export function CountBadge({ n, tone }: { n: number; tone: keyof typeof TONES }) {
  return (
    <span
      className={`inline-flex min-w-5 h-5 items-center justify-center rounded-chip px-1 text-[11px] font-medium ring-1 ring-inset ${TONES[tone]}`}
    >
      {n}
    </span>
  );
}
