// The links differential (kit-links-differential): Scriptorium's link cases,
// from links.test.ts, run through BOTH extractors and BOTH resolvers, its own
// (`./links`) and the kit's (`src/kit/workspace/links`), which is to become the
// one Scriptorium uses. Each case either gives the same answer from both, or
// names the deliberate difference it shows, and then BOTH answers are pinned, so
// a difference that closes or moves fails here as surely as a new one does.
//
// ⛔ THIS RUNS THE KIT, IT DOES NOT WIRE IT. Scriptorium still reads its links
// with its own extractor; moving it onto the kit's is a later cycle, and this is
// the bar that move is held to.
//
// It lives on Scriptorium's side because the kit stays a leaf: the kit imports
// nothing from a spell, so the comparison is made from here.
import { describe, expect, test } from "bun:test";
import {
  type LinkIndex as KitIndex,
  type LinkRef as KitLink,
  extractLinks as kitExtract,
  parseRel as kitParseRel,
  resolveTarget as kitResolve,
  splitTarget as kitSplit,
  type LinkKind,
} from "../../kit/workspace/links";
import { renderMarkdown } from "../surface/state/markdown";
import { wikiFormsResolver } from "./kit/links";
import {
  type BundleIndex,
  type ExtractOptions,
  type LinkRef,
  parseRel,
  type Resolution,
  resolveTarget,
  extractLinks as scrExtract,
  splitTarget,
} from "./links";
import type { DocMeta } from "./protocol";

// ── the deliberate differences ──────────────────────────────────────────────
//
// The port-shape write-up's §3e names the HTML ruling and seven smaller
// differences; running the cases found the rest. A case may cite one of these
// and nothing else: an unnamed difference fails.
const DIFFERENCES = {
  /** Ruled by Cole, 2026-10-14: the kit masks ALL raw HTML; Scriptorium only comments. */
  html: "kit rule, ruled: links inside raw HTML are masked",
  /** §3e.1: the kit counts an image embed as a link (`embed: true`); Scriptorium drops it. */
  embeds: "§3e.1 image embeds are links in the kit",
  /** §3e.2: the kit counts lines from the top of the file, frontmatter included. */
  lines: "§3e.2 line numbers count from the top of the file in the kit",
  /** §3e.3: `Chapter2:intro.md` is a path in the kit, a scheme in Scriptorium. */
  schemes: "§3e.3 a colon before a bare document name is a path in the kit",
  /** §3e.4: same-page anchors, kept by the kit only on `{ fragments: true }`. */
  fragments: "§3e.4 same-page anchors are kept as fragments on request in the kit",
  /** §3e.5: a wiki link's raw target is trimmed in the kit. */
  wikiTrim: "§3e.5 a wiki link's raw target is trimmed in the kit",
  /** §3e.7: `in-bundle` is `in-context`, and a file the workspace cannot open is `not-a-doc`. */
  notADoc: "§3e.7 a file that is not a document is `not-a-doc` in the kit",
  /**
   * Found here: the kit resolves every target as a path. Scriptorium's wiki
   * forms (a `type/slug` key by type and basename, a bare name by basename) and
   * its third place to look (the repo root) are not in the kit's own resolver.
   * On the kit path they come through Scriptorium's resolver slot
   * (kit-link-edges-slot): the block at the end of this file lands them.
   */
  wikiForms: "found: no `type/slug`, basename or repo-root resolution in the kit",
  /**
   * Found here: `?rel=` values. Case and repeats agree (ruled by Cole,
   * kit-links-differential `relCase`: the kit lowercases and drops a repeat
   * after folding, as Scriptorium does), non-ASCII case included (`İ`, `Ü`,
   * Greek). What still differs:
   * - Scriptorium keeps any value; the kit drops one that is not a relation
   *   word (`<relationship>`).
   * - Scriptorium reads the first `rel=` pair only; the kit reads every pair.
   * - Scriptorium decodes the value and then splits it on `,`; the kit splits
   *   and then decodes, so an encoded comma (`rel=a%2Cb`) is one value, `a,b`,
   *   which is not a relation word: `[]`.
   */
  relWords: "found: the kit drops non-word rels, reads every rel= pair, and splits before decoding",
  /**
   * Found here: a `/`-anchored target. Scriptorium looks under the bundle root
   * only; the kit looks under the root and then at the absolute path on disk
   * (its chat writes absolute paths), so `/w/other/notes.md` is `outside`.
   */
  rootFallback: "found: the kit also tries a `/` target as a filesystem path",
  /**
   * Found here: a missing image or SVG. The kit looks for an image's name as
   * written only; Scriptorium, which has no image types, also tries it with
   * `.md` added (`gone.png.md`).
   */
  imageLookups: "found: the kit never adds `.md` to an image or SVG name",
  /**
   * Found here, on the click path only (extraction drops these): an empty
   * target, `?rel=x` or `#top`. Scriptorium answers the document's own folder;
   * the kit answers a miss without asking the disk.
   */
  emptyTarget: "found: an empty target is a miss in the kit, the document's folder in Scriptorium",
  /**
   * Found here, the resolver's side of §3e.3: a markdown target shaped like a
   * scheme with no document name after it (`Note:Thing`, `C:/x.md`) is a
   * scheme to the kit, which asks nothing; Scriptorium looks for it as a path.
   */
  colonResolve: "found: the kit's resolver refuses a scheme-shaped markdown target",
} as const;
type Difference = keyof typeof DIFFERENCES;

// ── the fixtures, as links.test.ts has them ─────────────────────────────────

const meta = (fields: Record<string, unknown>): DocMeta => ({
  raw: "",
  fields,
  ...(typeof fields.type === "string" ? { type: fields.type } : {}),
  status: "stable",
  tags: [],
  trust: "unverified",
  stale: false,
  date: null,
});

