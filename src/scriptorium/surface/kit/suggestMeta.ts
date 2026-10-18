/**
 * "Add a block" on the kit path (E35, scriptorium-kit-suggest-meta): the
 * flagged frame's answer to the pane's `textOffer` slot. A document whose
 * active version has no frontmatter block is offered one; taking it asks the
 * kit daemon for the suggestion (`scriptorium.meta.suggest`, `../../backend/kit/wiki.ts`),
 * the shipped `meta.suggest`'s twin, and the pane puts it at the top of the
 * buffer, unsaved. Save writes it, as any edit is written (E7).
 *
 * What counts as "no block" is the shipped reader's rule (`splitFrontmatter`
 * in `../../backend/frontmatter.ts`), over the active version's text, as the
 * shipped header decides it (`doc.meta === null`). So a block that is there
 * but cannot be read is not offered a second one: the header shows it as
 * written and says why, as the shipped header does.
 *
 * Kit path only (`SCRIPTORIUM_KIT=1`). The shipped surface does not import this
 * file.
 */

import type { Daemon } from "../../../kit/context/daemonClient";
import type { DocumentPaneSlots, TextOffer } from "../../../kit/document/DocumentPane";
import { splitFrontmatter } from "../../backend/frontmatter";

/** The shipped header's words (`components/DocumentPane.tsx`). */
export const NO_FRONTMATTER = "This document has no frontmatter.";
export const ADD_A_BLOCK = "Add a block";

/** The suggestion as the daemon answers it. */
export type MetaSuggestion = { path: string; block: string; suggestedType?: string };

/** The pane's `textOffer` for a connected daemon client. */
export function scriptoriumTextOffer(
  daemon: Pick<Daemon, "request">,
): NonNullable<DocumentPaneSlots["textOffer"]> {
  return (doc, text): TextOffer | null =>
    splitFrontmatter(text).raw !== null
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
