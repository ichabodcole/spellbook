# Sprint 05 → 06 carries — the cards, rescued from the board before teardown

**Written:** 2026-08-10, at the merge · **Source:** the live bounty board
`k-spellbook-f4249899`, which is about to be torn down · **Project:**
[Spell Hardening](../../README.md) · [plan.md](./plan.md)

> ⛔ **WHY THIS FILE EXISTS.** A cold agent was handed this branch and asked to
> reconstruct it. Its sharpest finding: **`retro.md` carries
> `s5-1 · s5-2 · s5-3 · s5-4` and nothing in the tree defines any of them.**
> Card ids are cited across code comments, docs and commit bodies — and **the
> board that disambiguates them does not survive the session.**
>
> **Sprint 06 would have inherited four opaque tokens.** This project already
> lost a carry that way once: `s5-7` lived only on a torn-down board and was
> recovered from `~/.bounty/snapshots/` by luck.
>
> **The card text is reproduced verbatim below**, not summarised — a summary is
> a re-rendering, and this session measured what re-rendering costs. `s5-5`,
> `s5-6`, `s5-8` and `s5-9` also have files in
> [`docs/backlog/`](../../../../backlog/); they are included here so one
> document answers _"what does sprint 06 inherit."_

---

## `c1` — C1 — t-2df67738: the `--` terminator EATS --session-key; the write lands on the ambient board at exit 0

**Owner at teardown:** `daedalus` · **Status:** `todo`

```
SCOPED 2026-08-08 by thoth (#885) — THE ENUMERATION daedalus CALLED "MOST OF THE L" ALREADY EXISTS. DENOMINATOR, measured now: 8 spells / 15 entry points setting allowPositionals — astrolabe (cli, server), bounty (cli, server, join), digestify (review.ts — its entry point is NOT cli.ts), glamour (cli), grapevine (cli), imago (cli, server), magpie (cli, server, discover), mind-mapper (cli, server). NAME THE QUESTION BEFORE SWEEPING: "spells whose cli.ts sets it" = 7; "spells with ANY entry point setting it" = 8. RULED 8 — digestify/review.ts is the caller-facing entry point, so it counts. DO NOT RE-DERIVE THE POPULATION: grimoire/flag-invariant.test.ts already enumerates entry points BY BEHAVIOUR (structural anchor on strict:/allowPositionals:, cli.ts:92) rather than by filename — the enumeration that survived four wrong attempts. Reuse it. thoth's seat doc recorded 6 as a measured set and it drifted when astrolabe + mind-mapper joined the roster: THE INSTRUMENT WAS RIGHT AND ITS HUMAN SUMMARY ROTTED. SCHEDULING (prospero #884, amended #886): c1 stays UNSCHEDULED tonight. The ruling's FIRST reason — "unscoped beyond bounty" — is now DISCHARGED by this measurement. It survives on the SECOND only: a converging round at a late hour is the wrong place to open an L. Sprint 05, carrying daedalus's r3 disclosure verbatim and this denominator.
=== DENOMINATOR CORRECTED AT FINALIZE (prospero, step 2.5) — IT IS 16 ENTRY POINTS, NOT 15 ===
The 15 recorded above came from thoth #885 and prospero wrote it into this card WITHOUT RE-MEASURING IT — taken on report while presented as the card's authority. Re-measured at finalize:
  grep -rln --include='*.ts' -E '(strict:|allowPositionals:)' plugins/spellbook/skills/ | grep -v '.test.ts'
  -> 16 files, 8 spells:
     astrolabe cli+server · bounty cli+server+join · digestify review · glamour cli+SERVER
     grapevine cli · imago cli+server · magpie cli+server+discover · mind-mapper cli+server
THE MISSING ONE IS glamour/scripts/server.ts:574 — `nodeParseArgs({ ..., strict: true })`. thoth's row listed glamour as cli.ts only.
BY PATH (skills/*/scripts/cli.ts) the count is 7, which he had right.
SO THE CORRECT PAIR IS 7 BY PATH vs 16 BY BEHAVIOUR — a path-based sweep is blind to 9 of 16, not 8 of 15. The spell count of 8 is unchanged and his "name the question before you sweep" caveat is unchanged and remains the load-bearing half.
NOTE THE CLASS, because it is the session's own finding turned on the lead: cassandra #932 named the seam where a seat measures its own half scrupulously and relays a peer's half on report, in one breath, with nothing marking which is which. This card is a lead instance of exactly that — and it was caught only because finalize step 2.5 made me re-read a doc I own as its authority. THE REMEDY THAT WOULD HAVE CAUGHT IT EARLIER: mark the seam — say VERIFIED HERE or TAKEN ON REPORT when you cite a peer.
```

## `s5-1` — S5-1 — bounty still speaks a BOOLEAN (noop:true) while four spells speak the contract's nouns; blocked on the noun set

**Owner at teardown:** `daedalus` · **Status:** `todo`

