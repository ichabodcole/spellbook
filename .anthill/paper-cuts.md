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
   upstream** (it lives in a dependency — e.g. the spellbook plugin — so file an issue there), or
   **graduated** (it's really a feature → promote to a project). Strike through / mark resolved items
   so the open queue stays honest.

A friction that lives in a **dependency** (grapevine, bounty, the plugin itself) isn't yours to fix
in-repo — file it upstream and note the workaround here.

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