const ROOT = "/w/wiki";
const PATHS = [
  "/w/wiki/index.md",
  "/w/wiki/concepts/exit-codes.md",
  "/w/wiki/decisions/stay-pre-1-0.md",
  "/w/wiki/rules/exit-codes/help-exits-zero.md",
];
const METAS: Record<string, DocMeta> = {
  "/w/wiki/concepts/exit-codes.md": meta({ type: "concept" }),
  "/w/wiki/decisions/stay-pre-1-0.md": meta({ type: "decision" }),
  "/w/wiki/rules/exit-codes/help-exits-zero.md": meta({ type: "rule" }),
};
const index = (extra: string[] = []): BundleIndex => ({
  root: ROOT,
  paths: PATHS,
  metaOf: (p) => METAS[p] ?? null,
  exists: (p) => PATHS.includes(p) || extra.includes(p),
});
const DIRS = ["/w/wiki", "/w/wiki/concepts", "/w/wiki/rules", "/w/wiki/rules/exit-codes"];
const withDirs = (extra: Partial<BundleIndex> = {}): BundleIndex => ({
  ...index(),
  isDir: (p) => DIRS.includes(p),
  ...extra,
});
const disk = (docs: string[], dirs: string[], files: string[] = []): BundleIndex => ({
  root: ROOT,
  paths: [...PATHS, ...docs],
  metaOf: () => null,
  exists: (p) => PATHS.includes(p) || docs.includes(p) || files.includes(p),
  isDir: (p) => p === ROOT || dirs.includes(p),
});

// ── one shape for both answers ──────────────────────────────────────────────

/** What a link IS, in both: the kit's offsets and context line are its own extras. */
type Seen = {
  kind: LinkKind;
  target: string;
  raw: string;
  line: number;
  rel: string[];
  label?: string;
  scheme?: string;
  embed?: true;
  fragment?: true;
};
const fromScr = (l: LinkRef): Seen => ({
  kind: l.kind,
  target: l.target,
  raw: l.raw,
  line: l.line,
  rel: l.rel,
  ...(l.label !== undefined ? { label: l.label } : {}),
  ...(l.scheme !== undefined ? { scheme: l.scheme } : {}),
});
const fromKit = (l: KitLink): Seen => ({
  kind: l.kind,
  target: l.target,
  raw: l.raw,
  line: l.line,
  rel: l.rel,
  ...(l.label !== undefined ? { label: l.label } : {}),
  ...(l.scheme !== undefined ? { scheme: l.scheme } : {}),
  ...(l.embed ? { embed: true as const } : {}),
  ...(l.fragment ? { fragment: true as const } : {}),
});

/** Scriptorium's index as the kit reads one: same disk, same documents. */
const asKit = (i: BundleIndex): KitIndex => ({
  root: i.root,
  inContext: (p) => (i.paths.includes(p) ? p : null),
  exists: (p) => i.exists(p),
  isDir: (p) => i.isDir?.(p) ?? false,
});
/**
 * The index with every question put to the disk written down, in order: a
 * file (`exists`) or a folder (`isDir`). A resolver that has no `isDir` asks
 * no folder question, on either side.
 */
const probed = (i: BundleIndex): { index: BundleIndex; looked: string[] } => {
  const looked: string[] = [];
  return {
    looked,
    index: {
      ...i,
      exists: (p) => {
        looked.push(`file ${p}`);
        return i.exists(p);
      },
      // ⚠ ALWAYS GIVEN, and always written down. Scriptorium's resolver skips
      // the folder questions when an index has no `isDir`, which the kit's
      // cannot; a fixture without one is "no folder anywhere", so both are
      // handed that, and every folder question either side asks is recorded.
      isDir: (p: string) => {
        looked.push(`dir ${p}`);
        return i.isDir?.(p) ?? false;
      },
    },
  };
};
/**
 * A resolution in the kit's words. Scriptorium's `in-bundle` is the kit's
 * `in-context` (§3e.7's rename, which changes no answer). A miss is compared by
 * EVERY place the resolver asked the disk about, in order, not by what it
 * reports: Scriptorium reports one place and the kit every one, so comparing
 * reports by their first entry hid a place only the kit looks (`rootFallback`).
 */
type Landed = { state: string; path: string } | { state: "missing"; looked: string[] };
// Asking the disk the same question twice changes no answer (Scriptorium asks
// once per candidate, and an unanchored target's two candidates can be one), so
// a repeat is not a difference.
const once = (looked: string[]) => [...new Set(looked)];
const landedScr = (r: Resolution, looked: string[]): Landed =>
  r.state === "missing"
    ? { state: "missing", looked: once(looked) }
    : { state: r.state === "in-bundle" ? "in-context" : r.state, path: r.path };
const landedKit = (r: ReturnType<typeof kitResolve>, looked: string[]): Landed =>
  r.state === "missing"
    ? { state: "missing", looked: once(looked) }
    : { state: r.state, path: r.path };

// ── the cases ───────────────────────────────────────────────────────────────

type ExtractCase = {
  name: string;
  body: string;
  opts?: ExtractOptions;
  kitOpts?: { schemes?: boolean; fragments?: boolean };
  /** A declared difference, with what each side says. */
  differs?: { why: Difference; scr: Seen[]; kit: Seen[] };
};

/** A markdown link as both read it, with no label, rel or scheme unless given. */
const md = (target: string, line = 1, more: Partial<Seen> = {}): Seen => ({
  kind: "markdown",
  target,
  raw: target,
  line,
  rel: [],
  ...more,
});

