# glamour CLI: acc L0, then per-verb sets + census, then one table drives everything

**Date:** 2026-09-03

Against acc v0.1.11 (pin bumped from v0.1.7 once Cole reported the kit release
landed), glamour's `cli.ts` went NOT CONFORMANT → CONFORMANT (L0): one JSON
error envelope on stderr, taxonomy usage 2 / internal 1 / not_found 5 / conflict
6, `--version` as a root token, bare invocation and unknown verb as usage errors
naming the roster. Same day: per-verb flag sets and the recorded-surface census
(first run 450 disagreements, one cause — the unknown-flag rejection named the
registry, not the verb's set; fixed, 18/19 then 20/20 paths, 0 disagreements),
then the `switch` replaced by a `COMMANDS` table that drives dispatch, help,
rejections and an emitted `schema` declaration. Solo implementation with a
no-stake verify subagent, not a convened team. Branch `feat/glamour-acc-l0`;
named merge per policy.

**Key files:** `plugins/spellbook/skills/glamour/scripts/cli.ts`,
`plugins/spellbook/skills/glamour/tests/cli-contract.test.ts`,
`plugins/spellbook/skills/glamour/acc.config.json`,
`grimoire/{exit-site-inventory,flag-invariant}.test.ts`

**Docs:** `docs/projects/glamour-acc-l0/sessions/2026-09-03-glamour-acc-l0.md`
(charter: `docs/projects/glamour-acc-l0/proposal.md`); kit feedback filed as
`ichabodcole/agent-cli-conformance#37`