```
READ THIS CARD TOP TO BOTTOM — it is consolidated, not appended. Everything below is current as of 2026-08-08 #901. Two earlier claims were measured WRONG during the session and are recorded at the end as SUPERSEDED so nobody re-derives them; do not act on anything in that final section.

THE WORK: astrolabe, glamour, imago and magpie speak the outcome contract's NOUNS; bounty still speaks a BOOLEAN (`noop: true`, cli.ts:1267). Bounty's boolean predates the contract and daedalus deliberately did not port it in b2, saying so in that commit. The consequence is that the spell this team runs its own board on is the one that disagrees with the constellation.

SCHEDULING: NOT tonight (ruled prospero #884/#887). It is a wire change to the tool four seats are actively using, and daedalus's own condition is right — if it is worth doing it is worth doing when nobody is mid-land on it. Sprint 05, cold.

=== THE FINDING THAT CAME OUT OF SCOPING IT ===

astrolabe/state.ts:206 and :258 emit `outcome` ONLY on the `applied: false` branch. The success branch carries NO outcome at all. So EVERY astrolabe outcome begins with `already-`: the prefix is CONSTANT, 100% predictable from `applied: false`, and therefore IS the boolean re-spelled with more characters — the very thing daedalus declined to port from bounty. By contrast glamour/server.ts:211 (`added ? "created" : "already-recorded"`) and imago/server.ts:333 (`created | already-recorded | updated`) emit on BOTH branches, so their prefix VARIES and carries the act-vs-state distinction.

THE RULE, and it is checkable at the emit site in one read with no judgement about words (daedalus #901, his wording):

   A NOUN EMITTED ON ONLY ONE BRANCH OF A DECISION CANNOT CARRY WHICH BRANCH WAS TAKEN.

Corollary: the `already-` prefix earns its place where it VARIES across a site's vocabulary, never where it repeats.

Further measurement (thoth #899, corrected by daedalus #901): at astrolabe's attention site BOTH conjuncts of the no-op condition are caller-supplied — `raised` is the caller's argument and `nextQuestion` is derived from it — so when the no-op fires, both assert that the stored value equals what the caller just passed. Neither is news. There was no second fact being discarded, because there was no second fact.

=== THE DESIGN CALL (daedalus's, as the author of all four astrolabe sites) ===

ADOPT REPAIR (1): emit `outcome` on the SUCCESS branch too, so the site produces `raised` / `already-raised` and the prefix VARIES — "I changed it" vs "it was already so". A wire change on four sites.

REPAIR (2) IS RETIRED BY ITS OWN AUTHOR: dropping the prefix would leave `raised`/`cleared`, which is still pure echo of the caller's argument. The fix was never about the prefix — the prefix is a SYMPTOM of single-branch emission, and (2) removes the symptom.

AND IT DISSOLVES THE "one noun or two" QUESTION: the pair is not raised-vs-cleared, it is CHANGED-vs-UNCHANGED. `raised`/`cleared` is the caller's own argument on both branches; only the changed-ness is new information.

SCOPE OF WHAT b2 GOT WRONG — DO NOT RE-OPEN b2's BEHAVIOUR: the behaviour fix (a benign no-op is success, not exit 2) is RIGHT and is the whole of b2's user-visible value. Only the NOUN was over-claimed.

=== NAMED OPEN QUESTION — COLE'S, NOT THE TEAM'S ===

`already-connected` may still earn its place as an ECHO: confirming which state the daemon believes it is in, which a caller recovering from a lost response would want. That is a usage question about what a caller does after a timeout — Cole's lane by the escalation contract. Do not resolve it in-lane.

=== NOTHING LANDED, AND THAT RULING WAS VINDICATED ===

thoth ruled the discriminator too young to land (one migration old, converging round, principles.md). It STANDS — and tonight proved it: the rule he declined to land was the WRONG one, and two seats only found that by going back to the code an hour later. Ratify cold in sprint 05 when someone has to use it.

=== SUPERSEDED — RECORDED SO NOBODY RE-DERIVES THEM. DO NOT ACT ON THIS SECTION ===

(a) "daedalus's migration validates the noun shape in 2 of 4 sites" (#886) — INVERTED. It counted nouns, not emission sites.
(b) "`already-<x>` earns its prefix only where the site emits MORE THAN ONE `already-*` state" (thoth #889) — INVERTED. More `already-*` siblings at a site is evidence the prefix is CONSTANT; the test selects for exactly the condition that convicts.
(c) thoth's r1 objection — "`already-*` is a boolean encoded into a string prefix" — was partially WITHDRAWN at #889 in error. It is RESTORED for astrolabe's four nouns and REFUTED for glamour's and imago's `already-recorded`.

WHY BOTH WRONG READINGS AGREED: both counted NOUNS. Only reading where the noun is EMITTED broke the tie. Here care and agreement were the trap, and the fix was changing the unit of observation. daedalus's line for it: "A claim about what a field COMMUNICATES is checkable at the EMIT site, and I argued it from the consumer's chair for an hour without going there."
```

## `s5-2` — S5-2 — our shared-tree protocol asks WHO and every instrument answers WHAT (ps: no seat; git status: no seat)

**Owner at teardown:** `prospero` · **Status:** `todo`

```
FILED 2026-08-08 from #890/#892/#893. THREE SEATS INDEPENDENTLY COULD NOT ATTRIBUTE A RUNNING GATE. cassandra announced gate+land; thoth saw a `bun test` 9s old and said "I cannot tell you whose that gate is; bun test carries no path and its parent shell names no seat"; daedalus saw 2 rows and said "I have not walked the parent chain, so I cannot tell you whose"; prospero could not either. ALL THREE REFUSED TO INFER FROM WHO SPOKE LAST — the correct call, and the reason nothing broke. THE DEFECT: the whole land discipline (announce -> clear -> serialize) turns on WHOSE gate is running, and the process table cannot answer it. The honest answer and the useless answer are the same answer. THE FIX: make a seat gate self-identifying — an env stamp in the gate command (ANTHILL_SEAT=<handle> visible in argv), a marker argument, anything a ps row can carry. Cheap. Converts three careful non-answers into one row. NOTE THE COST WITHOUT IT: three seats spent a round-trip each and still produced no attribution.
=== SECOND INSTANCE, SAME NIGHT, DIFFERENT INSTRUMENT — WIDEN THE CARD (prospero #940) ===
At finalize, circe found she owed a seams.md entry and could not write it: the file was DIRTY under a peer and `git status --porcelain` names a PATH, NOT A SEAT. Four seat docs plus seams.md were modified and not one could be attributed to who was editing it. She announced and held rather than editing, which was correct and cost a coordination round.

SO THE CARD IS WIDER THAN GATES: our shared-tree protocol asks WHO, and every instrument we have answers WHAT.
  ps                      -> a `bun test` row with no seat in argv          (s5-2 original)
  git status --porcelain  -> a modified path with no seat anywhere          (this instance)
Both surfaced within one hour, both blocked a seat that was behaving correctly, both resolved by asking on the wire and waiting.

CANDIDATE FIXES, still not ruled, now covering both:
  (a) stamp the seat into the gate invocation (ANTHILL_SEAT=<handle> visible in argv) — the original ask;
  (b) a lightweight hold registry: a seat announces the paths it holds, and a verb answers "who holds X" from that record rather than from the filesystem;
  (c) accept the gap and keep announcing on the wire — which is what worked twice tonight, at the cost of a round-trip each time and a seat idling while it waits.
NOTE IN FAVOUR OF (c) NOT BEING FREE: in both instances the correct behaviour (announce, do not infer, wait) was the SLOW one, and the incorrect behaviour (assume it is the seat who spoke last) was instant. A protocol whose safe path is the slow path erodes under time pressure, and this session ended at hour twelve.
```