// Every extraction case in links.test.ts, by its test's name, then the ones the
// differences need. Their expected values live in links.test.ts; here only the
// AGREEMENT is checked, except where a difference is declared.
const EXTRACT: ExtractCase[] = [
  {
    name: "markdown links, minus images and external targets",
    body: [
      "[a](./other.md)",
      "[b](../concepts/exit-codes.md)",
      "![pic](./diagram.png)",
      "[c](https://x.dev)",
      "[d](mailto:a@b.c)",
      "[e](#anchor-only)",
    ].join("\n\n"),
    differs: {
      why: "embeds",
      scr: [
        md("./other.md", 1, { label: "a" }),
        md("../concepts/exit-codes.md", 3, { label: "b" }),
      ],
      kit: [
        md("./other.md", 1, { label: "a" }),
        md("../concepts/exit-codes.md", 3, { label: "b" }),
        md("./diagram.png", 5, { label: "pic", embed: true }),
      ],
    },
  },
  { name: "wiki links", body: "See [[exit-codes]] and [[stay-pre-1-0|that decision]]." },
  {
    name: "a link inside a fence",
    body: ["Real: [a](./real.md)", "", "```md", "[fake](./fake.md)", "```", ""].join("\n"),
  },
  { name: "a title is not a target", body: '[a](./other.md "A title")' },
  { name: "inline code", body: "see `[x](./a.md)` and [real](./b.md)" },
  { name: "a double-tick span holding a tick", body: "``[x](./a.md) ` ``" },
  { name: "an unclosed tick", body: "a stray ` then [y](./y.md)" },
  {
    name: "an indented code block",
    body: ["prose", "", "    [x](./a.md)", "", "[b](./b.md)"].join("\n"),
  },
  { name: "a list item's indented continuation", body: ["- item", "    [x](./a.md)"].join("\n") },
  { name: "a fence inside a blockquote", body: ["> ```", "> [x](./a.md)", "> ```"].join("\n") },
  { name: "an escaped opening bracket", body: "\\[not](./x.md)" },
  { name: "an escaped closing bracket", body: "[not\\](./x.md)" },
  { name: "an inline HTML comment", body: "p <!-- [x](./a.md) --> [b](./b.md)" },
  { name: "a comment block", body: ["<!--", "[x](./a.md)", "-->", "[b](./b.md)"].join("\n") },
  { name: "a comment opening a line", body: "<!-- [x](./a.md) --> [b](./b.md)" },
  { name: "an <…> target", body: "[a](<./My Notes.md>)" },
  { name: "a single-quoted title", body: "[a](./x.md 'A title')" },
  { name: "nested brackets in a label", body: "[a [b] c](./x.md)" },
  { name: "an escaped ] in a label", body: "[a \\] b](./x.md)" },
  { name: "a wrapped label", body: ["intro", "see [the long", "label](./x.md) here"].join("\n") },
  { name: "a blank line ends a label", body: ["[a", "", "b](./x.md)"].join("\n") },
  { name: "a heading ends a label", body: ["# [a", "b](./x.md)"].join("\n") },
  { name: "parentheses in a target", body: "[a](./notes(1).md)" },
  { name: "escaped parentheses in a target", body: "[a](./notes\\(2\\).md)" },
  { name: "a link inside another link's label", body: "[see [x](./y.md)](./z.md)" },
  { name: "an escaped image marker", body: "\\![pic](./pic.md)" },
  { name: "a wiki link in code, document order", body: "`[[skip]]` [[b]] then [a](./a.md)" },
  {
    name: "line numbers on a long document",
    body: Array.from({ length: 2000 }, (_, i) => `line ${i} [l${i}](./d${i}.md)`).join("\n"),
  },
  {
    name: "the map's body",
    body: "`[x](./gone.md)` <!-- [y](./gone2.md) --> \\[z](./gone3.md) [ok](./concepts/exit-codes.md)",
  },
  { name: "a typed link", body: "[a](./x.md?rel=supersedes)" },
  { name: "a repeated rel", body: "[a](./x.md?rel=a,a,b,a) [[y?rel=c,c|y]]" },
  {
    // The shape Prettier writes: a list item's label wrapped, indented under it.
    name: "a wrapped label indented at the break",
    body: "- [a list\n  item label](./y.md)\n\n[b\n\t  c](./z.md)",
  },
  { name: "a typed wiki link", body: "[[x?rel=see-also|label]]" },
  { name: "a bare link", body: "[a](./x.md)" },
  { name: "a bare wiki link", body: "[[x]]" },
  { name: "the target as written", body: "See [it](./missing/deep.md?rel=x#top).\n" },
  {
    name: "the line it is on",
    body: ["# Title", "", "prose", "", "- [a](x.md)", "- [b](y.md)"].join("\n"),
  },
  {
    name: "a fenced block shifts nothing",
    body: [
      "# Title",
      "",
      "```ts",
      "const a = [1](not-a-link.md);",
      "```",
      "",
      "real [link](x.md)",
    ].join("\n"),
  },
  { name: "a wiki link's raw", body: "A [[Ghost Page|the ghost]] here.\n" },
  { name: "the folder links", body: "[c](./concepts/) [r](rules)" },
  {
    name: "scheme targets, default",
    body: "[src](op:doc/1d63ec43-65cd) [web](https://x.dev) [doc](./a.md)",
  },
  {
    name: "scheme targets, kept",
    body: "[src](op:doc/1d63ec43-65cd) [web](https://x.dev) [doc](./a.md)",
    opts: { schemes: true },
  },
  {
    name: "an op: link with its line",
    body: ["intro", "[the source](op:doc/1d63?rel=derived-from)", "[w](https://x.dev)"].join("\n"),
    opts: { schemes: true },
  },
  {
    name: "outward schemes",
    body: "[a](http://x) [b](HTTPS://x) [c](mailto:a@b.c)",
    opts: { schemes: true },
  },
  {
    name: "other schemes",
    body: "[a](tel:123) [b](FTP://x) [c](javascript:void(0))",
    opts: { schemes: true },
  },
  { name: "an op: link in code", body: "`[x](op:doc/1)`", opts: { schemes: true } },
  {
    name: "the map's bodies",
    body: "[exit codes](./concepts/exit-codes.md) and [[stay-pre-1-0]] See [the rule](/rules/exit-codes/help-exits-zero.md?rel=governs) [gone](./nowhere.md)",
  },
  { name: "indented code in a list item", body: "- item\n\n      [x](./nope4.md)" },
  {
    name: "indented code in an ordered item",
    body: "1. item\n\n       [x](./nope.md)\n\n[b](./b.md)",
  },
  { name: "indented code in a blockquote", body: "> q\n>\n>     [x](./nope5.md)" },
  { name: "indented code in a quoted item", body: "> - item\n>\n>       [x](./nope6.md)" },
  { name: "a continuation paragraph", body: "- a\n\n  more [x](./ok.md)" },
  { name: "an ordered continuation paragraph", body: "1. a\n\n   more [y](./ok2.md)" },
  { name: "a code span across lines", body: "`a\n[x](./c3.md)`" },
  { name: "a double-tick span across lines", body: "``a ` b\n[x](./c4.md) ``" },
  { name: "a blank line ends a span", body: "`a\n\n[x](./c5.md)`" },
  {
    name: "a link around an image",
    body: "[![badge](./b.png)](./real.md)",
    differs: {
      why: "embeds",
      scr: [md("./real.md", 1, { label: "![badge](./b.png)" })],
      kit: [
        md("./real.md", 1, { label: "![badge](./b.png)" }),
        md("./b.png", 1, { label: "badge", embed: true }),
      ],
    },
  },
  {
    name: "a link around an image and text",
    body: "[t ![a](i.png)](./r.md)",
    differs: {
      why: "embeds",
      scr: [md("./r.md", 1, { label: "t ![a](i.png)" })],
      kit: [
        md("./r.md", 1, { label: "t ![a](i.png)" }),
        md("i.png", 1, { label: "a", embed: true }),
      ],
    },
  },
  {
    name: "a typed link around an image",
    body: "[![a](i.png) and text](./r2.md?rel=see-also)",
    differs: {
      why: "embeds",
      scr: [
        md("./r2.md", 1, {
          raw: "./r2.md?rel=see-also",
          rel: ["see-also"],
          label: "![a](i.png) and text",
        }),
      ],
      kit: [
        md("./r2.md", 1, {
          raw: "./r2.md?rel=see-also",
          rel: ["see-also"],
          label: "![a](i.png) and text",
        }),
        md("i.png", 1, { label: "a", embed: true }),
      ],
    },
  },
  {
    name: "an image of a document inside a link",
    body: "[![b](./b.md)](./real.md)",
    opts: { schemes: true },
    differs: {
      why: "embeds",
      scr: [md("./real.md", 1, { label: "![b](./b.md)" })],
      kit: [
        md("./real.md", 1, { label: "![b](./b.md)" }),
        md("./b.md", 1, { label: "b", embed: true }),
      ],
    },
  },
  {
    name: "a link inside a label beside an image",
    body: "[![b](i.png) [x](./y.md)](./z.md)",
    differs: {
      why: "embeds",
      scr: [md("./y.md", 1, { label: "x" })],
      kit: [md("i.png", 1, { label: "b", embed: true }), md("./y.md", 1, { label: "x" })],
    },
  },
  { name: "a protocol-relative URL", body: "[cdn](//cdn.example.com/x) [d](./d.md)" },
  {
    name: "an unclosed inline comment",
    body: "Use <!-- to open a comment.\n\n[later](./later.md)",
  },
  { name: "an unclosed comment on the line", body: "[b](./b.md) <!-- [x](./a.md)" },
  { name: "a comment block in a quote", body: "> <!-- q\n\n[z](./z.md)" },
  { name: "a comment block in a list item", body: "- a\n  <!-- c\n\n[z](./z.md)" },
  { name: "an unclosed comment block", body: "a\n<!-- x\n[y](./y.md)" },
  { name: "a comment opener in code", body: "`<!--` then [a](./a.md)" },

  // ── the differences, each shown on its own ──
  // An inline tag is masked as itself, not with what it wraps: the view shows
  // `<span>` as text and still links what sits between, and so do both.
  { name: "a link between inline HTML tags", body: "<span>[x](./a.md)</span> [b](./b.md)" },
  {
    name: "a link inside an HTML block",
    body: ["<div>", "[x](./a.md)", "</div>", "", "[b](./b.md)"].join("\n"),
    differs: {
      why: "html",
      scr: [md("./a.md", 2, { label: "x" }), md("./b.md", 5, { label: "b" })],
      kit: [md("./b.md", 5, { label: "b" })],
    },
  },
  {
    // Scriptorium is handed the body; the kit, the whole file. A body without
    // frontmatter is the same text to both, which is every other case here.
    name: "a link below frontmatter",
    body: ["---", "title: A", "---", "[a](./a.md)"].join("\n"),
    differs: {
      why: "lines",
      scr: [md("./a.md", 1, { label: "a" })],
      kit: [md("./a.md", 4, { label: "a" })],
    },
  },
  {
    name: "a colon before a document name",
    body: "[a](Chapter2:intro.md) [b](./b.md)",
    differs: {
      why: "schemes",
      scr: [md("./b.md", 1, { label: "b" })],
      kit: [md("Chapter2:intro.md", 1, { label: "a" }), md("./b.md", 1, { label: "b" })],
    },
  },
  {
    name: "a same-page anchor, asked for",
    body: "[top](#top) [b](./b.md)",
    kitOpts: { fragments: true },
    differs: {
      why: "fragments",
      scr: [md("./b.md", 1, { label: "b" })],
      kit: [
        md("", 1, { raw: "#top", label: "top", fragment: true }),
        md("./b.md", 1, { label: "b" }),
      ],
    },
  },
  { name: "a same-page anchor, by default", body: "[top](#top) [[#top]] [b](./b.md)" },
  // A label is trimmed by both, whatever space surrounds it.
  { name: "a wiki label with space around it", body: "[[y|  the label  ]]" },
  {
    // ...and the target before the pipe is §3e.5: only its raw differs.
    name: "a wiki link with space around its pipe",
    body: "[[x | the label ]]",
    differs: {
      why: "wikiTrim",
      scr: [{ kind: "wiki", target: "x", raw: "x ", line: 1, rel: [], label: "the label" }],
      kit: [{ kind: "wiki", target: "x", raw: "x", line: 1, rel: [], label: "the label" }],
    },
  },
  {
    name: "a wiki link with space inside its brackets",
    body: "[[ exit-codes ]]",
    differs: {
      why: "wikiTrim",
      scr: [{ kind: "wiki", target: "exit-codes", raw: " exit-codes ", line: 1, rel: [] }],
      kit: [{ kind: "wiki", target: "exit-codes", raw: "exit-codes", line: 1, rel: [] }],
    },
  },
  {
    name: "a rel with capitals",
    body: "[a](./x.md?rel=Extends,%20governs,extends)",
    // Agrees since the relCase ruling: both sides lowercase, then drop the repeat.
  },
  {
    name: "a rel in two pairs, and a placeholder rel",
    body: "[a](./x.md?rel=Extends&rel=Governs) [b](./y.md?rel=<relationship>)",
    differs: {
      why: "relWords",
      scr: [
        md("./x.md", 1, { raw: "./x.md?rel=Extends&rel=Governs", rel: ["extends"], label: "a" }),
        md("./y.md", 1, { raw: "./y.md?rel=<relationship>", rel: ["<relationship>"], label: "b" }),
      ],
      kit: [
        md("./x.md", 1, {
          raw: "./x.md?rel=Extends&rel=Governs",
          rel: ["extends", "governs"],
          label: "a",
        }),
        md("./y.md", 1, { raw: "./y.md?rel=<relationship>", rel: [], label: "b" }),
      ],
    },
  },
];

