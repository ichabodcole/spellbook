/**
 * scriptorium's wire vocabulary — the types the daemon, the CLI and the surface
 * all speak. TYPE-ONLY and import-free, so the surface can `import type` it
 * without dragging a byte of the daemon into its bundle, and the CLI can read
 * the same shapes without dragging the server graph into `dist/cli.js`.
 *
 * ── THE CONTEXT MODEL (E15) ─────────────────────────────────────────────────
 *
 * ONE type for "a single document" and "a folder": a `ContextEntry` is a root
 * directory plus a tree of `doc` / `group` nodes, and a group is a real
 * directory under the root. A folder entry is rooted at the folder and its
 * nodes mirror the directory; a single-file entry is rooted at the file's
 * parent and holds exactly that one doc node — not its siblings. The surface
 * renders an entry holding one doc as a document and anything else as a tree;
 * that is a rendering choice, not a second type.
 *
 * `membership` answers the one question the watcher must ask — "a new file
 * appeared under this root: is it mine?" `mirrored` = everything under the root
 * that is a document (less what the human hid); `listed` = exactly the nodes
 * written down, which in practice is ONE document. E22 settled what promotion
 * is: a set is a real folder, so "turn into a set" makes the folder, moves the
 * document into it, and the entry becomes a `mirrored` entry rooted there —
 * same id, so nothing that named the entry breaks.
 *
 * ⚠ NODE ORDER CARRIES NO MEANING (E17). There is no manual order anywhere:
 * the surface sorts children for display (by name, or by last-updated). The
 * arrays below happen to come out name-sorted from a scan; nothing may rely
 * on that, and nothing may write an order into the manifest.
 */

/** A node in an entry's tree. `rel` is POSIX-relative to the entry's root. */
export type ContextNode =
  | { kind: "doc"; rel: string }
  | { kind: "group"; rel: string; children: ContextNode[] };

export type Membership = "mirrored" | "listed";

export type ContextEntry = {
  id: string;
  label: string;
  /** An absolute directory on disk. */
  root: string;
  membership: Membership;
  nodes: ContextNode[];
  /** Set when a mirrored scan stopped at its node cap — said, not silent. */
  truncated?: boolean;
  /**
   * Mirrored only: rels the human took out of Scriptorium ("Remove from
   * Scriptorium", E24). The files stay on disk; the mirror skips them, and a
   * hidden folder hides everything under it.
   */
  hidden?: string[];
};

/** OKF 0.2 §6's tiers, DERIVED from `verified` on read and never stored. */
export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

/**
 * A document's frontmatter, read (E32). `fields` carries EVERY key, known or
 * not — the spec requires a consumer to preserve what it does not understand,
 * and the surface shows the rest as labelled values.
 */
export type DocMeta = {
  /** The block as written, so a writer can round-trip what it did not parse. */
  raw: string;
  fields: Record<string, unknown>;
  /** OKF's one REQUIRED field — absent is a fact to show, not an error. */
  type?: string;
  title?: string;
  description?: string;
  /** `draft | stable | deprecated` in practice; any string in principle. Defaults to `stable`. */
  status: string;
  tags: string[];
  /** A house extension (pdocs), shown and filterable, never validated. */
  lifecycle?: string;
  trust: TrustTier;
  stale: boolean;
  /** `generated.at` as an ISO date, for `find --since`. */
  date: string | null;
  /** The frontmatter would not parse. The document is still a document. */
  error?: string;
};

/** What the sidebar needs for every context document — small, because it rides every snapshot. */
export type DocSummary = {
  type?: string;
  title?: string;
  status: string;
  tags: string[];
  lifecycle?: string;
  trust: TrustTier;
  stale: boolean;
  error?: string;
};

// ── comparing and merging (E36) ───────────────────────────────────────────────
//
// The engine that produces these lives in `diff.ts`; the shapes live HERE
// because the surface renders exactly what the daemon computed. That is the
// point of putting them on the wire: there is no second diff implementation to
// disagree with the first, so a hunk the human accepts is the hunk the merge
// applies.

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
  /** Word-level refinement — only on lines the engine could pair. */
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
 * ⛔ THE LEFT SIDE IS ALWAYS THE ACTIVE VERSION, and that is a rule, not a
 * default. E2 says the active version is the only one the human writes, so
 * making it the left side of every comparison means a merge always has exactly
 * one legal destination. Comparing two versions NEITHER of which is active
 * would be readable and un-mergeable — a view with a disabled verb — so the
 * shape simply does not offer it: activate the one you mean to change first.
 */
