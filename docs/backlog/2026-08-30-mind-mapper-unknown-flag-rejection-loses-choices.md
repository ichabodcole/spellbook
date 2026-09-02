# mind-mapper: the flag rejection that an agent actually hits is the one without `choices`

**Added:** 2026-08-30 · **Found by:** a fresh-agent usability drive of the
**installed v2.2.0 artifact** (spell-kit session), then re-verified at HEAD ·
**Scope:** mind-mapper. Same rule as
[`astrolabe-per-verb-flags-and-enumerated-rejections`](./2026-08-27-astrolabe-per-verb-flags-and-enumerated-rejections.md),
**different spell and a different cause** — see _Not a duplicate_.

> ## The enumeration is already written, and it is gated behind knowing the answer

`cli.ts` has **two** unknown-flag rejection paths, and only one of them
enumerates:

| Path                                                       | Fires when                                             | Envelope                                                  |
| ---------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| **A** — the stray check (`cli.ts:464-472`)                 | the flag **is** in `CLI_OPTIONS`, just not this verb's | ✅ `message` + **`choices`**                              |
| **B** — `parseArgs({strict:true})` throwing (`cli.ts:458`) | the flag is **not** in `CLI_OPTIONS` at all            | ❌ node:util's generic text. **No `choices`, no `hint`.** |

Measured at HEAD:

```
$ bun cli.ts projects --skeleton        # A: --skeleton is real, just not this verb's
{"error":{"message":"--skeleton is not accepted by `projects` (it is a recognized
  mind-mapper flag, just not this verb's)","choices":["--create"]}}      ← the answer

$ bun cli.ts projects --xyz             # B: --xyz exists nowhere
{"error":{"message":"Unknown option '--xyz'. To specify a positional argument
  starting with a '-', place it at the end …"}}                          ← no choices
```

**Path A's message is excellent and path B's is the one a guessing agent hits.**
An agent that already knows a valid flag from another verb gets told the answer;
an agent that knows nothing gets node:util boilerplate. **The enumeration is
gated on already possessing part of what it would tell you.**

## How it was found — the cost is not hypothetical

Driving the installed artifact cold, trying to create a project:

```
projects add        → "Unexpected argument 'add'. This command does not take positional arguments"
projects --help     → "Unknown option '--help'"
projects --xyz      → "Unknown option '--xyz'"                        ← path B, dead end
```

Three rejections, no route forward — the drive stopped there. The answer,
`choices:["--create"]`, was **one lucky guess away**: `projects --skeleton`
would have printed it, because `--skeleton` happens to exist on `state`.

## Not a duplicate of the astrolabe item

Same acc guidance (_"a rejection should name the valid set"_), but the two
spells fail it for opposite reasons, and **mind-mapper is much cheaper**:

- **astrolabe** has ONE global `parseArgs` options object, so its item is
  blocked on scoping flags per verb first — naive enumeration would advertise
  `--phase` on `open`.
- **mind-mapper already has the per-verb registry.** `VERB_SPEC[path]`,
  `flagsFor(path)` and `CURRENT_COMMAND` all exist and are already used by path
  A. Nothing needs designing; path B just never reaches them.

## Acceptance Criteria

- [ ] An unknown flag on any verb returns an envelope carrying **`choices`** —
      that verb's accepted flags — regardless of which path rejects it.
- [ ] Path A's wording survives: distinguishing _"real flag, wrong verb"_ from
      _"no such flag"_ is genuinely useful and should not be flattened away.
- [ ] `--help` on a verb either works or is refused with `choices`. It currently
      returns bare `Unknown option '--help'`, which reads as "help is
      unsupported" rather than "help is not a flag here."
- [ ] A test pins **both** paths. The bug is that one was covered and the other
      was not; a test over path A alone stays green through the whole defect.

## Notes

**Not filed, and deliberately:** the same drive found `help` printing only a
one-line usage in v2.2.0 while a full 37-line `HELP` sits in the binary. **That
is already fixed at HEAD** (`cli.ts:581-587`) and is release lag, not a defect —
recorded here so the next person to notice it does not re-file it.
