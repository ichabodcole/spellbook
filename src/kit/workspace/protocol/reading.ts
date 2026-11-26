/**
 * Reading the context: search, links, backlinks, the link check, the graph and
 * document profiles. Part of the wire vocabulary (`../protocol.ts`); types
 * only.
 */

import type { KindPairUse, KindUse } from "../../lib/relationUse.ts";
import type { LinkKind, RelationUse, Resolution } from "../links";

// ── search ────────────────────────────────────────────────────────────────

/** What a result matched on. */
export type SearchKind = "name" | "text";

/** One result. Name results carry no position; text results carry all of it. */
export type SearchResult = {
  kind: SearchKind;
  /** The session's slug for the document, or null when it has not been opened. */
  slug: string | null;
  name: string;
  path: string;
  /** The active version that was searched, or null when the file on disk was read. */
  version: number | null;
  /** 1-based; text results only. */
  line?: number;
  /** 1-based, in characters of the line; text results only. */
  column?: number;
  /** Source offsets of the match, so a surface can select it; text results only. */
  from?: number;
  to?: number;
  /** The line the match is on, trimmed; a long line is windowed around the match with "…" at a cut end; text results only. */
  snippet?: string;
  /** Where the match is inside `snippet` (character offsets, `from` inclusive, `to` exclusive); text results only. */
  snippetFrom?: number;
  snippetTo?: number;
  /**
   * The match is in an image's description (its sidecar): the image's absolute
   * path, which is what a surface opens. The result's own `path` is the sidecar.
   */
  image?: string;
  /**
   * The match is in a bundle's main file, which the tree does not show: the
   * bundle, as its row names it. `path` is the main file, which opens.
   */
  bundle?: { path: string; name: string; label: string };
};

export type SearchReport = {
  query: string;
  /** Names first, best first; then text matches in document order. */
  results: SearchResult[];
  /** How many results are returned. */
  count: number;
  /** More matches existed than the limit allowed, so "3" and "3 of more" differ. */
  truncated: boolean;
};

// ── links ─────────────────────────────────────────────────────────────────

/** Where a link landed: `links.ts` says what each state means. */
export type LinkResolution = Resolution;

export type { RelationUse };

/**
 * Where a followed link's `#anchor` landed in the document it opened
 * (kit-heading-links-build), read by `findHeading` from the version opened.
 * `found` is absent when no heading matched: the document opens at the top and
 * the surface says which heading was not there.
 */
export type HeadingLanding = {
  /** The anchor as the link names it, decoded. */
  anchor: string;
  /** The document opened, and the version the offsets are in. */
  doc: string;
  version: number;
  found?: {
    /** The heading's text without its markup. */
    text: string;
    /** Its 1-based line, and the line's extent as offsets. */
    line: number;
    from: number;
    to: number;
    /** The anchor names several headings; this is the first. */
    ambiguous?: true;
  };
};

/** A heading the link picker offers, with the anchor a link to it is written with. */
export type HeadingOffer = {
  level: number;
  /** The heading's text without its markup. */
  text: string;
  line: number;
  /** What follows `#` in the link, encoded (`How%20lenses%20work#Stacking%20lenses` for a repeat). */
  anchor: string;
};

/** The headings of one document, for the link picker's second step. */
export type LinkHeadings = { path: string; headings: HeadingOffer[] };

/** A document a new link can point at, from the document the link is written in. */
export type LinkTarget = {
  /** The absolute path. */
  path: string;
  /** The file's name, with its extension. */
  name: string;
  /** The target to write: relative to the writing document's folder, encoded. */
  href: string;
  /** The path shown under the name: from the root of its context entry. */
  shown: string;
  /** An image the tree shows (kit-image-embeds): chosen, it is embedded unless words are being linked. */
  image?: true;
  /** An image's description, from its sidecar (its title and one-line description): matched as a name is. */
  description?: string;
  /** The document's kind (`kindOf`: its matched profile's, else its frontmatter `type`); absent for none and for an image. */
  kind?: string;
};

/**
 * A relation the link picker offers: one the world's links use (`count` of
 * them), one its vocabulary declares, or both. A declared one carries the
 * words its `_meta/profiles/_relations.json` gives it.
 */
