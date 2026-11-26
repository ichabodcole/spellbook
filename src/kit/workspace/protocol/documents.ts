/**
 * Documents: comparing and merging, authors and speakers, versions, notes and
 * the document views. Part of the wire vocabulary (`../protocol.ts`); types
 * only.
 */

// ── comparing and merging ─────────────────────────────────────────────────
//
// The engine lives in `diff.ts`; the shapes live here because the surface
// renders exactly what the daemon computed. There is no second diff
// implementation to disagree with the first, so a hunk the human accepts is the
// hunk the merge applies.

/** What happened to one line between the two sides. */
export type DiffOp = "same" | "add" | "del";

/** A run within a refined line: `changed` marks what differs from its pair. */
export type DiffSpan = { text: string; changed: boolean };

export type DiffLine = {
  op: DiffOp;
  /** 0-based index in the LEFT text, when the line is present there. */
  a?: number;
  /** 0-based index in the RIGHT text, when the line is present there. */
  b?: number;
  text: string;
  /** Word-level refinement, only on lines the engine could pair. */
  spans?: DiffSpan[];
};

/**
 * One contiguous difference: the left's `[aFrom, aTo)` lines become the
 * right's `[bFrom, bTo)`. A pure insertion has `aFrom === aTo`; a pure
 * deletion has `bFrom === bTo`.
 */
export type DiffHunk = {
  id: number;
  aFrom: number;
  aTo: number;
  bFrom: number;
  bTo: number;
  del: string[];
  add: string[];
};

export type Diff = {
  lines: DiffLine[];
  hunks: DiffHunk[];
  /** The two texts are identical. */
  same: boolean;
  /** The line diff gave up; the whole difference is ONE hunk, and it says so. */
  coarse: boolean;
};

/** What a comparison can be against: another version, or the file of record. */
export type DiffSide = number | "original";

/**
 * The left side is always the active version. That is a rule, not a default:
 * the active version is the only one the human writes, so making it the left
 * side of every comparison means a merge always has exactly one legal
 * destination. Comparing two versions neither of which is active would be
 * readable and un-mergeable, so the shape does not offer it.
 */
export type DiffPayload = {
  doc: string;
  active: number;
  against: DiffSide;
  diff: Diff;
  /** The daemon chose `against` (the request asked it to `pick`). */
  picked?: true;
  /** Picked, and no side differs: the file and every other version match the active one. */
  everyMatches?: true;
};

/**
 * Where the agent pointed the human's view (`show`): a change in the comparison
 * of the active version against `against`, by its hunk id, or a passage of the
 * active version, by its offsets. The daemon has already checked it is there.
 */
export type ShowTarget =
  | { doc: string; version: number; hunk: number; against: DiffSide }
  | { doc: string; version: number; from: number; to: number; quote: string };

// ── authors and speakers ──────────────────────────────────────────────────

/** Who wrote a version or a note. */
export type Author = "human" | "agent";

/** Who created a task. The daemon creates the tasks it runs itself. */
export type TaskAuthor = "human" | "agent" | "daemon";

/** Who is speaking in the chat. */
export type Speaker = "human" | "agent" | "system";

// ── versions, notes, documents ────────────────────────────────────────────

export type Version = {
  n: number;
  label?: string;
  by: Author;
  /** The version it was copied from (absent for v1, which comes from the original). */
  fromVersion?: number;
  createdAt: string;
  /**
   * Set once it has been the active version (activated, or the active one
   * when another was activated). Absent for a version never active since the
   * kit began recording it: what makes an agent's version a PROPOSAL the link
   * check reads (`LinkCheck.proposed`).
   */
  activated?: true;
  /**
   * Kept from an outside write to the active version (a write the kit did not
   * make), filed as the agent's: not a proposal the link check reads.
   */
  outside?: true;
};

/** How a note found its place in the current text; see `anchors.ts`. */
export type NoteHow = "context" | "unique" | "nearest" | "orphaned";

