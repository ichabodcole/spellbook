---
type: cycle
title: Spell CLI acc conformance
description:
  Take all nine spell CLIs through the full acc guidance, with a gate that holds
  it.
tags: [acc, conformance]
status: draft
lifecycle: closed
started: 2026-09-26
appetite:
  Stop when all nine CLIs are L0 conformant with steps 4-6 done and the gate
  holds it; a spell whose step 6 needs a rewrite beyond the guidance is cut,
  with its debt recorded, rather than stretched.
after: []
generated: { by: claude-opus-5-5, at: 2026-09-26 }
closed: 2026-09-26
---

# Spell CLI acc conformance

The cycle for
[feature/spell-cli-acc-conformance](../features/spell-cli-acc-conformance/feature.md).
Decisions made while Cole was away are logged, with the options not taken, in
the feature's
[decision log](../features/spell-cli-acc-conformance/decision-log.md).

## Why now

Cole ruled it on 2026-09-26: acc is the house CLI standard, and only six of nine
spell CLIs pass even L0, none has been taken through all seven steps, and
nothing gates it. The spell-hardening audit the same day found bounty's `--`
terminator defect (`c1`) still writing to the wrong board at exit 0, which acc's
A6 check catches on its own.

## Scope

- **[item/shared-cli-registry-in-the-kit](../items/shared-cli-registry-in-the-kit/item.md)**
  first: its answer decides how every spell does step 6.
- **[item/acc-conformance-gate](../items/acc-conformance-gate.md)** early, with
  current failures as recorded debt, so later items burn the debt down.
- **L0 first:** [bounty](../items/acc-conformance-bounty.md),
  [imago](../items/acc-conformance-imago.md),
  [digestify](../items/acc-conformance-digestify.md); with
  [item/terminator-eats-session-key](../items/terminator-eats-session-key.md)
  (`c1`, moved from spell-hardening's cycle) landing with bounty's A6 fix.
- **Then steps 4–6** for the rest:
  [astrolabe](../items/acc-conformance-astrolabe.md),
  [glamour](../items/acc-conformance-glamour.md),
  [grapevine](../items/acc-conformance-grapevine.md),
  [magpie](../items/acc-conformance-magpie.md),
  [mind-mapper](../items/acc-conformance-mind-mapper.md),
  [scriptorium](../items/acc-conformance-scriptorium.md).

Out of scope, deliberately: spell daemons and HTTP routes; the rest of
spell-hardening's fix queue (bounty `update`, #98, `astrolabe close`), which is
product behaviour, not the CLI contract.

## Outcome

**Shipped.** All nine spell CLIs are L0 conformant on acc v0.1.15 with no
`knownFailures` debt, their root rejections enumerate their flag set, every verb
path is recorded and read by the census with 0 disagreements, and every CLI has
a `schema` verb generated from the one table its parser walks: the new kit
module `src/kit/cli/registry.ts`, which all nine now run on. Two wards hold it:
the acc gate (`grimoire/acc-conformance.test.ts`, which also fails on stale
debt) and a golden snapshot of every CLI's accepted and rejected invocations
(`grimoire/cli-golden.test.ts`). Verified by the lead independently of the
implementers: `acc check` on all nine, and the full gate (green, 2956+ tests).

**Cut, with reasons.** bounty's step 4a (JSON by default) was declined because
anthill silently parses `bounty sessions` prose; it is filed to switch in
lockstep. Required flags in the registry, and `<verb> --help`, were left out;
the first is filed. `c1` went back to spell-hardening: acc fixed its root-level
half, and the rest is product behaviour. The step-7 upstream report is drafted
and waits for Cole to file it.

**Learned.** A no-stake cold read before ratifying the registry found every gap
that would otherwise have failed an adopter mid-wave. Parallel adopters in
worktrees are fast but collide on shared ward pins; the lead reconciling them by
hand, with the full gate after each wave, kept that tractable. Bun strips a
leading `--` after the script path, and Tailwind scans prose in `src/kit/`: both
were silent until a run looked closely. Decisions and the options not taken are
in the feature's
[decision log](../features/spell-cli-acc-conformance/decision-log.md).

## Sessions

- feature/acc-conformance (landed 2026-09-26)