export type DiffPayload = {
  doc: string;
  active: number;
  against: DiffSide;
  diff: Diff;
};

// ── the work queue (E50) ─────────────────────────────────────────────────────
//
// ⛔ A TASK IS A MESSAGE THAT CAN BE MARKED DONE. Cole's framing, and the whole
// design follows from it: the primitive is tiny and trivially updatable by an
// agent, and every affordance — a count, a spinner, a list of what is
// outstanding, a toast when something finishes — is built ON that rather than
// requiring its own machinery. `status` is for long multi-step work ("reading
// the corpus", "writing the links") and is optional: a task that never sets one
// is not a lesser task.

export type Task = {
  id: string;
  /** What the work IS — the message a human reads in the conversation. */
  text: string;
  who: VersionAuthor;
  createdAt: number;
  /** The chat message this task was announced as, so the two stay one thing. */
  messageId: string;
  /** The step currently being done — absent until someone says (E50). */
  status?: string;
  /** Set when it is finished. Absent means outstanding. */
  doneAt?: number;
  /** What came of it, said at the moment it was marked done. */
  outcome?: string;
};

// ── notes (E45) ───────────────────────────────────────────────────────────────

/** How a note found its place in the current text — see `anchors.ts`. */
export type NoteHow = "context" | "unique" | "nearest" | "orphaned";

/** A note as it is STORED: the text it was made on, never an offset. */
export type Note = {
  id: string;
  /** The version it was made on — provenance. It is not what anchors it. */
  version: number;
  quote: string;
  before: string;
  after: string;
  /** Where it was when made — a hint for choosing between identical quotes. */
  at: number;
  body: string;
  who: VersionAuthor;
  createdAt: number;
  /** When the body was last changed — absent if it never was (E46). */
  editedAt?: number;
  /**
   * Who changed it then (E65) — what tells a human's rewrite, which is owed an
   * answer, from the agent's, which is one. Absent on edits made before E65.
   */
  editedBy?: VersionAuthor;
  resolved: boolean;
};

/** A note PLACED in the active version's text as it stands right now. */
export type PlacedNote = Note & {
  from: number | null;
  to: number | null;
  how: NoteHow;
};

export type VersionAuthor = "human" | "agent";

export type Version = {
  n: number;
  label?: string;
  author: VersionAuthor;
  /** The version it was copied from (absent for v1, which comes from the original). */
  from?: number;
  createdAt: number;
  /** Absolute path of this version's file in the session folder. */
  path: string;
};

export type DocView = {
  /** The doc's id within the session — also its folder name under `docs/`. */
  slug: string;
  name: string;
  /** Absolute path of the file of record (E1). Written ONLY by Save (E7). */
  original: string;
  entryId: string | null;
  rel: string | null;
  versions: Version[];
  active: number;
  /** The open document's frontmatter, read from the ACTIVE version's text (E32). */
  meta: DocMeta | null;
  /** The active version differs from the original on disk. */
  dirty: boolean;
  /** The original changed on disk while the buffer was dirty — asked, not merged. */
  outsideChanged: boolean;
  /** Notes, placed against the ACTIVE version's text on every snapshot (E45). */
  notes: PlacedNote[];
};

/**
 * What the context's undo arrows show (E60).
 *
 * ⚠ A hand-written mirror of `history.ts`'s `HistoryView`, for the same reason
 * `GraphPayload` and `SearchReport` are mirrors: this file is import-free so the
 * surface and `dist/cli.js` never drag the daemon's modules. Guarded by key
 * equality in `history.test.ts`.
 */
export type HistoryView = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  /** Present when the next undo would DELETE — the surface confirms first. */
  undoDeletes?: { path: string; dir: boolean };
};

/** What the human has selected — rides every message they send (E5/E11). */
export type Selection = {
  doc: string;
  version: number;
  path: string;
  fromLine: number;
  toLine: number;
  text: string;
};

