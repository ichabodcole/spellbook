---
type: item
title: Should the kit own a shared CLI registry?
description:
  Decide whether src/kit should provide one command-registry module that drives
  parsing, help, rejections and the schema verb, instead of six spells
  hand-copying grapevine's pattern.
status: draft
lifecycle: done
id: 01a0e03d-fc41-75f2-8096-9a86bd1ff0c8
kind: research
generated: { by: claude-opus-5-5, at: 2026-09-26 }
parent: feature/spell-cli-acc-conformance
cycle: 2026-09-acc-conformance
---

# Should the kit own a shared CLI registry?

Part of
[Spell CLI acc conformance](../../features/spell-cli-acc-conformance/feature.md).

Step 6 of the acc guidance is one table driving parser, help, rejections and the
published interface. glamour, grapevine and scriptorium each built that
themselves; six spells have not. Every spell also calls `parseArgs` on its own,
which is why bounty and imago carry the same five L0 failures as two separate
bugs. The question is whether the next six copies should be one module in
`src/kit/`.

**The decision it feeds:** whether the step-6 part of each per-spell item builds
on a kit module or copies the grapevine pattern.

## What a good answer settles

- How far apart the three existing registries are (grapevine's `COMMANDS`,
  glamour's, scriptorium's): a shared shape, or three different ones.
- Whether a kit module can carry the per-verb flags, the `--` terminator rule
  (A6), usage-on-stderr for a bare invocation (C2/D2), `--version` (D1) and the
  acc declaration emitter without forcing any spell's surface to change.
- The cost of moving the three existing spells onto it vs leaving them.
- A recommendation, with the one it rejected and why.

## Definition of done

- [x] A write-up in this item's folder answers the four points above, with
      file:line evidence from the three registries.
- [x] Its recommendation is recorded on the feature, and the per-spell items'
      step 6 points at it.
