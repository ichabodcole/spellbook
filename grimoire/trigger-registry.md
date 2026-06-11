# Trigger Registry

> _"To name a thing is to be able to summon it, so naming is not cosmetic, it's
> the mechanic. A clumsy name is a fumbled cast."_ — the manifesto

The registry of reserved spell **names**. A name is the canonical identifier for
a spell — a single distinctive token. It is **not** the only way to invoke the
spell, and reserving it here is not a claim that invocation = this one word.

**Name vs. how it's triggered.** Two different things, kept separate on purpose:

- **The name** (`grapevine`) is the canonical handle. It's what gets reserved
  here, and it's the exact argument the planned **wand** CLI takes
  (`wand grapevine watch`) — a mage-facing tool, see
  `docs/fragments/2026-05-29-the-wand-mage-cli.md`. A CLI namespace can't be
  fuzzy, so that's the one place a precise, set-apart token genuinely matters.
- **Invocation** is how an agent or human actually triggers the skill in
  conversation — and that's deliberately **plural**: "cast grapevine," "start a
  grapevine channel," "join the vine." It often carries distinct **lenses**, too
  (creating a channel vs. joining one are different intents that route to the
  same spell). All of that lives in each spell's `SKILL.md` description, written
  generously so the agent recognizes intent however it's phrased. The registry
  does not enumerate it.

So: **reserve the name; let the skill description carry the many ways to trigger
it.** Don't reduce triggering to a single magic word.

**Reserve a name when an idea coalesces into a real spell** — at the
naming/solidification step of `inscribe`, not at genesis. You don't name a
problem or a scrappy prototype; you name the thing it became. A name that
collides with another spell, or with an everyday word a user might say without
meaning to summon anything, is a bug.

## Reserved spells

| Name        | Kind        | Conjures                                                           | Status  |
| ----------- | ----------- | ------------------------------------------------------------------ | ------- |
| `digestify` | cantrip     | One-shot reading/review surface, inline questions                  | shipped |
| `grapevine` | conjuration | Agent-to-agent channel daemon                                      | shipped |
| `bounty`    | conjuration | Live duplex Kanban board (todo→doing→review→done)                  | shipped |
| `magpie`    | conjuration | Image surface — drop, ask, orchestrate                             | shipped |
| `glamour`   | conjuration | Compose a visual style from influences → re-castable spec + images | shipped |

## Retired names (renamed away — don't reuse)

| Old name    | Renamed to | When       | Why                                          |
| ----------- | ---------- | ---------- | -------------------------------------------- |
| `tuskboard` | `bounty`   | 2026-05-30 | Named the furniture, not the spell (rebrand) |

## Reserved namespaces (don't name a spell into these)

To keep the **wand's** command namespace clean, avoid names that collide with:

- Plain words a user says without intending to summon anything (`open`, `send`,
  `show`, `make`, `run`) — these would make `wand <name>` ambiguous.
- Other spells' names, or established tool names.

(This is about the name as a CLI token. Conversational invocation is forgiving;
the wand argument is not.)

## Conventions

- A name is a single distinctive token — the canonical handle, and the wand's
  argument. Prefer evocative, set-apart names over descriptive ones; the
  set-apartness is what keeps the CLI namespace unambiguous. (Grimoires used
  Latin for the same reason; the current names are English but distinctive.)
- The name is _not_ the sole conversational trigger — the skill description
  carries the full, plural set of invocation phrasings and lenses.
- The verbs _inside_ a conjuration (grapevine's `tail`, `who`, `send`) are a
  separate, spell-scoped namespace and aren't registered here.

## Candidates / parked

| Name        | For                                                       | Notes                          |
| ----------- | --------------------------------------------------------- | ------------------------------ |
| _(liaison)_ | the emissary spell — a read-model/translator over a swarm | manifesto §4; name not settled |
