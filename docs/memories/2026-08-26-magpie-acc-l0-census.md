# magpie reached acc L0, and the census found 289 defects L0 could not see

**Date:** 2026-08-26

magpie went from `NOT CONFORMANT (L0)` (3 core violated) to conformant via
`--version`, a bare invocation that is a usage error, and a JSON error envelope
with acc's exit-code taxonomy. The finding that mattered came from acc's
**census**, not its checker: a hand-built recorded-surface batch over 17 command
paths measured **289 accepted-not-declared flag/path pairs** — one global flag
registry meant every verb accepted every other verb's flags at exit 0. Replaced
with `VERB_SPEC`, one table driving the verb set, each verb's parser options and
each rejection's `choices`; the census went to 0 with a control run in between
proving the number was a property of magpie rather than of how it was read.

**The transferable shape:** help was right, the parser was right, and _nothing
bound them_ — a 289-pair defect cost two sentences of documentation. Fix by
deriving both from one table, never by syncing two lists. Same shape as the
bounty surface mirror.

**Two process lessons.** `bun test` from a skill directory is not the repo's
gate — both grimoire ward failures this branch introduced were invisible to it,
so run `ward` before merging a spell. And an independent review caught three
defects the wards could not: `sessions` printed prose while the tool declared
`defaultOutput: "json"`, the dispatch switch lost its `default:` arm (falling
through to `return 0` — success for work never done), and the failure contract
had no test.

**Key files:** `plugins/spellbook/skills/magpie/scripts/cli.ts`,
`plugins/spellbook/skills/magpie/acc.config.json`,
`plugins/spellbook/skills/magpie/tests/cli.test.ts`,
`grimoire/flag-invariant.test.ts`, `grimoire/exit-site-inventory.test.ts`

**Docs:**
[Session](../projects/spell-hardening/sessions/2026-08-26-magpie-acc-l0-and-the-census.md)
·
[the grapevine session before it](../projects/spell-hardening/sessions/2026-08-24-standard-grapevine-acc-session.md)
