---
type: item
title: Port Story Studio's document pane into the kit
description:
  Port packages/kit/src/document from Story Studio's develop whole into
  src/kit/document, with its stylesheet rules and dependencies, on Spellbook's
  names.
status: stable
lifecycle: triage
id: 01a14dc5-6dcd-72df-91e6-9e9de1d19629
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, story-studio, document]
parent: feature/workspace-kit
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

- [ ] `src/kit/document` is Story Studio's `packages/kit/src/document` at a
      named `develop` sha, on Spellbook's names. Its tests come with it and
      pass.
- [ ] Nothing in it refers to Story Studio's copy-in model or plugin host.
      `testWorkspace` only makes a folder.
- [ ] The kit's stylesheet carries the document rules, so notes, find marks,
      embeds and relation chips are styled in a kit page.
- [ ] Every package the document module imports is declared at the root, at the
      version Story Studio pins.
- [ ] The kit's wards pass with the document module in the tree. The chat test's
      HTML-sink census now requires `document/MarkdownView.tsx`.
- [ ] The port-back note lists every change we made to Story Studio's code.