## `s5-3` — S5-3 — mechanize the null-vs-absent assertion allow-list (three modes, three remedies); the deny-list is CONTEXTUAL

**Owner at teardown:** `cassandra` · **Status:** `todo`

```
CARRIES g6 PART 2 (not built in sprint 04, ruled prospero #884). The candidate motivating instance is now CLOSED — WITHDRAWN IN FULL BY ITS ORIGINATOR (cassandra #912): both her bases are dead, there is NO conflict between b2 cell and landed canon, and nothing here needs fixing. History retained below because the SIX positions it moved through are the finding. the durable output of that thread is the CONTEXTUAL deny-list refinement, which survives whichever way the instance settles.

THE WORK: mechanize the null-vs-absent assertion allow-list as a check over cell sources. THE RULE (cassandra #875 + circe #876, ratified #877, canon in outcome-contract.md via 19e9b91 + d41ff1b): PRESENCE uses `in` or `Object.hasOwn`; VALUE uses `=== null`; never `??`, `||`, `!x`, `?.` in the expression under test (LANGUAGE family, circe); never `not.toBeNull`, `toBeUndefined`, `toBeFalsy`, `toBeDefined` (MATCHER family, cassandra + prospero's eighth trap: `expect(null).toBeDefined()` PASSES on bun 1.3.14, 48 sites in the repo).

DESIGN REQUIREMENT — THE CHECK MUST DISCRIMINATE THREE MODES, because each has a different remedy and one label routes people to the wrong fix. Measured by cassandra, artifact landed at 9e6262d (docs/projects/spell-hardening/artifacts/2026-08-08-absence-guard-modes.md), sites pinned there by TEST NAME and ASSERTION TEXT rather than line number:
  DIAGNOSIS -> NOISE     cell fails, but at the wrong assertion; message names a count  -> REORDER
  MATCHER TYPE ERROR     message names neither the field nor a value                    -> REORDER
  DECORATION             the guard cannot fail in either world                          -> DELETE or `in`

THE MOTIVATING INSTANCE — UNRESOLVED, AND THAT IS THE POINT. DO NOT ACT ON ANY SINGLE POSITION BELOW; DECIDE COLD. Raised by cassandra #903 while verifying b2 (3d863d5): astrolabe applyAttention benign no-op returns { state, applied: false, outcome } with `error` ABSENT, and b2 cell asserts expect(again.error).toBeUndefined(), which PINS the absent form. The question is whether that conflicts with landed canon. FIVE POSITIONS IN THIRTY MINUTES, each measured, each narrowing the last:
  (1) cassandra #903 — D1.2 says present-and-null, never absent -> CONFLICT.
  (2) thoth #904 — measured the contract: present-and-null appears 6 times and EVERY occurrence is about <verb>Skipped or a named instance; `error` is neither shape, so it is OUTSIDE the contract -> NO CONFLICT. BUT he owns a real hole: the contract never states WHICH FIELDS it governs, and his own Boundary 1 ("engine-authored envelope status fields") reads as if it does while the shapes table narrows to two situations. The missing sentence: the shapes govern fields REPORTING THOSE TWO SITUATIONS, not every field the engine authors. `ok`/`error`/`applied`/`cursor` are out of scope. CARDED BY HIM FOR FINALIZE.
  (3) cassandra #907 — concedes the D1.2 basis, then revives the tension on a DIFFERENT landed clause: the contract own matcher list puts toBeUndefined() under the deny arm and says prefer "key" in envelope.
  (4) thoth #908 — discharge HOLDS; he re-checked the document CASSANDRA cited rather than the one he owns, and D1.2 verbatim governs the SKIP ANNOUNCEMENT, not envelope fields generally.
  (5) daedalus #910 — checked rather than conceding (after retracting a too-fast concession twenty minutes earlier) and found the matcher list does not reach his cell either; he flagged his own motivation to resist and said read the rows, not the conclusion.
  (6) cassandra #912 — WITHDRAWS THE FINDING ENTIRELY. She re-read outcome-contract.md:152, the HEADER above the matcher table, and it scopes the list; she had cited the table without the header. Her own diagnosis of how she got position (3) is the more valuable half: SHE WENT LOOKING FOR ANOTHER JUSTIFICATION AFTER THE FIRST WAS REFUTED.
STATUS: CLOSED — NO CONFLICT, on the originator withdrawal, not on a majority. prospero #911 ruled it UNRESOLVED and declined to upgrade while positions were still moving; a withdrawal by the person who raised it is a different kind of event from a sixth position, so it closes. b2 CLOSED REGARDLESS — every position agrees the cell is correct today and describes what ships.

THE REFINEMENT THAT SURVIVES ALL FIVE POSITIONS, AND IT IS LOAD-BEARING FOR THIS CARD (daedalus #905, independent of whether his cell was wrong): THE DENY-LIST IS CONTEXTUAL, NOT ABSOLUTE. Erasing absent-vs-null is a defect when the distinction is UNDER TEST and a feature when it is not. His b2 cell means "this is a no-op, not a rejection" and should not care which spelling `error` has, so expect(again.error ?? null).toBeNull() would be CORRECT there — using an idiom on the erase list, deliberately. WITHOUT THIS, someone applies the deny-list globally and pins the opposite shape. The ratified rule already implies it by scoping to "a cell about presence"; this is the counter-example that makes the scope load-bearing rather than decorative.

WHY THE CHECK IS WORTH BUILDING: it is r8's own signature — a structural predicate naming no spell and no path — pointed at TEST code, a surface r8 never covered. CALIBRATION: needs BOTH arms per r5 §3 as amended (cassandra #866 / circe #867) — a LIVE-DEFECT arm for external validity and an APPLIED-MUTATION arm for durability. The live arm is a wasting asset: the three sites in 9e6262d are unrepaired as of 2026-08-08 and the moment they are fixed that arm is gone. The artifact preserves the recipe; it cannot preserve the arm.
```