/** A note as it is stored: the text it was made on, never an offset. */
export type Note = {
  id: string;
  /** The version it was made on: provenance. It is not what anchors it. */
  version: number;
  quote: string;
  /** The text just before and after the quote when it was made. */
  before: string;
  after: string;
  /** Where it was then: a hint for choosing between identical quotes. */
  at: number;
  body: string;
  by: Author;
  createdAt: string;
  /** When the body was last rewritten; absent if it never was. */
  editedAt?: string;
  /**
   * Who rewrote it then: what tells a human's rewrite, which is owed an answer
   * again, from the agent's, which is one (`notesWaiting`).
   */
  editedBy?: Author;
  /**
   * What the note said before the agent rewrote it, kept so the human can see it
   * and put it back. Absent when the agent never rewrote it, or the human has
   * rewritten it since.
   */
  replacedBody?: string;
  /** When it was last put back after being resolved; absent if it never was. */
  reopenedAt?: string;
  /** Who put it back: the human reopening asks again; the agent reopening is an act on it. */
  reopenedBy?: Author;
  resolved: boolean;
  resolvedAt?: string;
};

/**
 * A note placed in the active version's text as it stands right now. The
 * offsets and the lines are derived on every read and never stored.
 */
export type PlacedNote = Note & {
  from: number | null;
  to: number | null;
  how: NoteHow;
  fromLine: number | null;
  toLine: number | null;
};

/** A document as the manifest stores it. */
export type Doc = {
  /** Unique within the session; also the folder name under `docs/`. */
  slug: string;
  name: string;
  /** Absolute path of the file of record. Written only by Save. */
  original: string;
  entryId: string | null;
  rel: string | null;
  ext: string;
  versions: Version[];
  active: number;
  /** The next version number to hand out. Monotonic, never derived from what is present. */
  nextVersion: number;
  notes: Note[];
  /** Hash of the original as we last read or wrote it, so a restore can tell it changed. */
  originalHash: string;
  /** Set only when a document-type file inside a context entry was opened; Save writes no other original. */
  admitted: boolean;
  outsideChanged: boolean;
  /**
   * While `outsideChanged`: the hash of the file's text the human was asked
   * about. "Keep mine" saves over that text only; a newer one, missed by the
   * watcher too, is asked about again. Absent (a manifest from before it) reads
   * as a text nobody was shown.
   */
  outsideHash?: string;
  /**
   * The original is gone from disk: deleted or moved away outside the app, or
   * moved to the Trash from the sidebar. The record and its versions stay, so
   * the text is not lost; Save recreates the file only when asked to.
   */
  missing?: boolean;
};

export type VersionView = Version & {
  /** Absolute path of this version's file in the session folder. */
  path: string;
};

export type DocView = {
  slug: string;
  /**
   * A second slug this document answers to (`--doc`), when it has one: a
   * bundle's main file, opened under one name and its bundle renamed since,
   * answers to the slug of the bundle's name now as well as to `slug`, which
   * never changes while the session holds it (its versions are filed under
   * it). Absent when the two are the same, or another document holds it.
   */
  alias?: string;
  name: string;
  original: string;
  entryId: string | null;
  rel: string | null;
  ext: string;
  versions: VersionView[];
  active: number;
  /** Derived: the hash of the active version's current text. */
  hash: string;
  /** The active version differs from the original on disk. False while the original is missing. */
  dirty: boolean;
  /** The original changed on disk while the buffer was dirty (or while no daemon watched). */
  outsideChanged: boolean;
  /**
   * While `outsideChanged`: which text of the file is being asked about (`Doc`'s
   * `outsideHash`). A new one is a newer outside change: the comparison is asked
   * for again, and the human told again.
   */
  outsideHash?: string;
  /**
   * Absent while the original is on disk. `file`: the file is gone and its folder
   * is still there. `folder`: the folder went too. Save recreates the file only
   * with `recreate`, and the folder only with `recreate: "folder"`.
   */
  missing?: "file" | "folder";
  /** Notes, placed against the active version's text on every snapshot. */
  notes: PlacedNote[];
};