/** The body as each side is handed it: Scriptorium gets the body, the kit the file. */
const bodyOf = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, "");

describe("the kit's extractor against Scriptorium's link cases", () => {
  for (const c of EXTRACT) {
    test(`${c.name}${c.differs ? ` [${c.differs.why}]` : ""}`, () => {
      const scrSaw = scrExtract(c.differs?.why === "lines" ? bodyOf(c.body) : c.body, c.opts).map(
        fromScr,
      );
      const kitSaw = kitExtract(c.body, { ...c.opts, ...c.kitOpts }).map(fromKit);
      if (!c.differs) {
        expect(kitSaw).toEqual(scrSaw);
        return;
      }
      expect(DIFFERENCES[c.differs.why]).toBeDefined();
      expect(scrSaw).toEqual(c.differs.scr);
      expect(kitSaw).toEqual(c.differs.kit);
    });
  }

  test("§3e.2 lines: Scriptorium's line is the kit's, less the frontmatter's lines", () => {
    const text = ["---", "title: A", "---", "", "x [a](./a.md)"].join("\n");
    const [scr] = scrExtract(bodyOf(text));
    const [kit] = kitExtract(text);
    expect([scr?.line, kit?.line]).toEqual([2, 5]);
  });

  test("random documents of code, comment and link pieces read the same in both", () => {
    // links.test.ts's generator, seed and pieces, compared kit against
    // Scriptorium rather than against the renderer, with wiki links and typed,
    // spaced labels added, and EVERYTHING a link carries compared: kind,
    // target, raw, line, rel and label. Embeds are the kit's own (§3e.1), so
    // they are set aside; every other link must agree. A wiki target is
    // written without space before its `|`: that is §3e.5, shown on its own.
    let seed = 7;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // biome-ignore format: one row of pieces reads better than thirty lines
    const pieces = ["LINK", "LINK", "WIKI", "`", "``", "```", "~~~", "<!--", "-->", "\n", "\n\n", "    ", "\t", "- ", "> ", "1. ", " ", "word", "\\", "]", "(", ")", "# ", "!"];
    const disagree: string[] = [];
    let k = 0;
    for (let i = 0; i < 1500; i++) {
      let s = "";
      const len = 3 + Math.floor(rand() * 20);
      for (let j = 0; j < len; j++) {
        const p = pieces[Math.floor(rand() * pieces.length)] as string;
        const n = k++;
        s +=
          p === "LINK"
            ? [
                `[l${n}](./t${n}.md)`,
                `[ l ${n} ](./t${n}.md?rel=see-also)`,
                `[l ${n}\n   wrapped](./t${n}.md)`,
              ][n % 3]
            : p === "WIKI"
              ? [`[[w${n}]]`, `[[w${n}| the w${n} ]]`, `[[w${n}?rel=extends|w]]`][n % 3]
              : p;
      }
      const scr = JSON.stringify(scrExtract(s).map(fromScr));
      const kit = JSON.stringify(
        kitExtract(s)
          .filter((l) => !l.embed)
          .map(fromKit),
      );
      if (scr !== kit) disagree.push(s);
    }
    expect(disagree).toEqual([]);
  });

  test("and both agree with the renderer on what is a link (the bar both are held to)", () => {
    // One spot check that the comparison is not two wrong answers agreeing.
    const s = "see `[x](./a.md)` and [real](./b.md) <!-- [y](./c.md) -->";
    const shown = [...renderMarkdown(s).matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);
    expect(kitExtract(s).map((l) => l.raw)).toEqual(shown as string[]);
    expect(scrExtract(s).map((l) => l.raw)).toEqual(shown as string[]);
  });
});

