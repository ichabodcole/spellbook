---
type: artifact
title: "Sprint 06 re-measure: the phase-1 queue on develop after the acc cycle"
description:
  Every phase-1 defect re-run on develop (b0e9d852) by a no-stake subagent
  before any fix was briefed, because the acc cycle had rewritten bounty's and
  astrolabe's parsers since the items were filed.
status: stable
generated: { by: claude-opus-5-5, at: 2026-09-27 }
---

# Sprint 06 re-measure

Run 2026-09-27 on `develop` at `b0e9d852` (code identical to `ebd54767`), by a
subagent with no stake in the plan, under a scratch `HOME` (`BOUNTY_HOME`,
`ASTROLABE_HOME`, `GRAPEVINE_HOME` pointed at it). References below are pinned
to `b0e9d852`; read them with `git show b0e9d852:<path>`.

| item   | status                                                                      |
| ------ | --------------------------------------------------------------------------- |
| `s5-9` | still reproduces as filed                                                   |
| `s5-5` | still reproduces, and is wider than filed                                   |
| `#98`  | changed shape: half fixed, half unchanged, plus a new false claim           |
| `s5-8` | still reproduces as filed; two supporting measurements are stale            |
| `c1`   | root half refused; the demotion half reproduces on every variadic verb (43) |

## `s5-9`: `update --stdin` writes the title

```
add "Original title" --notes "original notes" --id t1
printf 'these are my notes\n' | update t1 --stdin               -> {"ok":true,"updated":"t1","valuesIgnored":null} exit 0
printf 'from stdin\n' | update t1 --stdin --title "explicit title" -> same envelope, exit 0
readback: {"title":"from stdin","notes":"original notes"}
```

`src/bounty/backend/cli.ts:1343-1344`: stdin goes to the title, and an `else if`
lets it beat `--title`. Row at `:1632`, envelope at `:1391`.

## `s5-5`: an empty value clears the field

- `update t1 --notes ""` and `--notes "$(cat /nonexistent 2>/dev/null)"`: both
  `ok:true`, `valuesIgnored:null`, exit 0; notes read back `""`.
- **Wider than filed:** `update t1 --title ""` blanks the title at exit 0, while
  `add` refuses an empty title (`:1297`). `printf '' | update t1 --stdin` blanks
  the title at exit 0, so the two items overlap on one case.
- `--notes` with no value is already refused at exit 2 by the registry;
  `--notes=` is taken as `""`.
- **The item's comparison point is absent.** It says bounty "already warns on a
  board-level destructive write". It does not: `init --stdin-tasks` over a
  populated board wiped it at `{"ok":true,"sent":"init","tasksDropped":null}`,
  exit 0, nothing on stderr.

**Falsifier 1 ("one repair"):** two edits in one place. Both defects live in
`:1343-1346` and share one envelope, but `s5-9` is which field is written and
`s5-5` is which value. No programmatic caller relies on either (anthill 2.3.0
never calls `bounty update`; `server.test.ts:1937,2114` pass non-empty notes).
Must change with any fix: `bounty/SKILL.md:236` (verb table) and `:262-282` (the
warning), `grimoire/fixtures/cli-golden/bounty.json`, and
`.anthill/principles.md:118`. anthill's own `comms`/`commit` already refuse
empty stdin and `-m` together with `--stdin`.

## `#98`: `bounty tail` on a target that never resolves

- `--session k-nope-123`: **exits 0 at once**, printing
  `{"type":"tail.closed",…,"next":"stop","command":"open --restore k-nope-123 --no-open"}`.
  It no longer loops (`b0174d9f`, the `reArm` stop at `cli.ts:1041-1047`), but
  it says "closed" about a board that never existed, and the printed come-back
  command spawns an unrelated fresh board at exit 0 (`restoreFailed: ENOENT`).
- `--session-key NOPE`, and a real key from the wrong cwd: **still retrying**
  after 10 s with the undifferentiated `# no session yet, retrying…` (`:1046`).
- Ask 1 (name the derived id and cwd): not done. Ask 2 (fail on a named target):
  done only for `--session`, and with the wrong exit and the wrong word.
- GitHub #98 is open; PR #99 from an outside contributor closed unmerged
  2026-08-10, nothing since.

## `s5-8`: `astrolabe close` exits 0 with an error

- No daemon: `{"ok":true,"applied":false,"error":"no daemon running"}`, exit 0.
  `src/astrolabe/backend/cli.ts:409-416` still bypasses `cmd()` (`:214`).
- The race holds: `close; close` gives `applied:true` twice; a third, 2 s later,
  gets the no-daemon envelope.
- **Stale:** `die()` now writes a JSON envelope to stderr, not prose; and no
  grimoire ward references this site, so the "still load-bearing" sequencing
  constraint has lapsed.

## `c1`: `--` swallows a real flag

- Root half: `bounty -- --session-key K1` exits 2, but because Bun strips the
  `--` after the script path, so the registry's A6 branch (`registry.ts:639`) is
  not what refuses it.
- Demotion half reproduces:
  ```
  add -- hello --session-key K1  -> {"ok":true,"added":…} exit 0, title "hello --session-key K1" on the ambient board
  message -- hi --session-key K1 -> {"ok":true,"sent":"message"} exit 0
  GRAPEVINE_FROM=alice grapevine send ch1 -- hello --as mallory -> ok, text "hello --as mallory", from alice
  ```
- Population from each spell's `schema`: 227 rows, 115 non-root rows take
  positionals, **43 variadic** (39 free text, 4 path/id lists) absorb a
  post-`--` flag at exit 0; 6 more rows with one optional positional can absorb
  a boolean flag. digestify has none.

## Same class, found and not chased

1. `bounty init --stdin-tasks` over a live board wipes it at `ok:true`,
   `tasksDropped:null`, no warning.
2. `bounty open --restore <missing>`: exit 0, `restoreFailed` set, and a fresh
   board.
3. `astrolabe status x hi` refuses at exit 2 (`unknown project`) but still
   spawns a daemon.
4. `astrolabe close` with a stale port file (daemon SIGTERMed): exit 1
   `internal` "Unable to connect", a third shape for close.
