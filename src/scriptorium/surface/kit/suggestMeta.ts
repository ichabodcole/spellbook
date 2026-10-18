/**
 * "Add a block" on the kit path (E35, scriptorium-kit-suggest-meta): the
 * flagged frame's answer to the pane's `textOffer` slot. A document whose
 * active version has no frontmatter block is offered one; taking it asks the
 * kit daemon for the suggestion (`scriptorium.meta.suggest`, `../../backend/kit/wiki.ts`),
 * the shipped `meta.suggest`'s twin, and the pane puts it at the top of the
 * buffer, unsaved. Save writes it, as any edit is written (E7).
 *
 * ⛔ WHETHER THERE IS A BLOCK IS THE DAEMON'S ANSWER, SHARED BY EVERY TAB. The
 * shipped header reads `doc.meta`, from the session's snapshot, which every
 * surface sees; the kit daemon's equivalent is `appState.noFrontmatter` (the
 * open documents whose active version has no block). Decided from this tab's
 * own copy of the text alone, a second tab that never saw the first one's edit
 * still offered, and taking it there put its stale text over the first tab's
 * typing. This tab's own text is asked too, so the offer goes the moment this
 * tab takes it, before the daemon's next broadcast says so.
 *
 * What counts as "no block" in either is the shipped reader's rule
 * (`splitFrontmatter` in `../../backend/frontmatter.ts`), so a block that is
 * there but cannot be read is not offered a second one: the header shows it as
 * written and says why, as the shipped header does.
 *
 * Kit path only (`SCRIPTORIUM_KIT=1`). The shipped surface does not import this
 * file.
 */

import type { Daemon } from "../../../kit/context/daemonClient";
import type { DocumentPaneSlots, TextOffer } from "../../../kit/document/DocumentPane";
import type { PublicState } from "../../../kit/workspace/protocol";
import { splitFrontmatter } from "../../backend/frontmatter";

/** The shipped header's words (`components/DocumentPane.tsx`). */
export const NO_FRONTMATTER = "This document has no frontmatter.";
export const ADD_A_BLOCK = "Add a block";

/** The suggestion as the daemon answers it. */
export type MetaSuggestion = { path: string; block: string; suggestedType?: string };

const NONE: readonly string[] = [];

/** The open documents the daemon says have no block, by slug (`appState.noFrontmatter`). */
export const noFrontmatterOf = (state: PublicState | null | undefined): readonly string[] =>
  (state?.appState as { noFrontmatter?: string[] } | null | undefined)?.noFrontmatter ?? NONE;

/**
 * The pane's `textOffer` for a connected daemon client, given the daemon's
 * shared list of open documents with no block.
 */
export function scriptoriumTextOffer(
  daemon: Pick<Daemon, "request">,
  noFrontmatter: readonly string[],
): NonNullable<DocumentPaneSlots["textOffer"]> {
  return (doc, text): TextOffer | null =>
    !noFrontmatter.includes(doc.slug) || splitFrontmatter(text).raw !== null
      ? null
      : {
          id: "scriptorium.add-frontmatter",
          message: NO_FRONTMATTER,
          label: ADD_A_BLOCK,
          take: async () => {
            const frame = (await daemon.request({
              op: "scriptorium.meta.suggest",
              path: doc.original,
            })) as Partial<MetaSuggestion>;
            if (typeof frame.block !== "string")
              throw new Error("the daemon's answer carried no block");
            return frame.block;
          },
        };
}
