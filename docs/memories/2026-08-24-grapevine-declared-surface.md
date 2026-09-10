# grapevine declares its own surface (acc-standard working session)

**Date:** 2026-08-24

grapevine's CLI gained a `schema` verb emitting its interface as acc declaration
format v0, generated from a new COMMANDS registry that also drives dispatch,
per-verb flag parsing (identity pair `--as`/`--from` stays global by SKILL.md
contract), root flag routing, bare-invocation-as-usage-error, and arity
enforcement. acc verdict moved from 3 core violations to CONFORMANT (L0); the
session also fixed two defects in acc's instrument, caught pre-existing help
drift (`announce` was never listed), and produced the first outside evidence for
acc's drift-check thesis (four one-place breaks: three caught, negative control
honestly missed).

**Key files:** `plugins/spellbook/skills/grapevine/scripts/cli.ts` (COMMANDS
registry + `buildDeclaration`), `cli.test.ts` ("declared surface" block),
`docs/investigations/2026-08-24-grapevine-drift-experiment/`,
`docs/backlog/2026-08-24-bounty-conformance-gaps-and-latent-flag-drift.md`

**Docs:**
`docs/projects/spell-hardening/sessions/2026-08-24-standard-grapevine-acc-session.md`;
acc's own report:
`~/Projects/agent-cli-conformance/docs/reports/2026-08-24-first-outside-application-grapevine.md`