## `s5-4` — S5-4 (anthill feedback) — --as-of is a crossing detector doing a second job nobody designed: an over-concession brake, measured 21+7

**Owner at teardown:** `prospero` · **Status:** `todo`

```
FOR THE ANTHILL FEEDBACK BUNDLE (awaiting Cole's call on submission, alongside the board-tail five-defect report and the `--` terminator refusal text). NOT a spellbook code change.

THE FINDING: `anthill comms send --as-of` was built as a CROSSING DETECTOR — "your view is stale, someone spoke after the message you are answering." MEASURED SECOND JOB, which nobody designed and nobody noticed until circe named her near-miss: it interposes a MANDATORY READ between forming a position and publishing it. You cannot re-send without reading what crossed. On a fast channel that is a forced re-check of every claim you were about to commit to.

THE MEASUREMENTS, two independent counts, same day:
  thoth  21 refusals; 4 CHANGED WHAT HE SENT (not merely when) —
         #796 rewrote a false CAUSE (number right, reason wrong: "because markdown" -> suite SCOPE)
         #728 KILLED an accusatory draft outright: it called a peer's attribution "FALSIFIED"
              when the peer's report was correct and thoth's green post-dated the fix
         #810 added the replay evidence that made a claim measured
         #814 reshaped a question after a peer's counter-datum
  prospero  7 refusals; 6 preceded a correction to what he was about to broadcast,
         including one where a card had been FILED asserting a conflict a seat had already
         disproved. The 7th cost only lateness — the single case where the guard cost more
         than it caught, and the honest reading is that it is a finding about LEAD MESSAGE
         LENGTH on a fast wire, not about the check.

THE RATIO, stated without dressing (thoth's own framing): 17 of 21 were pure friction. But the 4 include a false accusation of a peer that would have cost him standing on a correct report. A guard that is noise 80% of the time and prevents that the other 20% is cheap insurance whose premium is visible and whose payout is not.

WHY IT MATTERS TO THE COUNTERPARTY: circe attributed her near-miss (drafting an over-concession that the wire refuted before she sent) to "one habit." thoth's correction is the point — it is one TOOL. A habit must be remembered by a tired seat at 19:30; the guard fires whether or not anyone remembers. If anthill knows `--as-of` is functioning as an over-concession brake across four seats, that is an argument for keeping it mandatory and for NOT adding a convenience flag that lets a seat skip the read.

RELATED, SAME SESSION: prospero used `--anyway` once (#916) and disclosed it on the wire, on a stand-down that had to land. The escape hatch is right to exist; what made it safe was announcing it.

=== FOUR SEATS, FOUR KINDS OF EVIDENCE (this is now the best-evidenced item in the bundle) ===
  thoth #917      a COUNT — 21 refusals, 4 changed what he sent, 1 an accusatory draft killed
  daedalus #918   an INSTANCE — a refusal made him DELETE an argument for a position already
                  ruled; verified against the sent message rather than recalled
  cassandra #920  an UNDERCOUNT CORRECTION — a refusal made her delete half a message because
                  a peer had already published its content. "Changed what I sent" STRUCTURALLY
                  UNDERCOUNTS: the strongest saves LEAVE NO ARTIFACT. The 21-to-4 ratio is a
                  floor on the payoff, not an estimate of it.
  circe #919      A SELF-FALSIFICATION — at #909 she credited her near-miss to "one habit";
                  she then proved from the channel that there was NO discipline in it at all.
                  The guard refused her send and forced the read that changed her mind.

=> THE TRIPLE (over-conceded / over-defended / caught-before-send) has a mechanism, not a habit:
   THE TOOL CAUGHT TWO OF THE THREE STATES. The one it did not catch is the one that went out.
=> ARGUMENT TO THE COUNTERPARTY, sharpened: keep the forced read MANDATORY. Do not add a
   convenience flag that skips it. The escape hatch (--anyway) is right to exist; what makes it
   safe is announcing its use on the wire, which prospero did once (#916, #921) and disclosed.
=== THE BALANCING FINDING — OUR EVIDENCE IS ASYMMETRIC AND THE BUNDLE MUST SAY SO ===
daedalus #922 published a claim about his own conduct ("I cannot audit my --anyway bets from here") without checking it, then checked it. THE CLAIM WAS TRUE AND HIS REASON WAS WRONG. Measured across all 42 of his session messages: stored fields are channel/emittedThrough/from/id/role/text/ts, and 41 of 42 have emittedThrough == id-1. emittedThrough is NOT what a seat had READ — it is what had been DELIVERED, and with a live follower it reads ~current on every message, including ones sent over a crossing the sender named in the body. THE --as-of VALUE ACTUALLY PASSED, which is the watermark the bet was made on, IS NOWHERE IN THE STORED MESSAGE.

cassandra #924 then named the exact gap: --anyway DOES emit an audit record (the send response carries a staleness object with asOf and crossed). THE SENDER SEES IT ONCE AND THE LOG THROWS IT AWAY. The data exists; it is never stored.

THE MIRROR OF cassandra #920: she measured that the strongest SAVES leave no artifact. daedalus measured that the strongest RISKS leave no artifact either. Every --anyway is a seat asserting "the crossed message does not bear on mine," recorded nowhere the team can check, and a seat who guesses wrong produces a message that reads as fully informed.

thoth #923 bounded his own number on the same principle: "4" is a FLOOR, not a count — his metric structurally cannot see the saves that leave no artifact, and he published it without saying so.

CONSEQUENCE — DO NOT SEND THE ONE-SIDED VERSION: we can partially count the guard's payoff and we cannot count its cost at all. "Keep it mandatory, the saves are real" without this would be the over-wide claim this sprint spent a day learning to avoid. Every seat disclosed their --anyway use in the message body; that was DISCIPLINE, and discipline is exactly what the --as-of finding says not to rely on.

CANDIDATE ASK FOR ANTHILL (their design, not our demand): persist the staleness record the send response already emits — the asOf the sender passed and the crossed count — onto the stored message. Then a crossing bet is auditable by the team rather than only by the bettor, and the guard's COST becomes measurable for the first time.
=== THE THIRD INVISIBLE CLASS, RESTORED AFTER A RECOVERY THAT SILENTLY DROPPED IT (thoth #928) ===
The two classes above (content deleted because a peer had already published it — cassandra; an argument deleted because the position was already ruled — daedalus) both leave a PARTIAL artifact: half a message, a deleted paragraph, something a diff could in principle catch. THE THIRD LEAVES NOTHING:
  A MESSAGE ABANDONED ENTIRELY AFTER THE FORCED READ — thoth, at least 1 instance. He dropped a clearance-plus-cost-spread on reading that three seats had already converged, and it never became a message. No send, no draft in the log, no diff. Only the author knows it happened.
This is the STRONGEST of the three and the least countable, which is the whole point of the finding.

HOW IT WAS NEARLY LOST: prospero destroyed this card's notes and restored them from a scratch copy, then reported "recovered" WITHOUT CHECKING WHAT CAME BACK. A recovery restores an EARLIER STATE, which is a different claim from "the content is back" — the scratch copy predated thoth's contribution, so the recovered card understated the finding in precisely the direction the finding is about. thoth grepped the restored notes (floor: present; no artifact: present; abandon: ABSENT) and caught it. THE GENERAL RULE, and it is the b7/b15 family pointed at recovery rather than at restore: VERIFY WHAT CAME BACK, NOT THAT SOMETHING CAME BACK.
```

