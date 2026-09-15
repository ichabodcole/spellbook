import type { Theme } from "../state/types";

/**
 * What replaces the whole page after a successful submit.
 *
 * Two branches, and which one a theme takes is decided by whether it ships a
 * sent-page illustration. If it does, THE MASCOT IS THE MESSAGE and there is no
 * headline. If it does not, a "✓ Sent" headline stands in, with the ambient
 * mascot below it when that had a src — a combination no shipped theme reaches,
 * because every theme with an ambient mascot also has a sent one. classic
 * therefore gets the headline and no image at all.
 */
export function SentScreen({ theme }: { theme: Theme }) {
  return (
    <div className="px-6 py-20 text-center text-brand-ink">
      {theme.sentMascotSrc ? (
        <img
          className="mx-auto mt-0 mb-4.5 block w-[clamp(120px,18vw,200px)] [filter:drop-shadow(0_14px_24px_rgb(106_77_188/0.2))]"
          src={theme.sentMascotSrc}
          alt="Digested"
        />
      ) : (
        <>
          <h2 className="mx-0 mt-0 mb-6 inline-block text-[56px] font-black tracking-[-1px] text-brand-strong">
            ✓ Sent
          </h2>
          {theme.mascotSrc ? (
            <img
              className="mx-auto mt-0 mb-4.5 block w-[clamp(120px,18vw,200px)] [filter:drop-shadow(0_14px_24px_rgb(106_77_188/0.2))]"
              src={theme.mascotSrc}
              alt=""
              aria-hidden="true"
            />
          ) : null}
        </>
      )}
      <p className="m-0 text-base text-ink-dim">You can close this tab.</p>
    </div>
  );
}
