---
type: item
title: The kit path no longer shows .mdx documents
description:
  The kit's document kinds leave out .mdx, so meta, find and the tree on
  Scriptorium's kit path drop .mdx files the shipped app shows; decide whether
  the kit counts them.
status: stable
lifecycle: done
id: 01a1486e-3b17-70ac-bb92-06ee1694742a
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-16 }
tags: [kit, scriptorium]
parent: feature/workspace-kit
cycle: 2026-10-shell
---

# The kit path no longer shows .mdx documents

Found by the wiki-verbs verifier (2026-10-17). The kit's document kinds include
`.json` and leave out `.mdx`, so on Scriptorium's kit path `.mdx` files vanish
from the tree, `meta` and `find`, where the shipped app shows them.

**Ruling (Cole, 2026-10-19, shell cycle):** yes, at the level the shipped
Scriptorium has always had. An `.mdx` file is a text document: it appears in the
tree, `meta` and `find`, and opens, edits, versions, compares and takes notes,
and its rendered view is plain markdown. MDX's own capabilities, `import` and
`export` lines and JSX components, are not compiled or run. That would mean
running a document's code in the page, and it would be an item of its own.

## Definition of done

- [x] A ruling on whether the kit counts `.mdx` as a document, recorded here.
- [x] If yes, `.mdx` documents appear on the kit path, with a test.

## Done and verified

On `impl/kit-tree-docs` (2026-10-19), one commit: "Kit: an app may add document
kinds; Scriptorium's kit path admits .mdx".

**An app-declared kind, not the generic list.** The kit grew a small registry
beside `registerBundleType`: `registerDocExtension(ext, format = "markdown")` in
`src/kit/lib/docFormat.ts`, with `docExtensions()` as the whole list. Putting
`.mdx` in `DOC_EXTENSIONS` would have given it to every Story Studio app too;
the registry costs about 30 lines and keeps the kit's own list as it was. A kit
kind or an image's extension is refused, so an app cannot redefine one.
Scriptorium registers `.mdx` in `src/scriptorium/backend/kit/docKinds.ts`,
imported by the kit-path daemon (`server.ts`), CLI (`cli.ts`) and surface
(`Frame.tsx`). Not by `app.ts`, which the shipped entries load for the flag.

**Every place the kit decides "is this a document"** now asks `isDocName` or
`docExtensions()`: the tree scan, `listedFile`, `listDir`, `add` and `meta`'s
CLI checks, `openPath`'s version extension (an `.mdx`'s versions are `v<n>.mdx`,
as the shipped app writes them), the drop or import refusal, `landingName` in
the link layer, and `linkScheme` (its `DOC_NAME` regex is gone, so
`Chapter2:intro.mdx` reads as a path). `docFormat` says `markdown` for `.mdx`,
so the document pane, links, search and the map treat it as markdown. Embeds go
through the same markdown path. Nothing compiles MDX: the kit's renderer
(micromark, no `allowDangerousHtml`) writes raw HTML and JSX as text.

**Verified:**

- `src/kit/lib/docFormat.test.ts` covers the registry, the refusals and the tree
  scan. `links.check.test.ts` covers `linkScheme` before and after registration.
- `src/scriptorium/backend/kit/mdx.integration.test.ts` drives the real launcher
  with `SCRIPTORIUM_KIT=1` and checks the tree, `meta`, `find`, `search`,
  `link-check`, `backlinks`, `version-new` (`.mdx` version file) and `diff`. A
  `.tsx` beside it stays out.
- In Chrome, on a scratch home, the flagged Scriptorium had an `.mdx` holding
  `import`, `export`, `<Chart …/>`, a `<script>` and an `<img onerror>`. It
  showed in the tree, opened raw, and rendered as markdown (H1, bold, the
  `guide` chip, "Linked from index"). The JSX and HTML showed as text: no
  `script`, `img` or `chart` element, the `onerror` flag never set, no console
  errors. A note on its `<Chart …/>` line was taken through the CLI.
- After the verifier's review: the fallback title (no frontmatter title, no
  heading) dropped only `.md`, `.markdown` and `.txt`, so a bare `bare.mdx` was
  titled `bare.mdx` where the shipped app says `bare`. Six places took that
  regex: three in `session.ts` (`linkCheck`, `linkGraph`, `summariesOf`), two in
  `Backlinks.tsx`, one in `ChatMessageView.tsx`. They now all ask
  `withoutDocExtension` in `docFormat.ts`, which knows the app's markdown kinds.
  A second grep of `src/kit` for hard-coded document-extension lists found no
  more. Tests: a `docFormat.test.ts` cell, a graph-title cell in
  `mdx.integration.test.ts` (red with `linkGraph` put back on the regex), and a
  `landingName` cell in `links.check.test.ts`, which goes red when `landingName`
  is put back on the kit's own list (the verifier's survivor M10).

## Port-back notes

- `lib/docFormat.ts`: new `registerDocExtension`, `unregisterDocExtension`,
  `docExtensions()` and, for tests, `withKitDocKindsOnly(fn)`. `isDocName` and
  `docFormat` read the registry too. The registry is per process, so in a
  whole-suite run a test that holds the kit's own list must not assume no other
  file loaded an app's registration; `tree.test.ts`'s "`.mdx` is not admitted"
  assertion now runs inside `withKitDocKindsOnly`. `DOC_EXTENSIONS` is
  unchanged, and now means the kit's own kinds only.
- `lib/linkTarget.ts`: `DOC_NAME` removed. `linkScheme` asks `isDocName`. The
  `links.check.test.ts` test that held the regex equal to the list now checks
  `linkScheme` with and without a registered kind.
- `workspace/{tree,verbs,links,session}.ts`: each `DOC_EXTENSIONS` used as "the
  admitted kinds" (refusal choices, `landingName`, a version's extension) is now
  `docExtensions()`. `context/model.ts` and `workspace/index.ts` re-export
  `docExtensions`.
- `lib/docFormat.ts`: new `withoutDocExtension(name)`. The
  `/\.(md|markdown|txt)$/i` title fallback in `session.ts` (three places),
  `document/Backlinks.tsx` (two) and `chat/ChatMessageView.tsx` (one) now calls
  it.
- Story Studio needs no change in behaviour: with nothing registered, every
  answer is the same as before.