export type RelationOffer = RelationUse & {
  /** Declared in the vocabulary in force for the document being written in. */
  declared: boolean;
  /** How it reads ("grounded in"). */
  label?: string;
  /** What it means: the picker's second line. */
  means?: string;
  /** It reads the same from both ends. */
  symmetric?: true;
  /** How it reads from the other end ("grounds"). */
  inverse?: string;
  /** The colour an app draws it in: a JSON Canvas preset ("1" to "6") or a hex. */
  color?: string;
};

/**
 * How the links into documents of one kind use one relation: `links` of them
 * in all, `fromKind` of those written in a document of the picker's own kind.
 * What the picker ranks relations by for the target in view.
 */
export type KindRelationUse = KindUse;

export type { KindPairUse };

/**
 * The relations in force at a path in the context (`relationsAt`), for an app
 * that types something between two documents other than a link written in one
 * (Atlas's board connections): what the link picker offers, with the
 * world's use of each relation between every pair of kinds, so the app ranks
 * them for any two ends (`kindUseFrom`, then `rankRelations`).
 */
export type RelationsAt = {
  /** Whether a vocabulary file is in force there. */
  vocabulary: boolean;
  /** As the link picker offers them: the relations in use and those declared. */
  relations: RelationOffer[];
  /** How the world's typed links use each relation, by the kinds at their two ends. */
  pairs: KindPairUse[];
  /** The nearest vocabulary file, usable or broken: where a new relation is proposed. Null with none. */
  file: string | null;
  /** Why the nearest file cannot be read, when it is broken. */
  broken?: string;
};

/**
 * What the link picker offers for document `doc`: every other document in the
 * session, and the relations: the `?rel=` values its documents already use,
 * most used first, and those the vocabulary in force declares. Read from the
 * link cache, so an open costs a stat per document, not a read of each.
 */
export type LinkTargets = {
  doc: string;
  /** The kind of the document being written in, or null. */
  kind: string | null;
  targets: LinkTarget[];
  relations: RelationOffer[];
  /** Whether a vocabulary file is in force for `doc`: without one, nothing is "not declared". */
  vocabulary: boolean;
  /** Each relation's use on links into each kind: the picker's ranking for the target in view. */
  byKind: KindRelationUse[];
};

/**
 * What a sidebar row dropped onto document `doc` writes there
 * (kit-tree-drag-into-document), one per path that writes or is refused, in the
 * order asked. An image in reach is embedded and a document linked (`image`
 * says which): `href` relative to the document and encoded as the link picker
 * writes it, `text` one line, unescaped: an image's sidecar title, a
 * document's title or first heading, else the file name without the
 * extension. Anything no relative path inside the document's own context
 * entry reaches is refused, in words. A path that writes nothing (a folder, an
 * image's description, the document itself) is left out.
 */
export type DroppedLink =
  | { path: string; image: boolean; href: string; text: string }
  | { path: string; refused: string };

/**
 * A link that lands on the document asked about, from another document in the
 * session. Read from the source's ACTIVE VERSION when the session holds it, so
 * an unsaved edit counts.
 */
export type BacklinkView = {
  /** The source document's absolute path. */
  source: string;
  /** Its file name, with its extension. */
  name: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** The 1-based line of the source file the link is on. */
  line: number;
  /** The target exactly as written: query, anchor and encoding kept. */
  raw: string;
  /** The `?rel=` relations; empty for a bare link, which asserts none. */
  rel: string[];
  kind: LinkKind;
  /** The link's text, when it has one (an embed's alt text). */
  label?: string;
  /** An embed (`![alt](x.png)`), which draws the image where it is written. */
  embed?: true;
  /** The line it is on, trimmed, cut to a window around the link when long. */
  context: string;
  /** Where the link sits in the source's active text, as offsets. */
  from: number;
  to: number;
};

/**
 * What links to a document. `relations` counts each relation once per link
 * that carries it (a link with two counts under both), most used first; `bare`
 * counts the links that carry none. `truncated` says the list was cut at its cap.
 */