describe("the kit's target parsing against Scriptorium's", () => {
  const SPLITS = [
    "../concepts/exit-codes.md#the-taxonomy",
    "Maren's%20Bakery.md",
    "Visual%20Style.md?rel=renders-per",
    "Hollowbrook%20%E2%80%94%20Overview.md",
    "100% done.md",
    "Maren.md",
    "Hollowbrook%20Overview.md#the-rules",
    "./missing/deep.md?rel=x#top",
  ];
  for (const raw of SPLITS)
    test(`splitTarget(${JSON.stringify(raw)})`, () => {
      expect(kitSplit(raw)).toEqual(splitTarget(raw));
    });

  test("parseRel agrees on lower-case words", () => {
    for (const q of [
      "rel=supersedes",
      "rel=see-also",
      "rel=renders-per",
      "rel=a,b",
      "rel=a,a",
      "rel=a,b,a",
      "",
      undefined,
    ])
      expect(kitParseRel(q)).toEqual(parseRel(q));
  });
  test("parseRel agrees on case and repeats (relCase, ruled): lowercased, first seen kept", () => {
    for (const q of [
      "rel=Extends,%20governs,extends",
      "rel=Extends",
      "rel=SEE-ALSO,see-also",
      "rel=A,b,a",
      // Non-ASCII case: İ folds to i + a combining dot on both sides, and the kit still reads it.
      "rel=İlgili",
      "rel=%C4%B0lgili",
      "rel=Über,über",
      "rel=Αναφέρεται,αναφέρεται",
    ])
      expect(kitParseRel(q)).toEqual(parseRel(q));
    expect(kitParseRel("rel=Extends,%20governs,extends")).toEqual(["extends", "governs"]);
  });
  test(`parseRel [relWords]: ${DIFFERENCES.relWords}`, () => {
    expect(parseRel("rel=<relationship>")).toEqual(["<relationship>"]);
    expect(kitParseRel("rel=<relationship>")).toEqual([]);
    // Scriptorium reads the first `rel=` pair; the kit reads them all.
    expect(parseRel("rel=a&rel=b")).toEqual(["a"]);
    expect(kitParseRel("rel=a&rel=b")).toEqual(["a", "b"]);
    // Folded on both sides, the difference is only in which pairs and words count.
    expect(parseRel("rel=A&rel=B")).toEqual(["a"]);
    expect(kitParseRel("rel=A&rel=B")).toEqual(["a", "b"]);
    // Scriptorium decodes, then splits; the kit splits, then decodes.
    expect(parseRel("rel=a%2Cb")).toEqual(["a", "b"]);
    expect(kitParseRel("rel=a%2Cb")).toEqual([]);
    expect(parseRel("rel=A%2CB,a")).toEqual(["a", "b"]);
    expect(kitParseRel("rel=A%2CB,a")).toEqual(["a"]);
  });
});

