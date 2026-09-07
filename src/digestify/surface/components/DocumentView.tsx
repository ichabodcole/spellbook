import hljs from "highlight.js/lib/common";
import { memo, useEffect, useMemo, useRef } from "react";
import { splitDocument } from "../state/document";
import { renderMd } from "../state/markdown";
import type { Answers, Comment, Payload, Theme } from "../state/types";
import { AnnotationLayer } from "./AnnotationLayer";
import { QuestionCard } from "./QuestionCard";

type Props = {
  payload: Payload;
  theme: Theme;
  comments: Comment[];
  initialAnswers: Answers;
  active: boolean;
  onAnswer: (id: string, value: string) => void;
  onAddComment: (anchor: string, text: string) => string;
  onEditComment: (id: string, text: string) => void;
  onDeleteComment: (id: string) => void;
};

/**
 * The rendered document, with a question card wherever a `:::question` fence
 * was and an annotation layer over the whole thing.
 *
 * `display: contents` on each HTML segment is deliberate: the markdown's blocks
 * must remain layout children of `#doc`, or margins collapse differently either
 * side of every question card.
 */
export function DocumentView(props: Props) {
  const { payload, theme, comments, initialAnswers, active, onAnswer } = props;
  const docRef = useRef<HTMLElement>(null);

  const segments = useMemo(() => splitDocument(renderMd(payload.markdown)), [payload.markdown]);
  const questions = useMemo(
    () => new Map(payload.questions.map((q) => [q.id, q])),
    [payload.questions],
  );

  /**
   * Syntax highlighting, after the document is in the DOM.
   *
   * ⛔ THE OLD PAGE'S `typeof hljs !== "undefined"` GUARD IS GONE, AND ITS
   * ABSENCE IS THE POINT. It existed because highlight.js arrived over a CDN
   * `<script>` tag that could fail — a silent branch where nothing highlighted
   * and nothing errored. `hljs` is now a bundled import; the guard could no
   * longer fail, and a check that cannot fail is a check that misleads the next
   * reader about what can go wrong here.
   *
   * `lib/common` is the ~37-language set, which is exactly what the CDN's
   * `highlight.min.js` shipped — the same auto-detection over the same
   * languages. `lib/index` (~190) would be a behaviour CHANGE in the other
   * direction, detecting languages the old page could not.
   */
  useEffect(() => {
    for (const el of docRef.current?.querySelectorAll("pre code") ?? []) {
      hljs.highlightElement(el as HTMLElement);
    }
  }, []);

  return (
    <main
      id="doc"
      ref={docRef}
      className="doc-prose relative mx-auto max-w-[860px] px-6 pt-10 pb-30 max-md:px-4 max-md:pt-8 max-md:pb-24"
    >
      {segments.map((segment, i) => {
        if (segment.kind === "html") {
          // Segments are positional and the document never changes, so the
          // index IS the identity here.
          return <HtmlSegment key={`html-${i}`} html={segment.html} />;
        }
        const question = questions.get(segment.id);
        if (!question) {
          // An id with no question is left exactly where it was, invisibly —
          // the old page's `if (!q) return` (template.html 1160-1161).
          return <HtmlSegment key={`orphan-${i}`} html={segment.marker} />;
        }
        return (
          <QuestionCard
            key={`q-${segment.id}`}
            question={question}
            stampLines={theme.stampLines}
            initialAnswer={initialAnswers[question.id]}
            onAnswer={onAnswer}
          />
        );
      })}

      <AnnotationLayer
        docRef={docRef}
        comments={comments}
        active={active}
        onAdd={props.onAddComment}
        onEdit={props.onEditComment}
        onDelete={props.onDeleteComment}
      />
    </main>
  );
}

/**
 * One run of the rendered document.
 *
 * ⛔ `memo` IS LOAD-BEARING, AND THE REASON IS A REACT 19 BEHAVIOUR NOBODY HERE
 * KNEW. React 19 re-applies `dangerouslySetInnerHTML` on EVERY update of the
 * element that carries it — it does not compare the previous `__html` and skip.
 * Measured 2026-09-07 with a MutationObserver on this surface: the syntax
 * highlighting applied on mount survived exactly until the countdown's first
 * one-second tick re-rendered App, and then a single `childList` mutation
 * replaced the whole subtree and the classes were gone.
 *
 * That silently breaks TWO things, and the second is worse than the first:
 *   1. highlight.js's work, which is applied to nodes React then discards; and
 *   2. every comment chip, because the AnnotationLayer's host nodes live INSIDE
 *      this subtree, and a wiped subtree detaches the portal containers.
 *
 * Neither is visible on first paint, and neither would ever have been caught by
 * a drive that did not wait a second and then look again.
 *
 * The document is static — one payload, no updates — so the honest fix is for
 * this element never to re-render at all. `html` is a stable string out of a
 * memoised split, so `memo` holds it.
 */
const HtmlSegment = memo(function HtmlSegment({ html }: { html: string }) {
  return (
    <div
      className="contents"
      // ⛔ ONE OF THE SURFACE'S TWO HTML SINKS. renderMd is DOMPurify over
      // marked; sinks.test.ts fails if anything else feeds one.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
