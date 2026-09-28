---
type: item
title: The acc ward cannot see a stale recorded-surfaces batch
description:
  grimoire/acc-conformance.test.ts runs acc check with --recorded-surfaces but
  not --declaration, so a batch that disagrees with the CLI's own schema passes;
  bounty's was two flags stale for a cycle.
status: draft
lifecycle: triage
id: 01a0e71f-2ec2-7145-b25d-cdf9369b4759
kind: bug
generated: { by: claude-opus-5-5, at: 2026-09-28 }
parent: feature/spell-cli-acc-conformance
---

# The acc ward cannot see a stale recorded-surfaces batch

Found 2026-09-28 while re-recording bounty's batch in
[cycle/2026-09-one-act-one-answer](../cycles/2026-09-one-act-one-answer.md).

The ward in `grimoire/acc-conformance.test.ts` passes `--recorded-surfaces` to
`acc check`, but not `--declaration`, so it only checks that the batch was read.
Bounty's batch had been stale since 2026-09-27: `update --clear-notes` was
missing from it, then `init --replace` too. The ward stayed green throughout. A
hand run with `--declaration` (the `schema` verb's output) reported "2
declaration self-contradictions" on the old batch and 0 on the re-recorded one
(`515d0fbc`).

**Fix:** have the ward pass each spell's `schema` output as `--declaration` and
fail when the batch disagrees with it. Then re-record every spell whose batch
turns out stale. Upstream, acc could also warn when a batch's build sha is not
an ancestor of HEAD; add that to the next feedback round.

**Other acc harness friction from the same re-record, for the next upstream
round** (not filed; #55 is the last round):

- `ACC_RECORDED_BY` replaces the whole `<user> via acc probe-plan harness`
  prefix, not just the name. The guide says only "set it to name yourself".
- The harness passes its environment through, so a scratch `HOME` works as
  `HOME=… sh capture.sh`. #55 item 10 asked for an option; what's missing is
  documentation of that.
- The generated capture script hard-codes absolute paths to the target, so it
  can't be committed or shared.
- The output is still not formatter-stable (confirms #55 item 10).