type ResolveCase = {
  name: string;
  /** What wrote the target: a wiki link's is resolved by the kit's wiki branch. */
  kind?: LinkKind;
  target: string;
  from: string;
  index: BundleIndex;
  differs?: { why: Difference; scr: Landed; kit: Landed };
};

const FROM = "/w/wiki/decisions/stay-pre-1-0.md";
const TWO_WORDS = (() => {
  const i = index(["/w/wiki/concepts/two words.md"]);
  return { ...i, paths: [...i.paths, "/w/wiki/concepts/two words.md"] };
})();
const IDX = "/w/wiki/index.md";
const BOTH_RULES = withDirs({
  paths: [...PATHS, "/w/wiki/rules.md"],
  exists: (p) => PATHS.includes(p) || p === "/w/wiki/rules.md",
});
const lands = (path: string): Landed => ({ state: "in-context", path });
/** A miss, with every question it put to the disk (`file …`, `dir …`), in order. */
const missing = (...looked: string[]): Landed => ({ state: "missing", looked });

const RESOLVE: ResolveCase[] = [
  {
    name: "an Operator typed link",
    target: "../concepts/exit-codes.md?rel=located-in",
    from: FROM,
    index: index(),
  },
  {
    name: "a percent-encoded space",
    target: "../concepts/two%20words.md",
    from: FROM,
    index: TWO_WORDS,
  },
  { name: "an anchor", target: "../concepts/exit-codes.md#the-rule", from: FROM, index: index() },
  {
    name: "the Hollowbrook shape",
    target: "../concepts/two%20words.md?rel=located-in#top",
    from: FROM,
    index: TWO_WORDS,
  },
  { name: "a relative path", target: "../concepts/exit-codes.md", from: FROM, index: index() },
  {
    name: "a leading slash is the bundle root",
    target: "/concepts/exit-codes.md",
    from: FROM,
    index: index(),
  },
  {
    name: "`type/slug` by type and basename",
    kind: "wiki",
    target: "concept/exit-codes",
    from: FROM,
    index: index(),
    differs: {
      why: "wikiForms",
      scr: lands("/w/wiki/concepts/exit-codes.md"),
      kit: missing(
        "file /w/wiki/decisions/concept/exit-codes.md",
        "file /w/wiki/concept/exit-codes.md",
        "dir /w/wiki/decisions/concept/exit-codes",
        "dir /w/wiki/concept/exit-codes",
      ),
    },
  },
  {
    name: "`type/slug` with the wrong type falls back to basename",
    kind: "wiki",
    target: "guide/exit-codes",
    from: FROM,
    index: index(),
    differs: {
      why: "wikiForms",
      scr: lands("/w/wiki/concepts/exit-codes.md"),
      kit: missing(
        "file /w/wiki/decisions/guide/exit-codes.md",
        "file /w/wiki/guide/exit-codes.md",
        "dir /w/wiki/decisions/guide/exit-codes",
        "dir /w/wiki/guide/exit-codes",
      ),
    },
  },
  {
    name: "`type/slug` that nothing answers",
    kind: "wiki",
    target: "concept/nothing-here",
    from: FROM,
    index: index(),
    differs: {
      why: "wikiForms",
      // Scriptorium answers a key from its index, then asks only for a folder.
      scr: missing(
        "dir /w/wiki/decisions/concept/nothing-here",
        "dir /w/wiki/concept/nothing-here",
      ),
      kit: missing(
        "file /w/wiki/decisions/concept/nothing-here.md",
        "file /w/wiki/concept/nothing-here.md",
        "dir /w/wiki/decisions/concept/nothing-here",
        "dir /w/wiki/concept/nothing-here",
      ),
    },
  },
  {
    name: "the lint.ts case",
    target: "lint.ts",
    from: IDX,
    index: index(["/w/wiki/lint.ts"]),
    differs: {
      why: "notADoc",
      scr: { state: "outside", path: "/w/wiki/lint.ts" },
      kit: { state: "not-a-doc", path: "/w/wiki/lint.ts" },
    },
  },
  {
    name: "an unanchored path from the bundle root",
    target: "src/acc/kit/checkers/a.ts",
    from: "/w/wiki/rules/x.md",
    index: index(["/w/wiki/src/acc/kit/checkers/a.ts"]),
    differs: {
      why: "notADoc",
      scr: { state: "outside", path: "/w/wiki/src/acc/kit/checkers/a.ts" },
      kit: { state: "not-a-doc", path: "/w/wiki/src/acc/kit/checkers/a.ts" },
    },
  },
  {
    name: "an unanchored path from the repo root",
    target: "src/acc/kit/checkers/a.ts",
    from: "/w/wiki/rules/x.md",
    index: { ...index(["/w/src/acc/kit/checkers/a.ts"]), repoRoot: "/w" },
    differs: {
      why: "wikiForms",
      scr: { state: "outside", path: "/w/src/acc/kit/checkers/a.ts" },
      kit: missing(
        "file /w/wiki/rules/src/acc/kit/checkers/a.ts",
        "file /w/wiki/rules/src/acc/kit/checkers/a.ts.md",
        "file /w/wiki/src/acc/kit/checkers/a.ts",
        "file /w/wiki/src/acc/kit/checkers/a.ts.md",
        "dir /w/wiki/rules/src/acc/kit/checkers/a.ts",
        "dir /w/wiki/src/acc/kit/checkers/a.ts",
      ),
    },
  },
  {
    name: "document-relative wins",
    target: "notes.md",
    from: "/w/wiki/decisions/x.md",
    index: { ...index(), paths: [...PATHS, "/w/wiki/decisions/notes.md", "/w/wiki/notes.md"] },
  },
  {
    name: "a bare name by basename",
    kind: "wiki",
    target: "exit-codes",
    from: FROM,
    index: index(),
    differs: {
      why: "wikiForms",
      scr: lands("/w/wiki/concepts/exit-codes.md"),
      kit: missing(
        "file /w/wiki/decisions/exit-codes.md",
        "file /w/wiki/exit-codes.md",
        "dir /w/wiki/decisions/exit-codes",
        "dir /w/wiki/exit-codes",
      ),
    },
  },
  {
    name: "outside the bundle",
    target: "../../other/notes.md",
    from: FROM,
    index: index(["/w/other/notes.md"]),
  },
  { name: "nothing answers", target: "./gone.md", from: FROM, index: index() },
  {
    // The kit looks under the root, then on the filesystem, for a `/` target.
    name: "a `/` target nothing answers",
    target: "/gone.md",
    from: FROM,
    index: index(),
    differs: {
      why: "rootFallback",
      scr: missing("file /w/wiki/gone.md", "dir /w/wiki/gone.md"),
      kit: missing("file /w/wiki/gone.md", "file /gone.md", "dir /w/wiki/gone.md", "dir /gone.md"),
    },
  },
  {
    name: "a `/` target that is an absolute path on disk",
    target: "/w/other/notes.md",
    from: FROM,
    index: index(["/w/other/notes.md"]),
    differs: {
      why: "rootFallback",
      scr: missing("file /w/wiki/w/other/notes.md", "dir /w/wiki/w/other/notes.md"),
      kit: { state: "outside", path: "/w/other/notes.md" },
    },
  },
  ...["./concepts/", "./concepts", "concepts/", "/concepts/", "./concepts/?rel=x"].map(
    (t): ResolveCase => ({ name: `a folder, ${t}`, target: t, from: IDX, index: withDirs() }),
  ),
  { name: "a bare name that is a folder", target: "rules", from: IDX, index: withDirs() },
  {
    name: "a nested folder",
    target: "../rules/exit-codes/",
    from: "/w/wiki/concepts/exit-codes.md",
    index: withDirs(),
  },
  { name: "the bundle root folder", target: "/", from: IDX, index: withDirs() },
  { name: "a document beats a folder", target: "./rules", from: IDX, index: BOTH_RULES },
  { name: "a trailing slash says folder", target: "./rules/", from: IDX, index: BOTH_RULES },
  { name: "a trailing-slash miss", target: "./places/", from: IDX, index: withDirs() },
  { name: "a trailing-slash key", target: "index/", from: IDX, index: withDirs() },
  { name: "no disk to ask", target: "./concepts/", from: IDX, index: index() },
  {
    name: "./v1.2 beside v1.2/",
    target: "./v1.2",
    from: IDX,
    index: disk(["/w/wiki/v1.2.md"], ["/w/wiki/v1.2"]),
  },
  {
    name: "./v1.2/ beside v1.2.md",
    target: "./v1.2/",
    from: IDX,
    index: disk(["/w/wiki/v1.2.md"], ["/w/wiki/v1.2"]),
  },
  {
    name: "./v1.2 with no document",
    target: "./v1.2",
    from: IDX,
    index: disk([], ["/w/wiki/v1.2"]),
  },
  { name: "./notes.v2", target: "./notes.v2", from: IDX, index: disk(["/w/wiki/notes.v2.md"], []) },
  {
    name: "./lint.ts",
    target: "./lint.ts",
    from: IDX,
    index: disk([], [], ["/w/wiki/lint.ts"]),
    differs: {
      why: "notADoc",
      scr: { state: "outside", path: "/w/wiki/lint.ts" },
      kit: { state: "not-a-doc", path: "/w/wiki/lint.ts" },
    },
  },
  ...["./gone.png", "./gone.svg", "./gone.PNG"].map(
    (t): ResolveCase => ({
      name: `a missing image, ${t}`,
      target: t,
      from: IDX,
      index: withDirs(),
      differs: {
        why: "imageLookups",
        scr: missing(
          `file /w/wiki/${t.slice(2)}`,
          `file /w/wiki/${t.slice(2)}.md`,
          `dir /w/wiki/${t.slice(2)}`,
        ),
        kit: missing(`file /w/wiki/${t.slice(2)}`, `dir /w/wiki/${t.slice(2)}`),
      },
    }),
  ),
  ...["", "?rel=x", "#top"].map(
    (t): ResolveCase => ({
      name: `an empty target, ${JSON.stringify(t)}`,
      target: t,
      from: IDX,
      index: withDirs(),
      differs: { why: "emptyTarget", scr: { state: "folder", path: "/w/wiki" }, kit: missing() },
    }),
  ),
  {
    name: "a colon target, Note:Thing",
    target: "Note:Thing",
    from: IDX,
    index: withDirs(),
    differs: { why: "colonResolve", scr: missing("dir /w/wiki/Note:Thing"), kit: missing() },
  },
  {
    name: "a colon target, C:/x.md",
    target: "C:/x.md",
    from: IDX,
    index: withDirs(),
    differs: {
      why: "colonResolve",
      scr: missing("file /w/wiki/C:/x.md", "dir /w/wiki/C:/x.md"),
      kit: missing(),
    },
  },
  {
    // A wiki link's target is a name, never a scheme, in both; the kit still
    // reads it as a path (`wikiForms`), so it asks for a file Scriptorium does not.
    name: "a wiki name with a colon",
    kind: "wiki",
    target: "Note:Thing",
    from: IDX,
    index: withDirs(),
    differs: {
      why: "wikiForms",
      scr: missing("dir /w/wiki/Note:Thing"),
      kit: missing("file /w/wiki/Note:Thing.md", "dir /w/wiki/Note:Thing"),
    },
  },
  { name: "./v9.9 missing", target: "./v9.9", from: IDX, index: disk([], []) },
  { name: "./gone.md missing", target: "./gone.md", from: IDX, index: disk([], []) },
];

