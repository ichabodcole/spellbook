# CLI stdout truncates at 64KiB on a pipe and exits 0 (grapevine + bounty; shared shape)

> ## ARCHIVED 2026-08-07 — both tracked issues shipped in **spellbook v2.0.0**
>
> **#77 and #78 are fixed, gated, released and closed.** The two acceptance
> criteria naming them are met, and the item is archived on that basis.
>
> **⚠ Its FOURTH acceptance criterion is NOT met, and this item is being
> archived anyway — deliberately, with the remainder named rather than
> absorbed.** _"Audit every other spell CLI for the same shape and fix the
> shape, not just the two reported call sites"_ is **partially** discharged:
>
> | AC                                     | status                                                                                                                                                       |
> | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
> | `grapevine pull` >64KiB through a pipe | ✅ sprint 01 (`59517c3`)                                                                                                                                     |
> | `bounty state --full` >64KiB           | ✅ sprint 01 (`92e1c57` is digestify's sibling gate)                                                                                                         |
> | a regression test **per spell**        | ⚠ **partial** — sprint 01: 5 pinned / 4 driven of 9. Sprint 02 P0f: **2 pinned · 3 driven**. No CLI-process harness exists for glamour · imago · magpie      |
> | audit + fix **the shape** everywhere   | ⚠ **partial** — **entry points** fixed across 8 files (sprint 01); **in-function** exits fixed only at the **five `tail` pairs** (sprint 02). **~30 remain** |
>
> **The remainder is not lost — it is the un-run part of P0f**, carried in
> `docs/projects/spell-hardening/sprints/02-success-shaped-lies/outcome.md`
> along with `bounty/join.ts`'s hang, which is explicitly **not** a P0f fix
> (`process.exit` there is load-bearing on a live WebSocket).
>
> **Archived because its two tracked issues are genuinely closed, not because
> the shape is fully audited.** Marking this DONE without that distinction would
> be the defect class this project exists to remove, committed in the filing
> system.

**Added:** 2026-08-05 · **Tracks:** GitHub issues
[#77](https://github.com/ichabodcole/spellbook/issues/77) (grapevine `pull`) and
[#78](https://github.com/ichabodcole/spellbook/issues/78) (bounty
`state --full`)

**This is the highest-priority correctness bug on the books.** On any payload
over 64KiB, the CLI writes a **truncated, unparseable prefix** to a pipe and
**exits 0**. The payload is complete; only the write is lost. For an agent —
which _always_ reads through a pipe — this produces **plausible, well-formed,
wrong data that reports success.**

Both issues are almost certainly **one bug in a shared output shape**, so fix
them together and verify both.

## Mechanism (already diagnosed in #77 — don't re-derive it)

Bun's stdout is **asynchronous on a pipe** and synchronous on a TTY or file, so
`process.exit` discards whatever hasn't drained:

```ts
function printJson(data: unknown) {
  process.stdout.write(`${JSON.stringify(data)}\n`);
}
// …
if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code); // ← discards the undrained tail
}
```

**The fix is to await the drain — or drop the explicit `exit` — before
returning. Not pagination, and not a `--complete` flag.** A control in #77
confirms this isn't inherent to Bun or to pipes: `anthill comms read` moved
983KB through a pipe intact, because its dispatch success path returns naturally
instead of calling `process.exit`.

## Why it's worse than an ordinary truncation bug

- **It doesn't cut at a record boundary.** The output stops mid-string, so an
  agent reading it as text sees a plausible transcript and no error.
- **`cursor` is the last key written** (`printJson({ ok, messages, cursor })`) —
  so **the one field that reports completeness is always the first casualty.**
  "The caller should have checked the cursor" is unavailable by construction.
- **It only fires on a pipe**, so it's invisible to the human at a terminal and
  mandatory for the agent consumer who suffers it.
- **It's mistaken for pagination, and the natural remedy inherits the mistake.**
  It was first reported as _"pull paginates at ~20-25 messages"_ with the fix
  _"loop until `cursor` stops advancing"_ — a loop that would advance ~64KiB of
  plausible history per pass and look diligent doing it. There is no pagination
  in either tool.

## Observed cost

A joining agent backfilled a channel, read it as ending at message #68 when it
stood at #116, stamped a formal verdict carrying that stale watermark — and the
session lead read the watermark as evidence the agent had ignored a briefing,
and broadcast that inference before retracting it. **One silent truncation
produced a wrong verdict and a wrong judgement of a teammate.**

## Acceptance Criteria

- [x] `grapevine pull` on a >64KiB payload emits **valid, complete** JSON
      through a pipe (`| cat`, `| jq`, `| head`), with `cursor` present.
- [x] `bounty state --full` on a >64KiB board does the same.
- [ ] A **regression test per spell** that pipes an over-buffer payload and
      parses the result — the bug is invisible at a TTY, so a test that doesn't
      pipe cannot catch it.
- [ ] Audit every other spell CLI for the same `main → process.exit(code)` shape
      (mind-mapper, imago, glamour, magpie, digestify) and fix the shape, not
      just the two reported call sites.

## References

- `plugins/spellbook/skills/grapevine/scripts/cli.ts:351-353` (`printJson`),
  `:1805-1807` (`main` → `process.exit`)
- `plugins/spellbook/skills/bounty/scripts/cli.ts:941-943` (identical shape)
- Reproduction, measurements, and the `anthill comms` control: issue #77
- **Bounty was measured but not proven.** #77 reports the live board at 52,982
  bytes — **under the buffer, so that cell was inconclusive, not passing.** The
  same board grew ~+13.8KB in one session (38,977 → 52,982), i.e. it crosses
  64KiB during the next one. #78 then observed it firing on a 52-task board.
- **Workaround until fixed:** redirect to a file and read the file
  (`bounty state --full > /tmp/b.json`).
