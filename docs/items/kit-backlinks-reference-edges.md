---
type: item
title: Linked from shows frontmatter references, not only body links
description:
  Story Studio's Backlinks view ignores BacklinkView's edges, so the ported pane
  would drop the frontmatter references the wiki layer added; render them and
  offer it back.
status: draft
lifecycle: triage
id: 01a14dc5-6e65-725d-911e-4c7631081b09
kind: task
generated: { by: claude-opus-5-5, at: 2026-10-17 }
tags: [kit, document, links]
parent: feature/workspace-kit
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

- [ ] "Linked from" lists a document that refers to this one only in its
      frontmatter, and says that it is a reference, not a body link.
- [ ] With no edge slot registered, "Linked from" is unchanged, and a test pins
      both cases.
- [ ] The change is offered to Story Studio on kit-parity.
