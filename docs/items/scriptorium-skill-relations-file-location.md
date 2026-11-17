---
type: item
title: Scriptorium's SKILL says where the relations file goes
description:
  Scriptorium reads its relation vocabulary from the kit's
  _meta/profiles/_relations.json inside a set, by default rather than by choice,
  and SKILL.md never says so.
status: draft
lifecycle: dropped
id: 01a1eac9-91a5-7685-8da4-7fdb66e66a46
kind: task
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [scriptorium, links, docs]
parent: feature/workspace-kit-follow-ups
---

# Scriptorium's SKILL says where the relations file goes

Found while checking GitHub #141 (closed 2026-11-17). The relation vocabulary
works in Scriptorium, but where its file lives was decided by default, not on
purpose. Scriptorium reads the kit's `_meta/profiles/_relations.json` inside a
set, where #141 proposed a `_relations.json` at the set's root. SKILL.md lists
`relations.*` among the doctor's finding kinds (around line 257), but never says
where the file goes, so neither an agent nor a human can make one without
reading the code.

## Definition of done

- [ ] Cole rules the location: keep the kit's `_meta/profiles/_relations.json`,
      or move it to the set's root.
- [ ] Scriptorium's SKILL.md says where the file goes and what its keys are,
      with a short example.
- [ ] The `relations` verb's help, or the doctor's finding when the file is
      missing or bad, names the path.

Dropped at triage, 2026-11-17: folded into
[scriptorium-session-vocabularies](scriptorium-session-vocabularies/item.md),
which decides where profiles and the relation vocabulary live; the SKILL text
follows from that call.
