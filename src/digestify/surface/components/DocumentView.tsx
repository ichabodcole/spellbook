import hljs from "highlight.js/lib/common";
import { useEffect, useMemo, useRef } from "react";
import { splitDocument } from "../state/document";
import { renderMd } from "../state/markdown";
import type { Answers, Comment, Payload, Theme } from "../state/types";
import { AnnotationLayer } from "./AnnotationLayer";
import { QuestionCard } from "./QuestionCard";
import { SanitisedHtml } from "./SanitisedHtml";

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
      className="doc-prose relative mx-auto max-w-[860px] px-6 pt-10 pb-30 max-narrow:px-4 max-narrow:pt-8 max-narrow:pb-24"
    >
      {segments.map((segment, i) => {
        if (segment.kind === "html") {
          // Segments are positional and the document never changes, so the
          // index IS the identity here.
          return <SanitisedHtml key={`html-${i}`} html={segment.html} className="contents" />;
        }
        const question = questions.get(segment.id);
        if (!question) {
          // An id with no question is left exactly where it was, invisibly —
          // the old page's `if (!q) return` (template.html 1160-1161).
          return <SanitisedHtml key={`orphan-${i}`} html={segment.marker} className="contents" />;
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