export type ChatWho = "human" | "agent" | "system";

/**
 * E53: the human is waiting on an answer, and how that should read.
 *
 * ⛔ DEFINED HERE, NOT IN `waiting.ts`, because it rides in `PublicState` — and
 * because this file is import-free ON PURPOSE (see the header). Re-exporting it
 * from the module that computes it would have made the wire vocabulary import
 * the daemon's logic and created a type cycle, for the convenience of one line.
 *
 * `working` is a pulse. `stalled` is STATIC and says so in words: a pulse over a
 * wedged agent is false liveness, which is the one thing this must not do.
 */
export type Waiting = {
  messageId: string;
  since: number;
  badge: "working" | "stalled";
};

/**
 * E65: a note the human wrote and the agent has not answered — E53's `Waiting`,
 * for a note. Same two badges, same rule for each: `stalled` is STATIC.
 * DERIVED by the daemon from the notes and the conversation (`notesWaiting` in
 * `waiting.ts`); nothing stores it, so a reload or a restart re-derives it.
 */
export type NoteWaiting = {
  doc: string;
  noteId: string;
  since: number;
  badge: Waiting["badge"];
};

export type ChatMessage = {
  id: string;
  who: ChatWho;
  text: string;
  ts: number;
  selection?: Selection | null;
  /** The active version's path at send time — so the agent knows what to read. */
  activePath?: string | null;
};

/** The snapshot the surface renders and `state --full` prints. */
export type PublicState = {
  sessionId: string;
  home: string;
  mode: "dev" | "release";
  context: ContextEntry[];
  docs: DocView[];
  openDoc: string | null;
  selection: Selection | null;
  chat: ChatMessage[];
  /** The work queue (E50) — newest first, done ones included. */
  tasks: Task[];
  /**
   * Whether the human is waiting on an answer (E53), computed by the DAEMON
   * because that is where the clock is. Null when nobody is waiting.
   *
   * ⛔ IT IS IN STATE RATHER THAN DERIVED IN THE SURFACE so there is one rule.
   * The daemon needs it anyway — it is what decides when to nudge the agent —
   * and two implementations of "is anyone waiting" would eventually disagree
   * about whether to draw a pulse and whether to send a ping.
   */
  waiting: Waiting | null;
  /**
   * E65: every note still owed an answer, oldest first — the same derivation
   * as `waiting`, for notes, and computed in the same place for the same
   * reason: one rule, drawn wherever the note is shown.
   */
  notesWaiting: NoteWaiting[];
  /**
   * E60: what the context's undo arrows should show. ⚠ NOT the editor's undo —
   * CodeMirror owns keystrokes inside a document; this is acts on the SHAPE of
   * the context (moves, renames, hiding, creation).
   */
  history: HistoryView;
  /**
   * Per-viewer conveniences (pane sizes, …), kept in `$SCRIPTORIUM_HOME/prefs.json`
   * rather than the browser's storage: every session is a new port, and browser
   * storage is keyed by origin — port included — so sizes kept there reset at
   * every `open` (slice-A journal finding). String values only; the surface owns
   * their meaning.
   */
  prefs: Record<string, string>;
  /** The user's home directory, so the surface can show `~/notes` for a path. */
  userHome: string;
  /**
   * The session's WORKSPACE (E23): where a dropped file is copied and a new
   * top-level document or set is made. Defaults to the directory `open` ran
   * in; either party can change it.
   */
  workspace: string;
  /**
   * Frontmatter for every document in the context, by absolute path (E32) —
   * the small shape, because this rides every snapshot. A document with no
   * frontmatter is absent from the map rather than present as null.
   */
  docMeta: Record<string, DocSummary>;
  /** Set when the frontmatter scan stopped at its cap — said, not silent. */
  docMetaTruncated?: boolean;
};

/**
 * Structure changes (E24) — ONE vocabulary for both parties: the surface sends
 * these over the WebSocket (menus, drag and drop), the agent posts them through
 * the CLI's verbs, and the daemon does the same real change on disk either way.
 * Every path is ABSOLUTE. A folder named as a destination must be a context
 * folder (a mirrored entry's root, or a folder under it) or the workspace.
 * Nothing here deletes a file: `hide` takes a node out of Scriptorium only.
 */
