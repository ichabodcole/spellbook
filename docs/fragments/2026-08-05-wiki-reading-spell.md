# Fragment: A Wiki-Reading Spell

**Date**: 2026-08-05 **Context**: Captured by Cole in Operator
(`fragments/wiki-reading-spell.md`, Spellbook project) and mirrored here.
Companion to
[`2026-08-05-project-roadmap-surface.md`](./2026-08-05-project-roadmap-surface.md),
captured minutes apart and explicitly linked by Cole — see "Relationship to the
roadmap surface" below.

> **Operator is the canonical precursor** (doc
> `ff0490f6-a7dc-45ec-99e9-16aed80eed5f`, v2). Keep in lockstep if it's edited
> there — same convention as the mind-mapper precursor. **Unnamed on purpose:**
> working handle only; the name and kind reserve at coalescence per
> `grimoire/trigger-registry.md`, not here.

## Observation

An interface that reads in a **wiki** — a folder of markdown documents on your
system, probably with an index file. The first move is defining a standard for
what gets imported and read.

You spin up the spell, the agent imports the documents, and you get a navigable
reading surface over that folder.

**What it needs to support:**

- **OKF (Open Knowledge Format) metadata** — a standard Cole has been moving
  toward, built around basic metadata fields describing the document.
- **Linking between documents** — needs a definition of how it works and which
  link types are supported.

**The interface:**

- **Sidebar: file tree** of the imported documents, for navigation.
- **Main viewer: the rendered document** — WikiLink navigation, and probably a
  **graph view**.
- **Reading surface modes** — raw editable markdown, or rendered markdown.
- **Chat sidebar** — conversation with the co-present agent running this via
  terminal. Talk about the documents, have the agent update them. In spell
  terms, the conversation is _about_ this style of documentation: quickly
  loading a context tree and then using it.

It sits somewhere between Obsidian and Operator — but **more ephemeral, which is
what makes it spell-shaped**: load it up, load in the context (a wiki
structure), navigate it.

**MVP:** a quick interface to navigate these document structures — rather than a
folder on your desktop, a nice interface for it. Plus basic editing (undo, redo,
the basics from Operator/Obsidian). Phaseable; the main focus is **a basic
editor + imported file tree + interactive chat bar**.

## The open question Cole flagged — write-back

The backend is just the files on your computer. Load them, see them, navigate
them. But can you **change the organization in the app and apply it to the
folder structure** on disk?

- **Automatic** — restructuring the file tree propagates to the file system.
- **Manual / opt-in** — changes stay in the app; you decide whether to apply
  them, knowing the two are disconnected.

Same question for document contents: automatic updates, or staged for approval?

**Unresolved — this is the load-bearing decision**, since it determines whether
the spell is a reader with an edit affordance or a genuine two-way file manager,
and that changes the risk profile entirely.

## Why the shape interests Cole

No login, no account. An ephemeral interface that brings in context, works
through it, talks about it with an agent, edits it — but **the data is a
separate concern**, not tightly coupled to the interface beyond the standard
itself.

A plain structured markdown folder should import even **without** metadata —
readable as a file structure. But _with_ metadata + WikiLink standardization,
much more powerful things become possible. For files arriving without it,
consider automating the addition — agent work, or straightforward programmatic
automation.

## Why It Might Matter

This is the **third** spell to want "read a folder of structured markdown, make
it navigable, put an agent beside it" — after mind-mapper (ingest → map) and now
the roadmap surface. That repetition is the signal: the substrate may be worth
building once rather than three times. See the boundary question below.

It also lands directly on the house's north-star: a surface as a **shared-state
board** where data lives outside the app and the agent is co-present.

## Relationship to the roadmap surface (flagged, not resolved)

Cole opened the roadmap fragment by naming this one as the tie-in. They share
almost the entire substrate: read structured markdown from disk, file-tree
navigation, frontmatter, no database, ephemeral lifecycle, agent chat alongside.

**The unresolved question: one spell with two lenses, or two spells sharing a
substrate?** The honest read is that they differ mainly in _what the frontmatter
means_ and _what the main view renders_ — a wiki renders a document, a roadmap
renders a plan. Worth deciding deliberately at coalescence rather than
discovering it after both are half-built.

## Trigger for Revisit

- **When the mind-mapper round-loop reaches a natural pause** — it's the active
  build and owns the team's attention; this shouldn't fork it mid-round.
- **If a third "read a markdown folder" spell idea appears** — at that point the
  shared substrate is confirmed and should be designed as one thing.
- **Before either this or the roadmap surface starts a build** — the
  one-spell-or-two question is much cheaper to answer now than later.

## Open questions to carry into an investigation

- What exactly is OKF, and is it stable enough to build a standard on? (Needs
  verification — it's been asserted, not yet checked.)
- What's the import contract — required vs. optional metadata, and what happens
  to a folder that has none?
- WikiLink resolution: how are broken links, ambiguous titles, and links out of
  the imported tree handled?
- Does the graph view overlap enough with mind-mapper's React Flow canvas to
  reuse it?

## Future Considerations (Cole's)

- **Multiple wiki trees at once** — load several, select the focused one. Though
  maybe unnecessary if the interface is light enough to just spin up multiple
  instances of the spell.
- **Drag markdown files in** to add them to the current folder structure.
- **Multiple media types** — images, not just markdown. Not MVP, but worth
  keeping in mind while designing so the media-type decision isn't painted into
  a corner.

## Related Documentation

- Operator precursor: `fragments/wiki-reading-spell.md` (Spellbook project)
- Companion fragment:
  [`2026-08-05-project-roadmap-surface.md`](./2026-08-05-project-roadmap-surface.md)
- Substrate precedent:
  [`2026-06-30-mind-mapper-spell-concept.md`](./2026-06-30-mind-mapper-spell-concept.md)
  and `docs/projects/mind-mapper/`
- Landscape work still owed: the Operator implementation, Obsidian, and other
  markdown editors — Cole explicitly asked for this before settling the
  interface.
