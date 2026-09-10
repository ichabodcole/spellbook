# Grapevine drift experiment — does the census bite on a fresh break?

**Date:** 2026-08-24 · **Session:** `standard-grapevine` grapevine channel
(acc + trellis) · **Base commit:** `648366c` on
`feat/grapevine-self-declaration`

The first outside test of the acc standard's central assumption (CHARTER.md Q4):
_"an adopter binds a declaration to their code, the tool drifts from it, and the
drift check catches it."_ grapevine emits its own interface description
(`schema`, acc declaration format v0) generated from the COMMANDS registry its
parser and dispatcher walk. Each variant here breaks that pairing in exactly ONE
place; the census (`acc check --declaration`) is then asked whether it notices.

## Results

| Variant     | One-place break                                                                             | Census result                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `a-omit`    | Emitter filters `--version` out of the root args (generator drops a slot; acc DT-1's shape) | **CAUGHT** — `accepted-not-declared: --version at (root)`                                          |
| `b-phantom` | Emitter publishes a phantom `--debug` the root refuses (DT-2's shape)                       | **CAUGHT** — `declared-not-accepted: --debug at (root)`                                            |
| `c-rename`  | `schema` verb renamed `describe` in the registry only; `selfDescription` still `["schema"]` | **CAUGHT** — `self-description-not-declared: schema at (root)` (zero-probe)                        |
| `d-below`   | Emitter drops `open`'s `--fresh` — below the root                                           | **NOT caught** (negative control) — the kit's documented root-only ceiling, behaving as documented |

Three catches, correct finding kind each, first attempt; the negative control
shows the instrument is not simply agreeing with whatever it is handed. All four
broken variants still read `CONFORMANT (L0)` in the headline — reported upstream
as a report defect (an _emitted_ declaration contradicting its own tool is a
self-contradiction inside one process); acc is adding a headline annotation.

## Files

- `<variant>.patch` — the one-place break, as a unified diff against
  `plugins/spellbook/skills/grapevine/scripts/cli.ts` at `648366c`
- `<variant>.declaration.json` — what the broken binary emitted
- `<variant>.report.json` — the full acc report (`--json`), findings under
  `.data`; the census block carries both readings per finding
- `clean.declaration.json` — the unbroken CLI's emission (0 disagreements)

## Reproduce

```bash
# from the Spellbook repo at 648366c
cp plugins/spellbook/skills/grapevine/scripts/cli.ts /tmp/drift-cli.ts
patch /tmp/drift-cli.ts < a-omit.patch
bun /tmp/drift-cli.ts schema > /tmp/decl.json
bun <acc-repo>/src/acc/cli.ts check /tmp/drift-cli.ts --declaration /tmp/decl.json --format text
```

Reports were produced against the acc **develop working tree** with the
`surface.ts` short-flag fix live but not yet committed — that fix landed about
an hour later as `080c766`, so these artifacts predate the sha while matching
its behaviour exactly (it is why the false `-h`/`-V` findings from earlier in
the session do not appear here). The `c-rename` declaration is emitted via
`describe`, the renamed verb.
