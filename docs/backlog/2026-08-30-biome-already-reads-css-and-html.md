# The gate's blind set is 96% self-inflicted: biome already reads CSS and HTML

**Added:** 2026-08-30 · **Found by:** measuring the checker question raised
while ruling [spell-kit R5](../projects/spell-kit/design-resolution.md) ·
**Scope:** repo tooling (`biome.json`), house-wide

> ## The exact failure `gate-honesty.test.ts` documents is closable by a config change

That ward's opening claim is:

> _"A hard JS syntax error injected into a shipped surface passes BOTH arms
> green."_

**It no longer has to.** Measured against the repo's own pinned
`@biomejs/biome@2.4.16`:

```
$ biome check broken.html      # `const x = = = ;` injected into template.html's inline <script>
  > 585 │   const x = = = ;
        │             ^
  … 1 × parse diagnostic, naming the exact line
```

Controlled comparison, same file clean vs. broken:

|                                              | errors | `parse` diagnostics |
| -------------------------------------------- | -----: | ------------------: |
| `template.html` (clean)                      |      7 |                   0 |
| `broken.html` (one injected JS syntax error) |      8 |               **1** |

Biome also **lints** the inline Alpine JS — `useOptionalChain`,
`noUnusedFunctionParameters`, `useTemplate` all fire inside the `<script>`
block, and `noImportantStyles` fires on the CSS.

**These files are excluded by our own `biome.json`, not by a missing
capability:**

```json
"files": { "includes": ["**/*.ts", "**/*.tsx", "**/*.json", "**/*.jsonc", …] }
```

## What that closes, and what it does not

| Blind population       |     Lines | Coverable by                                     |
| ---------------------- | --------: | ------------------------------------------------ |
| `.html` (7 files)      |     3,582 | **biome, today** — add `**/*.html` to `includes` |
| `.css` (4 files)       |       431 | **biome, today** — plus a parser option, below   |
| `.py` (`remove.py`)    |       145 | a Python checker — `ruff` is the obvious pick    |
| `.toml` (4 × `bunfig`) |         8 | `taplo` — marginal, 8 lines total                |
| **total**              | **4,166** | **4,013 (96%) is biome config**                  |

**CSS needs one parser option.** Biome reports it by name against our Tailwind
v4 sheets: _"Enable `tailwindDirectives` in the css parser options, or remove
this if you are not using Tailwind CSS."_ Without it, `@theme` / `@apply` /
`@source` read as errors.

## ⚠ This is not a flag flip, and the precedent says so out loud

A **clean, unmodified** `template.html` already produces **7** biome errors. So
switching `includes` on today turns `bun run check` red — the identical shape as
[`typecheck-gate-is-a-project-not-a-flag`](./2026-08-10-typecheck-gate-is-a-project-not-a-flag.md),
whose whole lesson is that two careful readers sized that gate from config alone
and were both wrong by two orders of magnitude. **The count above is one file.
Nobody has run it across all eleven.**

**First step is therefore a measurement, not an edit:** add the extensions in a
scratch config, run it over the roster, and report the real number before
choosing between fix-all / scope-and-ratchet / relax-rules.

## Acceptance Criteria

- [ ] The real error count across all 11 CSS/HTML files is **measured and
      reported**, not estimated from config.
- [ ] A decision is recorded between fixing, scoping the gate and ratcheting, or
      enabling parse-only (syntax errors) without the lint rules — **the last is
      worth costing separately: it closes the ward's stated failure at a
      fraction of the cleanup.**
- [ ] `tailwindDirectives` is set, or the CSS parser findings are explained.
- [ ] Whatever lands, the gate **states what it still cannot see** — clause (i).
      Python and TOML remain blind either way.

## Interaction with spell-kit R5

R5 extends `gate-blind-set.ts` to a **second root** (`src/`), because relocating
a surface moves its `styles.css`/`index.html` out of the instrument's view
without making them readable. **That ruling stands regardless of this item** —
but if this lands, the blind population it counts drops from 4,166 lines to
roughly **153** (Python + TOML), and the second root's job shrinks to guarding
that it stays there.

**Do not sequence R5 behind this.** R5 is a few lines and unblocks Slice 1; this
is a project.
