# Fresh-agent test — glamour (rebuild / cutover)

**Date:** 2026-06-25 · **Trigger:** glamour rebuilt + new SKILL.md authored at
the v2→glamour cutover (ergonomics changed wholesale → ward fresh-agent gate).

## Method

Two cold subagents (no session context) read ONLY the new `SKILL.md`: one as a
**cold operator** (could it run a session end-to-end from the doc?), one for
**comprehension + gaps**. Findings synthesized + verified against the code,
fixes applied, then **one re-verify subagent** re-read the revised doc against
the specific gaps.

## Blockers found (and fixed)

1. **Reading dropped items** — the doc never said the agent reads references/
   context via each item's on-disk `path` (v1's SKILL had this; the rebuild lost
   it). Cold agent would be stuck reading a dropped brand doc. → Added a
   "reading dropped items" note + defined References (images) vs Context
   (text/brand docs).
2. **Section `--status` literals** — `empty|forming|agreed` never quoted; agent
   would guess the strings. → Quoted the literals + who sets them (agent
   judgment).
3. **Marks: pushed or ambient?** — unstated whether like/star/pin/archive emit
   tail events; an agent could never react to a pin. Ground truth: they're
   AMBIENT (not in AGENT_EVENT_TYPES) — read from state; the surface updates
   Canonical from pins automatically. → Stated explicitly in the marks +
   operating-rule sections; defined "ambient."

Plus ~8 important/minor fixes: `focus`/`style-save`+tray prose,
stay-silent-after- open, style-save-before-close, a concrete Monitor example,
`--timeout` vs `--start-timeout`, `--n` vs `--round`, the "done" inference,
`--no-open`, `$GLAMOUR_HOME`.

## Result

Re-verify pass: **9/9 previously-blocked operability questions now answerable**
(reviewer cited the exact lines). Blockers cleared; a cold agent can now operate
glamour from the doc.

## Remaining minor polish (logged, not blocking)

A future doc pass could tighten: distinguishing a clean tail-end from a
transient disconnect; what to do on a bare `item.add` before any `message.user`;
when to run `media-forge models list`; `$GLAMOUR_HOME` as an explicit prereq
line; the "settled with the user" wording on `agreed`; clarifying the agent's
own `focus` call vs ambient focus. None block use.
