# glamour acc L0 — the before-run, the fix, and the after-run

**Session 2026-09-03 · branch `feat/glamour-acc-l0` · solo implementation with a
no-stake verify subagent (cold read + drive), not a convened team.** Trigger:
Cole reported the `acc` kit release had landed (the charter's blocker) and asked
for the checks to run and the guidance to be followed. Kit pinned **v0.1.7 →
v0.1.11**, `acc version --check` up to date at install time.

## Result

|                                    | before (37f71f3, kit 0.1.11)                                              | after (this branch, kit 0.1.11)                                             |
| ---------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| acc verdict                        | **NOT CONFORMANT (L0)** — C2, D1, D2 core; A6, D3 diagnostic; A7, B5 UNVR | **CONFORMANT (L0)** — 0 core violated, 1 core UNVR (D3, the house residual) |
| exit code                          | 9                                                                         | 0                                                                           |
| B5 (machine mode on parser errors) | unverified (nothing declared)                                             | hard pass (`defaultOutput: json` declared, envelope built)                  |
| A6 (`--` terminator)               | FAIL — value after `--` re-parsed as an option                            | PASS+ — whole argv parsed at the root, verb included                        |
| glamour + grimoire tests           | 167 pass                                                                  | 182 pass (15 new contract cells); full gate 1553 pass / 0 fail              |

Reports saved from the run: the before/after JSON was captured to the session
scratchpad; the verdict lines above are what `acc report --format text` rendered
from them. Success criterion 1 of the charter is met **with the kit version**:
`CONFORMANT (L0) … [acc 0.1.11]`.

The residual is the same shape mind-mapper and astrolabe carry: **A7** (no
closed value set advertised, nothing to falsify) and **D3** (help _claims_
JSON-by-default in prose; the kit cannot verify a sentence, and a caller sees
help, not `acc.config.json`). Not chased, per the L0 guide.

## What changed in `scripts/cli.ts`

- **Error envelope.** `die()` no longer writes prose and `process.exit(2)`s; it
  throws a `CliError` and `main()` returns the taxonomy code, so stdout drains.
  Every failure is one JSON document on stderr:
  `{ok:false, error:{kind, exit_code, retryable, message, hint?, choices?, server?}, meta:{command}}`.
  Taxonomy is the house one (magpie's, adopted by mind-mapper): usage 2 ·
  internal 1 · not_found 5 · conflict 6.
- **Root tokens** resolved before any parsing: `--help`/`-h` → help;
  `--version`/`-V`/`version` → `{name:"glamour", version}` read from the plugin
  manifest. `--version` is deliberately **not** a registry flag, so
  `state --version` stays refused (the flag-invariant ward records the waiver).
- **Bare invocation and unknown verb** are usage errors (exit 2) whose rejection
  names the verb roster under `choices`; an unknown flag's rejection names the
  recognized flag registry under `choices` (A3's SHOULD, and what a future
  recorded-surface census would read).
- **The whole argv is parsed, verb included**, so a bare `--` at the root is
  honoured (A6). Flags before the verb are therefore accepted too.
- Help gained an `Output:` footer and a `help | --version` line; the
  `style-archive` usage line said `--restore` where the code has said
  `--unarchive` since sprint 05 — fixed.

## Decisions, with the options not taken

1. **no-session → `not_found` / exit 5**, following magpie's no-session
   precedent and mind-mapper's no-daemon ruling exactly. This is a caller-facing
   exit-code change (was 2). Not taken: keeping 2 to minimise the
   characterization delta — the port's harness is _this_ contract, and a
   contract that disagrees with three sibling spells for no distinguishing
   reason is the drift class acc exists to close.
2. **Daemon-HTTP refusals wrapped, body verbatim under `error.server`**, kind
   mapped off the status (400 usage, 404 not_found, 409 conflict, else
   internal). Previously every non-200 was prose at exit 2. Same ruling as
   mind-mapper #1100/#1101; not re-litigated.
3. **Solo implementation, subagent verification** rather than
   `/anthill:convene`. The change is one file plus its test and documentation;
   the team ritual's cost was not proportionate. What the team supplies that a
   solo author cannot — verification that does not fire on its own author — was
   kept: a no-stake subagent ran the claims and drove invocations the author had
   not tried. Its findings are in the ledger below.
4. **No census (acc step 5) this session.** The charter's scope is L0 on
   `cli.ts`; the recorded-surface batch is the follow-on, and glamour's flat
   verb table has less below the root than mind-mapper's did.

## Instrument ledger

- The exit-site inventory ward fired on the removed `process.exit(2)` and named
  the line — the pin was moved by hand with a note on why the family lost a
  member, as the ward's own header prescribes.
- zsh does not word-split unquoted `$args`; the first smoke loop passed
  `state --nope` as one token and reported an unknown _verb_. Caught by reading
  the rejection's message, not by the exit code — which is the A3 argument (name
  the token) working on its author.
- `bun` strips one bare `--` immediately after the script path. The contract
  test sends two, as acc's runner does; SKILL.md now says so.

## The verify seat's findings (cold drive, no stake)

All nine wire claims held. The DOES-NOT-FIT bucket, and what was done with it:

- **`tail` with no session waits forever, stderr is `#`-prose** — pre-existing
  and by design (it is started around `open`), but the new help/SKILL prose
  over-claimed "every failure is an envelope". **Documented as the exception**
  rather than changed; changing it would break the Monitor flow.
- **Flags before the verb are now accepted** (`--session x state` dispatches
  `state`) — a real behaviour change the whole-argv parse introduced and
  SKILL.md still denied. **SKILL.md corrected; pinned by a test cell.**
- **`meta.command` was null on every parser-stage rejection**, exactly where an
  agent needs it. **Fixed** — the verb is named before the parse — and pinned.
- `tray` ignored the daemon's HTTP status where `state` did not — **fixed** to
  go through the same refusal path.
- The `open` help row omitted `--start-timeout` — **fixed**. There is no ward
  binding HELP to `CLI_OPTIONS`; noted under deferred.
- `close` reports `{ok:true}` on _any_ fetch error, not only the ECONNRESET the
  comment names — a stale pointer to a dead port is "success". Pre-existing,
  arguably idempotent-close semantics; **left, and listed as a decision owed.**

What acc's own report now reads back from the tool: **26 flags enumerated at the
root, 18 verbs advertised** (envelope-`choices` shape), so a recorded surface
batch has something to compare against.

## Success criteria, against the charter

1. ✅ `acc check` passes, recorded with the kit version (0.1.11).
2. ⏳ The same check must be re-run **after the port** (`glamour-conversion`)
   and still pass, or name what the port changed. Not this session's to close.
3. ❓ **Whether acc runs automatically is still unruled.** Nothing in
   `package.json`, CI, or the hooks re-runs it; three spells' conformance is a
   claim about a moment by hand. Recommendation: add
   `bunx acc check <cli> --config-dir <spell>` per conformant spell to the
   `gate` (exit 9 is the only "not conformant" code; anything else is the kit
   failing). Cost: four subprocess sweeps, seconds each. **Owner: Cole**, since
   it is a gate-cost decision; the wire is ready either way.

## Deferred

- The recorded-surface census for glamour's verbs (acc step 5). Prerequisite
  worth knowing: glamour has ONE flag registry, so an unknown-flag rejection
  names all 26 flags at every verb; a per-verb comparison needs per-verb sets
  (mind-mapper's `VERB_SPEC` two-stage parse), and that is also what would let
  one table drive help, parser and rejections (acc step 6) — the HELP drift the
  verifier found is the symptom of not having it.
- `close`'s swallow-all catch: idempotent by decision, or ECONNRESET-only as the
  comment claims.
- The four remaining `printJson`/envelope copies converging into shared backend
  code — the trigger the charter names, still not pulled.