export type Backlinks = {
  /** The document's slug when the session holds it, else null. */
  doc: string | null;
  path: string;
  count: number;
  backlinks: BacklinkView[];
  /**
   * `as` is how the relation reads from this end, when the vocabulary in force
   * for this document says: its declared inverse ("grounds" for
   * `grounded-in`), or for a symmetric relation its label ("contrasts with").
   */
  relations: (RelationUse & { as?: string })[];
  bare: number;
  /**
   * The bundles that reference the document (boards it is a card on), one
   * entry each, apart from `backlinks`: a board is not canon, so it is listed
   * under its own heading, "On the board The well". Not in `count`.
   */
  bundles: ReferenceBacklinkView[];
  /**
   * The app's edges that land on the document (kit-link-edges-slot), apart from
   * `backlinks`: Scriptorium's frontmatter references. Present only when the
   * app adds edges; cut at the same cap, `edgeCount` the whole. Not in `count`.
   */
  edges?: EdgeBacklinkView[];
  edgeCount?: number;
  truncated?: true;
};

/** An app's edge (kit-link-edges-slot) as a report shows it: where it is written, and its target as written. */
export type EdgeBacklinkView = {
  /** The document the edge is written in, absolute. */
  source: string;
  /** Its file name, with its extension. */
  name: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** The edge's kind, the app's word for it: `frontmatter`. */
  edge: string;
  /** The target exactly as written. */
  raw: string;
  /** What in the document carries it, when the app says: a frontmatter key (`related`). */
  key?: string;
  /** The 1-based line of the source file, when the app knows it. */
  line?: number;
  /** Relations it asserts; empty for none. */
  rel: string[];
  label?: string;
};

/** An app's edge that nothing answers: `tried` is every place the resolver looked. */
export type CheckedEdgeView = Omit<EdgeBacklinkView, "rel"> & {
  tried: string[];
  /**
   * Where the edge is written in the source's active text, as offsets: the
   * app's line when it gives one, else the first place its target is written
   * in the frontmatter (`line` is filled from it). Absent when neither finds it.
   */
  from?: number;
  to?: number;
  /** The id of the set (context entry) the source is in. */
  set?: string;
};

/**
 * A link or an app edge that lands on a file the session does not hold: a
 * file beside a listed document, or outside a set's folder. A link to one of
 * the session's own documents never leaves, whichever set either is in. Not a
 * problem (a set may well point beyond itself), but it says the session is
 * not self-contained. Reported only for an app that asks
 * (`LinkCheckOptions.leaving`).
 */
export type LeavingLinkView = {
  /** The document it is written in, absolute. */
  source: string;
  name: string;
  /** Its path from the root of its set. */
  shown: string;
  /** The 1-based line of the source file, when known. */
  line?: number;
  /** The target exactly as written. */
  raw: string;
  label?: string;
  /** Where it is written, as offsets, when known: what opening it reveals. */
  from?: number;
  to?: number;
  /** The file it lands on, absolute. */
  target: string;
  /** The file as a person reads it: its path in its own set, else from the source's set root. */
  targetShown: string;
  /** The label of the set whose folder holds the target (a file there that is not a document); absent for a file in no set. */
  targetSet?: string;
  /** An app edge's kind (`frontmatter`); absent for a body link. */
  edge?: string;
  key?: string;
  /** The id of the set the source is in. */
  set?: string;
};

/** A bundle that references a document: the boards a document is on, each with the cards that point at it. */
export type ReferenceBacklinkView = {
  /** The bundle's main file, absolute: what opens it. */
  source: string;
  /** The bundle's folder, absolute. */
  bundle: string;
  /** Its name as its row shows it (its title). */
  name: string;
  /** Its folder's path from the root of its context entry. */
  shown: string;
  /** What a person calls one ("board") and what holds a reference ("card"). */
  noun: string;
  part: string;
  /** Each reference to the document, in the order written. */
  refs: ReferenceView[];
};

/** One reference in a bundle's main file, as written. */
export type ReferenceView = {
  /** What holds it, by its id in the file (a card's id). */
  id: string;
  line: number;
  /** The path exactly as written. */
  raw: string;
  /** What it is called where it is (the title a card last showed), when it has one. */
  label?: string;
  /** A place inside the target (a heading), as written. */
  subpath?: string;
  from: number;
  to: number;
};

/**
 * A bundle's reference the link check reports (a card on a board whose file
 * is gone): the bundle, the reference, where it looked, and a sentence that
 * says so ("card 'The Glade' points at `bible/the-glade.md`, which is missing").
 */
export type CheckedReferenceView = ReferenceView & {
  source: string;
  /** The id of the set (context entry) the source is in. */
  set?: string;
  bundle: string;
  name: string;
  shown: string;
  noun: string;
  part: string;
  /** Every place it looked, in order. */
  tried: string[];
  text: string;
};

