/**
 * The kinds of document Scriptorium admits beyond the kit's own: `.mdx`, as
 * the shipped Scriptorium always had (its `tree.ts`, deleted at the cutover).
 *
 * ⛔ AN `.mdx` IS TEXT, NOTHING MORE (Cole, 2026-10-19, the shell cycle's
 * ruling 1). It shows in the tree, `meta` and `find`, opens, edits, versions,
 * compares and takes notes, and its rendered view is plain markdown. Its
 * `import` and `export` lines and its JSX components are never compiled or
 * run: the kit's renderer encodes raw HTML as text, so `<Chart />` reads as
 * written. Running a document's code in the page would be an item of its own.
 *
 * Registered at load, once per process, by every kit-path entry that reads a
 * tree or a name: the daemon (`./server.ts`), the CLI (`./cli.ts`) and the
 * surface (`../../surface/Frame.tsx`). Pure, so the surface can bundle it.
 */

import { registerDocExtension } from "../../../kit/lib/docFormat";

/** What Scriptorium adds to the kit's document kinds. */
export const SCRIPTORIUM_DOC_EXTENSIONS = [".mdx"] as const;

for (const ext of SCRIPTORIUM_DOC_EXTENSIONS) registerDocExtension(ext);