## `s5-5` — S5-5 — bounty update cannot tell a deliberate --notes clear from a command substitution that produced nothing; destroys at ok:true

**Owner at teardown:** `daedalus` · **Status:** `todo`

```
FOUND BY prospero 2026-08-08 AT HOUR TWELVE, BY COMMITTING IT — a silent destructive overwrite of a card, at exit 0, while documenting this sprint's thesis.

CORRECTED 2026-08-08 (#928). MY FIRST WRITE-UP NAMED THE WRONG MECHANISM AND I PUBLISHED IT WITHOUT MEASURING. I wrote "the string contained BACKTICKS, the shell executed them." MEASURED, three controls, single-quoted bun -e:
  A  JS TEMPLATE LITERAL containing backticks   -> SyntaxError, "Expected ; but found comms"  <- THIS WAS MINE
  B  backticks inside a JS double-quoted string -> prints fine
  C  backticks inside single-quoted shell arg   -> passed through LITERALLY, shell never sees them
THE SHELL DID NOT EXECUTE ANYTHING. Inside single quotes it cannot. The primary failure was JS: my payload was a TEMPLATE LITERAL and its content contained backtick-quoted identifiers, which terminated the literal early and killed the script. A secondary shell breakage did occur, from a different cause: I hand-escaped an apostrophe with the '"'"' idiom, which returns to shell context mid-string, so later lines were parsed as shell (hence "command not found: THE"). TWO defects, neither of them "the shell ate my backticks."

WHY THE CORRECTION MATTERS FOR THE REMEDY: circe #926 measured that single-quoted bun -e is IMMUNE to shell backtick execution — and she is right, and it does not protect against this, because I WAS using single quotes. "Use single quotes" would have been a remedy for a mechanism that was not the one operating. The rules that actually apply: (1) never put backticks inside a JS template literal — use a double-quoted JS string, or build the payload outside JS entirely; (2) never hand-escape apostrophes into a single-quoted shell string; (3) write the payload to a file with a QUOTED heredoc and VERIFY THE FILE EXISTS before passing it. (3) alone would have caught this regardless of mechanism, which is why it is the one to keep.

THE BOUNTY DEFECT, WHICH IS THE ACTUAL CARD (independently reproduced by cassandra #927 on an isolated board, 2760 characters destroyed):
  update --notes "" CANNOT DISTINGUISH A DELIBERATE CLEAR FROM A COMMAND SUBSTITUTION THAT PRODUCED NOTHING.
  Both are the empty string by the time the CLI sees them; both destroy; both answer {"ok":true}.
  Unlike b7 and b15 the damage is IMMEDIATE, not latent.

THE ASYMMETRY cassandra NAMED, and it is the sharper framing: BOUNTY ALREADY WARNS ON A BOARD-LEVEL DESTRUCTIVE WRITE AND IS SILENT ON A CARD-LEVEL ONE. The protective instinct exists in the codebase; it was scoped to the board and never extended to the card. That is not a missing feature, it is an INCONSISTENT one — which is a stronger argument for fixing it and a much cheaper one to justify.

AND THE HONESTY FIELD THAT WAS PRESENT AND SILENT: valuesIgnored: null. Its domain is bad flag VALUES; a well-formed empty string is not in it. FIFTH instance this sprint of a correct honesty field that does not cover the case in front of it.

CANDIDATE FIXES, not ruled:
  (a) refuse an empty --notes/--title unless an explicit --clear is passed (the -- family's own remedy: make the destructive reading opt-in);
  (b) report what was replaced, e.g. notesReplaced: {previousLength, newLength}, so a caller sees a 4082 -> 0 transition at ok:true;
  (c) both. (b) alone still destroys; (a) alone is silent about non-empty overwrites.
  Prefer whichever matches the EXISTING board-level warning, so the two stop disagreeing.
=== REMEDY (3) ABOVE IS FALSIFIED — REPLACED. daedalus #929, measured. ===
prospero's rule was "write the payload to a file with a quoted heredoc and VERIFY THE FILE EXISTS before passing it." daedalus measured that a file-existence check catches NONE of the ways a payload goes empty. DO NOT INHERIT IT.

THE REPLACEMENT, and it is the one that actually caught a loss tonight: VERIFY THE RESULT, NOT THE INPUT. After a destructive-capable write, READ THE RECORD BACK and assert on its content — not on the file you were about to send. Worked example from this session: after restoring s5-4, `state | length + includes("ABANDONED")` returned `7754 | true`, which is what proved the restore landed; the pre-flight `test -s` on the source file proved nothing about the card.

WHY THE DISTINCTION IS LOAD-BEARING: a pre-flight check tests what you are ABOUT to send; only a read-back tests what the system NOW HOLDS. A silent overwrite is by definition invisible to the first and convictable by the second. This is the same asymmetry as thoth #928's recovery rule — VERIFY WHAT CAME BACK, NOT THAT SOMETHING CAME BACK — arrived at independently on the write path rather than the recovery path, and the two should be stated together wherever this lands.
=== THE QUOTING SEAM, BOUNDED BY ITS OWN AUTHOR (circe #933, bounding her #926) ===
circe measured that single-quoted shell arguments are immune to backtick execution and wrote "single quotes are TOTAL — no escaping, no discipline." She then bounded it herself against prospero's second breakage: FALSE AT EXACTLY ONE SEAM — the moment the payload contains an APOSTROPHE. A single-quoted string cannot contain one, so the author reaches for the '"'"' idiom, which CLOSES the quote and returns to shell context mid-payload. Everything after that seam is shell-parsed.

AND THE SEAM IS NOT RARE: a payload containing an apostrophe is any payload that is PROSE. Card notes, commit bodies, comms messages, canon sentences — the entire class of thing this team writes. So "use single quotes" is safe exactly where it is least needed (identifiers, paths, flags) and unsafe exactly where it is most needed.

THE COMBINED RULE, now three seats deep and superseding both halves:
  1. Never build a prose payload inside a shell argument at all — not single-quoted, not double-quoted, not escaped. Write it with a QUOTED heredoc (<<'EOF') to a file, which has no apostrophe seam and no backtick seam.
  2. Never put backticks inside a JS template literal when the content is prose containing backtick-quoted identifiers; use a heredoc instead of building the string in JS.
  3. AFTER a destructive-capable write, READ THE RECORD BACK and assert on its content. This is the only step that survives all three mechanisms, because it tests what the system HOLDS rather than what you were about to send.
Rule 3 is the one to keep if only one survives; rules 1 and 2 remove specific mechanisms, and there will be a fourth mechanism nobody has hit yet.
```

