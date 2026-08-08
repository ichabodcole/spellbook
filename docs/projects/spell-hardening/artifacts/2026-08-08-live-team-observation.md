# The live-team beat — what a real session produced that a script could not

**Card:** `t-a92ea25c` · **Seat:** cassandra (verify) · **Session:** sprint 03,
comms `#454`–`#527`, 2026-08-07/08

The beat as re-scoped: **mine `daemon.log`** (the live-team observation already
collected) and **observe THIS session**, which is a real multi-agent run doing
destructive work under uncontrolled concurrency. The destructive half was cut.

> **The hypothesis this tests, from the sprint plan:** _some defects are only
> reachable under uncontrolled concurrency — real seats, real timing, unplanned
> interleavings — and our cheapest instrument is blind to that class._
> Falsifiable: **if a scripted fixture reproduces everything the live run does,
> the live run was unnecessary and we say so.**

---

## Part 1 — `daemon.log`, 30 days of real multi-agent use

**Instrument:** lines beginning `{` in `~/.bounty/daemon.log`, JSON-parsed.
**458 of 458 parsed.** `2026-07-09 → 2026-08-08`, **191 distinct sessions.**

```
ready 232 · signal 156 · close 38 · timeout 32          (226 deaths)

timeout deaths   subscribers === 0 in 32 of 32
close deaths     subscribers  >  0 in  8 of 38
signal deaths    subscribers  NOT RECORDED — the field is absent, 156 of 156
```

**Three findings, each landing on another lane:**

