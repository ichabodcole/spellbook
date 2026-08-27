# Astrolabe: scope flags per verb, then enumerate them in rejections

**Added:** 2026-08-27

Adopt the acc guidance astrolabe doesn't yet follow: when the CLI rejects an
unknown flag or verb, the rejection should name the valid set (`choices`) —
just-in-time discovery for an agent caller, at the moment of the mistake. This
is worth doing on its own merits (a better CLI for any agent driving it, acc or
not); a side effect is that the acc recorded-surface census flips from
"observed, diff did not run" to actually comparing declared vs accepted per
path.

Ordering matters: `cli.ts` currently has ONE global `parseArgs` options object
shared by every verb, so naive enumeration would advertise `--phase` on `open`
and similar nonsense. Same defect class magpie already fixed ("scope flags to
their verb"). So:

1. Scope the flag registry per verb (magpie's pattern is the prior art).
2. Emit the verb's valid set as `choices` in the usage envelope `die()` builds,
   and name valid verbs on an unknown-verb rejection.
3. Re-run the step-4 pass (paths + modelled declaration live in the 2026-08-26
   session notes; harness via `acc probe-plan`) and confirm the census compares.

Context: the acc trial session,
`grimoire/fresh-agent/2026-08-26-acc-astrolabe-fresh-run.md` (epilogue), and the
acc-trial grapevine channel (msgs 11–12) — the acc team confirmed comparison is
gated on enumeration everywhere (`declaration.ts`), and adopted "recording buys
observation, not comparison" into their SKILL.md.

## Acceptance Criteria

- [ ] Unknown flag on any verb rejects with exit 2, an envelope naming the
      offending token AND that verb's valid flags (not the global set).
- [ ] Unknown verb rejection names the valid verbs.
- [ ] `acc check --recorded-surfaces … --declaration …` reports paths compared
      (not `NOT COMPARED`) for the recorded verbs.
- [ ] Existing 53 astrolabe tests still pass.

## References

- `plugins/spellbook/skills/astrolabe/scripts/cli.ts` (single global parseArgs
  options object; `die()`)
- acc rule A3 (`choices` SHOULD), guide `how-to-record-surfaces-below-the-root`