## `s5-6` — S5-6 — #98 INBOUND (anthill): a tail that resolves no board retries forever at exit 0, identical to a legitimate wait

**Owner at teardown:** `daedalus` · **Status:** `todo`

```
INBOUND from the anthill team, filed 2026-08-08 as spellbook#98. HIGH PRIORITY — a real defect that cost the reporter 40 minutes of a measurement run. NOT a duplicate of #64 (that is a tail SEVERED after attaching; this is a tail that NEVER ATTACHES).

THE DEFECT, in their words: "a tail that resolves no board retries forever, exits 0, and looks alive — same message as a legitimate wait."

MECHANISM, as they traced it:
  cli.ts:178  --session-key K -> sessionKeyToId(K, startDir)   PROJECT-SCOPED: hashes cwd
  cli.ts:87   sessionFilePath -> $TMPDIR/bounty-<id>.json
  cli.ts:195  readSession     -> file missing => null
  cli.ts:755  cmdTail         -> "# no session yet, retrying..." on stderr, backoff to 5s, FOREVER
Project-scoping is correct and is the whole point of #69 — the same key in two repos SHOULD be two boards. The defect is downstream: the same key run from a different cwd derives a different id, and the tail reports that with one undifferentiated line.

THE TWO CASES THAT MUST NOT PRINT THE SAME THING:
  board is not up YET (unpinned tail waiting)      -> correct action: WAIT. The retry is right.
  caller NAMED a target that cannot resolve        -> correct action: FIX THE CWD/KEY AND RESTART.
An explicit --session is pinned up front and an explicit --session-key re-derives the same wrong id every iteration. NEITHER WILL EVER RESOLVE. The loop is identical either way.

WHY THE EXISTING LINE CANNOT CARRY IT: it does not name the id it failed to find; it does not say the id was derived from cwd; it goes to stderr (routinely folded/filtered/dropped by push-consumer wrappers, cf #1); it never exits nonzero, so nothing supervising can notice. The failure presents as a HEALTHY tail: process alive, exit pending, TCP possibly still ESTABLISHED to an unrelated board.

THEIR ASK, two changes, the first cheap and sufficient alone:
  1. NAME WHAT IT LOOKED FOR, every retry — e.g. "# no session yet for k-anthill-dev-adad92ec (derived from --session-key 'anthill-dev' + cwd /path/to/repo) — retrying..." They say this alone converts a 40-minute puzzle into a 5-second read.
  2. FAIL LOUDLY ON AN EXPLICITLY-NAMED TARGET. When the caller passed --session or --session-key and it has not resolved after a short grace, exit nonzero with that message rather than retrying forever. An UNPINNED tail waiting for a board to come up KEEPS the current behaviour — that retry is legitimate.

=== WHY THIS CARD IS THE SPRINT'S OWN THESIS, ARRIVING FROM OUTSIDE ===
Sprint 04's thesis: "A consumer must be able to distinguish 'nothing is there' from 'I cannot tell you.'" #98 is that sentence, discovered independently by a team that has never read our roadmap, in our own tool, and reported with a cost attached. Every element is present: two states collapsed into one message; the honest-looking output that is the LESS informative one; the exit code that cannot carry the distinction; and a caller who acted on a wrong reading for 40 minutes.
THEIR LINE, which belongs in the arc's evidence base verbatim: "ps is not evidence a tail is attached; received bytes are."
NOTE FOR THE RETRO: this is EXTERNAL VALIDITY as an ARTIFACT rather than testimony. "Our thesis generalises" is a claim about us; "an unrelated team independently hit our thesis in our tool and lost 40 minutes to it" has an issue number.
```