/**
 * One document as a report names it: where it is, what it is called, and its
 * kind as the world's profiles say (the graph's node, without its links).
 */
export type DocSummary = {
  path: string;
  /** Its file name, with its extension. */
  name: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** Its frontmatter `title`, else its first heading, else its file name without the extension. */
  title: string;
  /** The matched profile's kind, else the frontmatter `type`; null when it has none. */
  kind: string | null;
  /** The kind's label: the matched profile's, else the kind as written; null with no kind. */
  label: string | null;
  /** False when its matched profile says `"canon": false`; true otherwise. */
  canon: boolean;
  /** Its frontmatter `status`, when it has one. */
  status?: string;
};

/**
 * A document as a card shows it (`cardSummaries`): its summary, its
 * frontmatter `description` when it has one, and how many links it writes
 * (to files, not to a scheme such as `https:`), read from the link cache.
 */
export type DocCardSummary = DocSummary & { description?: string; links: number };

/**
 * A link a document writes, and where it lands, followed from where it is
 * written as backlinks follow it. `state` is the resolver's (`in-context`,
 * `outside`, `not-a-doc`, `folder`, `missing`), or `scheme` for a target with
 * a scheme (`op:doc/…`, `https:`), which names no file here.
 */
export type OutlinkView = {
  /** The 1-based line of the FILE (frontmatter counted). */
  line: number;
  /** The target exactly as written. */
  raw: string;
  /** The `?rel=` relations; empty for a bare link. */
  rel: string[];
  kind: LinkKind;
  label?: string;
  embed?: true;
  /** The line it is on, trimmed, cut to a window around the link when long. */
  context: string;
  from: number;
  to: number;
  state: "in-context" | "outside" | "not-a-doc" | "folder" | "missing" | "scheme";
  /** Where it landed, for every state but `missing` and `scheme`. */
  path?: string;
  /** The scheme, lower-cased, with state `scheme`. */
  scheme?: string;
  /** With state `scheme`: `http`, `https` and `mailto` open outward, in a browser; any other opens nothing here. */
  outward?: boolean;
};

/** The links one document writes, in the order it writes them. */
export type Outlinks = {
  path: string;
  shown: string;
  /** The version read (the active one unless one was asked for), or null for a document the session does not hold. */
  version: number | null;
  count: number;
  links: OutlinkView[];
  truncated?: true;
};

/** One document's text as the session holds it. */
export type DocText = {
  path: string;
  shown: string;
  /** The version read (the active one unless one was asked for), or null for a file read from disk. */
  version: number | null;
  text: string;
};

/** A link the check reports: where it is written, and the link as written. */
export type CheckedLinkView = {
  /** The document the link is written in, absolute. */
  source: string;
  /** Its file name, with its extension. */
  name: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** The 1-based line of the source FILE (frontmatter counted). */
  line: number;
  /** The target exactly as written: the string to search the source for. */
  raw: string;
  kind: LinkKind;
  label?: string;
  /** An embed (`![alt](x.png)`) rather than a link. */
  embed?: true;
  /** The line it is on, trimmed, cut to a window around the link when long. */
  context: string;
  /** Where the link sits in the source's active text, as offsets. */
  from: number;
  to: number;
  /** The id of the set (context entry) the source is in: what the list groups by. */
  set?: string;
};

/**
 * A link broken in a version that is not active (kit-relink-misses-proposed-
 * versions): a move's relink rewrites only the active version, so a version
 * proposed before the move keeps the old target. `line`, `from`, `to` and
 * `context` are in THAT version's text, not the active one's. Reported, never
 * rewritten.
 */
export type ProposedLinkView = CheckedLinkView & {
  /** The document's slug (`--doc`). */
  doc: string;
  /** The version the link is written in. */
  version: number;
  /** Every place the resolver looked. */
  tried: string[];
  /**
   * Where the target went, written from the document as relink writes it:
   * only when a move or rename this daemon made explains the break (the
   * target moved, or the document did) and the rewritten link lands. Absent
   * otherwise, and after a restart: never a guess.
   */
  suggest?: string;
  /**
   * The act that fixes it, said to the agent: propose the version again with
   * the link fixed (`version-new --from vN`), then delete the old proposal
   * (`version-delete vN`), which was the agent's own and never active.
   */
  act: string;
};

