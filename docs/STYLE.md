# How prose is written here

[SCHEMA.md](./SCHEMA.md) governs **structure**: frontmatter, types, where a
document lives, and what `pdocs check` enforces. This page governs **prose**.
Read it before writing a document, and use it as the checklist when editing one.

This file is seeded: the scaffold installed it, and it is yours to change. When
your team writes differently, edit it. A migration updates it only while your
copy is still the one the scaffold installed
([Who owns which file](./SCHEMA.md#who-owns-which-file)).

## Which mode a document is in

A reader is in one mode at a time: working on a task, looking something up
mid-task, studying how something works, or finding out what happened. A page
that serves two modes serves neither. The first three are
[Diátaxis](https://diataxis.fr)'s how-to, reference and explanation; records sit
outside it.

| Mode        | The reader is                        | Types here                                                       |
| ----------- | ------------------------------------ | ---------------------------------------------------------------- |
| How-to      | doing a task, attention elsewhere    | `playbook`, `plan`, `test-plan`, `handoff`                       |
| Reference   | looking one thing up mid-task        | `specification`, the folder READMEs, `SCHEMA.md`, an item's body |
| Explanation | studying, with time to follow a case | `architecture`, `interaction`, `feature`, `design-resolution`    |
| Record      | back later, asking what happened     | `session`, `report`, `write-up`                                  |

Diátaxis has a fourth mode, the tutorial. The scaffold ships no tutorial type.

## Language, by mode

**How-to** — conditional imperatives: _"If you want x, do y."_ The title says
exactly what the page shows. Assume competence and omit the unnecessary;
practical usability beats completeness. A playbook's shape — Goal · Steps ·
Verification — is this mode, and its [README](./playbooks/README.md) has the
detail.

**Reference** — declarative statements, plus warnings where they apply: _"You
must use a. You must not apply b unless c."_ Describe, and only describe. A
reference page does not teach the task; it links to the playbook that does. An
item's definition of done is reference: a list of observable results a reviewer
can check without asking you.

**Explanation** — the one mode licensed to argue: _"W is better than z,
because…"_, _"Some prefer w. That can work, but…"_ Weigh the alternatives and
admit the counter-case. Keep it closely bounded: a "why" question fixes the
scope, and instructions and reference tables stay out.

**Record** — narrative is right here, because the reader needs to know exactly
what was done, in what order, and why. A record is dated by `generated.at`,
written once, and never brought up to date. Never make a record the only home of
a rule: a step a future agent must follow goes in a playbook, where it will be
read at the moment it applies.

## Guidance is imperative

A playbook or a README is read by an agent in the middle of a task, and an
observation is not an instruction. "The migration failed when the template had
moved" leaves the reader to work out what to do; "Before a migration that moves
a template, check that the seed manifest records the new path" tells them.

- **Write the step, not the story.** Each line answers: do I have this problem,
  is this the fix, what do I do. Cut how the rule came about unless the rule
  cannot be reached without it.
- **Name the concrete case** that motivates a rule — "a template that moves
  folders", not "structural changes". A general rule is one the reader cannot
  tell applies to them.

These two are this project's practice, not a measured result.

## Density

The evidence behind each rule below varies, and it is stated next to the rule,
because a rule stripped of its condition gets applied mechanically.

**Keep what belongs together, together.** Subject next to its verb, modifier
next to what it modifies. _Strong measured support_: material wedged between a
subject and its verb depressed recall more than any other feature tested, for
experienced readers, in real documents.

Two rules you might expect are inside that one. **Abstract nouns** hurt mainly
by pushing the verb away: the mechanism is locality, and _the direct evidence
that nominalised prose is harder to read is thin_. **Long sentences** are not
the problem either: length tracks dependency distance without causing the cost.
**Do not split a sentence to hit a word count.** Splitting drops the connective
(_because_, _however_, _unless_) and leaves the reader to infer the logic. There
is no sentence-length limit here for that reason.

**Put the point first.** A reader who stops after one sentence should still have
the answer. _Weaker evidence, and contested_: in some constructions more
preceding material makes the ending easier. Treat a run of point-last sentences
as the signal, not a single one.

**Do not compress without declaring it.** An acronym announces that a definition
exists to look up. A memorable phrase hides the same compression behind ordinary
words, so a reader who lacks the argument cannot tell whether they are missing
context or reading badly. _Argued, not measured._ The test: would this sentence
be improved by being an acronym? If yes, it carries a definition. Expand it
where it appears, or link to where it is defined. A compressed line may stay
when it earns its place, if the next sentence pays for it with a concrete
instance.

**Compression suits some modes and not others.** It suits explanation, whose
reader is studying. It is wrong in a how-to, whose reader is working with their
attention elsewhere. The closer a page sits to doing, the looser and more
concrete its prose should be.

**Dense content is a reason to write more plainly, not less.** A reader spending
capacity on new facts has none left for a construction that must also be
decoded. _A judgement, not a measurement._

## What earns its place

Every line is a liability as well as an asset. Before adding one, check that it
is at least one of these:

- **Non-discoverable** — the reader cannot get it from the surrounding material
  or the code.
- **Reachable** — if it is a warning, the wrong path it guards can actually be
  reached from what the page already says.
- **Load-bearing** — it changes a judgement, names a destination, or states
  intent.

A line that is none of these is noise, and noise is not neutral: it buries the
signal. Five things no check detects, which reading must catch:

- **Context dragged in** — material belonging to another document, or to the
  history of how this one came to be written. A playbook step carrying the story
  of a bug already fixed is the standing example.
- **Unnecessary explanation** — the reader told why before they have any use for
  it, or told twice.
- **A promise the page does not keep** — the heading announces one thing, the
  body delivers another.
- **A scaffold taught and then abandoned** — once a reader has learned a section
  shape, every departure costs them a re-derivation.
- **An example the reader cannot look up** — a private tool or another team's
  repository named as precedent. Cite something the reader can open, or make the
  point in your own voice.

## What is not enforced, and cannot be

`pdocs check` checks **shape**: frontmatter vocabulary, links and anchors,
catalog reachability, references between work items. It cannot check whether an
explanation explains or whether a step can be followed.

There is no prose checker, deliberately. A green one would read as "the prose is
fine", and nothing available can support that claim. **The check is a reading,
by a person or an agent, page by page.** This page is input to that reading, not
a substitute for it.
