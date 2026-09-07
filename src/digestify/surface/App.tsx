import { useEffect } from "react";
import { AmbientMascot } from "./components/AmbientMascot";
import { DocumentView } from "./components/DocumentView";
import { Header } from "./components/Header";
import { SentScreen } from "./components/SentScreen";
import { resolveThemeName, THEMES } from "./state/themes";
import type { Payload } from "./state/types";
import { useReview } from "./state/useReview";

export function App({ payload }: { payload: Payload }) {
  const themeName = resolveThemeName(payload.theme);
  const theme = THEMES[themeName];
  const review = useReview(payload);

  // The palette is an attribute on <body>, which is index.html's element, not
  // this tree's — the three themes are one L3 override on one set of token
  // names (surface/styles.css). Set here rather than in main.tsx so it follows
  // the same payload the rest of the page reads.
  useEffect(() => {
    document.body.dataset.theme = themeName;
  }, [themeName]);

  // The tab title. The daemon already substituted it into <title> at serve
  // time, so this is a second, redundant path to the same string — kept because
  // it is the one the old page actually relied on.
  useEffect(() => {
    document.title = payload.title;
  }, [payload.title]);

  // A native alert, as the old page had. It is the only failure this surface
  // reports to the user, and a modal is the right shape for it: the click that
  // dismisses it is also the acknowledgement that the answers are still here.
  useEffect(() => {
    if (review.submitError === null) return;
    alert(`Submit failed: ${review.submitError}`);
    review.clearSubmitError();
  }, [review.submitError, review.clearSubmitError]);

  if (review.submitted) return <SentScreen theme={theme} />;

  return (
    <>
      <Header
        theme={theme}
        title={payload.title}
        sessionId={review.sessionId}
        restored={review.restored}
        submitting={review.submitting}
        timerText={review.timerText}
        timerState={review.timerState}
        justReset={review.justReset}
        onExtend={review.extendDeadline}
        onSubmit={review.submit}
      />
      <AmbientMascot src={theme.mascotSrc} theme={themeName} />
      <DocumentView
        payload={payload}
        theme={theme}
        comments={review.comments}
        initialAnswers={review.initialAnswers}
        active={!review.submitted}
        onAnswer={review.setAnswer}
        onAddComment={review.addComment}
        onEditComment={review.editComment}
        onDeleteComment={review.deleteComment}
      />
    </>
  );
}
