/**
 * The mascot that watches from the bottom-right corner.
 *
 * ⚠ THE `[src]` REVEAL IS BEHAVIOUR, NOT DECORATION. The old page always put
 * the `<img>` in the markup and only sometimes gave it a `src`; the element is
 * `opacity: 0` until it has one, so a theme with no mascot (classic) shows
 * nothing without any branch in the script. Classic hides it outright on top of
 * that, and EVERY theme hides it under 640 px, where it would cover the text.
 *
 * ⛔ AND THE SELECTOR IS THE ATTRIBUTE ITSELF — `[&[src]]:`, not a `data-` flag
 * this component sets alongside it. Those are observationally identical for
 * every input the payload can produce (the src is decided once, at boot), and
 * that is exactly why the first draft's `data-has-src` looked right: drive it
 * and the difference appears only when the attribute is removed at runtime,
 * where the old page hides the mascot and a data flag does not. Carrying a
 * mechanism that agrees "for every reachable input" is how a rewrite drifts one
 * defensible step at a time. The attribute selector costs the same and is the
 * thing the old page actually did.
 */
export function AmbientMascot({ src, theme }: { src: string; theme: string }) {
  return (
    <img
      className="pointer-events-none fixed right-[max(22px,calc((100vw-1120px)/2))] bottom-[18px] z-2 w-[clamp(120px,16vw,220px)] translate-y-3 rotate-[-3deg] opacity-0 transition-[opacity,transform] duration-200 [filter:var(--mascot-filter)] max-narrow:hidden [&[src]]:translate-y-0 [&[src]]:opacity-100 data-[theme=classic]:hidden"
      data-theme={theme}
      src={src || undefined}
      alt=""
      aria-hidden="true"
    />
  );
}