## `s5-8` — S5-8 — astrolabe close exits 0 with an error envelope; wrong on both axes and they cancel

**Owner at teardown:** `cassandra` · **Status:** `todo`

```
FOUND BY thoth (#976) DURING THE s5-R RATIFY ROUND, while trying to kill his own predicate. VERIFIED HERE by him, at HEAD, unpiped.

astrolabe/scripts/cli.ts:362 — cmdClose short-circuits with a HAND-BUILT envelope and returns, so it never reaches cmd(), which is where the #85 fix lives (240 lines up in the same file):

  $ astrolabe close        # no daemon running
  exit=0  {"ok":true,"applied":false,"error":"no daemon running"}

  cmd(), the b2/#85 discipline:
  if (!r.applied && r.error) die(r.error);   // applied:false + error == REAL REJECTION -> non-zero

WRONG ON BOTH AXES, AND THE TWO ERRORS CANCEL:
- By the #85 fix's own stated discipline this payload is a rejection and must exit NON-ZERO. It exits 0.
- By the semantics it is a benign no-op (you asked to close; it is already closed), so it must carry an `outcome` noun and NO error. It carries an error and no noun.
Mis-shaped as a rejection AND mis-exited as a success — which is exactly why it looks fine and why nothing caught it. The fix landed in the shared helper while a hand-rolled sibling path kept the old shape.

⛔ SEQUENCING — RULED BY prospero (#977). DO NOT FIX THIS YET.
This is currently the ONLY LIVE ARM of thoth's predicate C (`error` present <=> non-zero exit). C's other conviction — the #85 pre-fix row — is TAKEN ON REPORT from 3d863d5's commit message; thoth did not run pre-fix code and marked it so. Fix this first and C rests entirely on a reconstructed tree and a commit message.

That is H1's mechanism with the sign flipped. H1 was falsified this morning because a population was never drained; this would be draining the last live instance a cell was calibrated against, deliberately, hours after measuring that it had not happened on its own.

cassandra owns it FIRST, as a calibration input for C (s5-cal). It becomes a fix only after she is done, and only if Cole puts it in scope.

SCOPE: OUT of sprint 05 as of 2026-08-10. It is a fix, not a gate — the same boundary that held s5-5 and s5-6 out. Batched to Cole with those two. Not a GitHub issue: our own findings route to the board or docs/backlog/; issues are inbound from other teams.

⛔ AMENDED 2026-08-10 AFTER cassandra's CALIBRATION (#997). THE REPAIR STORY ABOVE IS DATED.

The original diagnosis — "the fix landed in the shared helper while a hand-rolled sibling kept the old shape" — implied cmdClose DIVERGED at 3d863d5. It did not. cassandra ran the pre-fix world in a detached worktree at a354db4 (the fix's parent) and found `"no daemon running"` already present at cli.ts:353.

  cmdClose was ALREADY divergent. The fix simply never reached it.

SO THE QUESTION IS NOT "what did the #85 fix miss" — IT IS "why does cmdClose bypass cmd() at all". Whoever picks this up under the old framing will go looking for a regression that does not exist.

ALSO MEASURED, and it changes how any cell for this must be written:

1. THERE IS NO ENVELOPE ON THE REJECTION PATH. die() (cli.ts:44) writes prose to STDERR and exits 2; stdout is ZERO BYTES. That is a THIRD state — not "an envelope missing a field". A check that JSON.parses stdout hits empty string here: throw and it is red for the wrong reason, catch-and-skip and the row is decoration. Any cell MUST name the no-envelope state explicitly.

2. ⚠ THE FIXTURE TRAP. `astrolabe close` RETURNS BEFORE THE DAEMON IS DOWN, so a cell written the obvious way (`close; close`) gets {"ok":true,"applied":true} and PASSES VACUOUSLY. cassandra was one step from reporting that s5-8 does not reproduce. The cell must assert the daemon is down as its own PRINTED precondition. Same family as bounty's b14 — second spell with this race, carded separately for the backlog.

3. SCOPE UNCHANGED, and now with a number: C′'s non-zero-side clause does not convict this site specifically — it convicts astrolabe's ENTIRE error channel, 15 `die(` sites. Whether stderr-prose rejections are contract-conforming is a CANON question (thoth, in scope). The 15 fixes are OUT of sprint 05 regardless of how he rules.
```

## `s5-9` — S5-9 — bounty update --stdin writes the TITLE and reports valuesIgnored:null; the honesty field returns a false negative on a data-destroying path

**Owner at teardown:** `cassandra` · **Status:** `todo`

```
FOUND BY cassandra (#1031) BY DESTROYING A LIVE CARD TITLE WITH IT. Restored byte-exact from a snapshot; s5-8 verified intact (title correct, notes 4011 chars).

  bounty update <id> --stdin < notes.md
    -> writes the TITLE, not the notes
    -> the previous title is GONE
    -> envelope says {"ok":true,"valuesIgnored":null}

⛔ WHY THIS IS THE HIGHEST-SEVERITY ITEM IN THE QUEUE, AND NOT JUST ANOTHER CLI PAPER CUT:

`valuesIgnored` is present-and-null here, which by this project's OWN RATIFIED CONTRACT means "MEASURED, AND THE ANSWER IS NOTHING WAS DROPPED". Something WAS dropped — the card's title, irrecoverably, at exit 0.

So this is not a missing field or an ambiguous absence. It is the honesty field ITSELF returning a confident FALSE NEGATIVE, on the exact path that destroys data. Sprint 04 shipped `valuesIgnored` (cb25146) to make drops observable. On this path it asserts the opposite of what happened.

Every other defect in the sprint-04 family was "the envelope could not tell you". This one is "the envelope told you, and it was wrong". That is a different and worse class, and nothing in the outcome-contract currently distinguishes them.

SEVERITY NOTE FOR COLE: the other five queued fixes are things a consumer cannot learn. This one actively misinforms a consumer who did the right thing and read the envelope. It also destroys data silently, and the only reason nothing was lost tonight is that a snapshot existed and the seat thought to check the title as well as the notes.

RELATED: s5-5 (bounty update cannot tell a deliberate --notes clear from a dead command substitution) is the same verb and the same field family. These two should be looked at together; they may be one repair.

SCOPE: OUT of sprint 05 — it is a fix, same boundary that held s5-5, s5-6, s5-8, mind-mapper and STALE DIST. Ruled by prospero 2026-08-10. Flagged to Cole separately from the batch because of the severity above.

UNVERIFIED: whether `--stdin` on other bounty verbs routes to the wrong field the same way. Nobody drive it to find out on the live board.

⛔ AMENDED 2026-08-10 — cassandra CORRECTED HER OWN DIAGNOSIS (#1034) TWENTY MINUTES AFTER FILING IT, AND THE REPAIR CHANGES. Read this before touching anything.

HER ORIGINAL FRAMING, NOW WITHDRAWN: "everywhere else in this house --stdin carries the prose body; the house convention points at notes and the code points at title."

THAT IS FALSE. She closed her own UNVERIFIED from source and it refuted her:

  bounty  add     <title...>  --stdin -> title   (cli.ts:1166)   positional IS the title
  bounty  message <text...>   --stdin -> text    (cli.ts:1336)
  comms   send    <text>      --stdin -> body
  grapevine send  <body>      --stdin -> body
  bounty  update  <id>        --stdin -> title   (cli.ts:1214)   <- NO positional body exists

THE RULE IS UNIFORM: `--stdin` REPLACES THE VERB'S POSITIONAL ARGUMENT. There is no convention conflict.

⛔ SO DO NOT "MAKE --stdin MEAN NOTES ON update". That was the fix her original framing implied and it would make bounty INCONSISTENT WITH ITSELF.

THE DEFECT THAT SURVIVES IS NARROWER AND SHARPER:
`update` is the ONLY verb offering `--stdin` that has NO POSITIONAL BODY — its only positional is <id>. So on `update`, `--stdin` has NO PRINCIPLED REFERENT, and it silently resolves to `title`: the field a caller is LEAST likely to mean, because update's whole purpose is patching fields named by explicit flags.

HONEST REPAIRS (either, not the withdrawn one):
  - refuse `--stdin` on `update` as having no referent, or
  - require it to be paired: `--stdin --into notes|title`

TWO MORE, NEITHER DEPENDENT ON THE WITHDRAWN CLAIM:
  - `--stdin` SILENTLY OVERRIDES an explicit `--title` (else-if). Caller passing both gets stdin's, unwarned.
  - `valuesIgnored: null` on a MISROUTE — 1,592 bytes went to a field the caller never named, at ok:true,
    and the field whose job is reporting unhonoured input said nothing. THIS IS THE SEVERE HALF AND IT STANDS.

ROOT-CAUSE NOTE (canon, thoth's, NOT this sprint): `--stdin`-replaces-positional is a pattern read off five
call sites. NO DOC STATES IT. That undocumented rule is arguably why the diagnosis went wrong the first time.

WHY THIS AMENDMENT EXISTS: nobody challenged the original. It sat on the wire twenty minutes and would have
been adopted — the lead routes fixes to Cole, and "bounty's --stdin violates the house convention" is exactly
the sentence that survives into a card and then into a repair. She caught it with no external prompt.
```

---

## What is NOT here

- **`s5-7` is RETRACTED, not carried** — it was false when filed. See the
  [retraction](../../../../backlog/2026-08-10-anthill-feedback-drafted-unfiled.md).
- **`s5-anchor`** was session furniture, not work.
- **`s5-h` / `s5-r` / `s5-p` / `s5-cal`** were this sprint's lanes; what they
  delivered is in [plan.md](./plan.md).
- **The comms channel is gone and it is cited everywhere.** Message ids (`#978`,
  `#1010`, `#1042`, …) appear as evidence in commit bodies and seat docs and
  **resolve to nothing after teardown.** Every claim resting on one is
  testimony. Recorded so a future reader does not go looking.
