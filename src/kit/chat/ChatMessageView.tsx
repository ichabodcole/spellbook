// One line of the conversation.
//
// Agents answer in markdown, so the log RENDERS it, rendered only: a message is
// read, never edited, and the agent chose markdown to be read rendered. The
// human's messages render too, so the two sides read alike; micromark leaves
// ordinary prose alone (`snake_case`, `2 * 3`, a lone `*`), so a human who never
// meant markdown sees what they typed. A system line, or an `info` line, is the
// daemon's own words about an act ("Agent moved ...") and stays plain text.
//
// Two fields drive how it looks. `from` says who is speaking (the human, the
// agent, the system) and `type` says what the line is: a spoken `message`, an
// `info` line about something that happened, or the `result` of work.
//
// THE HTML COMES FROM `lib/markdown.ts` AND NOWHERE ELSE. Chat text is written by
// the agent, which is exactly the input the renderer's refusals are for: raw HTML
// is encoded, and a link target that is not http, https, mailto or relative is
// struck through and does nothing. Links behave as they do in a rendered
// document, through the one shared rule in `renderedLink.ts`.
//
// Kept presentational: a message and a callback in, markup out, no daemon.
import { CheckCircle2Icon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { bundleDisplayName, bundleOf, isBundleMember } from "../lib/bundles.ts";
import { cn } from "../lib/cn.ts";
import { EMBED_IN_CHAT, renderMarkdown } from "../lib/markdown.ts";
import { oneLine } from "../lib/oneLine.ts";
import type { Message, MessageAbout } from "../workspace/protocol";
import { onRenderedLinkClick } from "./renderedLink.ts";
import { type BadgeKind, WaitingBadge } from "./WaitingBadge.tsx";

/** The line range, said the way a human would read it. */
export function linesLabel(a: { fromLine?: number; toLine?: number }): string | null {
  if (a.fromLine === undefined) return null;
  if (a.toLine === undefined || a.toLine === a.fromLine) return `line ${a.fromLine}`;
  return `lines ${a.fromLine}–${a.toLine}`;
}

/**
 * A path as a chip names it: its last segment without its document extension,
 * or, at or inside a bundle, the bundle's name (its folder's, without the
 * extension: the surface passes `pathName` to name it by its title). A
 * document in a bundle's member folder is a document of its own, named as one.
 */
export const pathLabel = (path: string): string => {
  const b = bundleOf(path);
  if (b && !isBundleMember(path))
    return bundleDisplayName(b.root.split("/").pop() ?? b.root, undefined);
  return (path.split("/").pop() ?? path).replace(/\.(md|markdown|txt)$/i, "");
};

/** Pointed-at documents, as a chip reads them: up to three names, else a count. */
export function pointedLabel(names: readonly string[]): string {
  if (names.length <= 3) return names.join(", ");
  return `${names.length} documents`;
}

/** What a message was about, as the chip reads: `plan · v3 · lines 4–6`. Null when it names no document. */
export function aboutLabel(
  about: MessageAbout,
  docName: (slug: string) => string,
  pathName: (path: string) => string = pathLabel,
): string | null {
  const parts: string[] = [];
  if (about.doc) parts.push(docName(about.doc));
  if (about.doc && about.version !== undefined) parts.push(`v${about.version}`);
  const lines = linesLabel(about);
  if (lines) parts.push(lines);
  if (about.noteId) parts.push("a note");
  // An old message's pointed documents (no longer written), as it always read.
  if (about.docs?.length) parts.push(pointedLabel(about.docs.map((p) => pathName(p))));
  // What it drew on besides its subject: the subject's own path is already named.
  if (about.refs?.length) {
    const names = about.refs.map((r) => r.label ?? pathName(r.path));
    parts.push(`with ${names.length <= 3 ? names.join(", ") : `${names.length} references`}`);
  }
  // A whole document or image named as the subject, with no slug to name it by.
  if (!about.doc && about.path) parts.unshift(pathName(about.path));
  if (about.entryIds?.length)
    parts.push(
      `${about.entryIds.length} context ${about.entryIds.length === 1 ? "item" : "items"}`,
    );
  return parts.length ? parts.join(" · ") : null;
}

export function ChatMessageView({
  message: m,
  badge,
  docName = (slug) => slug,
  pathName = pathLabel,
  onFollowLink,
  actions,
}: {
  message: Message;
  /** Shown on the message nobody has answered yet. */
  badge?: BadgeKind | null;
  /** A document's display name, from its slug. Default: the slug itself. */
  docName?: (slug: string) => string;
  /** A path's display name (a bundle by its title). Default: `pathLabel`. */
  pathName?: (path: string) => string;
  /** An internal link: the daemon resolves it. */
  onFollowLink?: (target: string) => void;
  /** The app's own actions for this message (`ChatSidebar`'s `messageActions`), under it. */
  actions?: ReactNode;
}) {
  const plain = m.from === "system" || m.type === "info";
  const chip = m.about ? aboutLabel(m.about, docName, pathName) : null;
  return (
    <div
      data-from={m.from}
      data-type={m.type}
      className={cn(
        "rounded-md px-2 py-1 text-xs leading-relaxed text-ink-dim",
        m.from === "agent" && "bg-surface-raised text-ink",
        m.from === "human" && "bg-brand/10 text-ink",
        m.type === "result" && "border-l-2 border-added",
      )}
    >
      {plain ? (
        <>
          <span className="mr-1.5 font-medium text-ink-faint">·</span>
          {m.text}
        </>
      ) : (
        <>
          <span className="flex items-center gap-1 text-[11px] font-medium text-ink-faint">
            {m.type === "result" && <CheckCircle2Icon aria-hidden className="size-3 text-added" />}
            {m.from === "agent" ? "Agent" : "You"}
            {m.type === "result" && <span className="font-normal">· result</span>}
            {/* The gesture, when it was not the composer: shown as sent, known or not. */}
            {m.via && m.via !== "chat" && (
              <span data-slot="via" className="font-normal">
                · {m.via}
              </span>
            )}
          </span>
          <ChatMarkdown id={m.id} text={m.text} onFollowLink={onFollowLink} />
        </>
      )}
      {/* THE RECORD SHOWS WHAT WAS SENT. The passage travelled with the message,
          so the log has to show it: otherwise the human reads "can you answer
          this one?" a week later with no idea what "this" was, while the agent
          had it all along. */}
      {m.about && chip && (
        <p
          data-slot="about-chip"
          className="mt-1 border-l-2 border-edge pl-2 font-mono text-[11px] text-ink-dim"
        >
          <span className="text-ink-faint">{chip}</span>
          {m.about.text && (
            <>
              <br />
              {oneLine(m.about.text)}
            </>
          )}
        </p>
      )}
      {actions != null && actions !== false && (
        <div data-slot="message-actions" className="mt-1.5 flex flex-wrap gap-1.5">
          {actions}
        </div>
      )}
      {badge && <WaitingBadge badge={badge} />}
    </div>
  );
}

/** A message body, rendered. `md-chat` is the narrow-panel variant of `md-prose`. */
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
  const html = useMemo(
    () => renderMarkdown(text, { idPrefix: id, embedReason: EMBED_IN_CHAT }),
    [text, id],
  );
  // Hoisted and memoised (React 19 compares the prop OBJECT): a fresh literal
  // would rewrite the message's DOM on every render of the log, and drop any text
  // the human had selected in it.
  const htmlProp = useMemo(() => ({ __html: html }), [html]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the handler intercepts clicks on the ANCHORS the renderer minted, and an anchor already fires click on Enter.
    // biome-ignore lint/a11y/noStaticElementInteractions: same reason: the interactive elements are those anchors, each already focusable.
    <div
      className="md-prose"
      onClick={(e) => onRenderedLinkClick(e, onFollowLink)}
      // A chat body's HTML sink: renderer output only, so raw HTML is encoded
      // and links are checked. A test holds this the only sink in the kit, fed only
      // by `renderMarkdown`.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the sink the header describes.
      dangerouslySetInnerHTML={htmlProp}
    />
  );
}
