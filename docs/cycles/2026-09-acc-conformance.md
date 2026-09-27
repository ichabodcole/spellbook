---
type: cycle
title: Spell CLI acc conformance
description:
  Take all nine spell CLIs through the full acc guidance, with a gate that holds
  it.
tags: [acc, conformance]
status: draft
lifecycle: active
started: 2026-09-26
appetite:
  Stop when all nine CLIs are L0 conformant with steps 4-6 done and the gate
  holds it; a spell whose step 6 needs a rewrite beyond the guidance is cut,
  with its debt recorded, rather than stretched.
after: []
generated: { by: claude-opus-5-5, at: 2026-09-26 }
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

_Written at close, not before._

## Sessions