/** A document sharing its file name with another, and the name it could take. */
export type SharedNameFile = {
  path: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** A suggested new name, free in its folder and in the session. Never applied. */
  suggest: string;
  /** The id of the set (context entry) the file is in. */
  set?: string;
};

/**
 * The link check, in three sections. Each section's `count` is the whole, and
 * its list is cut at a cap (`truncated` says one was). Read from each document's
 * ACTIVE VERSION, so an unsaved edit counts; `proposed` alone reads the other
 * versions. A dangling link is reported, never an error.
 */
export type LinkCheck = {
  /** The link problems found: dangling links, unsupported links and shared names (never `unusedImages`). */
  count: number;
  /** Links that resolve to nothing: `tried` is every place the resolver looked. */
  dangling: { count: number; links: (CheckedLinkView & { tried: string[] })[] };
  /**
   * Links broken in a version the agent proposed: written by the agent and
   * never active (`Version.activated`), so a version the human has had active
   * is not read (`ProposedLinkView`), each with the act that fixes it. A link the active
   * version has broken too, as written, is in `dangling` alone. Counted in
   * `count`: activated, it is a broken link. Always sent by this daemon; optional
   * for a list built by hand.
   */
  proposed?: { count: number; links: ProposedLinkView[] };
  /** Links with a scheme nothing here opens (`op:doc/…`): `scheme` is `op`. */
  unsupported: {
    count: number;
    /** Every scheme in use among them, sorted, from the whole list, not the capped one. */
    schemes: string[];
    links: (CheckedLinkView & { scheme: string })[];
  };
  /** File names more than one document has, each file with a suggested rename. */
  duplicates: { count: number; names: { name: string; files: SharedNameFile[] }[] };
  /**
   * Images in an `images/` folder (where a paste or a drop into a document
   * puts them) that no link or embed in any document reaches: left behind when
   * an embed was undone or deleted. Only those folders: an image kept anywhere
   * else (a mood board, references) needs no embed to belong. Not in `count`,
   * which counts problems with links: an unused image is not a broken link.
   */
  unusedImages: { count: number; images: { path: string; shown: string; set?: string }[] };
  /**
   * Links carrying a relation the vocabulary declares symmetric, written one
   * way only: the document linked to writes no link with that relation back.
   * One per pair and relation, the first such link standing for the rest. A
   * HINT, never a problem (the human may not want the reverse link): not in
   * `count`, and never a doctor finding. Empty in a world with no
   * `_relations.json`.
   */
  symmetry: { count: number; hints: SymmetryHint[] };
  /**
   * Links whose document resolves but whose `#anchor` names no heading in it
   * (kit-heading-links-build): usually a heading reworded since. `nearest` is
   * the heading most like it, when one is close. Counted in `count`, apart
   * from dangling links, since following one still opens the document.
   */
  headings: { count: number; links: HeadingProblem[] };
  /**
   * Links whose bare `#anchor` names more than one heading (a repeated
   * heading's text): following lands on the first. A HINT, not in `count`;
   * the path of headings (`#Parent#Child`) names one alone.
   */
  ambiguousHeadings: { count: number; hints: HeadingProblem[] };
  /**
   * References in bundles (cards on boards) whose file nothing answers,
   * beside the documents' dangling links. Counted in `count`.
   */
  references: { count: number; links: CheckedReferenceView[] };
  /**
   * The app's edges that nothing answers (kit-link-edges-slot): Scriptorium's
   * frontmatter references to a page not written. Present only when the app
   * adds edges; `kinds` is every edge kind among them. Counted in `count`.
   */
  edges?: { count: number; kinds: string[]; links: CheckedEdgeView[] };
  /**
   * The app's edges that nothing answers and that are NOT written as a path
   * (`pathShaped`: no extension, no leading `/`, `./` or `../`), such as
   * `feature/some-slug`: a reference in a convention the kit does not know.
   * Listed, never counted in `count`: the kit cannot tell a broken one from
   * one another tool resolves. Present when `edges` is.
   */
  unresolved?: { count: number; kinds: string[]; links: CheckedEdgeView[] };
  /**
   * Links and app edges that land outside the set they are written in
   * (`LeavingLinkView`). Not in `count`, nor in a set's `total`: leaving the
   * set is not broken, so it is listed, never counted. The `edge` filter
   * applies as it does to the other sections.
   */
  leaving?: { count: number; links: LeavingLinkView[] };
  /** The app's word for a set (`LinkCheckOptions.noun`), when it gives one: what a list calls them. */
  noun?: string;
  /**
   * The session's sets, in the context's order: each entry above names its
   * set by `set`, and a list grouped by set titles each group from here.
   */
  sets?: {
    id: string;
    label: string;
    /** What the sign counts of the set, before any list is cut (shared names, the session's, unresolved references and leaving links apart). */
    total: number;
  }[];
  truncated?: true;
};

