type Props = {
  text: string;
  state: "expired" | "warn" | null;
  justReset: boolean;
  onExtend: () => void;
};

/**
 * The idle countdown, and the only control that extends it.
 *
 * `data-state` and `data-just-reset` are kept as ATTRIBUTES rather than folded
 * into class names: they are what the behaviour inventory's S9/S10/S21 rows are
 * written against, and the old page drove its own styling from them. The `↻`
 * glyph is a real character in the markup rather than a `::before`, because a
 * pseudo-element cannot be animated per-instance from a data attribute without
 * a hand-written rule, and this way the spin is one utility.
 *
 * ⚠ THE `group` ON THE BUTTON IS LOAD-BEARING. The ↻ glyph's resting opacity
 * is 0.55 and it goes to 1 on hover — the old page's `#timer-display:hover
 * ::before { opacity: 1 }`. `group-hover:` needs an ancestor carrying `group`,
 * and without it the utility compiles, ships, and never matches: measured 0.55
 * resting AND 0.55 hovered, with S21 and S24 both green throughout. The glyph
 * now has its own inventory row (S25) so the reveal is asserted rather than
 * assumed.
 *
 * ⚠ ONE MECHANISM CHANGE, SAME OBSERVABLE. The old page was a
 * `<div role="button" tabindex="0">` with its own Enter/Space keydown handler
 * (template.html 878-883, 1140-1145). This is a real `<button>`, which gets
 * focus, the button role and Enter/Space activation from the platform — so the
 * hand-rolled key handler is GONE rather than kept beside a native one that
 * would fire it twice on Space. Inventory rows S20 and S23 record the swap.
 */
export function TimerPill({ text, state, justReset, onExtend }: Props) {
  return (
    <button
      type="button"
      id="timer-display"
      title="Time remaining before idle timeout — resets on activity, or click to reset manually"
      data-state={state ?? undefined}
      data-just-reset={justReset ? "1" : undefined}
      onClick={onExtend}
      className="group inline-flex min-w-14 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-edge bg-surface-soft px-2.5 py-1.5 text-[13px] font-extrabold tabular-nums text-ink-dim transition-colors select-none hover:bg-surface hover:text-brand-ink data-[state=warn]:border-alarm-edge data-[state=warn]:bg-alarm-bg data-[state=warn]:text-alarm data-[state=expired]:border-expired data-[state=expired]:bg-expired data-[state=expired]:text-white"
    >
      <span
        aria-hidden="true"
        className="inline-block text-[13px] font-bold opacity-55 transition-transform duration-400 group-hover:opacity-100 data-[spin=1]:rotate-360"
        data-spin={justReset ? "1" : undefined}
      >
        ↻
      </span>
      {text}
    </button>
  );
}