export type StructureOp =
  /** A new empty document in `dir`; `name` defaults to a free "Untitled.md". */
  | { type: "doc.create"; dir: string; name?: string }
  /** A new folder in `dir`; in the workspace it becomes a new set. */
  | { type: "folder.create"; dir: string; name?: string }
  | { type: "move"; path: string; into: string }
  | { type: "rename"; path: string; name: string }
  | { type: "hide"; path: string }
  /** Bring back everything hidden in a mirrored entry. */
  | { type: "unhide"; entry: string }
  /** A single document becomes a set: a folder named for it, the document moved in (E22). */
  | { type: "set.make"; path: string }
  /** A COPY of a file's text, written into `into` (default: the workspace) — E23's drop. */
  | { type: "import"; name: string; text: string; into?: string }
  | { type: "workspace.set"; path: string };

export type StructureOpType = StructureOp["type"];

export type FsListEntry = { name: string; path: string; dir: boolean };

/**
 * E59's report.
 *
 * ⚠ ANOTHER HAND-WRITTEN MIRROR, for the same reason `GraphPayload` is one:
 * this file is import-free so the surface and `dist/cli.js` never drag the
 * daemon's modules. It is GUARDED the same way — `search.test.ts` asserts key
 * equality with `search.ts`'s types in both directions, so a field added to one
 * side alone fails the type check instead of drifting.
 */
export type SearchHit = { line: number; text: string; from: number; to: number };
export type SearchReport = {
  query: string;
  documents: { path: string; slug?: string; name: string; title?: string; score: number }[];
  text: { path: string; slug?: string; name: string; version?: number; hits: SearchHit[] }[];
  count: number;
  truncated: boolean;
};

/** The map of one set (E33). Shapes follow pdocs' `graph` where they overlap. */
export type GraphPayload = {
  entry: string;
  root: string;
  nodes: {
    path: string;
    rel: string;
    title: string;
    type?: string;
    status: string;
    stale: boolean;
    tags: string[];
    linksOut: number;
    linksIn: number;
  }[];
  /**
   * ⚠ A HAND-WRITTEN MIRROR OF `links.ts`'s `Edge`, and it has to be: this file
   * is import-free on purpose, so it cannot reference the module that computes
   * these. The mirror is GUARDED — `links.test.ts` asserts the two shapes are
   * assignable in both directions, so adding a field to one and not the other
   * fails the type check rather than drifting quietly. (E54 added `raw`/`line`
   * to the computing side only, and that is exactly how this was found.)
   */
  edges: {
    from: string;
    to: string;
    source: "link" | "frontmatter";
    key?: string;
    raw?: string;
    line?: number;
    rel: string[];
    state: "in-bundle" | "outside" | "missing";
  }[];
  dangling: number;
};

/**
 * What a move WOULD do, asked before a folder is moved (E26). The surface
 * confirms a folder move in these terms; the git facts are the daemon's,
 * because only it can look at the disk.
 */
export type MovePlan = {
  from: string;
  into: string;
  /** The moved thing's own name. */
  name: string;
  folder: boolean;
  /** Documents that would move with it (1 for a document). */
  docs: number;
  /** The git working tree the source is in, by its folder name — null if none. */
  repo: string | null;
  /** The source is in a git working tree and the destination is not in the same one. */
  leavesRepo: boolean;
};

