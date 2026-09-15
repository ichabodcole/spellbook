// surface/components/ActivityBars.tsx
// Equalizer-style "working" animation — the in-progress signal (the Re-slice
// button, the Remove-bg processing overlay). Bars inherit the current text color;
// staggered delays make the wave (see .activity-bar / @keyframes wave in styles.css).
export function ActivityBars() {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="activity-bar" style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </span>
  );
}