describe("the kit's resolver against Scriptorium's resolving cases", () => {
  for (const c of RESOLVE) {
    test(`${c.name}${c.differs ? ` [${c.differs.why}]` : ""}`, () => {
      const s = probed(c.index);
      const scr = landedScr(resolveTarget(c.target, c.from, s.index), s.looked);
      const k = probed(c.index);
      const kit = landedKit(
        kitResolve(c.target, c.from, asKit(k.index), "document", c.kind ?? "markdown"),
        k.looked,
      );
      if (!c.differs) {
        expect(kit).toEqual(scr);
        return;
      }
      expect(DIFFERENCES[c.differs.why]).toBeDefined();
      expect(scr).toEqual(c.differs.scr);
      expect(kit).toEqual(c.differs.kit);
    });
  }
});

describe("every declared difference is shown by a case", () => {
  test("no difference is listed that no case cites", () => {
    const cited = new Set<string>([
      ...EXTRACT.flatMap((c) => (c.differs ? [c.differs.why] : [])),
      ...RESOLVE.flatMap((c) => (c.differs ? [c.differs.why] : [])),
    ]);
    expect(Object.keys(DIFFERENCES).filter((d) => !cited.has(d))).toEqual([]);
  });
});

// ── the wiki forms on the kit path (kit-link-edges-slot) ────────────────────
//
// The kit's resolver, given Scriptorium's resolver slot (`./kit/links.ts`, the
// one the flagged daemon runs with), lands every `wikiForms` case where
// Scriptorium's own resolver does. A miss is a miss on both sides; where each
// looked still differs (the kit asks for a file first), which is the kit's rule.
// Every other case answers exactly as the bare kit does: the slot is asked only
// when the kit's own lookup found no file.
describe("on the kit path, Scriptorium's wiki forms go through its resolver slot", () => {
  const withSlot = (i: BundleIndex): KitIndex => {
    const app = wikiFormsResolver(() => i.repoRoot ?? null);
    const docs = i.paths.map((path) => ({
      path,
      type: i.metaOf(path)?.type ?? null,
      frontmatter: i.metaOf(path)?.fields ?? null,
    }));
    return {
      ...asKit(i),
      app: (target, kind) => app({ target, from: null, root: i.root, kind, documents: () => docs }),
    };
  };
  for (const c of RESOLVE) {
    const wiki = c.differs?.why === "wikiForms";
    test(`${c.name}${wiki ? " [wikiForms, now landed]" : " [unchanged by the slot]"}`, () => {
      const k = probed(c.index);
      const slotted = landedKit(
        kitResolve(c.target, c.from, withSlot(k.index), "document", c.kind ?? "markdown"),
        k.looked,
      );
      if (!wiki) {
        const b = probed(c.index);
        const bare = landedKit(
          kitResolve(c.target, c.from, asKit(b.index), "document", c.kind ?? "markdown"),
          b.looked,
        );
        expect(slotted).toEqual(bare);
        return;
      }
      const s = probed(c.index);
      const scr = landedScr(resolveTarget(c.target, c.from, s.index), s.looked);
      if (scr.state === "missing") {
        expect(slotted.state).toBe("missing");
        return;
      }
      // The repo-root case lands on a `.ts` file: `outside` to Scriptorium,
      // `not-a-doc` to the kit (`notADoc`, ruled).
      const expected =
        scr.state === "outside" && "path" in scr && !scr.path.endsWith(".md")
          ? { state: "not-a-doc", path: scr.path }
          : scr;
      expect(slotted).toEqual(expected);
    });
  }
});
