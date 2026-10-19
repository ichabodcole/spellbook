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

- [ ] Each of the five inputs is a test on both paths, and the file changes only
      in the named key.
- [ ] The fix is in the shared helper, so the shipped and kit paths stay
      byte-identical to each other.