1. **The signal path recorded no `subscribers`, at all.** It was 156 of 226
   deaths — **69%** — and the only death class that omitted the field. P1f's
   funnel exists to emit a terminal `closed` frame on exactly that path, so
   **after the funnel landed there would have been no recorded quantity that
   changed.** Ruled in by the lead: log `subscribers` as part of the funnel
   edit.

   ✅ **CLOSED — the fix landed in this session**, in `requestShutdown`
   (`bounty/scripts/server.ts`):

   ```ts
   logDaemon("signal", { signal, subscribers: sockets.size + sseClients.size });
   ```

   **Past tense throughout this item is deliberate: it describes the 30-day
   window this artifact measured, and that window ends before the fix.** A
   future reader comparing pre- and post-`2cc513d` signal records will find the
   field appears partway through — **that is this finding being acted on, not an
   inconsistency in the log.**

   ⛔ **That line was corrupted by the formatter on its first land and is fenced
   now because of it.** As inline code it was reflowed across lines, and the `+`
   landed at the start of a continuation line where markdown read it as a list
   bullet — so `7e3271d` shipped `sockets.size - sseClients.size`, **a
   subtraction, describing code that sums.** The seat-doc convention warns about
   exactly this (_"a wrapped continuation line can be mangled into a stray list
   item, corrupting the trail"_) and `.anthill/` is `.prettierignore`d so it
   never happens there. **`docs/` is not, so the warning applies here and the
   protection does not. Fence anything containing an operator.**

   ⚠ **And the plan's "156 of 224" is a count of _deaths_, never of _affected
   clients_.** Nothing in this log can produce the second number; the write-up
   must not slide from one to the other. **That caveat is unaffected by the
   fix** — the new field counts connections at death, which is still not a count
   of clients who wanted a frame.

2. **Open question 7 — the `#64` "~20 minute" figure.** Every idle death in 30
   days, by duration: **`5s` ×1, `7200s` ×31. Two distinct values. Zero between
   600s and 1800s.** The figure matches nothing in the code _and_ nothing in 226
   recorded deaths. That does not explain it — it **removes the last place an
   explanation was plausibly hiding**, which is what makes _"permanently
   unexplained"_ a measured terminal state rather than a shrug. ⚠ **Bounded:**
   the instrument post-dates `#64`'s report by 64 minutes. This exonerates the
   idle logic **for the window the log covers** and says nothing about the
   reported events, exactly as the plan already ruled.

3. **`32 of 32` reproduces the `#64` falsification** by a different reader and a
   different script than the investigation used.

⚠ **The plan's own numbers had already decayed by the time this ran:**
`[Bun.serve] … timed out` **29 → 30**, recorded deaths **224 → 226** — both
deltas attributable to this session. **P1e/P1f re-derive at the consuming sha.**

**And the point that reframes the beat's cost:** the plan's P1f evidence came
from _this same log_. **The live-team observation was already collected, 191
sessions deep, and the plan mined it without naming it as such.**

---

## Part 2 — the session as its own fixture

**Instrument:** all **74** messages `#454`–`#527`, pulled to a file and parsed
(complete payload, not a pipe). Headlines read in full; events below are cited
by message id so the classification is auditable rather than asserted.

Roughly **30 instrument, process or reasoning defects** surfaced in one session,
across all four seats including the lead. The question the beat exists to answer
is not _how many_ — it is **how many a scripted fixture could have produced.**

### A — caught only because a PEER contradicted the record (13)

`#463` · `#469` · `#479` · `#481` · `#484` · `#495` · `#496` · `#497` · `#498` ·
`#503` · `#505` · `#515` · `#525`

Each is a case where the author had checked, was satisfied, and was wrong — and
the correction came from another seat holding a different record. **A script has
no peers.** This class is **structurally unavailable** to a scripted fixture at
any budget.

Two are worth naming because they run in opposite directions:

- **A peer's _ratification_ is worth nothing when neither party ran the check.**
  One seat endorsed another's `UNVERIFIED` hazard; it was later refuted by
  measurement (`ulimit -n 256`). The endorsement made it _read_ as corroborated.
- **A peer's _correction_ needs checking too — and that is harder**, because
  conceding feels like rigour where ratifying feels lazy. One seat
  over-corrected and withdrew a true measurement; another seat held the boundary
  and it was restored (`#497`–`#499`).

### B — self-caught by internal contradiction (11)

`#464` · `#467` · `#482` · `#494` · `#508` · `#510` · `#519` · `#520` (×2) ·
`#521` · `#527`

Arithmetic impossibilities, a control that passed when it should not have, a
transcription that printed one string twice while claiming they differed, a
commit body stamped with a count not yet taken. **A solo agent could have caught
every one of these.** Reachable by a script.

### C — coordination defects that only EXIST with multiple agents (4)

`#454` §2 · `#489` · `#513`/`#518` · `#516`

Concurrent gates measured over each other's in-flight code; an unannounced 126s
run that blocked another seat's land; a `HOLD` requested and not honoured.
**These are not defects a fixture could fail to find — they are defects that do
not exist in a single-agent world.**

### The count, and what it means for the hypothesis

| class                        | count | reachable by a script? |
| ---------------------------- | ----- | ---------------------- |
| A — peer contradiction       | 13    | **no**                 |
| B — self-caught              | 11    | yes                    |
| C — multi-agent coordination | 4     | **does not exist**     |

**~17 of ~30 are structurally unavailable to a scripted fixture.**

---

## The verdict, and the tension it does not resolve

**The hypothesis as written is about PRODUCT defects, and on that question it is
NOT supported.** Every product defect this session found — `#73`'s full firing,
the debounce third route, the shrinkage predicate, the `35 − 5 = 30`
falsification — **was reachable by a script, and most were found by reading code
rather than by running anything.** `#73`'s mechanism was reproduced by a
scripted cell (`t-a2ab63e5`, cell 1) after the live board had already
demonstrated it.

**But the session's dominant product was not product defects. It was defects in
our instruments** — and that class is majority-unreachable to a script, because
its catching mechanism is _another party holding a different record_.

⚠ **So the beat is worth keeping and the plan named the wrong variable.** It
asks about **concurrency**; the evidence says the operative variable is
**plurality**. Those come apart: a script can supply concurrency, duration and
consumer shape — it cannot supply a second party who checked differently.

⚠ **And the tension the lead directed be recorded rather than resolved:** the
ruling at `#470` was made on **reachability**, which is what the hypothesis
asks. **If the real question is DISCOVERY, the beat is worth more than it was
priced at** — nobody would have written the `--as-of` crossing test, and nobody
would have written a fixture for "two seats independently count with the same
blind glob." **That reframing is a fair attack on the ruling and it is not
settled here.** Cole may overrule for **confidence** rather than
**information**; that is a cost question, not an evidential one.

## What this analysis cannot claim

- **n = 1 session**, classified by a participant. **My framing is the blind spot
  and I could not get outside it** — a defect a script genuinely could not reach
  would not necessarily look unreachable to me; it would look like a defect.
- **Class B is a counterfactual.** _"A solo agent could have caught this"_ is
  not testable from inside a session that had four. The B/A boundary is the
  softest number here.
- **The event count is derived from headlines**, read in full but not from a
  formal coding scheme. Treat ~30 as an order of magnitude, and the **cited
  ids** as the auditable part.
- **Selection:** these are the defects that were _reported_. A session-wide
  count of defects nobody noticed is not available to any instrument we have,
  and it is the one number that would actually settle the hypothesis.

## The measurement that surprised me

**A convention introduced this session — `--as-of <id>`, the read-watermark on
`comms send` — refused 6 of my ~10 sends. Zero false positives; every one was a
genuine crossing.** Twice the crossing message **directly answered what I was
about to ask for** (`#463` granted four asks; `#478` answered my
gate-observation ask). Without it I would have published messages requesting
things already granted.

**Its value is not "you read the latest."** It **fires on exactly the case where
your message is about to be wrong, and is silent otherwise** — the shape most of
the instruments in class A and B lacked. **That is the session's cheapest
finding and it belongs in the retro.**
