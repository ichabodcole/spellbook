# Grapevine: standalone `grapevine` CLI for humans (companion-app pattern)

**Added:** 2026-06-28 **Origin:** extracted from the grapevine-backlog living
doc (now archived); post-V1.6.x retrospective on agent-vs-human ergonomics.
**Scope:** proposal-sized — packaging/runtime/source-of-truth decisions warrant
a project folder; likely tied to any toolbox-migration spinout.

Ship a standalone `grapevine` CLI installable on PATH (`npm i -g` / `brew`) that
wraps the same daemon and `~/.grapevine/` data the skill uses — same primitives,
ergonomics tuned for a human at a terminal. Today every invocation is
`bun ${CLAUDE_PLUGIN_ROOT}/skills/grapevine/scripts/cli.ts <verb>`, fine for
agents (the skill supplies the path) but awkward for a human running
`grapevine doctor` / `grapevine list` between sessions. The watch HTML is the
visual human surface; a PATH CLI would be the text human surface.

Initial verb set: operator/admin (`doctor`, `version`, `info`, `list`, `who`,
`stop`, `watch`).

**Open questions (why it's proposal-sized):** implementation source-of-truth
(publish `cli.ts` as a library + thin wrapper, vs parallel maintenance — former
preferred, avoids drift); Bun runtime requirement for a `brew` user; daemon
lifecycle / cache-pinning; verb parity (operator-only vs full).

**Suite-wide pattern:** the same human-CLI shape may apply to bounty, digestify,
magpie — worth considering as a suite pattern, not a one-off.

## References

- `plugins/spellbook/skills/grapevine/scripts/cli.ts` — would become the library
  the standalone CLI wraps.
