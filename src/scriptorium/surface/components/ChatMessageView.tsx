// One line of the conversation (item chat-renders-markdown).
//
// Agents answer in markdown, so the log RENDERS it — rendered only, by Cole's
// ruling: a message is read, never edited, and the agent chose markdown to be
// read rendered. The human's messages render too, so the two sides read alike;
// micromark leaves ordinary prose alone (`snake_case`, `2 * 3`, a lone `*`), so
// a human who never meant markdown sees what they typed. A SYSTEM line is the
// daemon's own words about an act ("Agent moved …") and stays plain text.
//
// ⛔ THE HTML COMES FROM `state/markdown.ts` AND NOWHERE ELSE. Chat text is
// written by the agent, which is exactly the input the renderer's refusals are
// for: raw HTML is encoded, and a link target that is not http, https, mailto
// or relative is struck through and does nothing. `src/scriptorium/sinks.test.ts`
// declares this component's sink and holds that it is fed by `renderMarkdown`.
//
// Links behave as they do in the rendered document, through the one shared
// rule in `renderedLink.ts`. Nothing else of MarkdownView comes along: a chat
// line has no selection (E51), notes or scroll place (E63) to keep.
//
// Kept presentational — a message and a callback in, markup out, no daemon — so
// it can move into a shared kit chat component when one exists, carrying the
// renderer with it.
import { useMemo } from "react";
import type { ChatMessage, Waiting } from "../../backend/protocol";
import { renderMarkdown } from "../state/markdown";
import { onRenderedLinkClick } from "./renderedLink";
import { WaitingBadge } from "./WaitingBadge";

export function ChatMessageView({
  message: m,
  badge,
  onFollowLink,
}: {
  message: ChatMessage;
  /** E53: shown on the message nobody has answered yet. */
  badge?: Waiting["badge"] | null;
  /** An internal link: the daemon resolves it (E33). */
  onFollowLink?: (target: string) => void;
}) {
  return (
    <div
      data-who={m.who}
      className="rounded-md px-2 py-1 text-xs leading-relaxed text-ink-dim data-[who=agent]:bg-surface-raised data-[who=agent]:text-ink data-[who=human]:bg-rubric/10 data-[who=human]:text-ink"
    >
      {m.who === "system" ? (
        <>
          <span className="mr-1.5 font-medium text-ink-faint">·</span>
          {m.text}
        </>
      ) : (
        <>
          <span className="block font-medium text-[11px] text-ink-faint">
            {m.who === "agent" ? "Agent" : "You"}
          </span>
          <ChatMarkdown id={m.id} text={m.text} onFollowLink={onFollowLink} />
        </>
      )}
      {/* ⛔ THE RECORD SHOWS WHAT WAS SENT (E48). The passage travelled with
          the message, so the log has to show it — otherwise the human reads
          "can you answer this one?" a week later with no idea what "this"
          was, while the agent had it all along. */}
      {m.selection && (
        <p className="mt-1 border-l-2 border-edge pl-2 font-mono text-[11px] text-ink-dim">
          <span className="text-ink-faint">
            {m.selection.doc} · v{m.selection.version} ·{" "}
            {m.selection.fromLine === m.selection.toLine
              ? `line ${m.selection.fromLine}`
              : `lines ${m.selection.fromLine}–${m.selection.toLine}`}
          </span>
          <br />
          {m.selection.text.replace(/\s+/gu, " ").trim()}
        </p>
      )}
      {badge && <WaitingBadge badge={badge} />}
    </div>
  );
}

/** A message body, rendered. `.md-chat` is the narrow-panel variant of `.md-prose`. */
function ChatMarkdown({
  id,
  text,
  onFollowLink,
}: {
  /** The message's id: it scopes the ids a footnote mints to this message. */
  id: string;
  text: string;
  onFollowLink?: (target: string) => void;
}) {
  // Every message renders into the same page, so a `[^1]` in two replies would
  // mint one id twice; `idPrefix` makes them this message's own. A click on a
  // footnote then jumps within this body (`renderedLink.ts`).
  const html = useMemo(() => renderMarkdown(text, { idPrefix: id }), [text, id]);
  // Hoisted and memoised for the same reason as MarkdownView's (React 19
  // compares the prop OBJECT): a fresh literal would rewrite the message's DOM
  // on every render of the log, and drop any text the human had selected in it.
  const htmlProp = useMemo(() => ({ __html: html }), [html]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the handler intercepts clicks on the ANCHORS the renderer minted, and an anchor already fires click on Enter.
    // biome-ignore lint/a11y/noStaticElementInteractions: same reason — the interactive elements are those anchors, each already focusable.
    <div
      className="md-prose md-chat"
      onClick={(e) => onRenderedLinkClick(e, onFollowLink)}
      // A chat body's HTML sink, declared in `src/scriptorium/sinks.test.ts`:
      // renderer output only, so raw HTML is encoded and links are checked.
      dangerouslySetInnerHTML={htmlProp}
    />
  );
}
