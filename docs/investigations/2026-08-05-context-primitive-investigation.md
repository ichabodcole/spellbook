# Investigation: Context as a First-Class Primitive Across Spells

**Date Started:** 2026-08-05 **Investigator:** Claude Code (with Cole)
**Status:** Active **Outcome:** In Progress

> **Companion to
> [the communication-log primitive investigation](./2026-08-05-message-log-primitive-investigation.md).**
> Cole frames these as two halves of one thing: **ingestion** (this doc — bring
> context in, navigate it) and **communication** (the log of what was said about
> it). They meet at `ground` — the message field holding ids into the context
> library — so this investigation's shape constrains that one.

---

## Question / Motivation

Every co-presence spell needs the human and agent to share **context**, and each
one has built its own way of holding it. Cole's framing:

> "There is a really important aspect of context management in these apps —
> supporting multiple types of context, both in media, but also not just a
> single flat list of documents. The idea of structured documents or document
> groups, where you might have a nested hierarchy, relations between them, and
> metadata. I want to build that into the idea of a really good context
> primitive — UI and data structure — so we aren't constantly reinventing it."

Three sub-questions:

1. **Is it actually being reinvented?** (Cole's claim, tested below.)
2. **What should the standard be** — metadata, hierarchy, and linking — and what
   can we support?
3. **Should there be an import adapter layer**, so a source like Operator can be
   transformed in rather than forcing one universal format?

**The central decision this investigation must inform:** does Spellbook design a
context primitive, **adopt one already being built elsewhere**, or extract a
shared one? That framing changed during the investigation — see Finding 4.

## Current State Analysis

### The trail — seven captures across three repos

Cole's instinct that "this keeps coming back up" is **confirmed, and it
understates it**. Ordered by date:

| When        | Where                                                | What it established                                                             |
| ----------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| (origin)    | **StoryLoom** context library                        | Prior art cited by imago: a context library is a **passive catalog**            |
| 2026-06-16  | Spellbook `backlog/imago-unified-context-library`    | "styles, quick-prompts, skills are all just text" — one library over both media |
| 2026-06-17  | Spellbook `projects/imago/context-library-design`    | **Shipped.** Linked sets; ✕ = unlink, never destroy; one guarded hard-delete    |
| 2026-07-02  | StoryLoom `investigations/operator-document-linking` | Feature note **for Operator**: links must be data, not text                     |
| ~2026-07-19 | Spellbook mind-mapper R4                             | "OKF adapter" enters the design queue — **deferred every round since**          |
| 2026-07-30  | StoryLoom `projects/structured-context-documents`    | **The full design**, now in build (see Finding 4)                               |
| 2026-08-05  | Spellbook `fragments/` ×2                            | Wiki-reading spell + roadmap surface — both want structured markdown import     |

### What exists in code today

Two shipped implementations in this repo, with a third deferred:

**imago** — `ContextEntry` (`imago/surface/state/types.ts:96`):

```ts
type ContextKind = "prompt" | "style" | "skill" | "context";
type ContextEntry = {
  id;
  kind;
  name;
  content;
  tags?;
  image?;
  imagePath?;
  captured?;
};
// membership modelled as linked sets, NOT flags on the item:
type ContextSet = "active" | "quickPrompts";
// consumption sites: activeContextIds[], quickPromptIds[]
```

**glamour** — `LibraryItem` (`glamour/surface/state/types.ts:17`):

```ts
type ItemKind = "ref" | "context" | "gen" | "style";
type LibraryItem = {
  id;
  kind;
  title;
  src;
  path;
  text;
  mime;
  tags;
  starred;
  liked;
  annotations;
  canonical;
  canon;
  archived;
  createdAt;
  gen;
};
```

## Investigation Findings

### Finding 1 — the reinvention is documented in a source comment

`glamour/surface/state/types.ts:17` says, verbatim:

> `// One catalog entry. Shape follows imago's ContextEntry conventions:`

The copy is not inferred; **glamour's own code declares that it hand-mirrors
imago's model.** This is the same lockstep-mirror-with-no-guard pattern already
recorded for the bounty surface. Nothing tests that the two stay aligned, and
they already haven't:

| Concept      | imago                       | glamour                                    |
| ------------ | --------------------------- | ------------------------------------------ |
| display name | `name`                      | `title`                                    |
| body text    | `content`                   | `text`                                     |
| image / path | `image` / `imagePath`       | `src` / `path`                             |
| archival     | — (absent)                  | `archived`                                 |
| media type   | — (absent)                  | `mime`                                     |
| created      | — (absent)                  | `createdAt`                                |
| membership   | **id arrays** (linked sets) | **flags on item** (`canonical`, `starred`) |

The last row is the substantive divergence: imago's design doc argues at length
that membership must live with the **use**, not as flags on the item — and
glamour, the copy, put flags back on the item.

### Finding 2 — what both shipped models lack is exactly Cole's ask

Neither has **hierarchy** (no parent/child), **relations** (no edges between
entries), or an **import adapter**. Both are flat catalogs of standalone items.
Cole's three asks map cleanly onto the three gaps, so this is a genuine
increment rather than a restatement of what exists.

### Finding 3 — Operator's linking exists because Cole specified it, and it shipped

StoryLoom's `2026-07-02-operator-document-linking.md` is a feature note **for
Operator**, arguing a link must be data, not text. **Operator now has it.**
Probed live against the Spellbook workspace today:

- **Typed edges** — a `rel` per edge, with a canonical vocabulary of 11:
  `references, extends, grounded-in, sourced-from, governs, summarizes, applies, see-also, supersedes, sister-of, contrasts-with`
  (freeform values allowed).
- **Character spans** (`spanStart`/`spanEnd`) anchoring an edge into content,
  with `updatedAt` as an explicit staleness anchor.
- **Backlinks** as first-class (inbound direction).
- **Dangling detection with reasons** — `deleted` / `missing` /
  `not_resolvable_in_scope`, the last being scope-relative so it can't leak the
  existence of documents you can't see.
- **`untypedCount`** — a linking-pass progress signal ("how many edges are still
  untyped").
- `list_relationships` ranks in-use rels by frequency **"so an agent converges
  on established terms instead of reinventing near-duplicate synonyms"** — an
  anti-reinvention mechanism for relation names, which is the same problem this
  investigation is about, one level down.
- `extract_links` names **"the mind-mapper's use case"** in its own description.

> **Usage — measured (2026-08-05, updated).** Initially recorded as UNVERIFIED:
> the Spellbook workspace has 13 documents and **zero** links (`inUse: []`), so
> it could confirm capability but not practice. **HiveMind was then probed and
> answers it**: 39 typed edges, and **`untypedCount: 0`.**
>
> | rel            | uses |
> | -------------- | ---- |
> | `sourced-from` | 14   |
> | `references`   | 10   |
> | `see-also`     | 6    |
> | `sister-of`    | 3    |
> | `applies`      | 2    |
> | `extends`      | 2    |
> | `grounded-in`  | 2    |
>
> Two things this establishes. **The vocabulary is used, not aspirational** — 7
> of 11 canonical relations are exercised, and zero edges are untyped, so the
> typing discipline holds in practice rather than only in the tool. And the
> **unused four are informative**: `governs`, `summarizes`, `supersedes`, and
> `contrasts-with` have no uses — `supersedes` being the one a versioned
> standard would need (see the Amendment below).
>
> Still not probed: the Hollowbrook bible itself, which lives in a workspace not
> reached in this pass and is the densest link corpus.

### Finding 4 — the primitive is already designed, and is being built in StoryLoom

**This is the finding that reframes the question.** StoryLoom's
`structured-context-documents` (2026-07-30) is not a sketch — it has a proposal,
a naming pass, a gap analysis, a render protocol, a phased plan, a checkpoint
rubric, and a pre-migration snapshot. Its own overview states the problem in
almost the words Cole used today:

> "The context that feeds all of this is a **flat list**. Every piece is a
> standalone document with no parent, no siblings, and no readable relationship
> to anything else... This project makes context **structured**: containers that
> nest, documents that link to each other, frontmatter you can query, full-text
> search, an explorer/editor, and markdown-vault import/export."

Status: **in build** — Phase 1, session 1 complete, stopped at the T3 gate.
Phase 1 explicitly **excludes** links, `rel`, full-text search, frontmatter
predicates, and the editor; those are Phases 2–3.

It has also already solved the vocabulary problem, in `naming.md`:

> **"'Context' is both the genus and one of its species"** — and the principle
> _"name a thing for what it is a view of, not for its shape."_

And it names the asymmetry that should govern any Spellbook adoption:

> "Operator's documents are **terminal** — a document's job is done when a human
> reads it. Story Loom's are **inputs to generation**."

**Spellbook's spells are on StoryLoom's side of that asymmetry**, not
Operator's: context is fuel for agent work, not an end in itself. That makes
StoryLoom's model the closer fit of the two.

### Finding 5 — OKF needs verification before anything is built on it

Cole cites **OKF (Open Knowledge Format)** as the metadata/linking standard he's
been moving toward. Evidence found:

- **In this repo:** OKF appears throughout mind-mapper — drive findings 3, 4, 5,
  6, and 11, `plan-round4.md`, two session docs, and a memory. In every one it
  is an **"OKF adapter" in the design queue, deferred**; round 4 asserts "No OKF
  parsing" as explicitly absent.
- **In StoryLoom:** zero references.
- **As an external standard:** not verified in this pass.

> ⚠ So OKF is currently a **recurring intention, not an implementation** — named
> for months and never built. Before it becomes the standard, confirm it is a
> real, stable, externally-maintained spec rather than a remembered name.

## Options Considered

1. **Do nothing.** Each spell keeps its own model. Cost: the drift in Finding 1
   continues, and the two new spell ideas become models six and seven.
2. **Extract a shared Spellbook primitive** from imago + glamour. Honest about
   what's proven, but risks designing in parallel with — and diverging from —
   StoryLoom's active build.
3. **Adopt StoryLoom's model as the reference**, and extract the Spellbook
   version from it once its Phase 2 (links, `rel`, FTS) lands. Slower, but the
   design work is already done and paid for.
4. **Adapter-first.** Define only the **import contract** now (source → our
   shape), leaving each spell's internal model alone. The smallest step that
   serves both new spell ideas.

## Recommendation

- [x] **More Research Needed** — then most likely a project, scoped as _extract
      a shared primitive_, **not** _invent one_.

**Rationale:** the question this started as ("design a context primitive") is
the wrong one. Finding 4 shows the primitive has been designed and is in build
one repo over, by the same author, against the same complaint. **The real risk
is no longer under-designing — it is designing a seventh model in parallel with
an active build and having them diverge**, which is precisely the failure
Finding 1 documents at a smaller scale.

Two things must be resolved before committing: **OKF's status** (Finding 5), and
**what StoryLoom's Phases 2–3 actually land**, since links and `rel` are the
part Spellbook most needs and the part not yet built.

### Amendment (Cole, 2026-08-05) — "adopt StoryLoom's" is too strong

Cole's correction, recorded because it changes the shape of the recommendation
rather than merely softening it:

> "I don't necessarily think that one app is going to be the thing that drives
> the full spec and says _this is the standard_... I do think this is something
> that probably isn't going to be fully realized in any single project. Working
> across projects is where I find the rough edges and the use cases. What I'd
> expect is a bit of **push-pull** — pulling from one project the things that
> are emerging there, refining them, and pushing that back."

So the model is **not** _one project owns the spec and the others consume it_.
It is a standard that lives **above** any project and is refined by circulation.
StoryLoom is the most advanced contributor **right now** because it has had
Cole's attention — not because it is the owner. Attention moves; ownership
shouldn't have to move with it.

Two consequences:

- **Which project is "ahead" is a function of attention, not correctness.** A
  spec pinned to whichever repo is currently hot would be re-pinned every few
  months. That is an argument for a home that is not a project.
- **`supersedes` is the missing mechanism.** A standard refined over time needs
  versioned replacement, not edits in place. Operator ships `supersedes` in its
  canonical vocabulary and it currently has **zero uses** (measured below) — the
  affordance exists and is unexercised.

### The stewardship question — where does the standard live?

Cole raised this as genuinely open, including the honest objection against his
own idea ("I don't know if that just adds another place to put things").

| Option                          | For                                                                              | Against                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Stays in StoryLoom**          | Where the work is; no new home                                                   | Pins the spec to one project's attention; other repos consume a moving target |
| **A dedicated primitives repo** | Neutral ground, versionable                                                      | A third place to look; risks becoming a spec nobody reads                     |
| **HiveMind**                    | Already the cross-project knowledge base, **and already has the pull mechanism** | Currently shaped for methodology, not normative specs (see below)             |
| **Distributed + cross-links**   | No new home; each project keeps its own                                          | This is the status quo, and it produced the drift in Finding 1                |

**HiveMind was probed today, and it is closer to fit than expected.** Structure:
`Playbooks/` (8), `Feedback/` (21), `Lessons Learned/` (4), `Scenarios/` (8),
plus a field guide. Its playbooks are **already technical, not just procedural**
— _Cloud MCP Server implementation_, _Real-Postgres integration-test harness_,
_Tenant API-key lifecycle_ — so a technical standard is not foreign to it.

More importantly, **the push-pull loop Cole describes already exists as
tooling**: `hivemind-consult` can _"materialize a playbook or principle into the
project's local docs/ with provenance"_ (the pull), and `hivemind-capture` /
`hivemind-feedback` → `hivemind-digest` promote findings back up (the push).
That is the circulation mechanism, built.

**The gap is genre, not capability.** HiveMind holds _playbooks_ ("how to do X",
procedural) and _lessons_ ("what we learned"). A **standard** is a third genre:
normative, versioned, and cited rather than followed. There is no `Standards/`
folder and no convention for one. Adding that genre is a smaller change than
standing up a new repo.

### The linchpin risk — worth naming explicitly

> "I am probably the linchpin in this right now, the cross-pollinator, because I
> see these."

**This is a mechanism with a bus factor of one, and it is the kind that fails
silently.** Cross-pollination currently depends on Cole personally recognizing
that a thing emerging in one repo is relevant to another. Per anthill's own
field notes, a **dispositional** instruction holds while a **situational** one
fails at the recognition step — and "notice when this pattern recurs elsewhere"
is purely situational. Today's finding is the evidence: glamour copied imago's
context shape by hand and drifted, and nothing surfaced it for two months.

Cole notes his overview projects (astrolabe, HiveMind) "tend to be focused on
read and analysis versus actually doing the work of pushing across projects."
**That asymmetry is the actual gap** — the observation capability exists; the
circulation capability is manual. Whatever home is chosen should be judged
primarily on whether it removes this dependency, not on where the files sit.

### A requirement not yet in this document — the agent's read path

Cole named an acceptance criterion for the standard that the findings above do
not cover:

> "A really good agent experience in terms of navigating it — getting a **map**,
> not having to read everything in, but being able to get a **meta
> understanding** of context."

**This is a first-class requirement, not a nice-to-have**, and it constrains the
data model: the structure must support a cheap, faithful **summary projection**
so an agent can orient without ingesting the corpus. Precedents already in hand
— StoryLoom's proposal ships a **rendered index**; Operator's `browse` returns
`charCount`/`wordCount` and a `headings` search mode explicitly for fast
orientation; imago and glamour both strip blobs in a **lean agent projection**.
Three independent versions of "give the agent a cheap map." Any candidate
standard should be tested against this, not just against what it can represent.

## Next Steps

1. **Verify OKF** — is it a real external standard, and is it stable enough to
   build on? If not, Operator's shipped `rel` vocabulary (Finding 3) is the
   in-house candidate, and it has the advantage of already existing.
2. **Read StoryLoom's `structured-context-documents` proposal in full**, plus
   `naming.md` and `gap-analysis.md` — as the most advanced **contribution** to
   the standard, not as the standard itself (see the Amendment). What to pull
   forward, and what is StoryLoom-specific, is the ruling to record.
3. ~~Probe a corpus that actually uses links to turn Finding 3's capability list
   into usage evidence.~~ **Done** — HiveMind, 39 typed edges, 0 untyped (see
   Finding 3). The Hollowbrook bible remains the densest corpus if a larger
   sample is wanted.
4. **Decide the stewardship question** — where the standard lives. Leading
   candidate is HiveMind **with a new `Standards/` genre**, on the grounds that
   the circulation tooling already exists there and a new repo would not have
   it. Judge any option primarily on whether it removes the linchpin dependency.
5. **Test candidates against the agent read-path requirement** (cheap map /
   meta-understanding without full ingestion), not only against expressiveness.
6. **Decide the boundary with mind-mapper**, which already ingests markdown,
   already has a graph canvas, and already has the OKF adapter in its queue. It
   may be the natural host for the primitive rather than a consumer of it.
7. **Feed the result back** to the two 2026-08-05 fragments, whose
   one-spell-or-two question is downstream of this one.

## Open Questions

- Is the primitive a **shared library** (code both spells import) or a
  **convention** (a documented shape each implements)? The bounty surface-mirror
  precedent suggests a convention with no guard drifts.
- Does the primitive belong in Spellbook at all, or in a package shared with
  StoryLoom? Cross-repo sharing is a much larger commitment.
- **Write-back**: the wiki fragment's unresolved automatic-vs-staged question
  recurs here, and a hierarchy makes it sharper — moving a container is a
  filesystem move.
- Should the import adapter target Operator's **MCP API** (live) or its
  **markdown export** (files)? The two give very different coupling.
- Cole named this as **one of two** related concerns; the second is now captured
  in the companion investigation above. `ground` is the seam between them.

## Related Documentation

- Spellbook: `docs/projects/imago/context-library-design.md`,
  `docs/backlog/2026-06-16-imago-unified-context-library.md`,
  `grimoire/fresh-agent/2026-06-18-imago-context-library-findings.md`
- Spellbook fragments (2026-08-05): wiki-reading spell, project-roadmap surface
- Code: `plugins/spellbook/skills/imago/surface/state/types.ts:96`,
  `plugins/spellbook/skills/glamour/surface/state/types.ts:17`
- StoryLoom (`~/Projects/dreamwood/story-loom`):
  `docs/projects/structured-context-documents/` (proposal, naming, gap-analysis,
  plan), `docs/investigations/2026-07-02-operator-document-linking.md`,
  `docs/investigations/2026-07-02-world-as-llm-wiki-queryable-bible.md`,
  `docs/investigations/2026-07-31-operator-as-substrate-deltas.md`
- Operator MCP: `list_relationships`, `get_links`, `extract_links`,
  `list_dangling_links`
