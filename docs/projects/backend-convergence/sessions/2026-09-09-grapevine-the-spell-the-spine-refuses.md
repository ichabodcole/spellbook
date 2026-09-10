# 2026-09-09 — grapevine: the spell the spine refuses, and three defects behind one sentence

**Agent:** Claude Opus 5, as the implementing agent · **Branch:**
`feat/grapevine-backend-port` · **Mode:** brief-driven, single implementer;
orchestrator reviews, Cole finalizes.

**Phase 6 of the backend convergence.** grapevine's whole backend — `cli.ts`
(2,476 lines), `daemon.ts` (1,467) and `cli.test.ts` (2,608, the second largest
suite in the repo) — out of the deployed skill folder, behind two launchers,
with the kit modules that survive their verdict.

**This is the first port whose deliverable is a REFUSAL.** Three of eight kit
modules are structurally wrong for grapevine, the refusal is the honest outcome
at each, and the kit was not widened. It is also the port where the playbook's
own error message had three unrelated causes hiding behind it.

---

## What shipped, by sha

| chapter | sha        | what it is                                                                                                                                                                                                                                      |
| ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | `c2ac1dc1` | **the relocation** — two entries and two test files into `src/grapevine/backend/`, two launchers, two committed artifacts. The flat-sibling spawn fixed. Five ward rows re-addressed, two lists extended, three live prose references repaired. |
| 2       | `ec543bfb` | **the adoption** — five kit rows taken, three refused in writing, the 38-site error contract converted, the tail replaced by the shared client, the heartbeat seam created, and the leak the port itself created closed and celled.             |
| —       | (this)     | **the records** — D71–D74, `phase-6-journal.md`, this file, the caveats row, three register entries (one CLOSED), and the Phase B amendment pass.                                                                                               |

**No third chapter.** The MAYBE slot Phase B budgets for an instrument the port
breaks did not fire: all three candidate instruments had already been repaired
in advance (D42, D49, and the launcher-pairing ward's derived populations).

---

## The three things that made this port different

### 1 · The launcher that would have killed the daemon

Every other spell's daemon `main()` awaits its own teardown, so
`const exitCode = await run(); process.exit(exitCode)` is correct there.
**Grapevine's resolves the instant `Bun.serve` binds** — the event loop holds
the process up, not the promise — so that shape exits 0 milliseconds after
binding. The pre-work drove it both ways and turned B2's discriminator from "CLI
vs daemon" into a property (D69). It gave the right answer first try, and the
confirmation in the port is one invocation: run the daemon launcher alone, watch
it stay up, `GET /`.

### 2 · Three defect classes, one error string

`daemon failed to start within 3s` is reported for the launcher shape above, for
a **flat-sibling spawn path** (`DAEMON_SCRIPT = join(SCRIPT_DIR, "daemon.ts")` —
glamour's exact shipped defect, which grapevine genuinely had), and for a
**dev-mode daemon dying at its surface import**, which `cli.ts`'s own comment
attributes it to. Fixing the second does not clear the message.

They are separable, and the journal has the table. The cheap discriminators:
cause 1 **writes the port file and then orphans it**; causes 2 and 3 never write
one at all; and cause 1 is the only one that reproduces with **no CLI in the
picture**. The `die` at the end of `ensureDaemon` now carries a `hint` naming
all three, which is the cheapest possible version of that table delivered where
the defect is actually met.

### 3 · The refusal, written in both places

`eventLog` is one capped in-memory array against **N durable per-channel
`.jsonl` files** whose `next_id` is a high-water mark read back off disk on
boot. `sse` is `Set<{close, send}>` against
`Map<symbol, {alias, human, lurk, send}>` whose metadata **six routes** read —
counted, with file and line, because "they are different" is an assertion and
"six routes read this field" is a measurement. `housekeeping` splits per export.

**The kit was not widened**, and the reason is a count rather than a preference:
a widening lands in every spell that bundles the module — six artifacts across
five spells for these rows, each owed a drive, paid by ports that are finished
and by agents not in the room. Each refusal is now a paragraph in the kit
module's **own header**, naming grapevine and the reason, which is the half that
survives this session: the next agent opens `sse.ts` in order to adopt it, and
that file is where they will look for whether it is a good idea.

---

## The thing that did not transfer

**The assumption that a spell's failure PROSE is only presentation.** Every
`errors.ts` bullet in the playbook treats the old wording as something the
envelope improves on. Grapevine's rejections were **engineered for a machine
reader**: `recognized flags: --a --b`, colon straight after the noun, under a
comment recording that a qualifier between the two "reads as prose, not a set",
and sorted long-flags-first because an extractor stops at the first token that
is not a `--long` flag. That came out of grapevine's own acc registry work.

Inside a JSON document a marker is a substring of an escaped string. The
adoption therefore had to move the enumeration into a field rather than replace
it — and the field already existed, and the answer was **checked rather than
assumed**: glamour is CONFORMANT L0 and publishes its accepted set as `choices`.
(D71.)

**And the contract was two contracts.** A grep for `die(` reports 46 sites.
There were 46 **plus four** parser rejections writing their own prose and
returning 2 — the ones an agent meets first. Digestify's port taught "look for
the raise, not for the helper"; grapevine is where a spell had both.

---

## What was driven

Every daemon had its own home under the session scratchpad and was torn down.

- The daemon launcher **alone**, staying up and answering `GET /`.
- The full CLI chain, `scripts/cli.ts` → `dist/cli.js` → spawned
  `scripts/daemon.ts`: `open`, `send`, `pull`, `info`, `stop`.
- **Release**: `mode release`, `/watch` 200, hashed chunk 200, and the leak this
  port created measured on both sides — `GET /daemon.js` 200 / 146,330 bytes and
  `GET /cli.js` 200 / 251,310 at chapter 1, both **404** at chapter 2, with the
  artifacts proven on disk and over 50 KB first.
- **Dev**, from `src/grapevine/` through the same launcher: `mode dev`, and
  `_bun/client/…` + `_bun/asset/…` on the wire, which is what proves Contract
  5's cwd pin survived.
- A **tail through `tailEvents`**: grounding line, `: grapevine-keepalive`, a
  live frame with its read pointer, clean SIGTERM.
- **Seven failure invocations**, before and after, across all four kinds.

Gate green **unpiped** at both chapters; `bun scripts/dist-check.ts` exit 0 on
all three arms after each chapter's commit.

---

## What I could not verify

- The two environment variables the heartbeat adoption **added** —
  `GRAPEVINE_IDLE_TIMEOUT_SEC`, `GRAPEVINE_HEARTBEAT_MS`. Nobody chose them;
  they arrive with the kit's parsers. Filed as register A13, because the
  question is the same for every adopter of that module.
- **The tail's idle watchdog firing.** 9,000 ms of silence against a wedged
  half-open socket needs a fixed-port proxy that accepts and stops sending
  (Gotcha 9), which was not built.
- **A `roll` under a live tail** — the reconnect-onto-a-new-daemon property
  `tailEvents`'s `resolve` callback exists for.

## What I would tell the next agent

**Read the entry block's seven questions and write the answers down before
touching anything.** Every one of them changed a decision here, and questions 5,
6 and 7 each stopped a defect that would have read as something else: a daemon
that exits when it must not, a `roll` that replays every message of every tailed
channel into an agent's pipe, and three kit adoptions that would have been
rewrites of the spell.

**And measure the leak in chapter 1.** It costs one `curl` against the daemon
you are already driving, and it is the only free proof that chapter 2's
whitelist is load-bearing rather than shadowed.
