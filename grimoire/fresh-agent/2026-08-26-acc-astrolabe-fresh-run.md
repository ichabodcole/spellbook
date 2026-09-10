# acc × astrolabe — session notes (2026-08-26)

Clean-slate run of the acc conformance kit against the astrolabe spell, entry
point `skills/acc/SKILL.md` in the kit repo, treated like a built-in skill.
Logging friction, surprises, and findings as I go.

## Log

- **Path mismatch in SKILL.md's own frame.** Cole said the entry point is
  `skill/acc/SKILL.md`; the actual path is `skills/acc/SKILL.md` (plural).
  Minor, user-side, not the kit's fault — though the SKILL.md self-describes as
  "a file in the `acc` repository, at the path given," and all its internal doc
  paths remain to be verified.
- SKILL.md first read: clear ordering (install → read result → fix → optional
  subcommand recording → optional registry derivation → report back). The "NOT
  FULLY VERIFIED" framing (pass ≠ rule holds) is stated up front — good.
- Install line is
  `bun add -d git+ssh://github.com/ichabodcole/agent-cli-conformance.git` — repo
  is private, needs SSH access.

- **Install:** bun blocked a postinstall ("Blocked 1 postinstall") but acc works
  anyway via bunx. Didn't need the broken-install guide. Unclear if the blocked
  postinstall costs anything silently — candidate for the guide to mention.
- **Non-executable .ts target handled well.** cli.ts is -rw-r--r-- with a bun
  shebang; acc figured out targetArgv0 ["bun", cli.ts] on its own. Friction I
  expected did not happen. But it has a consequence: A6 (the `--` terminator) is
  UNVERIFIED because _bun swallows the leading `--`_ — the kit says this plainly
  in the report. Honest and specific.
- Piped output auto-switched to JSON exactly as SKILL.md said; `--format text`
  got me the human report.
- **Verdict: NOT CONFORMANT (L0)** — core FAILs C2 (a usage error exited 0 —
  pattern 2,2,0, third probe unknown), D1 (no --version), D2 (bare invocation
  exits 0 printing 1224B of help to stdout); diagnostic FAIL D3 (help names no
  machine-mode flag/schema command). UNVR A6 (bun launcher), A7 (no closed value
  sets advertised), B5 (+B3 N/A) — both point at `defaultOutput` in
  acc.config.json.
- The NOT FULLY VERIFIED block is long but genuinely informative — reads as a
  disclosure of probe limits per rule, not boilerplate.

## Fix pass (SKILL.md step 3, via how-to-reach-l0 guide)

- Guide's predicted gradient played out exactly: declaring
  `defaultOutput: "json"` (astrolabe is always-JSON, no mode flag) moved B5
  unverified→FAIL because die() answered parser errors in prose. "The report
  gets one violation longer for telling the truth" — accurate.
