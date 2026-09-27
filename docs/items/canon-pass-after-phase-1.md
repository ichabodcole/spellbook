---
type: item
title: Bring the canon in line with what phase 1 and the acc cycle shipped
description:
  "Doc pass: record D4 as measured zero, rule D3 as no exemption, cite D52 for
  D5, amend house-style's exit-code rule to the codes spells emit, and amend
  outcome-contract's Boundary 3 to the registry's stderr warning."
status: draft # OKF §5.4: draft | stable | deprecated. Nothing else.
lifecycle: ready
id: 01a0e213-3b98-772c-a21a-87282db40347
kind: chore
generated: { by: claude-opus-5-5, at: 2026-09-27 }
parent: feature/spell-hardening
cycle: 2026-09-filed-is-not-fixed
---

# Bring the canon in line with what phase 1 and the acc cycle shipped

Part of [spell-hardening](../features/spell-hardening/feature.md), sprint 06
phase 2.

The canon edits phase 2's reads found owed
([phase-2 scope](../features/spell-hardening/sprints/06-filed-is-not-fixed/phase-2-scope.md)).
Docs only; no code.

## Definition of done

- [ ] **D4** recorded as measured zero (571 `?.` links, 12 value-position reads
      on nullable names, 0 erase a present-and-null wire field), with the method
      and its limit (name-based population), where D4 lives.
- [ ] **D3**: no `useOptionalChain` exemption; amend `outcome-contract.md`
      Boundary 3's precision block (its cited survivor
      `bounty/scripts/template.html:951` no longer exists; the surface is `.tsx`
      inside biome).
- [ ] **D5**: `outcome-contract.md:292-295` cites D52 (2026-09-09) instead of
      "to be carded".
- [ ] **Row 3**: house-style's exit-code rule (~`:635-639`) states the codes
      spells actually emit and where each is defined (`EXIT_FOR` in
      `src/kit/wire/errors.ts`: 0, 1, 2, 5, 6; session endings 124/130 where a
      spell has them, conjurations without 130), and names the known residue
      (`bounty join` idles out at 0; ends on error at 2). Update its
      decay-ledger row if its text changes.
- [ ] **Boundary 3 / anthill refusal text**: `outcome-contract.md` § "The
      refusal text we owe anthill" amended to the registry's stderr `# warning:`
      line (`dccd2cb7`) as the report for a flag demoted by `--`, replacing the
      `valuesIgnored`-envelope prescription (team ruling 2026-09-27, decision
      log).
- [ ] `bun scripts/pdocs/cli.ts check` and `bun test ./grimoire` green.
