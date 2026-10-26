---
type: item
title: Port Story Studio's document pane into the kit
description:
  Port packages/kit/src/document from Story Studio's develop whole into
  src/kit/document, with its stylesheet rules and dependencies, on Spellbook's
  names.
status: stable
lifecycle: done
id: 01a14dc5-6dcd-72df-91e6-9e9de1d19629
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, document]
parent: feature/workspace-kit
cycle: 2026-10-document-pane
---

# Port Story Studio's document pane into the kit

The fourth workspace-stack cycle ports the kit's document pane
([port shape, §2b](workspace-stack-port-shape/write-up.md#2b-the-cycles), row
4). Read again on 2026-10-17 with `git log` and `git show` only, Story Studio's
`develop` is at `b6d5956`. Ten commits since `027d7a3` touch
`packages/kit/src/document`. Eight are ones we want:

- `0ff5698`: pending edits are sent before a version op;
- `85a319e`: a note's menu shows that it is waiting on the agent;
- `ae08f10`: a chosen note paints its passage;
- `4e6d4d4`: an edit overtaken by the agent's switch is saved where it was
  typed;
- `e82d3ff`: relation names fold to lower case, our own relCase work ported back
  ([kit-links-differential](kit-links-differential.md) asks for it here);
- `bbc54fd`: a profile fix sends `via: "fix"`;
- `3eb5143`: a find-bar test that failed under load made robust;
- `704744a`: Tab indents in the editor.

The other two change only tests. `6b3d943` (copy-in) moves each test's set into
a workspace through `testWorkspace()`. `3d029f0` (plugin host) adds a no-op
`unregisterBundleType` call. So, unlike context, **the module's code comes from
`develop` whole**: 9,020 lines, plus 10,025 lines of tests.

**What it needs that we lack:**

- `testWorkspace` in our test harness: a few lines that make a folder, with none
  of the copy-in model.
- The stylesheet rules Story Studio keeps in `theme/base.css` (about lines
  118–371): `.md-prose`, embeds, the `a[data-rel]` relation chip, the
  `::highlight(...)` note and find marks, and `[data-flash]`. Without them
  notes, find and embeds render unstyled. The scrollbar rules after them belong
  to the shell.
- Dependencies at the root, at Story Studio's lockfile versions. Today the
  CodeMirror packages and `mdast-util-*` are declared only by Scriptorium and
  reach the kit by hoisting. `@codemirror/lang-json` is missing entirely.
- The renamed view-mode key: `story-studio:view-mode` becomes
  `spellbook:view-mode`, matching `spellbook:theme`.

**Out of scope:** the frontmatter references in "Linked from" are
[kit-backlinks-reference-edges](kit-backlinks-reference-edges.md). Putting the
pane in Scriptorium is
[scriptorium-kit-document-centre](scriptorium-kit-document-centre.md).

## Definition of done

- [x] `src/kit/document` is Story Studio's `packages/kit/src/document` at a
      named `develop` sha, on Spellbook's names. Its tests come with it and
      pass.
- [x] Nothing in it refers to Story Studio's copy-in model or plugin host.
      `testWorkspace` only makes a folder.
- [x] The kit's stylesheet carries the document rules, so notes, find marks,
      embeds and relation chips are styled in a kit page. _(Closed by
      [scriptorium-kit-document-centre](scriptorium-kit-document-centre.md),
      `e650fbf2`. The flagged frame's own sheet, `surface/kit/styles.css`,
      imports the shipped sheet and then `document.css`. The built frame sheet
      carries every `::highlight` rule: `doc-note`, `doc-note-focus`,
      `doc-note-pending`, `doc-flash`, `find-match` and `find-current`. In a
      real browser the chosen note's paint and the "Linked from" relation chip
      showed. Find marks and embeds were not driven there. The shipped sheet is
      byte-identical.)_
- [x] Every package the document module imports is declared at the root, at the
      version Story Studio pins.
- [x] The kit's wards pass with the document module in the tree. The chat test's
      HTML-sink census now requires `document/MarkdownView.tsx`.
- [x] The port-back note lists every change we made to Story Studio's code.

## Done and verified

Ported from Story Studio's `develop` at
`b6d595682a7715e8ec60e7b9bfcbe428d9d7c446` (`b6d5956`), whole: 77 files, 9,020
non-test lines (unchanged in the port) and 10,025 test lines (10,015 after the
adaptations below). The verbatim commit is byte-identical to that folder.

Commits on `impl/kit-port-document`:

- `bdcefc74`: the root declares
  `@codemirror/{commands,lang-json,language,search,state,view}`,
  `@lezer/highlight` and `mdast-util-{from-markdown,gfm}`, each pinned at the
  version Story Studio's `bun.lock` resolves at `b6d5956`. One hoisted copy of
  each; Scriptorium's caret ranges take the same ones;
- `b64a8acb`: the verbatim port;
- `691f6f16`: our names (`spellbook:view-mode`), `testWorkspace` (a folder,
  nothing else) and the tests' copy-in wording;
- `2e3b9c9a`: the image-description tests without the `generated` origin our lib
  left out;
- `1b308c60`: prose reworded for the kit prose ward, and the ward's `box-sizing`
  cell;
- `b3a88a9c`: the rendered-markdown rules in `src/kit/theme/document.css`;
- `07a3721c`: the chat test's HTML-sink census in Story Studio's form;
- `ab17c3ef`: the rebuilt dist;
- after the first verification:
  - `383a2b37`: only a page with the document pane carries its utilities;
  - `742583f9`: the flash's keyframes are pinned;
  - `d2fb4966`: every spell's stylesheet is back to the cycle base's.

The document tests pass (445 in 44 files), the kit wards pass, and so does the
gate: exit 0, with 6,462 passing and 0 failing across 428 files.

**The stylesheet is a sheet of its own, not `base.css`.** Every themed spell
imports `base.css`, the shipped Scriptorium among them, and Scriptorium writes
its own `.md-prose` rules. Merged in, Story Studio's rules would change its
rendered view. So `document.css` holds them, verbatim, and a page with the kit's
chat or document pane imports it after `base.css` (`DOCUMENT_CSS_SPECIFIER`).
Nothing imports it yet: the
[document-centre item](scriptorium-kit-document-centre.md) wires it into the
flagged page. It was built through Tailwind in a scratch page, and every rule
was emitted.

**The pane's utilities stay out of other spells' stylesheets.** `base.css` used
to scan all of `src/kit` and exclude a few folders. That put the document pane's
classes into every themed spell's stylesheet, none of them used: bounty +462
lines, digestify +455, grapevine +451, imago +405, mind-mapper +399 and
Scriptorium +236, about a tenth each, plus three theme variables. An exclusion
cannot keep them out, because Tailwind 4.3's `@source not` applies to the whole
build. A `not` in `base.css` also cancelled `document.css`'s own scan of the
folder. So `base.css` now names the kit's shared markup modules (chat, context,
theme, ui, wire). `document.css` scans `src/kit/document` itself. `base.css`
also leaves out `document.css`, whose text alone marked `--color-pointed` as
used in every spell.