- Fixes to cli.ts: die() now emits one JSON error envelope on stderr (stdout
  stays empty — B1/B5 both hold, matching B5's note that an envelope on stdout
  would trade B5 for B1); bare invocation → usage error exit 2 (D2, which was
  also C2's third invocation — one fix, two rules); root --version/-V/version as
  a verb-position token reading plugin.json (D1; guide §6's drift warning is why
  it's a verb, not a parseArgs flag); help sentence claiming JSON-default (D3).
- **D3 prose matcher is narrower than its rule page suggests.** My first
  sentence "Output: machine-readable by default — every command answers with
  structured JSON on stdout" did NOT downgrade fail→unverified: the matcher
  needs "JSON … by default" in that ORDER within one clause (line breaks split
  clauses). Reworded to "every command prints JSON on stdout by default" →
  unverified. The rule body admits the heuristic misreads phrasings, but a
  natural sentence failing silently (report line identical to no-sentence case)
  cost a diagnosis round-trip. Suggestion: when help contains json+default
  tokens in a non-matching arrangement, hint.
- Result: CONFORMANT (L0), exit 0. Remaining UNVR: A6 (bun launcher swallows
  `--`), A7 (nothing declared to falsify), D3 (ceiling for flagless
  machine-first). All 53 astrolabe tests still pass.

## Kit findings (for step 6 report)

1. **SKILL.md step 4 names `acc probe-plan` — the command does not exist**
   (0.1.0): `unknown command 'probe-plan'`, choices [rules, show, path, tags,
   schema, check]. (acc's own rejection envelope is lovely, exit 2, names
   choices.)
2. **SKILL.md step 4 says "your report tells you which you are in — look for
   `enumerated N flags at the root:` / `did not enumerate at the root; …`" —
   neither line exists in the check report** (text or JSON). I inferred the
   situation from A7's gap text instead.
3. **how-to-reach-l0 §4 says every report names the config it read ("config:"
   line in text, `configSource` in JSON) — neither exists.** JSON data keys have
   no configSource; text has no config: line, even with --config-dir in use.
   Docs ahead of code, presumably.
4. **SKILL.md step 4 is unimplementable end to end in 0.1.0.** The recording
   guide's own `--recorded-surfaces` flag is also unknown to `acc check` (only
   --config-dir exists). So all three legs — the report lines that route you
   into step 4, the probe-plan generator, and the flag that consumes a batch —
   are documented-but-absent. Notably the wiki guide is stamped generated
   2026-08-26 (today) — docs ahead of code, presumably deliberate, but SKILL.md
   presents step 4 as available.
5. Positive: acc's own error envelope on unknown command/flag is exemplary
   (kind, exit_code, hint, choices) — the kit eats its own cooking.
6. Positive: the how-to-reach-l0 guide's triage frame (fix / waiver / debt,
   waiver-vs-debt distinction, stale-expectation ratchet) maps cleanly onto a
   real fix session; I never needed anything outside the named docs to reach
   green except for the D3 matcher diagnosis (read checker source).

## Where each step-6 category landed

- Category 1 (couldn't tell what to do): step 4's promised report lines absent.
- Category 2 (did the wrong thing): none — no crash, nothing untrue about the
  target. Closest is D3's silent non-match of a true prose claim.
- Category 3 (worked, wanted more): a hint when json+default tokens are present
  but unmatched; a config:/configSource line (already documented, just absent).

## Epilogue: the version-skew resolution and the step-4 test (same session)

- The acc maintainer identified my entire category 2 as version skew: I ran acc
  0.1.0; 0.1.1 ships probe-plan, --recorded-surfaces, configSource, and the
  enumeration lines. Measurement showed the mechanism: my `bun add` on the
  unpinned git+ssh URL was fresh, but bun resolved it from a cached clone whose
  main still sat at the v0.1.0 release merge (82a7d5d) — silent, exit 0. Fix now
  on their list: pin a committish in the install line + tell the reader what
  [acc <version>] should say.
- Remedy executed and proven: remove + `bun pm cache rm` + add `#v0.1.1` →
  0.1.1. (Note: the cache-rm prints "Cleared 0 cached 'bunx' packages" even when
  it clears the git cache that matters — the proof is the version after
  reinstall, not the remedy's output.)
- Step 4 run end to end against astrolabe on 0.1.1, at the maintainer's request:
  enumeration line present (matches the A7 inference), config:/ configSource
  present (richer than documented), probe-plan generated a readable, correct
  harness (12 paths from the dispatch table; declaration modelled from help per
  the two-artifacts advice), harness ran clean in a sandboxed ASTROLABE_HOME,
  and --recorded-surfaces consumed the batch after one validation round-trip
  (positionals need `required`; exact-key error).
- Census outcome, the honest one for a non-enumerating tool: 12 paths observed
  [recorded-by-caller], THE DIFF DID NOT RUN — astrolabe's rejections never name
  their valid set, so nothing is comparable. Reported upstream that SKILL.md's
  "recording is the only coverage you will get" oversells this: recording buys
  observation, not comparison. Astrolabe's real unlock would be enumerating
  rejections (A3's choices SHOULD) — parked as future astrolabe work, not done
  in this session.
