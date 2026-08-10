# Team Paper-Cuts — friction log → fix candidates

A running log of friction the team hits in its **tooling, docs, skills, and CLIs** during real
sessions — what bit, and the suggested fix. Distinct from a seat's `dev/<handle>.md` (durable per-seat
_taste_) and `seams.md` (inter-seat _contracts_): this is the **process/tooling backlog**, captured
so a recurring tax becomes a tracked fix instead of a re-discovered annoyance.

## The method

1. **Append during the session.** The moment something bites — a clunky command, a doc that lied, a
   missing affordance — drop a line here (or in your scratch, to harvest at finalize). Cheap capture
   beats perfect memory.
2. **Triage by cost at finalize.** The lead (or the team) groups items by **cost-to-team ×
   cost-to-fix** — the highest repeated tax, fixed first. A one-off annoyance ranks below a small tax
   paid every session.
3. **Track disposition.** Every item ends in one of: **fixed** (link the commit/PR), **filed
   upstream** (it lives in a dependency — **anthill itself**, or the spellbook plugin, or another — so
   file an issue there), or **graduated** (it's really a feature → promote to a project). Strike
   through / mark resolved items so the open queue stays honest.

A friction that lives in a **dependency** (grapevine, bounty, the plugin itself) isn't yours to fix
in-repo — file it upstream and note the workaround here. When the dependency is **anthill**, the
streamlined path is **`anthill feedback`** (on a team, surface it to the lead — see the SOP's feedback
routing); ideas to improve anthill route the same way, not just bugs.

---

## <date> — <session label>

_(append entries below as you hit friction; triage at finalize. Suggested shape:)_

<!--
### Tier 1 — highest repeated cost

1. **<short title>** _(which seat(s) hit it)._ <what bit, concretely — the tax it imposed>.
   - **Fix:** <the proposed change>. <in-repo? or upstream (which dependency)?>
   - **Workaround now:** <what to do until it's fixed>.

### Disposition (<lead>) — <date>

- ✅ **#1 → <commit/PR>** — <what shipped>.
- ◻ **#2** — filed upstream (<where>) / graduated to <project>.
-->

## 2026-08-08 — sprint 04 · the shape of nothing

### Tier 1 — highest repeated cost

1. **The board-tail filter that `anthill join` prints cannot match the events it exists to
   deliver** _(thoth; hit independently by more than one seat)._ The manifest's checklist emits
   `grep -E --line-buffered '"type":"(task|unblocked|closed)"'`. The alternation demands a **closing
   quote immediately after `task`**, so `"type":"task.add"` and `"type":"task.update"` — the entire
   card lifecycle — never match. **Measured at finalize by capturing the raw tail to a file: 25
   events replayed, 17 of them `task.add`/`task.update`; I received 1 board event all session, and a
   card filed to me was silently eaten.**
   - **Why it survives a reading:** the string is plausible, it is *pre-resolved by the CLI* so seats
     are told to run it verbatim, and its failure mode is **silence** — indistinguishable from a
     quiet board. I read this filter, pasted my own probe output containing `"type":"task.add"`
     directly beneath it, and armed it anyway.
   - **Fix (upstream — anthill, the `join` manifest):** make it an **exclusion**, not an
     enumeration: `grep -v --line-buffered keepalive`. A deny-list cannot silently omit a member,
     which is the whole defect class here — four successive allow-list filters each left a different
     hole before the exclusion form ended it.
   - **Workaround now:** run the exclusion form instead of the printed string, and **sample the raw
     tail into a file once** to confirm bytes are arriving.

2. **A tail that resolves no board is indistinguishable from a tail that is waiting** _(filed by the
   anthill team as `spellbook#98`; cost them 40 minutes)._ Retries forever, exits 0, prints the same
   `# no session yet, retrying…` in both cases. **Their line is the durable one: `ps` is not evidence
   a tail is attached; received bytes are.**
   - **Checked our side at finalize and we were clean** — raw capture shows `{"type":"ready",…}`
     with a real `session_id` and 0 retry lines. **Clean by measurement, not by assumption:** #1
     above meant our board wire *looked* dead all session, and #98 is a second, independent cause
     that produces the identical symptom. Two different defects, one indistinguishable silence.
   - **Fix:** carded as `s5-6` (daedalus, cold). Not tonight.

3. **`bounty` and `anthill` disagree on the response envelope, and a reader written for one silently
   misreads the other** _(thoth)._ `anthill` returns `{ok, data, meta}`; `bounty state` returns a
   bare `{state:{tasks:[…]}}` — no `ok`, no `data`, no `error`. Two throwaway readers minutes apart
   failed in **opposite** directions: `(j.data?.cards) ?? []` rendered an `ok:false`
   (`Unknown command bounty` — wrong binary) as **"0 cards, 0 open, clean board"**, and a
   compensating `if (j.ok !== true)` then rejected a **valid** payload as `NOT OK: undefined`.
   - **Fix:** this is `#82`'s own subject arriving on the consumer side — see
     `grimoire/outcome-contract.md`. Worth a row in the cross-tool spelling work rather than a
     one-off patch.
   - **Workaround now:** print `Object.keys()` of the payload before writing any accessor against it.

4. **`bounty state --help` answers for a command it did not run** _(thoth)._ `bounty` is not an
   `anthill` subcommand, so `anthill … bounty state --help` returned **`ok:true`** with anthill's own
   top-level description. An unknown *command* was swallowed and the help text described something
   else — the same asymmetry the join skill documents for unknown *positionals*, one level up.
   - **Fix:** upstream (anthill CLI) — an unrecognized command should fail the way an unrecognized
     flag does, by name.