/** What an app asks of the link check beyond the kit's own (`WorkspaceDaemonOptions.linkCheck`). */
export type LinkCheckOptions = {
  /** Report the links and app edges leaving their set (`LinkCheck.leaving`). Off by default. */
  leaving?: boolean;
  /** The app's word for a set (`set`), said in the answer as `noun`. */
  noun?: string;
};

/** A link to a heading the check reports. */
export type HeadingProblem = CheckedLinkView & {
  /** The anchor as the link names it, decoded. */
  heading: string;
  /** The document linked to, absolute and as shown. */
  target: string;
  targetShown: string;
  /** Missing: the closest remaining heading's text, when one is close. Ambiguous: the heading it lands on. */
  nearest?: string;
};

/** A symmetric relation written one way: the link that writes it, and the document that does not link back. */
export type SymmetryHint = CheckedLinkView & {
  rel: string;
  /** The document linked to, absolute and as shown. */
  target: string;
  targetShown: string;
  /** In words: "The Ruin contrasts-with The Glade; The Glade does not link back". */
  hint: string;
};

/**
 * The world's relation vocabulary (`_meta/profiles/_relations.json`, the
 * nearest file winning per relation) and how the links use it.
 */
export type RelationsReport = {
  /** Every vocabulary file in the context, usable or broken (with why, and the line and column when it does not parse). */
  files: {
    path: string;
    shown: string;
    relations: number;
    broken?: string;
    /** Keys a relation has that are not read (a typo such as `symetric`), each ignored; `$`-keys are notes and never listed. */
    warnings?: string[];
  }[];
  /** How many warnings, across every file. */
  warnings: number;
  /** How many files are broken: each defines nothing until it is fixed. */
  broken: number;
  /**
   * Each declared relation, once per file that declares it, with `uses`: the
   * links using it in documents for which this file's definition is the one in force.
   */
  declared: {
    rel: string;
    label: string;
    means?: string;
    symmetric: boolean;
    inverse?: string;
    color?: string;
    /** The file it is declared in, as shown. */
    file: string;
    uses: number;
  }[];
  /** Relations links use where a vocabulary is in force but does not declare them, with how many links. */
  undeclared: RelationUse[];
  /** Every relation in use in the world, with how many links, most used first: the same with or without a vocabulary. */
  used: RelationUse[];
};

/**
 * What the link graph keeps. Every part is optional: with none, every document
 * in the session and every link between them, up to the cap.
 */
export type GraphOptions = {
  /** Centre on this document (a slug, a held name, or an absolute path in the context). */
  focus?: string;
  /** How far from the focus, in links followed either way: 0 to 3, default 1. */
  hops?: number;
  /** Keep links carrying any of these relations; untyped links go unless `untyped`. */
  rel?: string[];
  /** Keep untyped links. Default: true with no `rel`, false with one. */
  untyped?: boolean;
  /** Keep documents of these kinds only (a kind is `kindOf`'s: the matched profile's, else the frontmatter `type`). */
  kind?: string[];
  /** Keep documents with no kind. Default: true with no `kind`, false with one. */
  kindless?: boolean;
  /** Keep documents under this folder only (absolute): a set, or a folder in one. */
  within?: string;
  /** The most documents to answer with, best connected first; at most GRAPH_CAP. */
  limit?: number;
  /**
   * Bundles whose type reads references (boards) as nodes too, of their
   * type's kind, not canon, with an edge to what each references (marked
   * `reference`). Default false.
   */
  bundles?: boolean;
  /**
   * Keep links of these edge kinds only (kit-link-edges-slot): `link` for the
   * body links, or an app's own kind (`frontmatter`). A bundle's references
   * stay. Default: every kind.
   */
  edge?: string[];
};

