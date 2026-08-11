# Spell Architecture Maturity — backlog

**Status:** **Archived (Superseded)** — archived 2026-08-10 · **Created:**
2026-06-01 · **Author:** Cole Reed (with familiar)

> **The core question was answered on 2026-06-15.** `7719c34` wrote the
> canonical house pattern — _drive a conjuration through a daemon + thin CLI_ —
> into `grimoire/house-style.md:188–225`; `d097474` migrated bounty off the old
> file-pump substrate onto it; `ef29f10` archived the `bounty-agent-usable`
> project that carried the work. All four conjurations (bounty, grapevine,
> glamour, magpie) now follow the pattern; digestify is a cantrip and correctly
> exempt.
>
> **The rest was absorbed, not dropped:** surface complexity and build posture →
> [`spell-surface-pipeline`](../../spell-surface-pipeline/); correctness and
> parity defects → [`spell-hardening`](../../spell-hardening/).
>
> **Two things this archive does NOT resolve, recorded so they are not lost:**
>
> - **Full-state broadcast vs. granular diffs** — never decided, in either
>   direction. No record exists of a choice being made.
> - **The scaffold** (`scaffold/`) remains deliberately unwritten per
>   `scaffold/README.md` ("not yet written, on purpose"). Whether that is still
>   house intent is an open question for a human, not a stale artifact.
>
> _Archived by the 2026-08-10 sweep —
> [`docs/reports/2026-08-10-project-status-sweep.md`](../../../reports/2026-08-10-project-status-sweep.md)._

A place to track the question: _are our spells implemented at a consistent level
of maturity, and should the better patterns become canonical (a guide + a real
scaffold)?_

## Why this exists

Building `glamour` surfaced that the spells are **not** at a uniform tooling
maturity. Two conjurations, two different agent-interface shapes:

- **bounty** (younger): agent drives it via raw **JSON-lines on stdin/stdout**,
  with `bg.ts` bridging to events/cmds files for chat-style agents.
- **grapevine** (heavily iterated): agent drives a **CLI verb surface**
  (`cli.ts`) over the daemon's **HTTP API**, with `tail` (SSE) **wrapped in
  Monitor** for push-style reaction, structured responses, and `doctor`/`info`.

glamour was cloned from bounty, then — mid-build — **upgraded to grapevine's
pattern** (HTTP API on the daemon + `cli.ts` + Monitor-wrappable `tail`; `bg.ts`
dropped). That upgrade is the evidence: the mature pattern is markedly better to
drive, and the gap between spells is real.

## Backlog items

1. **Audit every spell's agent interface for maturity.** Across `digestify`,
   `bounty`, `magpie`, `grapevine`, `glamour`: which use the stdin/stdout +
   `bg.ts` shape vs. the CLI + HTTP + Monitor-tail shape? Decide, per spell,
   whether to upgrade. **bounty** is the prime candidate (same conjuration shape
   glamour just upgraded from). Weigh against churn + the ward/version cost.

2. **Make the agent-surface architecture canonical.** The `agent-surface-bun`
   recipe lives in `project-docs`; the in-repo `grimoire/house-style.md` carries
   only the reachable summary. Consider:
   - Graduating the recipe's substance into Spellbook (house-style references it
     today — see "Carry the Bun gotchas forward").
   - Writing the deliberately-unwritten **`scaffold/`** (a cantrip skeleton + a
     conjuration skeleton) _derived from the matured spells_ — exactly what
     `scaffold/README.md` says to do once the real overlap is visible. glamour's
     refactor makes the conjuration shape clearer.

3. **Reconcile divergences found while building glamour:**
   - **CDN vs. self-contained surfaces.** glamour's `template.html` uses
     Tailwind/Alpine via CDN; bounty/grapevine are vanilla + self-contained.
     house-style permits CDN, but pick a canonical default (and decide whether
     to vanilla-ize glamour).
   - **Discovery-file double-prefix quirk.** Both bounty and glamour write
     `<prefix>-<prefix>-<id>.json` discovery files (sessionId already carries
     the prefix). Harmless but sloppy; fix in the canonical pattern.
   - **Full-state broadcast vs. granular diffs.** glamour broadcasts the whole
     state snapshot on every change (simple, dodges diff bugs); bounty/grapevine
     diff. Decide the canonical recommendation and when each fits.
   - **Consume patterns.** grapevine ships three (tail/Monitor, long-poll wait,
     episodic pull) for cross-runtime reach; glamour ships only tail. Decide
     whether the scaffold should include all three by default.

## Outcome this should produce

- A short **decision** on whether/how to upgrade the older spells.
- Either a **canonical architecture guide** (graduated recipe) **or** a real
  **`scaffold/`**, so the next spell starts from the matured shape, not from
  whichever existing spell happened to get cloned.

## Related

- `docs/projects/image-style-spell/design-notes.md` — glamour's architecture +
  the refactor that triggered this.
- `docs/projects/spellbook-coherence/proposal.md` — the sibling "make the set
  coherent" pass (conventions/feedback-touchpoints); this backlog is the
  _architecture/tooling_ analogue.
- `scaffold/README.md` — the not-yet-written scaffold this would finally write.
- `plugins/spellbook/skills/grapevine/scripts/{cli,daemon}.ts` — the reference
  for the mature pattern.
