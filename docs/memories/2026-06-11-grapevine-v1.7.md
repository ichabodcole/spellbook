# Grapevine V1.7 — human as a first-class participant

**Date:** 2026-06-11

Shipped grapevine V1.7: the human is now a real participant from the browser
watch surface — named identity (per-HOME `alias` config + `GET /identity`), a
human marker (`who.humans`, `tail --human`), join/lurk (default-lurk, persisted
per-channel, truly-invisible), in-browser compose, threading (`in_reply_to`),
and archive/unarchive. The watch surface was first ported vanilla→Alpine (no
build, CDN+SRI). Validated by a live human+agent soak (two emergent bugs caught

- fixed), ward, a cold fresh-agent test, and a finalize-branch dual review.
  `bun test` 130 pass.

**Key files:**
`plugins/spellbook/skills/grapevine/scripts/{daemon.ts,cli.ts,watch.html,cli.test.ts}`,
`plugins/spellbook/skills/grapevine/SKILL.md`

**Docs:** `docs/projects/grapevine-v1.7/` (proposal, soak-findings, sessions/);
`grimoire/scenarios/2026-06-11-default-to-the-passive-state.md`;
`grimoire/fresh-agent/2026-06-11-grapevine-v1.7-findings.md`