/** A document in the link graph. */
export type GraphNodeView = {
  path: string;
  /** Its file name, with its extension. */
  name: string;
  /** Its path from the root of its context entry. */
  shown: string;
  /** Its frontmatter `title`, else its first heading, else its file name without the extension. */
  title: string;
  /** Its kind: the matched profile's kind, else the frontmatter `type`; null when it has none. */
  kind: string | null;
  /** Its kind's label: the matched profile's (`Location`), else the kind as written; null with no kind. */
  label: string | null;
  /** False when its matched profile says `"canon": false`; true otherwise, and in a world with no profiles. */
  canon: boolean;
  /** Its frontmatter `status`, when it has one. */
  status?: string;
  /** Links in and out within the filtered graph, before the cut. */
  linksIn: number;
  linksOut: number;
  /** Links away from the focus (0: the focus), when there is one. */
  hop?: number;
  /** A bundle (a board) rather than a document: what a person calls one. */
  bundle?: { noun: string };
};

/**
 * Links from one document to another with the same relations, folded: `rel`
 * is empty for untyped. `reference`: a bundle's references (cards on a board),
 * which assert no relation.
 */
export type GraphEdgeView = {
  from: string;
  to: string;
  rel: string[];
  count: number;
  reference?: true;
  /** An app's edges of this kind (kit-link-edges-slot), not body links: `frontmatter`. */
  edge?: string;
};

/**
 * The session's documents and the typed links between them, filtered and cut
 * by degree (`GraphOptions`). Read from each document's ACTIVE VERSION, as
 * backlinks are. `relations`, `untyped` and `kinds` describe what the filters
 * chose from, so a legend can offer what is hidden; `total` is what passed the
 * filters before the cut, and `truncated` says the cut dropped some.
 */
export type LinkGraph = {
  /** The focus's absolute path, or null. */
  focus: string | null;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  relations: RelationUse[];
  untyped: number;
  /**
   * Every kind among the documents before `kind` filters, most first, with its
   * label and whether it is canon (false only when every document of it is not).
   */
  kinds: { kind: string | null; label: string | null; canon: boolean; count: number }[];
  /**
   * Links of each edge kind before `edge` filters, most first (`link`: the
   * body links). Present only when an app's edge is among them.
   */
  edgeKinds?: { kind: string; count: number }[];
  /**
   * What passed the filters, before the cut: documents, edges (folded pairs)
   * and the links they fold. With bundles shown (`bundles: true`), `bundles`
   * and `references` say how many of the nodes and links are bundles (boards)
   * and their references, present only when there are some.
   */
  total: { nodes: number; edges: number; links: number; bundles?: number; references?: number };
  truncated?: true;
  /**
   * What in the filter matched nothing, said rather than silent: a kind no
   * document has, a relation no link in view carries, a folder with no document
   * in the session, or a filter that left no document at all. The answer is
   * still the graph the filter asked for.
   */
  warnings?: string[];
};

// ── document profiles ─────────────────────────────────────────────────────
//
// What a kind of document is expected to carry in its frontmatter, read from a
// world's `_meta/profiles/<kind>.json` files (see `profiles.ts`). Problems are
// warnings: nothing here blocks a save.

/** One way a document's frontmatter differs from its profile. */
export type ProfileWarningView = {
  field: string;
  /** `required`, `type`, `enum`, `const`, `minLength`, or `forbidden` (a property whose schema is `false`). */
  rule: "required" | "type" | "enum" | "const" | "minLength" | "forbidden";
  /** A sentence a human reads. */
  message: string;
  /** What the rule expects: the types, the allowed values, the constant or the length. */
  expected?: unknown;
  /** The profile's own `description` of the field: guidance for fixing it. */
  description?: string;
  /**
   * The file whose rule this is, absolute and as shown: the kind file, or a
   * shared file its `allOf` refers to. A fix to the rule goes there.
   */
  file?: string;
  fileShown?: string;
  /** What to do about it, in words: "add `region` to the frontmatter". */
  fix?: string;
};

/**
 * A profile file that does not parse or is not a usable schema: its kind
 * matches nothing beneath it. A shared file (`kind` null) broken in itself is
 * listed once; each kind broken only because of it is listed too, with
 * `through` naming the shared file to fix.
 */
export type BrokenProfileView = {
  path: string;
  /** Its path from the root of its context entry (led by the entry's folder when two would read the same). */
  shown: string;
  /** The kind its file name says; null for a shared file. */
  kind: string | null;
  reason: string;
  /** For a kind broken only through a shared file: that file, as shown. The fix goes there. */
  through?: string;
  /** How many documents it leaves unchecked. */
  documents?: number;
};

