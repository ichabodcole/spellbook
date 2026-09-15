import { memo } from "react";

/**
 * ⛔ THE SURFACE'S ONE HTML SINK. BOTH CALLERS GO THROUGH IT, AND THAT IS THE
 * WHOLE POINT OF ITS EXISTENCE.
 *
 * There were two sinks — a document segment and a question prompt — and `memo`
 * was applied to ONE of them. The other's subtree was destroyed and rebuilt
 * once per second for the life of the page, because React 19 re-applies
 * `dangerouslySetInnerHTML` on EVERY update of the element that carries it: it
 * does not compare the previous `__html` and skip. Measured on the shipped
 * surface with a `MutationObserver` on `#doc .qprompt > div`: **6 nodes removed
 * and 6 added every second, forever, in both modes.**
 *
 * Three things broke behind that, none of them visible on first paint:
 *   - a comment anchored inside a question prompt lost its chip's portal host,
 *     so the comment stayed in state, was PERSISTED and was SUBMITTED while the
 *     user could not see, edit or delete it;
 *   - an editor opened on prompt text vanished within a second, taking the
 *     typed text and the focus with it;
 *   - text selected inside a prompt was dropped within a second, leaving a
 *     stale floating button.
 *
 * ⛔ AND THE GUARD THAT SHOULD HAVE CAUGHT IT DID NOT, FOR A REASON WORTH MORE
 * THAN THIS COMPONENT. `sinks.test.ts` maintained a list of every sink in the
 * surface — both of them, by name — and then asserted the memoisation property
 * over ONE member of that list. **A guard that enumerates a set and then checks
 * one item is a guard that reports on its own diligence.** The cell is now
 * written over the FOUND set, so a third sink is governed the day it appears.
 *
 * Collapsing the two sinks into one component is the belt to that braces: there
 * is now exactly one place in the surface where a string becomes markup, one
 * place the sanitiser has to have run, and one place to memoise.
 */
export const SanitisedHtml = memo(function SanitisedHtml({
  html,
  className,
}: {
  /** ⛔ MUST be `renderMd(…)` output — DOMPurify over marked. `sinks.test.ts`
   *  fails if any caller feeds this anything else. */
  html: string;
  className?: string;
}) {
  return (
    <div
      className={className}
      // The surface's ONE sink, by construction; see this file's header.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
