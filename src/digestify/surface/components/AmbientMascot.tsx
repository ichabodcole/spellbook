/**
 * The mascot that watches from the bottom-right corner.
 *
 * ⚠ THE `[src]` REVEAL IS BEHAVIOUR, NOT DECORATION. The old page always put
 * the `<img>` in the markup and only sometimes gave it a `src`; the element is
 * `opacity: 0` until it has one, so a theme with no mascot (classic) shows
 * nothing without any branch in the script. Classic hides it outright on top of
 * that, and EVERY theme hides it under 640 px, where it would cover the text.
 */
export function AmbientMascot({ src, theme }: { src: string; theme: string }) {
  return (
    <img
      className="pointer-events-none fixed right-[max(22px,calc((100vw-1120px)/2))] bottom-[18px] z-2 w-[clamp(120px,16vw,220px)] translate-y-3 rotate-[-3deg] opacity-0 transition-[opacity,transform] duration-200 [filter:var(--mascot-filter)] max-md:hidden data-[has-src=1]:translate-y-0 data-[has-src=1]:opacity-100 data-[theme=classic]:hidden"
      data-has-src={src ? "1" : undefined}
      data-theme={theme}
      src={src || undefined}
      alt=""
      aria-hidden="true"
    />
  );
}