/** Surface → daemon, over the WebSocket. */
export type ClientMsg =
  | { type: "open"; path: string }
  | { type: "open.doc"; doc: string }
  | { type: "edit"; doc: string; version: number; text: string }
  | { type: "select"; selection: Selection | null }
  /** E59: the header search bar. Empty query means "close the results". */
  | { type: "search"; query: string; limit?: number }
  /**
   * E60: step the CONTEXT's history. `confirmDelete` is the surface saying the
   * human has seen the dialog and said yes — without it a deleting undo is
   * refused, so a client cannot delete by omission.
   */
  | { type: "history.undo"; confirmDelete?: boolean }
  | { type: "history.redo" }
  | { type: "say"; text: string; withSelection: boolean }
  | { type: "activate"; doc: string; version: number }
  /**
   * E37: the HUMAN makes a version. The agent has had `version.new` since E1;
   * the surface had no way to make one at all, which made the versions the
   * compare view reads an agent-only concept.
   */
  /**
   * E42: `activate` is what separates the two intentions. BRANCHING (true) —
   * "I want to work in a new version" — moves the human into it. SNAPSHOTTING
   * (false) — "mark this moment, I'm staying" — leaves them where they are.
   * The agent's `version.new` never activates: its versions arrive unbidden.
   */
  | { type: "version.new"; doc: string; from?: number; label?: string; activate?: boolean }
  /** E41: remove a version and its file. Never the active one. */
  | { type: "version.delete"; doc: string; version: number }
  /** E45: the human notes a SELECTION — offsets into the active text. */
  | { type: "note.add"; doc: string; from: number; to: number; body: string }
  | { type: "task.done"; id: string; outcome?: string }
  | { type: "task.remove"; id: string }
  /** Forget every finished task at once — the queue's own tidy-up. */
  | { type: "tasks.clear" }
  | { type: "note.edit"; doc: string; id: string; body: string }
  | { type: "note.resolve"; doc: string; id: string; resolved: boolean }
  | { type: "note.remove"; doc: string; id: string }
  | { type: "save"; doc: string }
  | { type: "revert"; doc: string }
  | { type: "context.add"; path: string }
  | { type: "context.remove"; id: string }
  | { type: "fs.list"; path: string }
  /** Load a version's text into the surface (answered with `version.text`, origin "load"). */
  | { type: "read"; doc: string; version: number }
  /** Compare the active version against another (answered with `diff`). */
  | { type: "diff"; doc?: string; against: DiffSide }
  /** Take named hunks from `against` into the active version's buffer. */
  | { type: "merge"; doc?: string; against: DiffSide; hunks: number[] }
  /** What would a move do? Answered with `move.plan`; changes nothing (E26). */
  | { type: "move.plan"; path: string; into: string }
  /** A set's map (E33) — answered with `graph`. */
  | { type: "graph"; entry: string }
  /** Follow a link from a rendered document (E33) — answered with `link.target`. */
  | { type: "link.open"; from: string; target: string }
  /** What a frontmatter block would say for this document (E35) — answered with `meta.suggestion`. */
  | { type: "meta.suggest"; path: string }
  | { type: "prefs.set"; key: string; value: string }
  /** Show a context item in the OS file manager (Finder's "Reveal"). The human's affordance; changes nothing. */
  | { type: "reveal"; path: string }
  /**
   * E44: show a VERSION's file in the file manager. Deliberately not `reveal`
   * with a path — that one only accepts a path the session already shows, and
   * widening it so the surface could name the session folder would let it ask
   * to reveal anything. The daemon resolves the version itself.
   */
  | { type: "reveal.version"; doc: string; version: number }
  /**
   * Open the OS's own file picker and act on what comes back: add it to the
   * context, or make a folder the workspace. The daemon is a local process, so
   * it gets a real PATH — which a browser picker never gives (E23's note).
   */
  | { type: "pick"; want: "context-file" | "context-folder" | "workspace" }
  | StructureOp;

/** Daemon → surface, over the WebSocket. */
export type ServerMsg =
  | { type: "state"; state: PublicState }
  | { type: "version.text"; doc: string; version: number; text: string; origin: "load" | "remote" }
  | ({ type: "diff" } & DiffPayload)
  | { type: "fs.list"; path: string; entries: FsListEntry[]; error?: string }
  | { type: "move.plan"; path: string; into: string; plan?: MovePlan; error?: string }
  | { type: "graph"; entry: string; graph?: GraphPayload; error?: string }
  /**
   * E59's answer. `query` rides along so a slow reply cannot overwrite the
   * results of a query the human has already moved on from — the surface drops
   * anything that does not match what is in the box.
   */
  | { type: "search.results"; report: SearchReport }
  /** A block the HUMAN may insert into their buffer — suggested, never written for them. */
  | {
      type: "meta.suggestion";
      path: string;
      block?: string;
      /** The type the neighbours suggest — named `suggestedType` because `type` is the frame's own. */
      suggestedType?: string;
      error?: string;
    }
  /**
   * Where a link went. `in-bundle` means the daemon opened it; `outside` names
   * a real file the human may add; `missing` is a dangling link, said and
   * tolerated (OKF §11).
   */
  | {
      type: "link.target";
      target: string;
      state: "in-bundle" | "outside" | "missing";
      path?: string;
    }
  /** To the sender only: a structure op landed, at `path` — so the surface can open or rename it. */
  | { type: "structure.done"; op: StructureOpType; path: string }
  | { type: "error"; message: string };

