/**
 * The link check: every link in the session's documents that nothing answers,
 * and what else the status bar's mark reports (`linkCheck`). Tier 5 of the
 * session parts (docs/architecture/workspace-session.md); it takes the core,
 * `places`, the read index, `linkResolve`, `relations`, and `follow` for the
 * move history (`movedFrom`, `movedTarget`).
 */

import { existsSync } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { withoutDocExtension } from "../../lib/docFormat.ts";
import { findHeading, headingPlainText, nearestHeading } from "../../lib/headingAnchor.ts";
import { decodePath, splitTarget } from "../../lib/linkTarget.ts";
import { BODY_LINKS, edgeKeeps, pathShaped } from "../linkEdges";
import {
  type DanglingLink,
  danglingLinks,
  duplicateNames,
  type LinkRef,
  type Resolution,
  type SchemeLink,
} from "../links";
import type {
  CheckedEdgeView,
  CheckedLinkView,
  CheckedReferenceView,
  ContextEntry,
  HeadingProblem,
  LeavingLinkView,
  LinkCheck,
  ProposedLinkView,
  SymmetryHint,
} from "../protocol";
import { oneWaySymmetric, type TypedEdge } from "../relations";
import { toPosix } from "../tree";
import { type DocFacts, IMAGES_DIR, keptOutside, LINK_CHECK_CAP, NO_FACTS } from "./facts.ts";
import type { Follow } from "./follow.ts";
import type { LinkResolve } from "./linkResolve.ts";
import { caseInsensitiveAt } from "./names.ts";
import type { Places } from "./places.ts";
import type { ReadIndex } from "./readIndex.ts";
import type { Relations } from "./relations.ts";
import type { State } from "./state.ts";

export class LinkChecker {
  constructor(
    private readonly core: State,
    private readonly places: Places,
    private readonly readIndex: ReadIndex,
    private readonly linkResolve: LinkResolve,
    private readonly relations: Relations,
    private readonly follow: Follow,
  ) {}

