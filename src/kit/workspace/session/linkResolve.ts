/**
 * Resolving a link: where a link written in a document lands
 * (`resolveFrom`, `resolveLink`), what the link picker offers
 * (`linkTargets`, `linkHeadings`), what dropped rows and embeds write and show
 * (`droppedLinks`, `embeds`), and which paths are documents in the context
 * (`contextDocs`). Tier 4 of the session parts
 * (docs/architecture/workspace-session.md); it takes the core, `places`, the
 * read index, `media`, `sidecars` and the `documents`, and the facade's
 * members it needs as hooks. `linkTargets`
 * reads the relations (`typedLinks`, `relationPass`), a part that itself
 * resolves through this one, so those two are hooks too, not an import.
 */

import { closeSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  docFormat,
  IMAGE_EXTENSIONS,
  IMAGE_HEAD_BYTES,
  imageSize,
  isImageName,
  isSvgName,
  type PixelSize,
} from "../../lib/docFormat.ts";
import { anchorFor, anchorHref, headingPlainText } from "../../lib/headingAnchor.ts";
import { linkScheme, splitTarget } from "../../lib/linkTarget.ts";
import { EMBED_BLOCKED, EMBED_REMOTE, EMBED_SVG } from "../../lib/markdown.ts";
import { kindUseFrom } from "../../lib/relationUse.ts";
import { readHeadFd } from "../images";
import type { ResolvableDocument } from "../linkEdges";
import {
  type LinkKind,
  type LinkOrigin,
  type Resolution,
  relativeHref,
  resolveTarget,
} from "../links";
import type {
  ContextEntry,
  DroppedLink,
  EmbedView,
  HeadingOffer,
  LinkHeadings,
  LinkTarget,
  LinkTargets,
} from "../protocol";
import { type RelationsLookup, relationOffers, type Vocabulary } from "../relations";
import type { Candidate } from "../search";
import { imagePaths, toPosix } from "../tree";
import type { Documents } from "./documents.ts";
import { docFacts, EMBED_CAP, oneLine, relationUses } from "./facts.ts";
import type { Media } from "./media.ts";
import type { Places } from "./places.ts";
import type { ReadIndex } from "./readIndex.ts";
import type { Sidecars } from "./sidecars.ts";
import type { State } from "./state.ts";
import type { ContextIndex, PlanWorld } from "./types.ts";

