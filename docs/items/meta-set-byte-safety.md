---
type: item
title: meta-set and meta-init corrupt some files, on both paths
description:
  Scriptorium's frontmatter setKey mangles a value holding $& or $', writes
  before the opening fence of an empty block, mixes line endings in CRLF files,
  duplicates quoted keys, and misses a block after a BOM; shipped and kit alike.
status: stable
lifecycle: ready
id: 01a1486e-39d2-74bc-9309-fbcd4276f813
kind: bug
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-shell
---

# meta-set and meta-init corrupt some files, on both paths

Found by the wiki-verbs verifier (2026-10-17), on the shipped and kit paths
alike: `setKey` in `src/scriptorium/backend/frontmatter.ts` uses
`text.replace(raw, rebuilt)`, so `$&` or `$'` in a value pastes the block into
the title; an empty block (`---\n\n---`) gets the key before its opening fence;
a CRLF file gets an LF line; a quoted key (`"status": draft`) is appended again;
and a BOM hides the block from `meta-set` and `meta-init`.

## Definition of done

- [x] Each of the five inputs is a test on both paths, and the file changes only
      in the named key.
- [x] The fix is in the shared helper, so the shipped and kit paths stay
      byte-identical to each other.

## Done and verified

Fixed in `7d42b340` on `impl/scriptorium-kit-keepers`, inside
[scriptorium-kit-keepers](scriptorium-kit-keepers.md). The helper moved to
`src/scriptorium/backend/kit/frontmatter.ts`, and the shipped `frontmatter.ts`
re-exports it, so the shipped and kit paths run one `setKey` and `withBlock`.
Fixing it there fixed both paths.

- `setKey` splices the block back by position, not with `String.replace`. That
  fixes `$&`, `$'`, `` $` `` and `$$` in a value, and the empty block.
- A replaced line keeps the CR of the line it replaces. An appended line takes
  the opening fence's line ending.
- A key written in double or single quotes is matched and replaced as it was
  written.
- The block pattern allows a leading BOM, so `meta-set` finds the block and
  `meta-init` refuses the file (409). `withBlock` keeps a BOM first.

One table (`backend/kit/fixtures/metaSetCases.ts`, twelve inputs that cover all
five and the doubled key) runs at three levels. The first is the helper
(`kit/frontmatter.test.ts`). The second is the kit's `metaSet`/`metaInit`
(`kit/metaSetBytes.test.ts`). The third is the shipped
`Session.metaSet`/`metaInit` writing real files
(`backend/metaSetBytes.test.ts`). Each of six mutations reddens all three
levels.

**One fact, one meaning (the fixups, after the no-stake verification).** The
pattern now sees through a BOM, so the readers must too. The first commit let
them disagree: the shipped surface drew the header and also the raw block, and
the kit path's graph read no frontmatter from the file. Now every reader on both
paths treats a block after a BOM as the block:

- the helper both backends run (`backend/kit/frontmatter.ts`): `meta`, `find`,
  `docMeta`, the shipped graph, `meta-set` and `meta-init`;
- the shipped surface's splitter (`surface/state/markdown.ts`). The guard cell
  that holds it equal to the helper now has two BOM inputs;
- the kit's own rule (`src/kit/lib/frontmatter.ts`), and so everything that
  reads through it: the rendered view, the projection, `headingsOf`, the kit
  session's facts and graph (Scriptorium's frontmatter edges included), links
  and the tree.

`backend/bomReaders.test.ts` runs one BOM file through each of them and checks
that they agree. In a real browser on a scratch home, the shipped surface shows
a BOM file's header once and its body's one heading, with no raw block. The kit
page does the same, and its map puts the file in its `type` column with its
frontmatter link.

**A key named twice.** `setKey` sets the LAST line that names the key, which is
the one YAML reads (last wins). That covers `"status": a` then `status: b`, and
also two bare lines, which silently did nothing before. Two cases were added to
the table.

**A quoted first key (second fixup round).** The kit's rule takes a block only
when its first non-empty line looks like a key, so prose between two scene-break
rules stays prose. It now also takes the key in matching quotes (`"status":`,
`'status':`). Before, a block that opened `"status": draft` showed in the kit's
document pane as a rule plus a heading. The kit's graph gave it no kind and no
frontmatter edge, and its backlinks missed `related`, while the tree marker,
`find` and `docMeta` saw it. `backend/bomReaders.test.ts` now runs this file
through every reader on both paths too (with the kit's backlinks). The pane was
checked in a real browser: header once, one H1, and in the map the file sits in
its `note` column with its frontmatter link.

**What still differs, left as it is.** A block whose first line is not a key,
including an empty block (`---\n\n---`) or `---\n: : :\n---`, is frontmatter to
Scriptorium's readers and prose to the kit's, so the kit's pane draws its fences
as two rules. Making the kit agree means dropping or widening the lookahead,
which would also take two scene-break rules at the top of a story as
frontmatter. That is Story Studio's rule to change, not a cheap fix here. Both
are older than this item.

**A trade-off the quoted key brings, for Story Studio.** The final verifier
(2026-10-19) found that a scene between two rules that opens with a quoted word
and a colon, such as `---\n"Wait": she said, and stopped.\n---` or
`'Stop': he cried.`, is now frontmatter on the kit path. Its line leaves the
body and shows as a header field. Before, it was prose. It joins a bare
`Note: this is prose.`, which was already frontmatter. Quote, word, colon is an
unusual way to punctuate dialogue, so the lead accepted it for Scriptorium. It
goes in the port-back offer beside the empty-block question, for Story Studio to
rule on. Other first lines remain frontmatter to Scriptorium's readers and prose
to the kit: plain prose, a quoted key with a space (`"due date":`), and a key
starting with a digit (`2024:`). For such a file the kit's `meta` reports a
defaulted `status: stable` and "not a mapping".

**Left as it is:** `titleFromBody` does not skip a BOM. So `meta-init` on a BOM
file with no block suggests an empty title, as it did before.
