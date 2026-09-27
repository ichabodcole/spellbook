---
type: item
title:
  The -- terminator eats --session-key; the write lands on the ambient board
description:
  A real flag after -- is swallowed as a positional (row 2's demotion half), so
  a bounty write lands on the ambient board at exit 0.
status: draft
lifecycle: done
id: 01a0dea2-8c12-7351-b60a-057892e894b3
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-26 }
cycle: 2026-09-filed-is-not-fixed
parent: feature/spell-hardening
from: features/spell-hardening/sprints/05-the-gate/carries.md
---

# The `--` terminator eats `--session-key`; the write lands on the ambient board

Carried from sprint 05 as card `c1` (`t-2df67738`, owner at teardown:
`daedalus`). When `--session-key` comes after a `--` terminator, parsing
swallows it as a positional instead of treating it as a flag. The bounty write
then lands on the ambient board, at exit 0, with nothing saying the key was
ignored.

This is row 2's **demotion** half: a real flag silently demoted to a positional.
Sprint 05's `terminator-invariant` solved only **promotion** (free text read as
a flag name), so a reader of sprint 05's deliverables would think row 2 is
closed. It is not.

The denominator is already measured: **16 entry points across 8 spells** set
`strict:`/`allowPositionals:` (re-measured at sprint 05's finalize; the card
first recorded 15). Reuse `grimoire/flag-invariant.test.ts`'s by-behaviour
enumeration and `grimoire/lib/entry-points.ts`. Do not re-derive the population.

## After the acc cycle (2026-09-26)

Moved back to spell-hardening from the acc-conformance cycle. What acc fixed,
and what it cannot:

- **Fixed:** on all nine spells a flag after `--` is now always a positional,
  never parsed as a flag (acc A6, the POSIX meaning of `--`). The root-level
  hazard is gone.
- **Not fixed, and not a CLI-contract defect:**
  `bounty add -- text --session-key K` still writes a card titled with the flag,
  on the ambient board, at exit 0. The caller asked for positionals and got
  them. This item's definition of done ("never silently a positional")
  contradicts `--` itself.
- **Proposal** (decision log #21 in the acc feature): keep A6, and add a
  `warning` to the envelope when a post-`--` positional spells a flag the verb
  accepts. That is product behaviour, for the spell-hardening pass.

## Fixed (2026-09-27)

Per the sprint 06 ruling (plan decision log, 2026-09-27, `c1` demotion): the kit
registry (`src/kit/cli/registry.ts`, `warnDemoted`) now **warns** where it used
to be silent. When a token after `--` spells a flag that row accepts — `--flag`,
`--flag=value`, a short alias, or a global flag the row takes — the row still
runs with it as text, and stderr carries ONE line:

```
$ bounty add -- hello --session-key K1
{"ok":true,"added":"t-5a2862ca","valuesIgnored":null}                     (stdout, exit 0: unchanged)
# warning: bounty add: --session-key after `--` was read as text, not as a flag; to use it as a flag, move it before `--`
```

- **Not refused**, on purpose: writing text that contains a flag name is what
  `--` is for. Stdout and the exit code are unchanged. A token the row does not
  accept (`--nope`, another verb's flag) is just text and says nothing.
- **One fix, every spell**: all nine CLIs run on the registry, so the 43
  variadic rows and the 6 one-optional-positional rows
  (`grapevine who -- --all`) are covered by the same check over post-`--`
  tokens.
- **Format**: the house's success-path stderr form, a `# `-prefixed line
  (`# warning:` as mind-mapper already mirrors its daemon warnings). An envelope
  reader looks for a `{` line and skips it. Emitted only after every registry
  refusal passes, so a registry-refused call's stderr is still exactly one
  envelope; a verb that warns and then fails in its own `run`
  (`grapevine send ch -- hi --as k` with no identity) prints the warning line
  above its envelope — there the warning is the recovery.
- **Pinned by**: `src/kit/cli/registry.test.ts` ("a flag demoted by `--` is
  warned about"), the bounty c1 test in `src/bounty/backend/server.test.ts`, and
  the CLI golden, whose records now carry `warned: true` (bounty, grapevine and
  one case in each other spell with a variadic verb).
- **SKILL.md**: the "`--` ends flag parsing" blocks that said "consumed silently
  … with no warning" (astrolabe, bounty, glamour, grapevine, imago, magpie) now
  describe the warning.

Not addressed here: the root-level `--` (Bun strips it before the registry sees
it), and the ward over the enumerated entry points in the definition of done
below.

## Definition of done

- [ ] A flag after `--` is either honoured or refused with a named reason, on
      every one of the 16 entry points. It is never silently taken as a
      positional.
- [ ] A ward asserts the demotion half over the enumerated entry points, with a
      zero-denominator guard.

Per spell, as each moves onto the kit CLI registry (the lead closes this item
after all spells move):

- [x] **bounty** (2026-09-26). At the root, `bounty -- --x` is
      `unknown command "--x"`, never an option (acc A6 passes). Inside a verb, a
      flag after `--` is a positional by design. `update t1 -- --session-key K`
      is now **refused** by the arity check with the token named (exit 2), where
      it used to be dropped silently. `add -- text --session-key K` still takes
      the flag as **title text** at exit 0, on the ambient board. That meets A6,
      but not this item's "never silently taken as a positional" for variadic
      verbs (`add`, `message`). Pinned by the golden fixture and by a test in
      `src/bounty/backend/server.test.ts`.

## Related Documents

- [Sprint 05 → 06 carries: the `c1` card and its denominator](../features/spell-hardening/sprints/05-the-gate/carries.md)
- [Sprint 06 plan, design call 2](../features/spell-hardening/sprints/06-filed-is-not-fixed/plan.md)
