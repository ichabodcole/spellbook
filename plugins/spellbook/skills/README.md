# Spells

Each subfolder here is a **spell** — a self-contained agent surface, shipped as
a Claude Code skill. Zip one folder and it runs anywhere `bun` is on PATH; no
cross-spell imports, no build step.

| Spell       | Kind        | What it conjures                                          |
| ----------- | ----------- | --------------------------------------------------------- |
| `digestify` | cantrip     | A one-shot reading/review surface with inline questions.  |
| `grapevine` | conjuration | A standing daemon for agent-to-agent channels.            |
| `bounty`    | conjuration | A live duplex Kanban board (human ↔ agent, real-time).    |
| `magpie`    | conjuration | An image surface — drop an image, the agent orchestrates. |

**Cantrip** = cast-and-resolve (spawn → user acts → submit → JSON on stdout →
exit). **Conjuration** = summons something with duration (a daemon / board you
return to). The structural tell: conjurations ship a `daemon.ts` (or
`server.ts`); cantrips don't.

## Anatomy of a spell

```
<spell>/
  SKILL.md          # trigger conditions, invocation, response shape, exit codes
  scripts/
    cli.ts          # the agent-facing entry
    daemon.ts        # conjurations only — the standing process
    *.test.ts       # bun test: pure-function + subprocess integration
  assets/           # index.html, client js, css (self-contained, CDN libs only)
```

## Adding a new spell

Don't hand-roll one. Run the **`inscribe`** authoring ritual
(`.claude/skills/inscribe/`): it names the spell, checks the trigger registry,
copies the `scaffold/`, points you at `grimoire/house-style.md`, and runs the
fresh-agent test loop.

> **Migration note:** the four spells above currently live in
> `project-docs/plugins/toolbox/skills/`. They land here during the Spellbook
> extraction — see `docs/projects/spellbook-extraction/proposal.md`.
