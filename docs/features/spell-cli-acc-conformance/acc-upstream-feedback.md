---
type: artifact
title: "acc upstream feedback from the Spellbook conformance cycle"
description:
  The step-7 report to agent-cli-conformance, grouped by kind, from taking nine
  CLIs through the full guidance on acc v0.1.15. Filed 2026-09-27 as
  ichabodcole/agent-cli-conformance#55.
status: stable
generated: { by: claude-opus-5-5, at: 2026-09-26 }
---

# acc upstream feedback

**Filed** 2026-09-27 on Cole's go-ahead (decision log #23) as
[ichabodcole/agent-cli-conformance#55](https://github.com/ichabodcole/agent-cli-conformance/issues/55).
Items 6 and 11 repeat points from #37 and say so.

**Context:** Spellbook took nine CLIs (astrolabe, bounty, digestify, glamour,
grapevine, imago, magpie, mind-mapper, scriptorium) through all seven steps on
v0.1.15. All nine end L0 conformant with 0 knownFailures, root rejections
enumerated, and recorded surfaces read with 0 disagreements. Most of what
follows is category 3 ("it worked, and we wanted more"); items 1–4 are the ones
that cost real time.

## 1. You could not tell what to do / missing mechanism

1. **No config key for a recorded-surfaces batch or a declaration.**
   `acc.config.json` accepts only `rules`, `knownFailures`, `defaultOutput`, so
   CI passes `--recorded-surfaces <file>` and every project invents a sidecar
   name (ours: `<skill>/acc.recorded-surfaces.json`).
2. **knownFailures cannot record debt on an `unverified` rule** (it is reported
   inert). A deliberately declined `defaultOutput` (bounty keeps prose because a
   downstream tool regex-parses it) has nowhere to live in the config.
3. **A stale or inert knownFailures entry does not change acc's exit code.** To
   enforce "a fix deletes its debt line" we parse the JSON in our own ward.
4. **Verbless tools:** with `--declaration`, a tool whose root is the command
   read 4 disagreements until its unknown-flag `choices` listed
   `--help`/`--version`; nothing says what a root row's `choices` should hold.
   probe-plan then offers only registry-added rows, and the advertised-verbs
   comparison silently does not run.

## 2. It reported something misleading

5. **B5 checks only the parse-error envelope,** yet declaring `defaultOutput`
   claims all plain output is JSON; the check and the claim don't line up.
6. **Under `bun <script>`, a leading `--` is stripped before the CLI sees it**
   (`bun cli.ts -- --x` delivers `["--x"]`). A repeat of #37 item 4: the kit's
   own probe sends `-- --` and is fine, but our golden-snapshot harness fell in
   the same hole a second time, which suggests the one-line warning in the
   skill's step 1 is still worth adding.
7. **F2 counts bundle-load time** for a `--version` served by a bundled CLI, and
   flaps under load (32–126 ms against 100 ms on the same build).
8. **The census reads only rejections:** where a verb does real work with no
   flags, nothing checks its accepted flags beyond the empty set it names; and a
   custom `help` override can drift without the census seeing it.

## 3. It worked, and we wanted more

9. **probe-plan's `recordedBy`:** stamps `-dirty` when any unrelated file is
   uncommitted, and after a history rewrite names a commit that no longer
   exists. A stale batch then reads with no warning even though it carries its
   build sha.
10. **probe-plan's harness:** no option to set `HOME`; runs `git` in a nested
    shell (blocked in some sandboxes); writes JSON that is not formatter-stable.
11. **Output format:** `acc check`/`acc report` emit JSON when piped even for
    the human report; `--format text` is needed and not obvious from the skill
    (also raised in #37; still bites on v0.1.15).
12. **The JSON report has no top-level disagreement count** or per-status
    summary for recorded surfaces; we tallied `.data.declaration.findings`
    ourselves.
13. **"N of M recorded paths enumerate the same K flags"** fires for genuinely
    global flags (`--as`/`--from`, `--session`): noise.
14. **The declaration cannot mark a flag required** (`add --path`,
    `element-add --bbox` render as optional in help and `schema`).
15. **`bunx acc` where acc is not installed** can fetch an unrelated npm package
    named `acc`; our ward pins the version for this reason.

## What we did instead (workarounds you would not otherwise learn)

- A grimoire ward runs `acc check` per spell with `--recorded-surfaces`, and
  fails on stale or inert knownFailures, a wrong `configSource`, or a kit
  version that differs from the pin.
- A golden snapshot of every CLI's accepted and rejected invocations catches
  what the census cannot (a dropped flag, help drift).
- One shared command registry drives parse, help, rejections and `schema` for
  all nine, so step 6 is one module rather than nine copies.
