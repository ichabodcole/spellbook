---
type: item
title: Can a frontmatter chip be changed from the rendered view?
description:
  Whether Scriptorium can let the human click a frontmatter chip, such as an
  item's status or lifecycle, and pick another allowed value from a list, with
  the values taken from the document's profile, and what is still missing to
  build it.
status: stable
lifecycle: ready
id: 01a1ead1-9cb0-77d3-9ecf-69af7d39c92c
kind: research
generated: { by: claude-opus-5-5, at: 2026-11-17 }
tags: [scriptorium, kit, frontmatter, profiles]
parent: feature/workspace-kit-follow-ups
cycle: 2026-11-research-and-safety
---

# Can a frontmatter chip be changed from the rendered view?

When Cole reviews a batch of documents in Scriptorium, such as work items, he
reads each one in the rendered view. Its frontmatter shows as chips: `type`,
`status`, `lifecycle` and the rest. Changing a value today means one of two
things:

- switching to the raw view and editing the YAML by hand;
- asking the agent to do it.

Both break the flow of a review. What he wants is to click the chip (say
`draft`) and pick another allowed value from a dropdown.

The allowed values have to come from somewhere. The kit's document profiles
(`_meta/profiles/<kind>.json`, JSON Schema with `enum`s) look like the source.

**The question:** is there enough in the kit today to build this, or does it
need more design first? If it needs design, what exactly? The answer decides
between filing build items now and doing more research first.

## Definition of done

- [ ] The write-up says what exists today: the chip header, profiles and their
      enums, the write path for a frontmatter change. Each point cites its file.
- [ ] It takes the allowed values from the profile the daemon has already
      resolved for a document, not from a particular folder. Where profiles come
      from is decided in
      [scriptorium-session-vocabularies](../scriptorium-session-vocabularies/item.md).
      Any build items it files are blocked by that item.
- [ ] It answers how a chip change is written and what checks it. The answer
      fits Scriptorium's version and save model, lets the agent see the change,
      and keeps rules such as `pdocs set`'s transition checks.
- [ ] It ends with a call. Either build now, with the items to file, or more
      design first, with the open decisions listed for Cole.
