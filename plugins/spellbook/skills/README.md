# Spells

Each subfolder here is a **spell** — a self-contained agent surface, shipped as
a Claude Code skill. Zip one folder and it runs anywhere `bun` is on PATH.

⛔ **Self-contained is a property of what SHIPS, not of how it is written.**
Each folder here carries a **committed `dist/`** and, at `scripts/`,
**launchers** — a few lines importing that built artifact. The spell itself is
authored at `src/<spell>/{backend,surface}/` and does share code across spells
(`src/kit/`). So the zip still runs anywhere, but _"no cross-spell imports, no
build step"_ was true of every spell once and is now true of none:
`bun run build` emits both halves, and `dist-check` holds the committed output
honest.

| Spell         | Kind        | What it conjures                                                      |
| ------------- | ----------- | --------------------------------------------------------------------- |
| `digestify`   | cantrip     | A one-shot reading/review surface with inline questions.              |
| `grapevine`   | conjuration | A standing daemon for agent-to-agent channels.                        |
| `bounty`      | conjuration | A live duplex Kanban board (human ↔ agent, real-time).                |
| `magpie`      | conjuration | A surface to extract each asset from a composite image into PNGs.     |
| `glamour`     | conjuration | A style studio — references in, re-castable style spec out.           |
| `imago`       | conjuration | A canvas — create⟷annotate⟷edit images in a conversation.             |
| `astrolabe`   | conjuration | A standing observatory — live state across every project in flight.   |
| `scriptorium` | conjuration | A co-present markdown editor — the human edits, you propose versions. |

**Cantrip** = cast-and-resolve (spawn → user acts → submit → JSON on stdout →
exit). **Conjuration** = summons something with duration (a daemon / board you
return to).

⚠ **There is no structural tell, and do not go looking for one.** This paragraph
used to say _"conjurations ship a `daemon.ts` (or `server.ts`); cantrips don't"_
— and since the backend convergence closed (2026-09-09) **the kind decides none
of the structure**: what ships at `scripts/` is a launcher either way. The kind
is a fact about the spell's LIFECYCLE, and the only place it is recorded is the
table above and the spell's own `SKILL.md`. (`scaffold/README.md` carries the
same correction, for the same reason.)

## Anatomy of a spell

```
<spell>/
  SKILL.md          # trigger conditions, invocation, response shape, exit codes
  scripts/          # LAUNCHERS — each imports a built entry from dist/
    cli.ts          # the agent-facing entry
    server.ts       # conjurations — the standing process (grapevine: daemon.ts)
  dist/             # COMMITTED build output: the real cli/server, surface bundle
  acc.config.json   # where the CLI is held to the conformance kit (not every spell)
  assets/           # only where a surface predates the bundler (three spells)
```

⛔ **`dist/` is committed on purpose** — a consumer installs this folder and
runs it; there is no build step on their side. Source without it ships nothing,
which is what `dist-check` exists to catch. Tests live with the source at
`src/<spell>/`, not here.

## Adding a new spell

Don't hand-roll one. Run the **`inscribe`** authoring ritual
(`.claude/skills/inscribe/`): it names the spell, checks the trigger registry,
copies the `scaffold/`, points you at `grimoire/house-style.md`, and runs the
fresh-agent test loop. Before merging, run **`ward`** — the consistency
checklist that keeps this table in sync with the marketplace manifest and the
trigger registry.
