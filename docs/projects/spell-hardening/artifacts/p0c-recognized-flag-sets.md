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

---

# P0c step 0 — the TYPES

**Owner:** `thoth` · **Ruled** a P0c blocking prerequisite at comms #295 ·
**Card** `t-f50f9d8b` · **Derived at `f77ae33`, 2026-08-06**

**This section answers the half the sets above do not.** `node:util` `parseArgs`
requires `{type: "boolean" | "string"}` **per option**. Every type below is read
off the **code that consumes the flag** — `typeof flags.x === "string"`,
`String(flags.x)`, a helper whose first line is `typeof v !== "string"`, a
comparison to `true`. **Never off `SKILL.md`, never off the flag's name.**

## ✅ CONSUMED AND VERIFIED — 6 of 6 entry points, 119 of 119 flags, zero divergence

**Re-run at `e7504cf` (P0c 6/6 landed), against the `parseArgs` registries the
lane actually declared** — not against this table's own reasoning:

```
bounty/scripts/cli.ts        15 string +  7 boolean = 22
glamour/scripts/cli.ts       23 string +  3 boolean = 26
glamour/scripts/server.ts     6 string +  0 boolean =  6
grapevine/scripts/cli.ts     13 string + 13 boolean = 26
imago/scripts/cli.ts         17 string +  3 boolean = 20
magpie/scripts/cli.ts        15 string +  4 boolean = 19

6 of 6 entry points read · 119 flags in code · 0 mismatched sets
```

**Every set compared as a SET (sorted, both directions), so an extra flag in
code and a missing one both fail.** The comparator asserts it read six files
before reporting — a partial read is an instrument failure, not a pass.

**The `glamour --restore` conflict resolved by SPLIT, which is why 118 → 119:**
`restore` (string, daemon spawn) and `unarchive` (boolean, `style-archive`). A
flag with two incompatible semantics cannot be typed; it can be **split**.
`glamour/SKILL.md:180` moved in the same commit (`a1e97a2`).

**The strongest single row: `grapevine`, 26 of 26** — 24 of those required
hand-reading, because grapevine **casts** (`flags.topic as string`) where its
siblings use a `typeof` guard. The mechanically-derived files could have been
right by luck; that one could not.

---

## Read this before you use the table