export class LinkResolve {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly readIndex: ReadIndex,
    private readonly media: Media,
    private readonly sidecars: Sidecars,
    private readonly documents: Documents,
    private readonly hooks: {
      docsAfter: (index: ContextIndex, world: PlanWorld) => readonly ResolvableDocument[];
      typedLinks: (
        index: ContextIndex,
        all?: Candidate[],
      ) => {
        kinds: Map<string, string | null>;
        links: { source: string; rel: string[]; to: string | null }[];
      };
      relationPass: (index: ContextIndex) => {
        lookup: RelationsLookup;
        at: (path: string) => Vocabulary;
      };
    },
  ) {}

  /**
   * The link picker's second step: the headings of the document at `path`,
   * each with the anchor a link writes for it (`anchorFor`: the heading's
   * text, or the path of headings that names a repeat alone), encoded. Only a
   * document in the context is read; anything else has no headings to offer.
   */
  linkHeadings(slug: string, path: string): LinkHeadings {
    this.documents.docOrDie(slug);
    const index = this.places.contextIndex();
    const own = this.places.canonical(path, index);
    const listed = index.entryOf.has(own) || this.core.m.docs.some((d) => d.original === own);
    if (!listed || isImageName(own)) return { path: own, headings: [] };
    const hs = this.readIndex.headingsAt(own) ?? [];
    const headings: HeadingOffer[] = hs.map((h, i) => ({
      level: h.level,
      text: headingPlainText(h.text),
      line: h.line,
      anchor: anchorHref(anchorFor(hs, i)),
    }));
    return { path: own, headings };
  }

  /**
   * What a link written in document `slug` can point at: every OTHER document in
   * the session, each with the relative target to write, and the `?rel=` values
   * the session's documents already use (read as search reads them, so a
   * relation typed a minute ago is offered). It only reads; the link is typed
   * into the editor by the human like any other text.
   */
  linkTargets(slug: string): LinkTargets {
    const from = this.documents.docOrDie(slug).original;
    const all = this.readIndex.markdownCandidates();
    const shownOf = (path: string) => {
      const entry = this.core.m.context.find((e) => path.startsWith(e.root + sep));
      return entry ? toPosix(relative(entry.root, path)) : basename(path);
    };
    const index = this.places.contextIndex();
    const targets: LinkTarget[] = all
      // An image's description is offered as its image, never as a document of
      // its own: a link to it would be a link to the words, not the picture.
      .filter((c) => c.path !== from && this.sidecars.imageOfDoc(c.path, index) === null)
      .map((c) => ({
        path: c.path,
        name: c.name,
        href: relativeHref(from, c.path),
        shown: shownOf(c.path),
      }));
    // And every image the tree shows (kit-image-embeds), by name only: an
    // image's bytes are never read here.
    const seen = new Set(targets.map((t) => t.path));
    for (const e of this.core.m.context)
      for (const path of imagePaths(e)) {
        if (seen.has(path)) continue;
        seen.add(path);
        const d = this.sidecars.imageDescription(path, index);
        const description = d ? [d.title, d.summary].filter(Boolean).join(": ") : "";
        targets.push({
          path,
          name: basename(path),
          href: relativeHref(from, path),
          shown: shownOf(path),
          image: true,
          ...(description ? { description } : {}),
        });
      }
    // The relations, from the link cache: a stat per document, and a read only
    // of what changed since the last ask (kit-picker-relation-meanings). Before,
    // every document's whole text was read on every open of the picker.
    const { kinds, links } = this.hooks.typedLinks(index, all);
    const here = this.places.canonical(from, index);
    const kind = kinds.get(here) ?? null;
    for (const t of targets) {
      const k = t.image ? null : (kinds.get(t.path) ?? null);
      if (k !== null) t.kind = k;
    }
    const { uses, pairs } = relationUses(kinds, links);
    const vocabulary = this.hooks.relationPass(index).at(here);
    return {
      doc: slug,
      kind,
      targets,
      relations: relationOffers(uses, vocabulary),
      vocabulary: vocabulary.any,
      byKind: kindUseFrom(pairs, kind),
    };
  }

  /**
   * Where a link written in document `from` (a slug, or null for a link in the
   * chat with no document open) goes. See `links.ts` for what the root and "in
   * the session" mean here. It only resolves: the caller opens an `in-context`
   * target, and nothing is ever added to the context.
   */
  resolveLink(target: string, from: string | null, origin: LinkOrigin = "document"): Resolution {
    const d = from === null ? undefined : this.documents.docOrDie(from);
    const src = d?.original ?? null;
    const entry =
      (d?.entryId ? this.core.m.context.find((e) => e.id === d.entryId) : undefined) ??
      (src
        ? this.core.m.context.find((e) => src.startsWith(e.root + sep))
        : this.core.m.context[0]);
    return this.resolveFrom(target, src, entry, origin, this.places.contextIndex());
  }

  /**
   * A dropped document's link text: its frontmatter `title`, else its first
   * heading (the user's choice, 2026-10-06), from its ACTIVE VERSION when the
   * session holds it, as the rest of the link layer reads. A JSON document, or
   * one that cannot be read, falls back to its file name.
   */
  private droppedDocTitle(path: string): string | undefined {
    if (docFormat(path) === "json") return undefined;
    const c = this.readIndex.markdownCandidates().find((x) => x.path === path);
    try {
      const f = docFacts(c ? this.readIndex.candidateText(c) : readFileSync(path, "utf8"));
      return f.title ?? f.heading ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * What sidebar rows dropped onto document `slug` write there
   * (kit-tree-drag-into-document): `DroppedLink` says the shape. An image the
   * tree shows is embedded, and a document is linked; a folder, an image's
   * description and the document itself write nothing. Only what lies under the
   * root of the document's own context entry is written: anything in another
   * set is refused rather than linked by a path that leaves the set, which
   * would break when either moves. Reads no image's bytes; a sidecar's title is
   * read as the viewer reads it. Link text is one line, its whitespace
   * collapsed, so a multi-line title cannot split the link.
   */
  droppedLinks(slug: string, paths: readonly string[]): DroppedLink[] {
    const d = this.documents.docOrDie(slug);
    const from = d.original;
    const index = this.places.contextIndex();
    // The entry the document is read in: its own, else the first that holds it.
    const home =
      (d.entryId ? this.core.m.context.find((e) => e.id === d.entryId) : undefined) ??
      this.core.m.context.find((e) => from.startsWith(e.root + sep));
    const out: DroppedLink[] = [];
    for (const raw of new Set(paths)) {
      const path = this.places.canonical(raw, index);
      const isImage = index.images.has(path);
      // A document links; a sidecar is its image's, and is reached through it.
      const isDoc = !isImage && index.entryOf.has(path) && !index.sidecars.has(path);
      if (path === from || (!isImage && !isDoc)) continue;
      if (!home || !path.startsWith(home.root + sep)) {
        out.push({
          path,
          refused: `${basename(path)} is in another part of the context, outside ${home ? home.label : "this document's folder"}, so no link from this document would travel with it. Copy it into this set first.`,
        });
        continue;
      }
      const title = isImage
        ? this.sidecars.imageDescription(path, index)?.title?.trim()
        : this.droppedDocTitle(path);
      out.push({
        path,
        image: isImage,
        href: relativeHref(from, path),
        text: oneLine(title ?? "") || basename(path).replace(/\.[^.]+$/, ""),
      });
    }
    return out;
  }

  /**
   * What each embed (`![alt](target)`) written in document `slug` shows, for
   * the rendered view: the image, when the target lands on one the tree shows
   * and the file route would serve it (the same guard, so a page saved as
   * `x.png` or a link out of the set is refused here, not drawn broken), or the
   * reason it is not, in words. Resolved exactly as a link from that document
   * is (relative to it, `?rel=` stripped). A remote image is never fetched and
   * an SVG is never served. Reads no image's bytes beyond the first few the
   * guard sniffs; distinct targets only, at most EMBED_CAP.
   */
  embeds(slug: string, targets: readonly string[]): EmbedView[] {
    const d = this.documents.docOrDie(slug);
    const src = d.original;
    const entry =
      (d.entryId ? this.core.m.context.find((e) => e.id === d.entryId) : undefined) ??
      this.core.m.context.find((e) => src.startsWith(e.root + sep));
    const index = this.places.contextIndex();
    const notShown = (target: string, reason: string): EmbedView => ({
      target,
      state: "not-shown",
      reason,
    });
    return [...new Set(targets)].slice(0, EMBED_CAP).map((target): EmbedView => {
      const scheme = linkScheme(target);
      if (scheme === "http" || scheme === "https") return notShown(target, EMBED_REMOTE);
      if (target === "" || scheme !== undefined) return notShown(target, EMBED_BLOCKED);
      if (isSvgName(splitTarget(target).path)) return notShown(target, EMBED_SVG);
      const r = this.resolveFrom(target, src, entry, "document", index);
      switch (r.state) {
        case "in-context": {
          if (!isImageName(r.path))
            return notShown(
              target,
              `${this.places.display(r.path)} is a document, not an image: link to it with [text](…).`,
            );
          try {
            const f = this.media.imageFile(r.path);
            // The size from the header, through the guard's own descriptor.
            let size: PixelSize | null = null;
            try {
              size = imageSize(readHeadFd(f.fd, IMAGE_HEAD_BYTES), f.type);
            } finally {
              closeSync(f.fd);
            }
            return {
              target,
              state: "shown",
              path: f.abs,
              stamp: f.stamp,
              type: f.type,
              ...(size ? { width: size.width, height: size.height } : {}),
            };
          } catch (e) {
            // The guard names the file by its full path; a placeholder names it
            // as the context does, so the reason fits on a line or two.
            const said = e instanceof Error ? e.message : String(e);
            return notShown(target, said.split(r.path).join(this.places.display(r.path)));
          }
        }
        case "not-a-doc":
          return notShown(
            target,
            isImageName(r.path)
              ? `${basename(r.path)} is an image no set in this session shows: add its folder, ${this.places.display(dirname(r.path))}, to show it.`
              : `${this.places.display(r.path)} is not an image the workspace shows (${IMAGE_EXTENSIONS.join(" ")}).`,
          );
        case "outside":
          return notShown(target, `${this.places.display(r.path)} is a document, not an image.`);
        case "folder":
          return notShown(target, `${this.places.display(r.path)} is a folder, not an image.`);
        default:
          // `missing`: nothing answers.
          return notShown(
            target,
            r.tried.length === 0
              ? "Image not found."
              : `Image not found: nothing at ${r.tried.map((p) => this.places.display(p)).join(" or ")}.`,
          );
      }
    });
  }

  /** Resolve `target` as written in the document at `src` (null: the chat), in `entry`. */
  resolveFrom(
    target: string,
    src: string | null,
    entry: ContextEntry | undefined,
    origin: LinkOrigin,
    index: ContextIndex,
    kind: LinkKind = "markdown",
    /**
     * Resolve in the world after a move that has not happened (`movePlan`):
     * `src`, `entry` and every path asked about are that world's, and each
     * is read on disk where it is now.
     */
    world?: PlanWorld,
  ): Resolution {
    const root = entry?.root ?? (src ? dirname(src) : this.core.workspace);
    const is = (p: string, what: "file" | "dir") => {
      const at = world ? world.back(p) : p;
      if (at === null) return false;
      try {
        const st = statSync(at);
        return what === "file" ? st.isFile() : st.isDirectory();
      } catch {
        return false;
      }
    };
    const inContext = (p: string): string | null => {
      if (!world) return this.readIndex.inContextAt(p, index);
      const at = world.back(p);
      const own = at === null ? null : this.readIndex.inContextAt(at, index);
      return own === null ? null : world.forward(own);
    };
    const app = this.readIndex.linkSlot.resolve;
    return resolveTarget(
      target,
      src,
      {
        root,
        inContext,
        exists: (p) => is(p, "file"),
        isDir: (p) => is(p, "dir"),
        ...(app
          ? {
              app: (path: string, k: LinkKind) => {
                try {
                  return app({
                    target: path,
                    from: src,
                    root,
                    kind: k,
                    documents: () =>
                      world
                        ? this.hooks.docsAfter(index, world)
                        : this.readIndex.resolvableDocs(index),
                  });
                } catch {
                  // An app resolver that throws answers nothing: the link is missing.
                  return undefined;
                }
              },
            }
          : {}),
      },
      origin,
      kind,
    );
  }

  /** An image the tree shows whose realpath stays inside its entry, as the file route requires. */
  private imageInside(abs: string): boolean {
    const at = this.media.imageNodeAt(abs);
    if (!at) return false;
    try {
      this.places.realInsideOrDie(abs, at.entry, "not pointed at");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Of `paths`, the ones that are documents in the session's context, each in
   * the context's own form, by the rule `linkSubject` uses: absolute, the same
   * file by realpath, and listed by a context entry. A path that only looks
   * like one (`/etc/passwd`, a `..` that climbs out) is dropped. For what a page
   * says it points at, which the agent then reads.
   */
  contextDocs(paths: readonly unknown[]): string[] {
    const out: string[] = [];
    for (const own of this.contextDocEach(paths))
      if (own !== undefined && !out.includes(own)) out.push(own);
    return out;
  }

  /**
   * Each path as `contextDocs` keeps it, in place: canonical when it is a
   * document or an image the tree shows, undefined when it is not. The
   * context's index is built once for the whole list (a message's refs).
   */
  contextDocEach(paths: readonly unknown[]): (string | undefined)[] {
    const index = this.places.contextIndex();
    return paths.map((p) => {
      if (typeof p !== "string" || !isAbsolute(p)) return undefined;
      const own = this.places.canonical(resolve(p), index);
      // A document, or an image the tree shows (a message about an image, such
      // as "describe this", points at the image file itself).
      if (index.entryOf.has(own)) return own;
      if (index.images.has(own) && this.imageInside(own)) return own;
      return undefined;
    });
  }
}
