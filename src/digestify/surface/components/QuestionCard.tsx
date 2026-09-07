import { renderMd } from "../state/markdown";
import type { Question, StampLine } from "../state/types";
import { Textarea } from "../ui/textarea";

type Props = {
  question: Question;
  stampLines: StampLine[];
  initialAnswer: string | undefined;
  onAnswer: (id: string, value: string) => void;
};

/**
 * One `:::question` fence, rendered where its marker sat in the document.
 *
 * The prompt is FULL BLOCK MARKDOWN (lists, paragraphs, fenced code all
 * welcome), which is why it needs its own wrapper: without a single inner div
 * the flex row would treat every block element as its own flex item and lay the
 * prompt out horizontally (template.html 1176–1188).
 *
 * The textarea is UNCONTROLLED, as the old page's was. Nothing on screen
 * depends on an answer's value, so there is no state to hold and therefore no
 * caret to drop — the failure class that produced the previous conversion's one
 * severe regression.
 */
export function QuestionCard({ question, stampLines, initialAnswer, onAnswer }: Props) {
  return (
    <div className="relative my-8 overflow-hidden rounded-lg border border-edge bg-surface bg-[image:var(--question-bg)] p-6 shadow-[var(--elevation-card)] before:absolute before:inset-y-0 before:left-0 before:w-1.5 before:bg-question-accent before:content-['']">
      {stampLines.length > 0 ? (
        <div
          aria-hidden="true"
          className="absolute top-3.5 right-4.5 rotate-[-8deg] text-[22px] leading-[0.95] font-black uppercase text-[color-mix(in_srgb,var(--color-brand-strong)_16%,transparent)]"
        >
          {stampLines.map((line) => (
            <span
              key={line.text}
              className={line.small ? "block text-[0.62em] tracking-[0.03em]" : "block"}
            >
              {line.text}
            </span>
          ))}
        </div>
      ) : null}

      <div className="qprompt relative mx-0 mt-0 mb-3.5 flex max-w-[88%] items-start gap-2.5 max-md:max-w-full">
        <div
          className="doc-prose min-w-0 flex-auto [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&>p:first-child]:font-extrabold [&>p]:mx-0 [&>p]:mt-0 [&>p]:mb-2.5"
          // ⛔ THE SECOND OF THE SURFACE'S TWO HTML SINKS. renderMd is
          // DOMPurify over marked; sinks.test.ts fails if anything else feeds
          // one.
          dangerouslySetInnerHTML={{ __html: renderMd(question.prompt) }}
        />
      </div>

      <Textarea
        placeholder="Your answer..."
        defaultValue={initialAnswer}
        onInput={(e) => onAnswer(question.id, e.currentTarget.value)}
        className="min-h-23 w-full resize-y rounded-lg border-edge bg-surface px-3.5 py-3 text-base text-ink"
      />
    </div>
  );
}
