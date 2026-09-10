import { useEffect, useState } from "react";
import type { Theme } from "../state/types";
import { Button } from "../ui/button";
import { SessionIdButton } from "./SessionIdButton";
import { TimerPill } from "./TimerPill";

type Props = {
  theme: Theme;
  title: string;
  sessionId: string;
  restored: boolean;
  submitting: boolean;
  timerText: string;
  timerState: "expired" | "warn" | null;
  justReset: boolean;
  onExtend: () => void;
  onSubmit: () => void;
};

/**
 * The sticky page head: the brand lockup, the document title, the session meta
 * (timer pill + session id), the submit button, and the restore banner that
 * hangs below it.
 *
 * The wordmark has TWO shapes and the empty-string branch is behaviour, not a
 * missing asset: a theme with a `logoSrc` renders the image, and a theme
 * without one (classic) renders its brand TEXT instead (template.html 940–948).
 */
export function Header({
  theme,
  title,
  sessionId,
  restored,
  submitting,
  timerText,
  timerState,
  justReset,
  onExtend,
  onSubmit,
}: Props) {
  return (
    <header className="sticky top-0 z-10 flex items-center justify-between gap-6 border-b border-header-edge bg-header px-7 py-3 shadow-[var(--elevation-soft)] backdrop-blur-lg max-narrow:px-4 max-narrow:py-2.5">
      <div className="min-w-0">
        {theme.logoSrc ? (
          <img
            className="m-0 block h-auto w-[clamp(126px,18vw,192px)] [filter:var(--brand-mark-filter)]"
            src={theme.logoSrc}
            alt="Digestify"
          />
        ) : (
          <span className="m-0 inline-block text-xl leading-none font-extrabold text-brand-ink">
            {theme.brand}
          </span>
        )}
        <h1
          id="page-title"
          className="mt-1 mb-0 overflow-hidden text-[13px] leading-tight font-bold text-ellipsis whitespace-nowrap text-brand-ink max-narrow:max-w-[58vw]"
        >
          {title}
        </h1>
      </div>

      <div className="mr-3.5 ml-auto flex flex-none items-center gap-2.5">
        <TimerPill text={timerText} state={timerState} justReset={justReset} onExtend={onExtend} />
        <SessionIdButton sessionId={sessionId} />
      </div>

      <Button
        id="submit-btn"
        type="button"
        size="lg"
        className="h-auto flex-none rounded-full px-5 pt-2.5 pb-3 text-sm font-black disabled:pointer-events-auto disabled:cursor-wait"
        disabled={submitting}
        onClick={onSubmit}
      >
        {submitting ? theme.submitting : theme.submit}
      </Button>

      {restored ? <RestoredBanner /> : null}
    </header>
  );
}

/** "Draft restored from earlier session" — shown on a restore, AUTO-HIDDEN
 *  AFTER FOUR SECONDS, with no dismiss control (template.html 893, 1055–1059).
 *  The timeout is easy to lose in a rewrite and impossible to notice on first
 *  paint; inventory row L10 is what caught its absence here. */
const BANNER_MS = 4000;

function RestoredBanner() {
  const [shown, setShown] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShown(false), BANNER_MS);
    return () => clearTimeout(t);
  }, []);
  if (!shown) return null;
  return (
    <div
      id="restored-banner"
      className="absolute top-[calc(100%+8px)] left-1/2 z-5 -translate-x-1/2 rounded-full bg-brand-strong px-3.5 py-1.5 text-xs font-extrabold text-white shadow-[var(--elevation-soft)]"
    >
      Draft restored from earlier session
    </div>
  );
}