/** Agent → daemon, over `POST /cmd` (the CLI's verbs). */
export type AgentCmd =
  | { type: "context.add"; paths: string[] }
  | { type: "version.new"; doc?: string; from?: number; label?: string }
  | { type: "say"; text: string }
  | { type: "activate"; doc?: string; version: number }
  | { type: "version.delete"; doc?: string; version: number }
  /**
   * E45: the agent notes a QUOTE — it has no offsets, and asking it to count
   * characters would be asking it to be wrong. The daemon finds the quote in
   * the active text and anchors from there, so both parties store the same shape.
   */
  | { type: "note.add"; doc?: string; quote: string; body: string }
  | { type: "notes"; doc?: string; all?: boolean }
  | { type: "note.edit"; doc?: string; id: string; body: string }
  /** E50: the agent says it has started something, and later that it is done. */
  /**
   * E53: "still working" — the snooze, and ONLY that. It silences the waiting
   * nudge for the message it is about and keeps the human's indicator a pulse
   * for a while; `seconds` overrides the default.
   *
   * ⛔ IT CARRIES NO MESSAGE, deliberately. An agent with something to tell the
   * human has `say` (which is a reply, and clears the wait) and `task-status`
   * (for the progress of declared work). A third channel saying "here is what I
   * am doing" would be a third place to look and two of them would go stale.
   */
  | { type: "working"; seconds?: number }
  | { type: "task.start"; text: string }
  | { type: "task.status"; id: string; status: string }
  | { type: "task.done"; id: string; outcome?: string }
  | { type: "task.remove"; id: string }
  | { type: "tasks.clear" }
  | { type: "note.resolve"; doc?: string; id: string; resolved: boolean }
  | { type: "note.remove"; doc?: string; id: string }
  | { type: "diff"; doc?: string; against: DiffSide; context?: number }
  | { type: "merge"; doc?: string; against: DiffSide; hunks: number[] }
  | { type: "close" }
  /** A document's frontmatter as read, or every context document's (E32). */
  | { type: "meta"; path?: string }
  /** A set's map as JSON, in pdocs' shape (E33). */
  | { type: "graph"; entry?: string }
  /** What cites a document — `related` and body `links` kept apart, as pdocs keeps them. */
  /**
   * E54: every link in a set that nothing answers, as `file:line` plus the
   * string the document actually contains. `graph` has the same facts and
   * buries them in several hundred edges.
   */
  | { type: "dangling"; entry?: string }
  /**
   * E61: forget a document whose file of record is gone. Refused while the file
   * exists — taking something out of the context is `hide`.
   */
  | { type: "forget"; doc?: string }
  /** E62: what is wrong with this session, each finding naming its own verb. */
  | { type: "doctor" }
  /**
   * E59: search the context. ⛔ THE ONE SEARCH VERB THERE IS, and deliberately
   * cross-document only: a single document an agent can read or grep, but the
   * ACTIVE VERSION of an open document is not at its original path, so grep
   * over the workspace finds the saved file and misses what the human is
   * reading. That asymmetry is the whole justification.
   */
  | { type: "search"; query: string; limit?: number }
  | { type: "backlinks"; path: string }
  /** Add a frontmatter block to a document that has none (E35). */
  | { type: "meta.init"; path: string; metaType?: string; by?: string }
  /** Set keys in an existing block — one line edit each. */
  | { type: "meta.set"; path: string; fields: Record<string, string> }
  /** pdocs's filter vocabulary over the context — ANDed, all optional. */
  | { type: "find"; filter: MetaFilter }
  | StructureOp;

/** The filters `find` accepts, named as pdocs names them. */
export type MetaFilter = {
  type?: string;
  status?: string;
  lifecycle?: string;
  tag?: string;
  /** ISO date; matches documents whose `generated.at` is on or after it. */
  since?: string;
};
