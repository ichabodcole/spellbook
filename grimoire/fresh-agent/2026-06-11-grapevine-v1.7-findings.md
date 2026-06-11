---
date: 2026-06-11
spell: grapevine
spell_version: V1.7 (human as participant) — post-soak
agent:
  general-purpose subagent, cold (no build-time context), hard-restricted to the
  shipped skill folder per the marketplace-isolation constraint
task:
  "set up a grapevine so I can supervise another agent and participate from the
  browser — use the new V1.7 stuff"; operate every V1.7 feature from the SKILL
  alone
---

# Fresh-Agent Findings — grapevine V1.7 (2026-06-11)

The cold agent-facing complement to the live human+agent soak (see
`docs/projects/grapevine-v1.7/soak-findings.md`). The soak proved the human
side; this proves an installed agent can operate V1.7 from the updated SKILL
alone, marketplace-isolated to the skill folder.

## Headline

**Every V1.7 behavior worked and matched the docs** — identity/alias,
`who.humans` marker, `--in-reply-to` threading, archive (reject + history +
re-open lock), and invisible-lurk (excluded from `connections`, `anonymous`,
**and** the `list` channel count, still receives). The one behavioral mismatch
was an output-shape nit (archive rejection). All the real gaps were
**navigational / curse-of-knowledge**, not bugs.

## The questions (the gold)

- **"How do I invoke this when `${CLAUDE_PLUGIN_ROOT}` is empty?"** → the var
  resolves only inside the plugin host; a bare-terminal user pasting a verb gets
  `module not found`. Nothing told the agent the fallback is the adjacent
  `scripts/`. **First command hit.**
- **"Which `~/.grapevine` is real when I set `GRAPEVINE_HOME`?"** → the SKILL
  had a hard-coded `~/.grapevine` discovery sentence that contradicts the
  `$GRAPEVINE_HOME` override it documents elsewhere.
- **"Why does `info`/`doctor` say `version 1.0.0` when everything says V1.7?"**
  → the narrative feature version (banner) vs the plugin semver were
  undistinguished.
- **"Is a rejected send `{error:"archived"}` or `grapevine: archived`?"** → the
  SKILL documented the daemon HTTP shape; the CLI surfaces prose on stderr (exit
  non-zero). An agent parsing for the JSON shape would miss it.
- **"Where's the daemon URL / how do I hit `GET /identity` myself?"** → partly
  test-induced (the scenario asked the agent to verify `/identity`, a
  watch-internal endpoint an agent wouldn't normally touch); the HTTP surface is
  implementation detail agents reach via verbs. Logged, not fixed.

## Disposition

| Finding                                             | On the route?                   | Action                                                           |
| --------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------- |
| `${CLAUDE_PLUGIN_ROOT}` unresolved in bare terminal | **yes — first command**         | **fixed** — added the empty-var fallback note (matches glamour)  |
| `~/.grapevine` contradicts `$GRAPEVINE_HOME`        | yes (anyone using the override) | **fixed** — discovery sentence now `$GRAPEVINE_HOME (default …)` |
| `info`/`doctor` `version 1.0.0` vs "V1.7"           | **yes — anyone verifying**      | **fixed** — banner notes feature-version vs plugin-semver split  |
| archive rejection prose vs documented JSON          | yes (agents parsing errors)     | **fixed** — send row notes the CLI prints `grapevine: archived`  |
| `recipients` excludes lurkers                       | maybe                           | **fixed** — one-liner added to the send row                      |
| `help` verb undocumented                            | low                             | **fixed** — added to the verb table                              |
| daemon HTTP surface undocumented                    | low (test-induced)              | accept — agents use verbs, not raw HTTP                          |

## What worked well (keep)

Self-contained runtime (cli + daemon + watch.html all in-folder, daemon
auto-spawns, zero external runtime deps); the honest presence model behaved
exactly as the table claims; **invisible-lurk held perfectly across all three
count surfaces** (the most precise claim in the SKILL); `doctor` praised for
restart-safety; `read --text` / `grep` / `--in-reply-to` / `--human` all
surprise-free. No reads escaped the skill folder — isolation intact.

## Meta

The cold test caught what the soak couldn't: the soak ran from full context (the
agent driver knew the verbs), so the **agent-facing doc gaps** (empty
`${CLAUDE_PLUGIN_ROOT}`, the `~/.grapevine` contradiction, the version-label
confusion) only surfaced when a context-free agent had to navigate by the SKILL
alone. The soak + cold-agent pair is the right two-sided check for a
human-participant spell: live human in the browser, cold agent on the docs.
