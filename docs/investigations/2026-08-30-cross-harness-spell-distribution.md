# Investigation: Cross-harness spell distribution — what each channel materializes, and what a spell must become to survive it

**Date Started:** 2026-08-30 **Investigator:** Claude Code **Status:** Concluded
**Outcome:** Amends
[`2026-08-29-shared-code-and-the-build-boundary`](2026-08-29-shared-code-and-the-build-boundary.md)
§Q2; feeds the `spell-kit` proposal as an **emission-matrix** decision rather
than standing up its own project

---

## Question / Motivation

Spellbook officially supports one distribution channel: the Claude Code
marketplace. Cole's question: what does supporting Codex, OpenCode, DeepSeek
Harness and friends actually look like?

Three sub-questions were posed. **One of them turned out to be already closed**,
so the scope here is narrower than proposed:

1. Is there a standard way to share skills across harnesses? — **Yes.** Agent
   Skills is an open standard. Answered by reading the spec.
2. Could we still ship `lib/` separately from the skill folder? — **No, not
   portably.** Answered by the spec; it needs no investigation, only recording.
   (See
   [the parent investigation's 2026-08-30 amendment](2026-08-29-shared-code-and-the-build-boundary.md).)
3. Is there an "npm for skills"? — **Yes, four of them, none dominant.**

**What actually needed investigating**, and what this document is: _given that
the standard exists and `lib/` cannot leave the skill folder, what does each
channel materialize on disk, and what must a spell become to survive the trip?_

---

## Summary

- **The portable unit is the skill directory.** No bundle layer, no
  `${CLAUDE_PLUGIN_ROOT}`, no shared-code concept. The spec says reference files
  _"using relative paths from the skill root."_
- **There is already a cross-harness port of a spell on this machine, and it is
  broken.** `~/.codex/skills/digestify` is a hand-copied fork, **115 days
  stale**, an entire runtime behind (Python, not TypeScript), and it still
  carries `${CLAUDE_PLUGIN_ROOT}` — **unset outside Claude Code**, so its two
  invocation lines resolve to `/skills/digestify/scripts/review.py`, a path that
  does not exist. This is the failure mode, live, unprompted, before anyone
  decided to support Codex.
- **`${CLAUDE_PLUGIN_ROOT}` is the whole portability blocker, and it is small:**
  **21 references across 6 SKILL.md files.** Codex's own bundled skills show the
  portable idiom — bare `scripts/foo.py`, exactly as the spec prescribes.
- **The dependency story is much better than feared.** Spells run from the
  installed marketplace cache with **zero `node_modules`** — Bun auto-installs.
  Verified on four spells.
- **Two spells fail spec validation today**, and no spell uses the one
  frontmatter field built for this problem.
- **Blocking is not the blocker.** Cole has already driven digestify and
  grapevine under Codex and a conjuration under DeepSeek Harness. The exit-code
  contract survives; what varies is the **monitor affordance** — Codex fell back
  to a time-based polling loop. The durable requirement that follows: **the
  tail/monitor verb must stay drivable by a naive poller.**
- **What is still unmeasured** is narrower: a **React surface** spell under a
  non-Claude harness. Every harness needed to test it is already installed here.

---

## Current State Analysis

### What Spellbook ships, and to where

One channel: the Claude Code marketplace, via `.claude-plugin/marketplace.json`
→ `plugins/spellbook/` → `~/.claude/plugins/cache/…/2.2.0/`. The parent
investigation established that this copies the plugin subtree whole, real files,
no symlinks, and that a non-`skills/` sibling survives.

**None of that machinery exists in the standard.** The
[Agent Skills specification](https://agentskills.io/specification.md) defines
exactly one artifact:

```
skill-name/
├── SKILL.md          # required: name + description frontmatter
├── scripts/          # optional
├── references/       # optional
├── assets/           # optional
└── ...               # any additional files
```

`name` must match the parent directory name. File references use _"relative
paths from the skill root,"_ kept _"one level deep."_ The documentation index
has **no page** on plugins, bundles, multi-skill packages, distribution,
registries, or sharing code between skills.

### The channels, and what each is

| Channel                       | Install path                                    | Unit                | Status                         |
| ----------------------------- | ----------------------------------------------- | ------------------- | ------------------------------ |
| Claude Code marketplace       | `~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/` | **plugin subtree**  | ✅ supported today             |
| Agent Skills, user scope      | `~/.agents/skills/<name>/`                      | **skill directory** | the cross-harness default      |
| Agent Skills, project scope   | `<repo>/.agents/skills/<name>/`                 | skill directory     | higher precedence              |
| Codex                         | `~/.codex/skills/<name>/`                       | skill directory     | `skills = true` in config.toml |
| DeepSeek Harness (`dsh`)      | `~/.agents/skills/`, `.agents/skills/`          | skill directory     | v0.1 preview, 2026-08-13       |
| npm-based (skillpm/skills.sh) | `node_modules/…` → linked out                   | skill directory     | four competing tools           |

**Claude Code is the outlier.** Every other channel's unit is the skill folder.

---

## Investigation Findings

### Finding 1 — A cross-harness port of a spell already exists here, and it is broken

Nobody decided to support Codex. It happened anyway, and the result is the
argument for doing it deliberately.

`~/.codex/skills/digestify/` — dated **2026-05-07** — is a hand-copied fork of
digestify:

| Axis         | Repo (`plugins/spellbook/skills/digestify`)                | Codex copy (`~/.codex/skills/digestify`)                 |
| ------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| Runtime      | `review.ts` (Bun/TypeScript)                               | `review.py` (Python) — **a rewrite behind**              |
| `SKILL.md`   | 375 lines                                                  | 260 lines                                                |
| Last touched | 2026-08-08 (`7135287`)                                     | 2026-05-07 — **115 days stale**                          |
| Invocation   | `${CLAUDE_PLUGIN_ROOT}/skills/digestify/scripts/review.ts` | `${CLAUDE_PLUGIN_ROOT}/…/review.py` — **variable unset** |

**The invocation is dead.** `CLAUDE_PLUGIN_ROOT` is a Claude Code variable;
outside it the shell expands it to empty, so the documented command becomes
`python3 /skills/digestify/scripts/review.py` — and `/skills` does not exist.

Three distinct failures in one artifact, and they are the three this
investigation is about: **fork drift** (no update path), **runtime drift** (the
copy predates a rewrite nothing propagated to it), and **an unportable
invocation** that fails silently rather than loudly.

> This is the
> [`cli-empty-vs-failed-read`](../backlog/2026-08-08-cli-empty-vs-failed-read.md)
> shape again at a different altitude: the correct version exists in the tree
> and cannot reach the site that needs it.

### Finding 2 — The portability blocker is one variable, 21 sites, and the fix is already demonstrated

| SKILL.md    | `${CLAUDE_PLUGIN_ROOT}` refs |
| ----------- | ---------------------------: |
| bounty      |                            5 |
| digestify   |                            4 |
| glamour     |                            4 |
| grapevine   |                            3 |
| magpie      |                            3 |
| imago       |                            2 |
| astrolabe   |                            0 |
| mind-mapper |                (no SKILL.md) |
| **total**   |                       **21** |

**astrolabe is already at zero**, which means the pattern is not load-bearing —
it is habit.

**Codex's own bundled skills show the portable idiom.**
`~/.codex/skills/.system/` ships six first-party skills, and they invoke bare
relative paths:

```
python3 scripts/create_basic_plugin.py <plugin-name>     # plugin-creator
scripts/list-skills.py --format json                     # skill-installer
scripts/image_gen.py                                     # imagegen
```

No environment variable. This is exactly what the spec prescribes, and it is
what OpenAI does in its own product.

> **⚠ But it carries an unverified assumption, and it is the one thing worth
> testing before committing.** A bare `scripts/foo.py` only works if the agent
> resolves it against the **skill root** rather than the session cwd (which is
> the user's project). Codex's own skills rely on this; whether every harness
> supplies it reliably to a **script-heavy** skill like a spell is exactly what
> Finding 7's end-to-end drive would settle. Spells are far more
> script-dependent than a typical instruction-only skill, so they stress this
> harder than the skills the convention was validated on.

### Finding 3 — Two spells fail spec validation today

Validated all eight `SKILL.md` files against the spec's frontmatter rules:

| Spell           | `SKILL.md` | `name` valid | matches dir | `description` | verdict                        |
| --------------- | ---------- | ------------ | ----------- | ------------: | ------------------------------ |
| astrolabe       | ✅         | ✅           | ✅          |           942 | pass                           |
| digestify       | ✅         | ✅           | ✅          |           943 | pass                           |
| glamour         | ✅         | ✅           | ✅          |           637 | pass                           |
| grapevine       | ✅         | ✅           | ✅          |           594 | pass                           |
| imago           | ✅         | ✅           | ✅          |           809 | pass                           |
| magpie          | ✅         | ✅           | ✅          |           821 | pass                           |
| **bounty**      | ✅         | ✅           | ✅          |      **1079** | ⛔ **over the 1024 limit**     |
| **mind-mapper** | ❌ absent  | —            | —           |             — | ⛔ **not a skill by the spec** |

mind-mapper's absence is
[a deliberate WIP ruling](../backlog/2026-08-10-mind-mapper-is-undeclared-and-shipped.md)
(`47238d7`) and the roster-drift ward exempts it by name — correct for the
Claude channel, but it means the largest spell in the roster is **structurally
unshippable** to every other channel until it gets a `SKILL.md`.

**No spell sets `compatibility`** — the optional field whose entire purpose is
declaring environment requirements to a foreign harness (_"Requires git, docker,
jq"_ / _"Requires Python 3.14+ and uv"_). Every spell requires Bun, and none of
them says so in the field built to say it.

The irony is sharp in bounty: its description **already ends with "Requires Bun
on PATH"** — the right sentence in the wrong field, and part of why that field
overflows.

### Finding 4 — The dependency story is much better than feared. Measured

The obvious fear: a spell dropped into `~/.agents/skills/` has no
`node_modules`, and the React spells import `react`, `sharp`, `@xyflow/react`
from the repo root.

**It already works, and it already ships that way.** The installed Claude plugin
contains **zero `node_modules`** anywhere, and spells run from it:

```
$ cd ~/.claude/plugins/cache/spellbook-marketplace/spellbook/2.2.0/skills/glamour/scripts
$ bun cli.ts --help
glamour — a grounded visual conversation surface.
```

Verified on glamour, bounty, grapevine and digestify. **Bun's auto-install
resolves the deps at runtime** — which is the same mechanism the
`spell-deps-resolution-in-host-repo` memory records from the other direction
(auto-install is _disabled_ when a `node_modules` exists up-tree). Installed
into `~/.agents/skills/`, there is no `node_modules` up-tree, so the mechanism
is **on**.

**Consequence:** the portability requirement is not "vendor the dependencies."
It is **"Bun on PATH"** — one line of `compatibility`. That is a far smaller ask
than it looked, and it makes Option C (vendoring the kit) cheap rather than
heavy.

### Finding 5 — The registry layer exists, is real, and hashes the folder

Four competing package managers, none dominant:
[skillpm](https://github.com/sbroenne/skillpm) (npm-native — package.json,
lockfiles, semver; scans `node_modules/` for `skills/*/SKILL.md`),
[skills.sh](https://dev.to/stevengonsalvez/skillssh-npm-for-agent-skills-35jc),
[skills-npm](https://www.npmjs.com/package/skills-npm) (symlinks skills out of
npm packages), and [Skilldex](https://arxiv.org/html/2604.16911v1) (an MCP
server).

**One is already in use here.** `~/.agents/.skill-lock.json` is a v3 lockfile
from `vercel-labs/skills`:

```json
{
  "version": 3,
  "skills": {
    "find-skills": {
      "source": "vercel-labs/skills",
      "sourceType": "github",
      "skillPath": "skills/find-skills/SKILL.md",
      "skillFolderHash": "3013fdeb8a11b10b1eb795ec3ae8bfca38f7c26d"
    }
  }
}
```

Two things matter. **It installs by copy, not symlink** (zero symlinks under
`~/.agents/skills`) — so relative traversal out of a skill folder would resolve
against the install location, not the source repo. And it is **content-addressed
on `skillFolderHash`** — the _folder_ is the hashed unit, which is the spec's
position expressed as a lockfile.

`skillpm`'s `skills/*/SKILL.md` glob does mean **one npm package can carry many
skills**, and a sibling `lib/` would exist on disk at `node_modules/<pkg>/lib`.
Whether it survives the link-out step is **unmeasured** and tool-specific — and
given the copy-not-symlink evidence above, the prudent assumption is that it
does not.

### Finding 6 — Growth numbers in circulation are marketing, not measurement

Figures like _"351,000 skill packages by early March"_ come from vendor blogs
with no methodology. They are directionally interesting and should not be cited
in a decision. What **is** verifiable: the official client showcase lists ~45
adopting products, including Codex, OpenCode, Cursor, GitHub Copilot, VS Code,
Gemini CLI, Goose, Amp, JetBrains Junie, Kiro, Factory, OpenHands, Roo Code and
Mistral Vibe.

Related and worth tracking rather than acting on: skill supply-chain security is
now an active research area
([_Skills Are Not Islands_](https://arxiv.org/pdf/2607.01136)), and DSH already
has a third-party plugin for prompt-injection defense when adopting external
skills. Publishing spells to a public registry is a new attack surface that
publishing to a personal Claude marketplace is not.

### Finding 7 — The one thing not measured, and every tool to measure it is installed

Nothing here demonstrates that a spell **drives end-to-end** under a non-Claude
harness — that the agent activates it, resolves `scripts/cli.ts`, opens a
browser surface, and reaches the exit-code contract.

**Partly answered after this document was drafted** — see Open Question 2: Cole
has driven digestify and grapevine under Codex, and a conjuration under DeepSeek
Harness, before this investigation existed. Blocking survives; the monitor
affordance is what adapts. What remains untested is a **React surface** spell
(imago/magpie/glamour) rather than a thin one.

**The whole bench is already on this machine:**

| Harness        | Version           |
| -------------- | ----------------- |
| `codex`        | codex-cli 0.149.1 |
| `opencode`     | 1.18.20           |
| `goose`        | 1.47.0            |
| `gemini`       | 0.46.0            |
| `amp`          | 0.0.1766937678    |
| `cursor-agent` | installed         |
| `crush`        | installed         |

`dsh` is **not** installed — the DeepSeek Harness preview would need fetching.

---

## The channel-requirements matrix

What a spell must satisfy per channel. **Bold = not satisfied today.**

| Requirement                                | Claude marketplace  | `~/.agents/skills` · Codex · OpenCode · dsh | npm registry             |
| ------------------------------------------ | ------------------- | ------------------------------------------- | ------------------------ |
| Valid spec frontmatter                     | not enforced        | **required** (bounty, mind-mapper fail)     | **required**             |
| `name` == directory name                   | ✅                  | ✅                                          | ✅                       |
| Self-contained skill folder                | not required        | **required** — no `lib/` sibling            | **required**             |
| Invocation without `${CLAUDE_PLUGIN_ROOT}` | ✅ (it's defined)   | **21 sites must change**                    | **21 sites must change** |
| Declared runtime (`compatibility: Bun`)    | not needed          | **should** — none set                       | **should**               |
| Dependencies resolvable                    | ✅ Bun auto-install | ✅ same mechanism (measured)                | ✅                       |
| An update path                             | ✅ marketplace      | ✅ lockfile + folder hash                   | ✅ semver                |

**Read the last row against Finding 1.** The Codex fork is stale because it was
copied by hand into a channel that _has_ an update mechanism nobody used.

---

## Options

**Do nothing.** Stay Claude-only. Legitimate — the spells are Cole's tools
first. But it does not restore the status quo: the broken Codex fork already
exists, and doing nothing leaves it broken and drifting.

**A — Conformance only (small).** Make every spell spec-valid and
harness-neutral: trim bounty's description, give mind-mapper a `SKILL.md`, add
`compatibility: Requires Bun on PATH`, replace the 21 `${CLAUDE_PLUGIN_ROOT}`
sites with the portable idiom, and add a ward that fails on regression. **Ships
nothing new** — but it makes every spell copyable-and-working into any of the
six installed harnesses, and it deletes the class of defect Finding 1 found.
This is a backlog item, not a project.

**B — A second emission target (medium).** Add a build target that emits each
spell as a standards-conformant skill directory — kit vendored in, no external
references — into `dist/skills/<name>/`. One authored source, two artifacts.
Depends on the kit existing, so it sequences **after** `spell-kit`.

**C — Publish to a registry (large).** Pick a package manager, publish, own an
update path and a security posture. Premature; the ecosystem has four contenders
and no winner.

## Recommendation

- [x] **No new project — fold into existing work.**

**Do A now, as a backlog item.** It is measured, bounded, mostly mechanical, and
independently correct even if cross-harness support never happens: a spell whose
`SKILL.md` documents a command that works in one product and silently
half-executes in another has a documentation defect regardless of strategy.

**Fold B into the `spell-kit` proposal as the emission matrix**, not as its own
project. This is the substantive correction to the parent investigation: A/B/C
there was framed as _"where does `lib/` live,"_ which is a filesystem-layout
question with one answer. It is actually _"what does each channel materialize,"_
which is a **build-target** question with one answer per channel — and the kit's
authoring home (`src/kit/`) is unchanged either way.

**Defer C** until a package manager wins, or until someone other than Cole wants
a spell.

**The deciding factor** is Finding 1. The cost of not choosing is not
hypothetical — it is already on disk, 115 days stale, one runtime behind, and
broken in a way that produces a confusing error rather than a clear one.

## Next Steps

1. **File the conformance backlog item** (Option A), scoped by the matrix above.
   Include the ward — this repo's own lesson is that an unenforced rule is not a
   rule.
2. **Fix or retire `~/.codex/skills/digestify`.** It is live and broken. Either
   re-port it from HEAD or delete it; leaving it is the worst option.
3. **Run the end-to-end drive** (Finding 7) against `codex` and `opencode`
   before committing to Option B — one spell, installed to `~/.agents/skills/`,
   driven to its exit-code contract. It settles the skill-root resolution
   assumption in Finding 2, which is the only load-bearing unknown left.
4. **Add the emission matrix to the `spell-kit` proposal** when it is written.

## Open Questions

1. **Does a harness resolve `scripts/cli.ts` against the skill root?** Finding
   2's assumption. Codex's own skills depend on it; spells stress it much
   harder. Settled by step 3, not by reading.
2. ~~**Do surface spells work at all elsewhere?**~~ **LARGELY ANSWERED — by
   Cole, from prior hands-on testing (2026-08-30), and it is the good news.**
   The blocking/exit-code shape survives; the **monitor affordance** is what
   varies:
   - **Codex + digestify** — works. Plain blocking cantrip, no adaptation.
   - **Codex + grapevine** — works, **but the agent drove it with a time-based
     polling loop**, not an internal monitoring mechanism.
   - **DeepSeek Harness + a conjuration** — works, and better: because
     everything in `dsh` is a plugin, Cole built a monitor-oriented plugin
     giving Claude-Code-`Monitor`-like behaviour, so the agent tails events
     natively.

   **This reverses the risk ranking in this document.** Blocking is not the
   blocker. What is left is a narrower and more actionable claim: **a spell's
   `tail`/monitor verb must remain drivable by naive polling**, because that is
   the lowest common denominator across harnesses. Resumable `--since` and
   bounded reads (already the house SSE idiom, and already the subject of four
   backlog defects) are exactly what makes polling work. **Design the kit's tail
   client for a poller, and every harness is served.**

   _Still unverified: a **surface** spell — one that opens a browser — under a
   non-Claude harness. digestify and grapevine are the two thinnest surfaces in
   the roster; imago/magpie/glamour are not the same test._

3. **What is the story for `dist/`?** mind-mapper's committed build output is
   fine under a folder-is-the-unit model — but the surface source lives in
   `src/`, outside the skill folder, so the fork-to-hack path does not port.
4. **Does a sibling `lib/` survive an npm link-out?** Finding 5 says probably
   not. Measurable if C is ever revisited.
5. **Would a spell in a public registry need a different security posture?**
   Finding 6. Not urgent; do not solve it now.
6. **Is `compatibility` actually honored anywhere?** The spec does not
   standardize enforcement. It may be documentation only — which is still worth
   setting.

---

## Appendix — invocations

```bash
# Spec conformance of every SKILL.md (bounty over 1024; mind-mapper absent)
python3 - <<'PY'
import os,re
root="plugins/spellbook/skills"
for s in sorted(os.listdir(root)):
    f=os.path.join(root,s,"SKILL.md")
    if not os.path.exists(f): print(f"{s:<13} NO SKILL.md"); continue
    fm=re.match(r'^---\n(.*?)\n---\n', open(f).read(), re.S).group(1)
    m=re.search(r'^description:\s*(.*?)(?=\n[A-Za-z_-]+:|\Z)', fm, re.S|re.M)
    d=" ".join(m.group(1).split())
    print(f"{s:<13} {len(d):>5} chars{'  OVER 1024' if len(d)>1024 else ''}")
PY

# The portability blocker (21 sites, 6 spells; astrolabe already at 0)
grep -c CLAUDE_PLUGIN_ROOT plugins/spellbook/skills/*/SKILL.md

# The broken Codex fork
ls -la ~/.codex/skills/digestify/scripts/          # review.py, not review.ts
grep -n CLAUDE_PLUGIN_ROOT ~/.codex/skills/digestify/SKILL.md
echo "expands to: '${CLAUDE_PLUGIN_ROOT:-<UNSET>}'"

# Spells run with zero node_modules (Bun auto-install)
C=~/.claude/plugins/cache/spellbook-marketplace/spellbook/2.2.0
find $C -name node_modules | wc -l                 # 0
(cd $C/skills/glamour/scripts && bun cli.ts --help | head -1)

# The portable idiom, as OpenAI ships it
grep -rn "scripts/" ~/.codex/skills/.system/*/SKILL.md | head

# Installed-by-copy, content-addressed on the FOLDER
find ~/.agents/skills -type l | wc -l              # 0 symlinks
cat ~/.agents/.skill-lock.json

# The test bench
for b in codex opencode goose amp cursor-agent gemini crush dsh; do
  printf "%-14s %s\n" "$b" "$(command -v $b || echo '—')"; done
```

**What this investigation did not do:**

- **This investigation never ran a spell under another harness.** Its
  cross-harness claims are about **files on disk and published specs**, not
  observed behaviour. Open Question 2 was subsequently answered **from Cole's
  own prior testing, not by this document** — and it answered in the optimistic
  direction, which is a reminder that the operator's memory was a cheaper
  instrument than the one proposed here and should have been consulted first.
- It did not install `dsh`; DeepSeek Harness claims are from published docs
  only, and it is a **v0.1 developer preview 17 days old**.
- It did not measure npm link-out behaviour (Finding 5) — inferred from the
  copy-not-symlink evidence, not tested.

---

**Related Documents:**

- [Shared code and the build boundary](2026-08-29-shared-code-and-the-build-boundary.md)
  — the parent; its §Q2 options are amended by this
- [`spell-surface-pipeline` proposal](../projects/spell-surface-pipeline/proposal.md)
  — §4's origin-vs-artifact split is the same idea one channel earlier
- [mind-mapper is undeclared and shipped](../backlog/2026-08-10-mind-mapper-is-undeclared-and-shipped.md)
- `grimoire/house-style.md` §"The build (there isn't one)" — _"zip one folder
  and it runs"_ is the Agent Skills distribution unit, written here first
- [Agent Skills specification](https://agentskills.io/specification.md) ·
  [overview + client showcase](https://agentskills.io/)
- [Codex skills](https://developers.openai.com/codex/skills/) ·
  [OpenCode skills](https://opencode.ai/docs/skills/) ·
  [DeepSeek Harness](https://deepseek.com/harness/en/)
