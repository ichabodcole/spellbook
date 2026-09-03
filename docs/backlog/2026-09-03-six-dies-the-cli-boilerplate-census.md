# Six `die`s — the CLI boilerplate census

**Filed:** 2026-09-03 · **Asked by:** Cole, at the end of the glamour port ·
**Scope:** repo-wide · **Status:** AGREED AS ITS OWN PROJECT, to start after
glamour-conversion completes

## The question that produced this

The `printJson` convergence question has been banked since spell-kit, and it was
always **one-function-shaped**. Cole asked the wider one: _are we independently
re-writing the same generic utilities across CLIs — `CliError`, `sleep`, session
paths — and had anyone actually looked?_

**Nobody had.** This is the census.

## Measured 2026-09-03 at `50932b8`

Seven CLIs: astrolabe · bounty · glamour · grapevine · imago · magpie ·
mind-mapper. Declarations compared by **normalised body** (comments and
whitespace stripped), not by name — a name census would have reported
duplication that isn't there.

### Genuinely identical

| helper                | copies | identical | lines |
| --------------------- | ------ | --------- | ----- |
| `printJson`           | 4      | **all 4** | 3     |
| `readSession`         | 4      | **all 4** | 7     |
| `api` (fetch wrapper) | 5      | 4 of 5    | 6     |
| `daemonCwd`           | 5      | 4 of 5    | 5     |
| `sleep`               | 5      | 4 of 5    | 3     |
| `UsageError`          | 5      | 4 of 5    | 1     |

≈25 identical lines per spell across 4–5 spells. **Extraction saves ~100 lines
repo-wide — which on its own does not justify anything.**

### ⛔ The finding is the DIVERGENCE, not the duplication

| helper            | copies | agreeing     |
| ----------------- | ------ | ------------ |
| **`die`**         | **6**  | **one pair** |
| `sessionFilePath` | 4      | one pair     |
| `requireSession`  | 4      | one pair     |
| `readStdin`       | 3      | one pair     |
| `flagsFor`        | 3      | none         |

**`die` is how a CLI fails** — exit code, envelope, taxonomy: precisely the
surface `acc` grades. Six independent implementations is why three spells each
needed a separate conformance pass to reach the same L0, and why each one
re-derived the same taxonomy by hand.

**So the payoff is not lines saved. It is divergence prevented.** `CliError`,
`UsageError`, `die` and `printJson` together are the CLI's contract with an
agent. Extracted once, a new spell is conformant **by construction** instead of
by a session.

## The blocker is structural

`src/` reaches a destination only through a bundle, so **a source-shipped
backend cannot import from `src/kit/`** — the specifier dangles at a consumer
install. Only astrolabe and magpie build. Any extraction must choose:

1. **each sharer builds** — a Contract 3 amendment covering 4+ spells; and
   bounty/grapevine are not in `src/` at all, so they would need relocation too
2. **vendor into each spell's `shared/`** — duplication with a blessing, but
   single-sourced upstream
3. something nobody has proposed

## Why this is not the glamour port's question

Re-answered for Cole at the end of the port: building glamour's backend does not
create sharing — **sharing would require a build.** The direction of causation
makes this a roster-wide decision about `src/kit`, not a per-spell one. See
`docs/projects/glamour-conversion/plan.md`, the Phase 3 ruling and its
2026-09-03 reconciliation.

## Related

- `docs/backlog/2026-09-03-five-seats-each-wrote-their-own-resolve-sweep.md` —
  the same shape one layer up: an instrument everyone rebuilds is an instrument
  everyone gets wrong privately
- `.anthill/dev/seams.md` — Contract 3 (backends ship as source), Contract 4
- `.claude/skills/acc/` — the conformance standard `die` is graded against
