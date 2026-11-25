/**
 * An image's description, its sidecar (`fox.png.md` beside `fox.png`): which
 * document describes which image (`sidecarDocOf`, `imageOfDoc`), what the
 * viewer shows of it (`imageDescription`, `withDescription`), and the sidecar
 * file a rename, move or Trash carries (`sidecarFileOf`). Tier 2 of the
 * session parts (docs/architecture/workspace-session.md); it takes the core
 * and `places`, and the facade's `activeText` (the documents', tier 3) as a
 * hook. It writes nothing.
 */

import { readFileSync } from "node:fs";
import { splitFrontmatter } from "../../lib/frontmatter.ts";
import {
  describeSidecar,
  type ImageDescription,
  imageOfSidecar,
  sidecarOf,
} from "../../lib/sidecar.ts";
import type { Doc } from "../protocol";
import { sidecarFile } from "../tree";
import { docFacts } from "./facts.ts";
import type { Places } from "./places.ts";
import type { State } from "./state.ts";
import type { ContextIndex } from "./types.ts";

export class Sidecars {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly hooks: { activeText: (d: Doc) => string },
  ) {}

  /**
   * The sidecar of the image at `abs`, when the session shows it as a document
   * (in a set, listed beside a loose image, or held): its path, else null. A
   * file nobody added is never read for the viewer.
   */
  sidecarDocOf(abs: string, index: ContextIndex = this.places.contextIndex()): string | null {
    const p = sidecarOf(abs);
    return index.sidecars.has(p) ? p : null;
  }

  /**
   * The image a document describes, when the document is a sidecar and the
   * session shows that image: its path, else null.
   */
  imageOfDoc(path: string, index: ContextIndex = this.places.contextIndex()): string | null {
    const image = imageOfSidecar(path);
    return image !== null && index.sidecars.has(path) && index.images.has(image) ? image : null;
  }

  /** A sidecar's text as the session holds it: its active version, else the file. */
  private sidecarText(path: string): string | null {
    const d = this.core.m.docs.find((x) => x.original === path);
    try {
      return d ? this.hooks.activeText(d) : readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  /** What the viewer shows of an image's sidecar, or undefined when it has none the session shows. */
  imageDescription(abs: string, index?: ContextIndex): ImageDescription | undefined {
    const path = this.sidecarDocOf(abs, index);
    if (!path) return undefined;
    const text = this.sidecarText(path);
    if (text === null) return undefined;
    const facts = docFacts(text);
    return describeSidecar(path, facts.fields, splitFrontmatter(text).body, facts.unparsed);
  }

  withDescription(abs: string): { description?: ImageDescription } {
    const description = this.imageDescription(abs);
    return description ? { description } : {};
  }

  /**
   * An image's sidecar on disk beside it, when it is a plain file: what a
   * rename, move or Trash of the image carries with it. A link or a folder of
   * that name is not carried.
   */
  sidecarFileOf(imageAbs: string): string | null {
    return sidecarFile(imageAbs);
  }
}
