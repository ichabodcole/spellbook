/**
 * What is on screen: the record's `openDoc`, `openImage` and `docAside` (the
 * document an image was opened over). Tier 2 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core, and only it
 * writes those three keys.
 *
 * The one rule: the centre shows one thing. A document coming on screen puts
 * the open image away and leaves nothing aside; an image coming on screen puts
 * the open document aside, and closing it brings that document back while the
 * session still holds it. The rest are the ways a thing on screen stops being
 * there (closed, orphaned, gone, forgotten) or follows a move. None of those
 * brings back the document aside: a Trash or a delete of the open image closes
 * it and leaves the aside document where it was, for a later close.
 *
 * Nothing here persists: the caller writes the record, at the point it always
 * did. Each method keeps the order its writes had in the facade.
 */

import type { State } from "./state.ts";

export class Viewer {
  constructor(private readonly core: State) {}

  /** A document comes on screen: the open image goes, and nothing is aside. */
  showDoc(slug: string): void {
    this.core.m.openDoc = slug;
    this.core.m.openImage = null;
    this.core.m.docAside = null;
  }

  /**
   * An image comes on screen. The document on screen is put aside, not
   * forgotten: closing the image brings it back. A second image opened over
   * the first keeps the same one.
   */
  showImage(abs: string): void {
    if (this.core.m.openDoc) this.core.m.docAside = this.core.m.openDoc;
    this.core.m.openImage = abs;
    this.core.m.openDoc = null;
  }

  /**
   * Put the open image away, and bring back the document it was opened over,
   * when that document is still held (closed or gone, nothing comes back).
   */
  closeImage(): void {
    const back = this.core.m.docAside;
    this.core.m.openImage = null;
    this.core.m.docAside = null;
    if (back && this.core.m.docs.some((d) => d.slug === back)) this.core.m.openDoc = back;
  }

  /** The document `slug` is put away when it is on screen. Whether it was. */
  closeDoc(slug: string): boolean {
    if (this.core.m.openDoc !== slug) return false;
    this.core.m.openDoc = null;
    return true;
  }

  /**
   * The open document left the context (its entry removed): close it in the
   * view. Its versions stay in the session, since nothing is deleted, and
   * bringing it back and opening it again finds them.
   */
  closeOrphaned(): void {
    const open = this.core.m.openDoc
      ? this.core.m.docs.find((d) => d.slug === this.core.m.openDoc)
      : undefined;
    if (open && open.entryId === null) this.core.m.openDoc = null;
  }

  /**
   * An open image `inside` a path that went (to the Trash, or deleted) simply
   * closes: it has no record to keep, and nothing aside comes back.
   */
  closeImageInside(inside: (p: string) => boolean): void {
    if (this.core.m.openImage && inside(this.core.m.openImage)) this.core.m.openImage = null;
  }

  /** The open image follows a rename or a move, as an open document does. */
  followMove(moved: (p: string) => string | null): void {
    const image = this.core.m.openImage ? moved(this.core.m.openImage) : null;
    if (image) this.core.m.openImage = image;
  }

  /**
   * The document `slug` was forgotten (its record already gone): when it was
   * on screen, the first held document takes its place, else none.
   */
  docForgotten(slug: string): void {
    if (this.core.m.openDoc === slug) this.core.m.openDoc = this.core.m.docs[0]?.slug ?? null;
  }

  /**
   * Documents were forgotten (a deleted path's records already gone): an open
   * one no longer held gives way to the first held, else none.
   */
  docsForgotten(): void {
    if (this.core.m.openDoc && !this.core.m.docs.some((d) => d.slug === this.core.m.openDoc))
      this.core.m.openDoc = this.core.m.docs[0]?.slug ?? null;
  }
}
