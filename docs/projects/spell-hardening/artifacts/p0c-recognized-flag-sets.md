# P0c prerequisite — the recognized-flag sets for the five accumulator parsers

**Owner:** `thoth` · **Ruled** a P0c prerequisite at comms #235 · **Card**
`t-416ae497`

**P0c's builder CONSUMES this. Do not re-derive it.** The risk this card removes
is entirely in the re-derivation: `grep 'flags\.'` returns a plausible,
well-formed, complete-looking list and is **wrong in all five files** — there is
no file where the naive approach happens to work and warns you by looking odd
elsewhere.

## Read this before you use the list

**This is the best available enumeration, not the answer.** Three things travel
with it:

1. **How it was produced** — every `flags.<name>` and `flags["<name>"]`
   consumption site in each `cli.ts`, at the commit stamped below.
2. **What it cannot see** — a **computed key** (`flags[someVar]`) is invisible
   to this method. None was found; "none found" from a pattern scan is exactly
   the claim this project has been burned by, so treat every count as a
   **floor**.
3. **What you must still do** — **drive each verb before converting it.** A
   handed-over enumeration that reads as authoritative is the failure mode this
   session produced five times.

**Why it matters after step 2:** the accumulator parsers accept _everything_
today, so a missing flag is a silent no-op. Once `strict: true` lands, a missing
flag becomes a **caller-facing hard error**. `--no-open` appears in four of the
five and is used by the spells' own daemon spawns — a naive derivation breaks
four spells' internal machinery.

## The two shapes — this is not one job done six times

- **Lookup (`glamour/server.ts`, the sixth):** recognized set already enumerable
  — exactly six literals, `intent port project restore timeout title`.
  Mechanical, low risk.
- **Accumulator (the five below):**
  `for (a of args) if (a.startsWith("--")) flags[key] = …` — **no recognized set
  exists to convert.** Step 2 must _author_ it. One easy conversion and five
  authoring tasks.

## The sets

### `bounty/scripts/cli.ts` — 22 flags

```
dot form     (19): as expect fresh full id mine notes on owner pin restore session since size status stdin tag timeout title
bracket form (3): no-open session-key stdin-tasks         <- a `flags\.` grep MISSES these
```

### `glamour/scripts/cli.ts` — 25 flags

```
dot form     (23): colors content cost custom file full intent kind label model note prompt prompts restore round seed session since src status timeout title url
bracket form (2): no-open start-timeout         <- a `flags\.` grep MISSES these
```

### `grapevine/scripts/cli.ts` — 26 flags

```
dot form     (22): all as channels force fresh from hold human last literal lurk max note quiet since status stdin text timeout topic verbose yes
bracket form (4): body-file dry-run from-start in-reply-to         <- a `flags\.` grep MISSES these
```

### `imago/scripts/cli.ts` — 20 flags

```
dot form     (18): clear content full image kind link models n options prompt restore session since summary tag tags timeout title
bracket form (2): edited-from no-open         <- a `flags\.` grep MISSES these
```

### `magpie/scripts/cli.ts` — 19 flags

```
dot form     (18): alpha bbox full ids intent label model name options pad remove restore session since stdin timeout title type
bracket form (1): no-open         <- a `flags\.` grep MISSES these
```

**Totals: 100 dot-form + 12 bracket-form = 112 flags across 169 consumption
sites.**

**Every one of the five has at least one bracket-form flag**, and `--no-open` is
in four. There is no file where `grep 'flags\.'` is sufficient.

## Verification — what was checked, and what it found

Each derived set was cross-checked against its spell's `SKILL.md` documented
flags. A flag documented but absent from the consumption sites is evidence of
**a site the derivation missed** — that is the check.

**Eleven candidates surfaced. All eleven are correctly excluded; zero real
misses:**

| candidate                                | why it is not a `cli.ts` flag                                    |
| ---------------------------------------- | ---------------------------------------------------------------- |
| bounty `host` `port`                     | belong to `server.ts` (`SKILL.md:344-345`)                       |
| bounty `url`                             | belongs to `join.ts` (`SKILL.md:561`)                            |
| grapevine `line-buffered`                | **a `grep` flag**, from the Monitor incantation (`SKILL.md:370`) |
| grapevine `version`                      | no such flag; the hits are a `version` field                     |
| glamour `help`                           | a **positional verb** (`cli.ts:614 case "help"`), not `--help`   |
| glamour `format` `n` `ref` · imago `ref` | not present in `cli.ts`                                          |
| magpie `format`                          | **`media-forge`'s flag** — an external tool (`SKILL.md:160`)     |

**Two of these are live instances of the hazard that shaped this ward from the
start: `grep --line-buffered` and `media-forge --format` are OTHER TOOLS' flags,
correctly documented in our prose.** A regex-driven sweep would "correct"
working documentation. **Scope by entry point, never by pattern.**

## Denominator

**5 of 5 files read; 5 of 5 produced a set.** A zero anywhere here would be the
instrument, not the answer — a sweep that fails to run reports the same thing as
a sweep that found nothing.

_Derived and verified at `d2380a3`, 2026-08-06._