Every themed spell's rebuilt stylesheet is now byte-identical to the cycle
base's, Scriptorium's included. `theme.test.ts` holds that every kit module with
markup is scanned by one of the two sheets, and the pane only by `document.css`.
It also holds that the flash's keyframes exist. A new markup module is not
scanned until it is added to `base.css`'s list, and that test fails until it is.

**Our session and the workspace folder.** A set inside the workspace folder is
treated like any other set: it is not an overlap (`overlapOf`), and the tests
that put their set or story there all pass. What differs from Story Studio is
that our workspace folder is not in the context by itself. Two tests opened a
file there without adding it. `DocumentPane.links.test.tsx` is taken from before
copy-in (`6b3d943^`), and `DocumentPane.noteFocus.test.tsx` adds its story
first.

**The shipped Scriptorium is unchanged.** Its CLI help, version,
`open --no-open`, `state`, `add` and `close`, run against the cycle base and
this branch in scratch homes, match apart from run-specific ids and paths. Its
stylesheet is byte-identical to the cycle base's. Its surface bundle changes
only inside CodeMirror's patch versions.

## Port-back notes

- **`DocumentPane.links.test.tsx`** is Story Studio's at `6b3d943^`: the set is
  added where it lives, and the refusal reads "Add its folder … to open it
  here". We have no copy-in.
- **`DocumentPane.noteFocus.test.tsx`** posts `context.add` for the story before
  opening it, because our workspace folder is not in the context by itself.
- **The copy-in comments** in 14 test files no longer say that every file of a
  session lives inside its workspace, or that the workspace is in the context
  from the start. They say that the story or set sits in the session's workspace
  folder.
- **`DocumentPane.bundles.test.tsx`:** the `unregisterBundleType` calls from
  `3d029f0` stay, but the comment "A second registration throws" is gone. Our
  `registerBundleType` replaces the type.
- **`imageDescriptions.test.ts`:** our `lib/sidecar.ts` has no `generated`
  origin. One cell now holds that `generated` is kept as written, with no
  fields. The skeleton cell drops its generated half.
- **`pane.ts`:** `DEFAULT_VIEW_MODE_KEY` is `spellbook:view-mode`. Do not take
  it back as it is.
- **Prose only, for the kit prose ward:**
  - "blur" becomes focus leaving (`DocumentPane.tsx`, `DocumentView.tsx`,
    `DocumentPane.agentSwitch.test.tsx`);
  - "sticky" becomes a note card (`DocumentPane.tsx`);
  - "not-really-an-image" becomes "not really an image"
    (`DocumentPane.embeds.test.tsx`);
  - header comments are added to `pane.test.ts` and `text.test.ts`.
- **The stylesheet:** the rules are in `theme/document.css`, not `base.css`.
  Because of that, `embeds.tsx` and `FindBar.tsx` name that sheet in their
  comments, and `DocumentPane.backlinks.test.tsx` reads the chip rule from it.
  Story Studio keeps them in `base.css`, so none of this goes back.
- **`chat.test.tsx`:** the census is Story Studio's form again, which closes the
  chat port's note.