/** A word about a usable profile file that is not a problem (a shared file's `kind`, which is ignored). */
export type ProfileFileNote = { path: string; shown: string; note: string };

/**
 * How one document matched a profile. `kind` is `kindOf`'s answer, the kind
 * the graph and the map use: the profile's kind when one matched, else the
 * frontmatter `type` exactly as today.
 */
export type DocumentProfile = {
  /** The document's slug when the session holds it, else null. */
  doc: string | null;
  /** For a held document, the version the answer was read from (its active one then). */
  version?: number;
  path: string;
  shown: string;
  /** Its frontmatter `type`, or null. */
  type: string | null;
  kind: string | null;
  /** `matched`: a usable profile; `broken`: its nearest file is broken; `none`: no profile for its type. */
  match: "matched" | "broken" | "none";
  /** The profile's label (`Location`), when one matched. */
  label?: string;
  /**
   * Whether the world counts the document as canon: false only when a matched
   * profile says `"canon": false`. With no profile, or a broken one, it is true,
   * as before profiles.
   */
  canon: boolean;
  /** The profile file that won (the nearest), absolute and as shown, when one matched or is broken. */
  source?: string;
  sourceShown?: string;
  /**
   * Why a broken source is broken, or, for `none`, why nothing matched: its
   * frontmatter does not parse, it has no `type`, or no profile defines it.
   */
  reason?: string;
  /**
   * For `broken`, when the kind is broken only because a shared file it refers
   * to is: that file, absolute and as shown. The fix goes there, not in `source`.
   */
  through?: string;
  throughShown?: string;
  /** The profile's own description of the kind. */
  description?: string;
  warnings: ProfileWarningView[];
  /** What the profile expects, field by field, in its order: for writing a new document of the kind. */
  fields?: {
    field: string;
    required: boolean;
    type?: string[];
    enum?: unknown[];
    const?: unknown;
    minLength?: number;
    description?: string;
    /** The profile's schema for it is `false`: a document of the kind does not take it. */
    forbidden?: true;
    /** The file this rule is written in, absolute and as shown. */
    file?: string;
    fileShown?: string;
  }[];
  /** The shared files the kind's `allOf` refers to, as shown, depth first. */
  refs?: string[];
};

/** The world's profiles: each kind with the file it came from and how many documents match it. */
export type ProfilesReport = {
  /** Documents in the session. */
  documents: number;
  /**
   * Each usable profile file with the documents it is the nearest for. A kind
   * defined in a nested folder too is listed once per file.
   */
  kinds: {
    kind: string;
    label: string;
    /** The file's `canon`: false for a kind the world does not count as canon, true when absent. */
    canon: boolean;
    source: string;
    shown: string;
    documents: number;
    /** Documents of it with at least one warning. */
    withWarnings: number;
    /** The shared files its `allOf` refers to, as shown, depth first. */
    refs: string[];
  }[];
  /** `type` values no profile defines, with how many documents carry each. */
  unprofiled: { type: string; documents: number }[];
  /** Documents with no `type` at all (a frontmatter block that does not parse is counted under `unparsed`). */
  untyped: number;
  /** Documents whose frontmatter block is there but does not parse as fields, each with why; cut at 500. */
  unparsed: { count: number; documents: { path: string; shown: string; reason: string }[] };
  broken: (BrokenProfileView & { documents: number })[];
  /** How many files need a fix: a shared file broken in itself counts once, not once per kind using it. */
  brokenFiles: number;
  notes?: ProfileFileNote[];
};

/** Every profile warning in the session, shaped like the link check. */
export type ProfileCheck = {
  /** All warnings, and every broken file, together. */
  count: number;
  warnings: {
    count: number;
    /** Documents with at least one warning. */
    documents: number;
    list: (ProfileWarningView & {
      source: string;
      name: string;
      shown: string;
      kind: string;
      /** The profile file it was checked against, as shown. */
      profile: string;
      /** What to do about it, in words. */
      fix: string;
    })[];
    /** Documents with more warnings than one document lists (20): how many more each has. */
    more?: { source: string; shown: string; count: number }[];
  };
  /** `count` is the files that need a fix; `files` also lists each kind broken through one, with `through`. */
  broken: { count: number; files: (BrokenProfileView & { fix: string })[] };
  notes?: ProfileFileNote[];
  truncated?: true;
};