  /**
   * The link check: every link in the session's documents that nothing answers,
   * links whose scheme nothing here opens (Operator's `op:doc/…`) kept apart,
   * and documents whose file names collide, each with a suggested rename. It
   * only reads; a dangling link is reported, never an error, and nothing is
   * renamed.
   *
   * The documents read are the ones search and backlinks read (`candidates`),
   * through the same per-file link cache and one context index, so a second
   * check after an edit re-reads only the document that changed.
   */
  linkCheck(opts: { edge?: readonly string[] } = {}): LinkCheck {
    const index = this.places.contextIndex();
    const all = this.readIndex.markdownCandidates();
    const read = new Set<string>();
    const entryOf = this.readIndex.entryFinder(index);
    // ⛔ THE INNERMOST SET WINS for which set a file is in: with `world` and
    // `world/inner` both in the context, `inner/deep.md` is `inner`'s, as the
    // shipped map counted it (whichever was added first). Resolving still goes
    // through `entryOf`, so the check follows a link as a click does.
    const setEntry = (path: string): ContextEntry | undefined => {
      let best = entryOf(path);
      for (const e of this.core.m.context)
        if (
          e.membership === "mirrored" &&
          path.startsWith(e.root + sep) &&
          (best === undefined || e.root.length > best.root.length)
        )
          best = e;
      return best;
    };
    // From the root of the set it is grouped under (`setEntry`, below).
    const shown = (path: string) => {
      const entry = setEntry(path);
      return entry ? toPosix(relative(entry.root, path)) : basename(path);
    };
    // Every image a link or an embed reaches, seen on the way: the unused-images
    // section costs nothing beyond the resolving already done.
    const used = new Set<string>();
    // Where each link landed, kept as it is resolved, so the symmetry hints
    // below resolve nothing again.
    const landed = new Map<string, string>();
    const facts = new Map<string, DocFacts>();
    const sources = all.map((c) => {
      const got = this.readIndex.readOf(c, read);
      facts.set(c.path, got?.facts ?? NO_FACTS);
      return {
        path: c.path,
        links: got?.links ?? [],
        fragments: got?.fragments ?? [],
        edges: got?.edges ?? [],
        edgeAt: got?.edgeAt ?? [],
      };
    });
    // Links and edges that land outside the set they are written in
    // (kit-broken-links-visible), for an app that asks (`linkCheck.leaving`).
    const leavingLinks: LeavingLinkView[] = [];
    // Only for an app that asks for it (`linkCheck.leaving`).
    const wantLeaving = this.readIndex.linkCheckOpts.leaving === true;
    const setOf = (path: string) => setEntry(path)?.id;
    /** Where a link from `from` lands, when that is outside `from`'s set; else null. */
    const leaves = (r: Resolution, from: string): { target: string } | null => {
      // ⛔ A LINK TO ONE OF THE SESSION'S OWN DOCUMENTS NEVER LEAVES
      // (scriptorium-broken-links-sign-noise, Cole's ruling 2026-10-22): the
      // session is what the human gathered, so a link between two of its
      // documents stays inside it, whichever sets they are in. Documents added
      // one by one are a set each, and counting every link between them as
      // leaving made the sign say little else.
      if (r.state !== "outside" && r.state !== "not-a-doc") return null;
      const own = setEntry(from);
      if (own === undefined) return null;
      // ⛔ A LISTED ENTRY (documents added on their own) HAS NO FOLDER OF ITS
      // OWN: its root is its document's folder, so the folder rule would take
      // every sibling on disk as inside it. A link from one to a file the
      // session does not hold leaves.
      if (own.membership === "listed") return { target: r.path };
      // A mirrored set: a file in its folder that is not a document (a CSV
      // beside the pages) is inside it; anything else leaves.
      return r.path.startsWith(own.root + sep) ? null : { target: r.path };
    };
    const leavingView = (from: string, target: string) => {
      // The set whose FOLDER holds the target: a listed entry holds only its
      // documents, and a leaving target is none of the session's documents.
      const near = setEntry(target);
      const there =
        near?.membership === "mirrored" && target.startsWith(near.root + sep) ? near : undefined;
      const own = setEntry(from);
      return {
        source: from,
        name: basename(from),
        shown: shown(from),
        target,
        targetShown: there
          ? toPosix(relative(there.root, target))
          : own
            ? toPosix(relative(own.root, target))
            : target,
        ...(there ? { targetSet: there.label } : {}),
        ...(own ? { set: own.id } : {}),
      };
    };
    // The body links that resolve, kept by how they were written, so the
    // leaving list below needs no second resolve.
    const resolvedLinks = new Map<string, Resolution>();
    // A bundle's references whose file nothing answers, beside the documents'
    // dangling links ("card 'The Glade' points at …, which is missing"). Each
    // one that lands on an image counts as that image's use.
    const references: CheckedReferenceView[] = [];
    for (const c of this.readIndex.referenceCandidates())
      for (const ref of this.readIndex.readOf(c, read)?.refs ?? []) {
        const r = this.readIndex.resolveReference(ref.raw, c.path, entryOf(c.path), index);
        if (r.state === "in-context" && index.images.has(r.path)) used.add(r.path);
        if (r.state !== "missing") continue;
        const v = this.readIndex.referenceView(c.path, ref, entryOf);
        const called = ref.label ?? basename(ref.raw);
        const set = setOf(c.path);
        references.push({
          ...v,
          ...(set !== undefined ? { set } : {}),
          tried: r.tried,
          text: `${v.part} '${called}' points at \`${ref.raw}\`, which is missing`,
        });
      }
    references.sort(
      (a, b) =>
        a.shown.localeCompare(b.shown, undefined, { numeric: true }) ||
        a.line - b.line ||
        a.from - b.from,
    );
    const found = danglingLinks(
      sources,
      // ⛔ As written in a DOCUMENT: no chat fallback, as backlinks reads them.
      (raw, from, kind) => {
        const r = this.linkResolve.resolveFrom(raw, from, entryOf(from), "document", index, kind);
        if (r.state === "in-context") {
          if (index.images.has(r.path)) used.add(r.path);
          landed.set(`${from}\0${kind}\0${raw}`, r.path);
        }
        resolvedLinks.set(`${from}\0${kind}\0${raw}`, r);
        return r;
      },
    );
    // The app's edges that nothing answers (kit-link-edges-slot), apart from
    // the body links: a frontmatter reference to a page not written yet.
    const keep = edgeKeeps(opts.edge);
    const danglingEdges: CheckedEdgeView[] = [];
    // The edges nothing answers that are not written as paths (`pathShaped`):
    // a reference in a convention the kit does not know, listed, not counted.
    const unresolvedEdges: CheckedEdgeView[] = [];
    if (this.readIndex.appEdges)
      for (const s of sources)
        s.edges.forEach((e, i) => {
          if (!keep(e.kind)) return;
          const r = this.linkResolve.resolveFrom(
            e.target,
            s.path,
            entryOf(s.path),
            "document",
            index,
          );
          const spot = s.edgeAt[i];
          const line = e.line ?? spot?.line;
          const at = spot ? { from: spot.from, to: spot.to } : {};
          const set = setOf(s.path);
          const out = wantLeaving ? leaves(r, s.path) : null;
          if (out)
            leavingLinks.push({
              ...leavingView(s.path, out.target),
              raw: e.target,
              ...(line !== undefined ? { line } : {}),
              ...(e.label !== undefined ? { label: e.label } : {}),
              ...at,
              edge: e.kind,
              ...(e.key !== undefined ? { key: e.key } : {}),
            });
          if (r.state !== "missing") return;
          (pathShaped(e.target) ? danglingEdges : unresolvedEdges).push({
            source: s.path,
            name: basename(s.path),
            shown: shown(s.path),
            edge: e.kind,
            raw: e.target,
            ...(e.key !== undefined ? { key: e.key } : {}),
            ...(line !== undefined ? { line } : {}),
            ...(e.label !== undefined ? { label: e.label } : {}),
            tried: r.tried,
            ...at,
            ...(set !== undefined ? { set } : {}),
          });
        });
    const edgeOrder = (a: CheckedEdgeView, b: CheckedEdgeView) =>
      a.shown.localeCompare(b.shown, undefined, { numeric: true }) || (a.line ?? 0) - (b.line ?? 0);
    danglingEdges.sort(edgeOrder);
    unresolvedEdges.sort(edgeOrder);
    if (wantLeaving && keep(BODY_LINKS))
      for (const s of sources)
        for (const link of s.links) {
          if (link.scheme !== undefined) continue;
          const r = resolvedLinks.get(`${s.path}\0${link.kind}\0${link.raw}`);
          const out = r && leaves(r, s.path);
          if (!out) continue;
          leavingLinks.push({
            ...leavingView(s.path, out.target),
            raw: link.raw,
            line: link.line,
            ...(link.label !== undefined ? { label: link.label } : {}),
            from: link.from,
            to: link.to,
          });
        }
    leavingLinks.sort(
      (a, b) =>
        a.shown.localeCompare(b.shown, undefined, { numeric: true }) ||
        (a.line ?? 0) - (b.line ?? 0) ||
        (a.from ?? 0) - (b.from ?? 0),
    );
    // Links broken in a version the agent PROPOSED (kit-relink-misses-proposed-
    // versions, Cole's ruling 2026-10-22): written by the agent and never
    // active (`Version.activated`). A move's relink rewrites only the active
    // version, so a proposal made before the move keeps the old target.
    // Reported, never rewritten. A version the human has had active, theirs
    // or one they took from the agent, is history, not a proposal: not read.
    // A link the active version also has broken, as written, is reported
    // there once, not again per version.
    const activeMissing = new Set(found.missing.map((l) => `${l.source}\0${l.raw}`));
    const proposed: ProposedLinkView[] = [];
    if (keep(BODY_LINKS))
      for (const c of all) {
        const d = c.slug === null ? undefined : this.core.m.docs.find((x) => x.slug === c.slug);
        if (!d || d.versions.length < 2) continue;
        const entry = entryOf(c.path);
        // Where the document was before the moves this daemon made: a link
        // written there reads from there.
        const wasAt = this.follow.movedFrom(c.path);
        for (const v of d.versions) {
          if (v.n === d.active || v.by !== "agent" || v.activated || keptOutside(v)) continue;
          const got = this.readIndex.readOf(c, read, v.n);
          if (!got) continue;
          // Every broken link of this version, then one act for them all: the
          // fix is ONE new version, so each entry's act names the whole of it.
          const mine: Omit<ProposedLinkView, "act">[] = [];
          for (const link of got.links) {
            if (link.scheme !== undefined) continue;
            if (activeMissing.has(`${c.path}\0${link.raw}`)) continue;
            const r = this.linkResolve.resolveFrom(
              link.raw,
              c.path,
              entry,
              "document",
              index,
              link.kind,
            );
            if (r.state !== "missing") continue;
            const suggest =
              link.kind === "markdown"
                ? this.follow.movedTarget(link.raw, c.path, wasAt, r.tried, entry, index)
                : undefined;
            mine.push({
              source: c.path,
              name: basename(c.path),
              shown: shown(c.path),
              line: link.line,
              raw: link.raw,
              kind: link.kind,
              ...(link.label !== undefined ? { label: link.label } : {}),
              ...(link.embed ? { embed: true as const } : {}),
              context: link.context,
              from: link.from,
              to: link.to,
              ...(setOf(c.path) !== undefined ? { set: setOf(c.path) } : {}),
              doc: d.slug,
              version: v.n,
              tried: r.tried,
              ...(suggest !== undefined ? { suggest } : {}),
            });
          }
          const label = v.label !== undefined ? ` --label ${JSON.stringify(v.label)}` : "";
          const make = `version-new --doc ${d.slug} --from v${v.n}${label} --stdin`;
          const drop = `version-delete v${v.n} --doc ${d.slug}`;
          const all =
            mine.length === 1 ? "its broken link" : `all ${mine.length} of its broken links`;
          for (const l of mine)
            proposed.push({
              ...l,
              act: `Your proposal v${v.n} links \`${l.raw}\` (line ${l.line}), ${
                l.suggest ? `which moved to \`${l.suggest}\`` : "which is missing"
              }${
                mine.length > 1
                  ? `, one of ${mine.length} broken links in v${v.n} (every \`proposed\` entry with version ${v.n})`
                  : ""
              }. Fix ${all} in ONE new version (\`${make}\`, v${v.n}'s text with each fixed${
                mine.some((x) => x.suggest) ? ", written as `suggest` says where it is given" : ""
              }), then delete v${v.n}, your unactivated proposal it replaces (\`${drop}\`).`,
            });
        }
      }
    proposed.sort(
      (a, b) =>
        a.shown.localeCompare(b.shown, undefined, { numeric: true }) ||
        a.version - b.version ||
        a.line - b.line ||
        a.from - b.from,
    );
    this.readIndex.pruneLinkCache(read);
    const view = (l: Omit<DanglingLink, "tried"> | SchemeLink): CheckedLinkView => ({
      source: l.source,
      name: basename(l.source),
      shown: shown(l.source),
      line: l.line,
      raw: l.raw,
      kind: l.kind,
      ...(l.label !== undefined ? { label: l.label } : {}),
      ...(l.embed ? { embed: true as const } : {}),
      context: l.context,
      from: l.from,
      to: l.to,
      ...(setOf(l.source) !== undefined ? { set: setOf(l.source) } : {}),
    });
    const order = (a: CheckedLinkView, b: CheckedLinkView) =>
      a.shown.localeCompare(b.shown, undefined, { numeric: true }) ||
      a.line - b.line ||
      a.from - b.from;
    const dangling = found.missing.map((l) => ({ ...view(l), tried: l.tried })).sort(order);
    const unsupported = found.unsupported
      .map((l) => ({ ...view(l), scheme: l.scheme }))
      .sort(order);
    const probed = new Map<string, boolean>();
    const names = duplicateNames(
      all.map((c) => c.path),
      {
        caseInsensitive: (p) => {
          const dir = dirname(p);
          let known = probed.get(dir);
          if (known === undefined) {
            known = caseInsensitiveAt(p);
            probed.set(dir, known);
          }
          return known;
        },
        exists: (p) => existsSync(p),
      },
    ).map((d) => ({
      name: d.name,
      files: d.files.map((f) => ({
        path: f.path,
        shown: shown(f.path),
        suggest: f.suggest,
        ...(setOf(f.path) !== undefined ? { set: setOf(f.path) } : {}),
      })),
    }));
    const unusedImages = [...index.images]
      .filter((p) => basename(dirname(p)) === IMAGES_DIR && !used.has(p))
      .map((path) => ({
        path,
        shown: shown(path),
        ...(setOf(path) !== undefined ? { set: setOf(path) } : {}),
      }))
      .sort((a, b) => a.shown.localeCompare(b.shown, undefined, { numeric: true }));
    // Symmetric relations written one way (kit-link-check-symmetry): which
    // relations are symmetric comes from the vocabulary in force for the
    // document that writes the link. A hint, kept out of `count`.
    const vocabulary = this.relations.relationPass(index);
    const edges: TypedEdge<LinkRef & { source: string }>[] = [];
    for (const s of sources)
      for (const link of s.links) {
        if (link.rel.length === 0 || link.scheme !== undefined) continue;
        const to = landed.get(`${s.path}\0${link.kind}\0${link.raw}`);
        if (to === undefined || !facts.has(to)) continue;
        for (const rel of link.rel)
          edges.push({ from: s.path, to, rel, link: { ...link, source: s.path } });
      }
    const title = (path: string) => {
      const f = facts.get(path) ?? NO_FACTS;
      return f.title ?? f.heading ?? withoutDocExtension(basename(path));
    };
    const symmetry = oneWaySymmetric(
      edges,
      (from, rel) => vocabulary.at(from).relations.get(rel)?.symmetric === true,
    )
      .map(
        (e): SymmetryHint => ({
          ...view(e.link),
          rel: e.rel,
          target: e.to,
          targetShown: shown(e.to),
          hint: `${title(e.from)} ${e.rel} ${title(e.to)}; ${title(e.to)} does not link back`,
        }),
      )
      .sort(order);
    // Links to a heading (kit-heading-links-build): a link whose document
    // resolves but whose anchor names no heading in it is a problem of its own,
    // kept apart from dangling links, with the heading most like it; a bare
    // anchor naming a repeated heading is a hint. Only documents some link
    // names with an anchor are read for headings.
    const missingHeadings: HeadingProblem[] = [];
    const ambiguous: HeadingProblem[] = [];
    // Each link with an anchor, and the document it names a heading in: where
    // it landed, or, for a link that is only `#heading`, the one it is in.
    const anchored: { source: string; link: LinkRef; to: string; anchor: string }[] = [];
    for (const s of sources) {
      for (const link of s.links) {
        if (link.scheme !== undefined || link.embed) continue;
        const anchor = splitTarget(link.raw).anchor;
        if (anchor === undefined) continue;
        const to = landed.get(`${s.path}\0${link.kind}\0${link.raw}`);
        if (to === undefined || index.images.has(to)) continue;
        anchored.push({ source: s.path, link, to, anchor });
      }
      for (const link of s.fragments)
        anchored.push({ source: s.path, link, to: s.path, anchor: link.raw.slice(1) });
    }
    for (const { source, link, to, anchor } of anchored) {
      const hs = this.readIndex.headingsAt(to);
      if (hs === null) continue;
      const heading = decodePath(anchor);
      const m = findHeading(hs, heading);
      const base = {
        ...view({ ...link, source }),
        heading,
        target: to,
        targetShown: shown(to),
      };
      if (m === null) {
        const near = nearestHeading(hs, heading);
        missingHeadings.push({
          ...base,
          ...(near ? { nearest: headingPlainText(near.text) } : {}),
        });
      } else if (m.ambiguous)
        ambiguous.push({ ...base, nearest: headingPlainText(m.heading.text) });
    }
    for (const file of this.readIndex.headingCache.keys())
      if (!read.has(file)) this.readIndex.headingCache.delete(file);
    missingHeadings.sort(order);
    ambiguous.sort(order);
    // A function, not a generic arrow: `<T>(` reads as JSX to a tsx parser,
    // and the import-boundary ward audits every file with one.
    function cut<T>(list: T[]): T[] {
      return list.slice(0, LINK_CHECK_CAP);
    }
    // An `edge` filter without `link` keeps no body link's section.
    if (!keep(BODY_LINKS)) {
      // (The leaving list kept only the edges the filter names already.)
      dangling.length = 0;
      unsupported.length = 0;
      missingHeadings.length = 0;
      ambiguous.length = 0;
      symmetry.length = 0;
    }
    const truncated =
      danglingEdges.length > LINK_CHECK_CAP ||
      missingHeadings.length > LINK_CHECK_CAP ||
      ambiguous.length > LINK_CHECK_CAP ||
      dangling.length > LINK_CHECK_CAP ||
      unsupported.length > LINK_CHECK_CAP ||
      names.length > LINK_CHECK_CAP ||
      unusedImages.length > LINK_CHECK_CAP ||
      symmetry.length > LINK_CHECK_CAP ||
      references.length > LINK_CHECK_CAP ||
      proposed.length > LINK_CHECK_CAP ||
      unresolvedEdges.length > LINK_CHECK_CAP ||
      leavingLinks.length > LINK_CHECK_CAP;
    // Each set's whole, before any list is cut: what a group says it shows
    // part of when the check is truncated. Shared names are the session's.
    // Unresolved references and links leaving the set are listed but not
    // counted, as the sign counts: a set with only those is still named, with
    // a total of 0.
    const totals = new Map<string, number>();
    for (const list of [
      dangling,
      unsupported,
      missingHeadings,
      ambiguous,
      symmetry,
      references,
      danglingEdges,
      proposed,
      unusedImages,
    ] as { set?: string }[][])
      for (const x of list)
        if (x.set !== undefined) totals.set(x.set, (totals.get(x.set) ?? 0) + 1);
    const named = new Set<string | undefined>([
      ...totals.keys(),
      ...cut(unresolvedEdges).map((e) => e.set),
      ...cut(leavingLinks).map((e) => e.set),
      ...cut(names).flatMap((n) => n.files.map((f) => f.set)),
    ]);
    return {
      count:
        dangling.length +
        unsupported.length +
        names.length +
        missingHeadings.length +
        references.length +
        danglingEdges.length +
        proposed.length,
      dangling: { count: dangling.length, links: cut(dangling) },
      proposed: { count: proposed.length, links: cut(proposed) },
      unsupported: {
        count: unsupported.length,
        schemes: [...new Set(unsupported.map((l) => l.scheme))].sort(),
        links: cut(unsupported),
      },
      duplicates: { count: names.length, names: cut(names) },
      unusedImages: { count: unusedImages.length, images: cut(unusedImages) },
      symmetry: { count: symmetry.length, hints: cut(symmetry) },
      headings: { count: missingHeadings.length, links: cut(missingHeadings) },
      ambiguousHeadings: { count: ambiguous.length, hints: cut(ambiguous) },
      references: { count: references.length, links: cut(references) },
      ...(this.readIndex.appEdges
        ? {
            edges: {
              count: danglingEdges.length,
              kinds: [...new Set(danglingEdges.map((e) => e.edge))].sort(),
              links: cut(danglingEdges),
            },
            unresolved: {
              count: unresolvedEdges.length,
              kinds: [...new Set(unresolvedEdges.map((e) => e.edge))].sort(),
              links: cut(unresolvedEdges),
            },
          }
        : {}),
      ...(wantLeaving ? { leaving: { count: leavingLinks.length, links: cut(leavingLinks) } } : {}),
      ...(this.readIndex.linkCheckOpts.noun !== undefined
        ? { noun: this.readIndex.linkCheckOpts.noun }
        : {}),
      // Only the sets the answer names, in the context's order.
      sets: this.core.m.context
        .filter((e) => named.has(e.id))
        .map((e) => ({ id: e.id, label: e.label, total: totals.get(e.id) ?? 0 })),
      ...(truncated ? { truncated: true as const } : {}),
    };
  }
}
