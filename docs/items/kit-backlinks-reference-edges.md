---
type: item
title: Linked from shows frontmatter references, not only body links
description:
  Story Studio's Backlinks view ignores BacklinkView's edges, so the ported pane
  would drop the frontmatter references the wiki layer added; render them and
  offer it back.
status: stable
lifecycle: active
id: 01a14dc5-6e65-725d-911e-4c7631081b09
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, document, links]
parent: feature/workspace-kit
cycle: 2026-10-document-pane
---

# Linked from shows frontmatter references, not only body links

The wiki layer gave our `BacklinkView` `edges` and `edgeCount`
(`src/kit/workspace/protocol.ts`, from
[kit-link-edges-slot](kit-link-edges-slot.md)). That is how Scriptorium's
frontmatter references count as links. Story Studio's `document/Backlinks.tsx`
never reads those fields. Ported as it stands, the pane would show a document's
body links in "Linked from" and silently leave out every document that points at
it only from its frontmatter.

This is a kit change, so it goes back to Story Studio on kit-parity. Their
daemon already sends `edges` wherever an app registers an edge slot.

## Definition of done

- [x] "Linked from" lists a document that refers to this one only in its
      frontmatter, and says that it is a reference, not a body link.
- [x] With no edge slot registered, "Linked from" is unchanged, and a test pins
      both cases.
- [ ] The change is offered to Story Studio on kit-parity.

## Done and verified

Commit `6ddc5b43` on `impl/kit-backlinks-reference-edges`, over Story Studio's
`Backlinks.tsx` as ported in [kit-port-document](kit-port-document.md). Story
Studio's `develop` (`b6d5956`) has no edge handling in `document/` to port.

- `Backlinks` takes an optional `onOpenEdge`. Given it, the daemon's `edges` are
  listed under "Linked from", after the body links, in one group per edge kind.
  The kind is the app's own word, shown as a chip and followed by "references,
  not links in the text". Each entry names its source and folder, and its line
  when the app gave one. Its second line is the key and the target as written
  (`refs[0]: ./part/b.md`). Its accessible name says "a frontmatter reference,
  not a link in its text".
- The heading counts both: "2 links, 1 reference". A document referred to only
  by an edge gets a section headed "1 reference". A cut list says "Showing the
  first N of M references".
- `DocumentPane` passes the opener. It opens the source at its top, because an
  edge carries no offsets.
- Without `onOpenEdge`, the edges are not listed, just as bundles are not
  without `onOpenBundle`. This is a deliberate choice: it keeps the component's
  other callers as they were.
- Tested over a real daemon, in `DocumentPane.references.test.tsx`, with a slot
  that is the test's own (`refs:` entries become `frontmatter` edges), so no
  Scriptorium names are involved. With the slot, a reference is listed and
  opens. With no slot, the answer carries no `edges`, the section is body links
  only, and a document referred to only from frontmatter shows nothing. With the
  slot registered but no edge landing, the markup is byte-identical to the
  no-slot markup.
- A one-off check, not kept, rendered the original component and the new one on
  the same data: no edges, `edges: []`, cut, and empty. With React's ids
  normalised, the markup was identical in all 16 comparisons.

The kit-parity offer is the lead's to make, so its box stays unticked.

## Port-back notes

- `document/Backlinks.tsx`:
  - imports `EdgeBacklinkView`;
  - adds `groupEdges`, `edgeLine`, an `EdgeEntry` component and `countText`;
  - adds the optional `onOpenEdge` prop;
  - the "Linked from" block shows when `count > 0` or there are edges;
  - the heading's count comes from `countText`, which reads exactly as before
    when there are no edges;
  - the "Showing the first N" note for links now also needs
    `backlinks.length < count`, because `truncated` is also set when only the
    edges were cut. Without edges the two conditions are the same;
  - a second note covers cut references.
- `document/DocumentPane.tsx` passes `onOpenEdge`, which opens `e.source`
  through `openAt`, or through `open` when there is no `openAt`.
- New test `document/DocumentPane.references.test.tsx`. It needs the daemon's
  `links` option (kit-link-edges-slot), which Story Studio's daemon already has.