1. **The denominator is 119 across SIX entry points** (was 118 at derivation;
   `glamour --unarchive` was minted by Cole's split ruling at `a1e97a2`). **112
   is a THIRD number** — the five accumulators only, which the plan and the card
   had glued to "6 entry points."
2. **"169 consumption sites" above is LINES. There are 249 read EXPRESSIONS.**
   Both are right and they answer different questions. **A type derivation done
   per-line misses 80 reads**, and several flags are read more than once on one
   line. Counted: `grep -nE 'flags\.[A-Za-z_$]|flags\["' <file> | wc -l` → 169
   over the five accumulators.
3. **NOTHING HERE HAS BEEN DRIVEN.** Every row is static evidence at the
   consumption site. The instruction above — _drive each verb before converting
   it_ — is **step 2's obligation and this section does not discharge it.**
   Marked `UNVERIFIED-BY-CONSTRUCTION` for behaviour; verified for consumption
   shape.
4. **One flag has NO correct type. See the conflict below. It is a design
   ruling, not a cell.**

## ⛔ The conflict — `glamour/cli.ts --restore`

```
glamour/scripts/cli.ts:254   archived: flags.restore !== true,                     <- BOOLEAN semantics
glamour/scripts/cli.ts:317   if (flags.restore) daemonArgs.push("--restore", String(flags.restore));   <- STRING semantics
```

Two verbs, one flag name, incompatible types, one `options` map.

| declared  | what breaks                            | how it fails                                                                                                                                              |
| --------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boolean` | `glamour open --restore <id>`          | the id falls to **positionals**; `:317` forwards `--restore true`; the daemon hunts a snapshot named `true`                                               |
| `string`  | `glamour style archive <id> --restore` | strict **throws** "argument missing" — or **swallows the next positional as the value**, which is this sprint's own defect class re-introduced by the fix |

**Neither is a no-op. Do not resolve this in the table.**

**A separate live bug underneath it, reported not fixed:** `:254` is
`flags.restore !== true`, so when `restore` holds a **string**,
`glamour style archive <id> --restore foo` **archives instead of restoring**,
exit 0, no signal. Candidate issue; filing is Cole's.

## The types

**Every flag not named in the conflict above is settled by unambiguous evidence
at every one of its consumption sites.** A flag whose sites disagreed would
appear as a second conflict row; exactly one did.

### `bounty/scripts/cli.ts` — 22 (15 string · 7 boolean)

```
string  (15): as expect id notes on owner restore session session-key since size status tag timeout title
boolean  (7): fresh full mine no-open pin stdin stdin-tasks
```

`expect` and `size` type off their helpers (`parseExpect`/`parseSize`, both
`if (typeof value !== "string") return undefined`), **not** off the bare
truthiness at the call site.

### `glamour/scripts/cli.ts` — 25 (22 string · 2 boolean · 1 CONFLICT)

```
string  (22): colors content cost custom file intent kind label model note prompt prompts round seed session since src start-timeout status timeout title url
boolean  (2): full no-open
CONFLICT (1): restore   <- see above
```

`custom` types off `parseCustom` (`typeof v !== "string"`). **Its values are
`k=v,k=v` pairs — a live test case for step 1's "split on the FIRST `=` only".**

### `glamour/scripts/server.ts` — 6 (6 string) — the LOOKUP parser

```
string   (6): intent port project restore timeout title
```

**⚠ This entry point has ZERO `flags.` reads.** It is
`const flag = (name) => { const i = args.indexOf(\`--${name}\`); return i >= 0 ?
args[i+1] : undefined; }` (`server.ts:487-490`). **A `flags.`-pattern derivation
returns zero here and a zero reads identically to "no drift".\*\* Enumerated by
hand.

All six are string by construction — `flag()` returns the next argv element.
`port` and `timeout` are `Number(...)`-coerced at the call site, which is a
value read, not a boolean one.

**Latent, pre-existing, out of scope:** `flag()` returns `args[i+1]`
**unconditionally**, so `--restore --title X` yields `restore === "--title"`.
Converting this parser fixes it as a side effect; noting it so the change is not
mistaken for a regression.

### `grapevine/scripts/cli.ts` — 26 (13 string · 13 boolean)

```
string  (13): as body-file channels from hold in-reply-to last max note since status timeout topic
boolean (13): all dry-run force fresh from-start human literal lurk quiet stdin text verbose yes
```

**⚠ grapevine is the outlier and here is WHY, so nobody treats it as merely
behind.** It types its flags with a **cast**
(`flags.topic as string | undefined`) where the other four use a **`typeof`
guard**. **A cast is a claim with no runtime check**, so grapevine's value flags
carry a class of latent type-lie the other four are guarded against. Two live
instances:

- `:1687` `flags.last !== undefined ? parseInt(flags.last as string, 10)` — bare
  `--last` yields `parseInt(true)` → **`NaN`, silently**.
- `:1544` `topic: flags.topic as string | undefined` — bare `--topic` puts
  **`true`** into a field typed `string`.

`max` types off `resolveTailMax` (`typeof flag === "string" ? flag : env`).
**Converting grapevine to `strict: true` turns each of these from a silent wrong
value into a caller-facing error** — the lane's stated purpose, and the largest
behaviour delta of the six.

### `imago/scripts/cli.ts` — 20 (17 string · 3 boolean)

```
string  (17): content edited-from image kind link models n options prompt restore session since summary tag tags timeout title
boolean  (3): clear full no-open
```

`kind` is **string**, not boolean, despite reading as `flags.kind === "edit"` —
it is compared to a string literal (`:436`).

### `magpie/scripts/cli.ts` — 19 (15 string · 4 boolean)

```
string  (15): alpha bbox ids intent label model name options pad restore session since timeout title type
boolean  (4): full no-open remove stdin
```

## Denominator

**6 of 6 entry points read; 6 of 6 produced a set. 118 of 118 flags typed: 88
string · 29 boolean · 1 conflict.** Flag COUNTS reproduce the five accumulator
sets above exactly (22 / 25 / 26 / 20 / 19) from an independent instrument —
that is corroboration of the sets, and the only claim here I will call that.

**What this method cannot see, stated so the next reader does not re-derive
it:**

- A **computed key** (`flags[someVar]`) is invisible to this method. **⚠ RE-RUN
  AT `b00428f` (cassandra, comms #325): there is now exactly ONE computed-key
  read, and it did not exist when this table was derived.**

  ```
  bounty/scripts/cli.ts:450   ATTACH_LOST_FLAGS.filter((f) => Boolean(flags[f]))
  ```

  **Introduced by `8f4d92d` — P0b, this session, four hours after the derivation
  sha.** At `f77ae33` the count was **0**; at `8f4d92d` and after it is **1**
  (`git log -S "Boolean(flags[f])"` → that commit and no other). The original
  claim was **true as stamped and false at HEAD** — which is only sayable
  because the derivation carries a sha, and is why it does.

  **Practical impact is small: under `strict: true`, `values[f]` over a
  string-keyed object still works.** The hazard is that the one construct this
  method cannot see now exists, so **"treat every count as a floor" has teeth it
  did not have this morning.**

  **This is the first recorded instance of the sprint's re-run rule** — the
  standing precondition landed at `da1ec2b`, stated once in
  [`sprints/02-success-shaped-lies/plan.md`](../sprints/02-success-shaped-lies/plan.md).
  **Deferred to, not restated here:** a rule copied into the artifact it governs
  is a second source of truth, and this file is the thing that decays.

  **What this file owes, and it is the whole obligation:** re-run the absence
  claims above before consuming them, and record the sha you re-ran at.

  | re-run at                         | computed-key reads   |
  | --------------------------------- | -------------------- |
  | `f77ae33` (derivation)            | 0                    |
  | `b00428f` (cassandra, comms #325) | **1** — `cli.ts:450` |

  _`8f4d92d` invalidated two of this sprint's artifacts in one commit — this
  claim and the exit-site count — which is the scar behind the rule, recorded
  where the rule is, not here._

- **Bare truthiness carries no type evidence** — `if (flags.x)` is satisfied by
  `true` and by any non-empty string. Every such row was resolved by reading its
  **other** sites or its helper, never by guessing from the flag name. A flag
  read **only** as bare truthiness with no second site would be genuinely
  undetermined; **there are none.**
- **Behaviour is undriven** (point 3 above).

_Derived at `f77ae33`, 2026-08-06. Conflict and denominator corrections
published at comms #308._
