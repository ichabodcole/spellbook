---
name: digestify
description:
  Digestify is a one-shot browser review tool. The agent writes substantive
  content (summary, recap, document review, brain-dump synthesis, or multi-agent
  state report) with inline questions, the user reads it rendered in their
  browser and answers in place, then submits once and the agent gets a JSON
  response in the same turn. Two trigger modes. Explicit — the user says the
  magic word ("digestify", "digestify this", "open a digestify", or any obvious
  variant), and the agent fires the tool immediately. Suggested — the agent has
  produced 150+ words of synthesis paired with concrete questions only the user
  can answer; the agent proposes the tool ("Want me to digestify this?") and
  fires only if the user agrees. Do NOT auto-fire on soft cues like "summarize
  this", "what do you need to know", or "give me a recap" — those stay in chat
  unless the user opts in. Do NOT use for single short questions, iterative
  chat, or visual design picking.
---

# Digestify

A one-shot browser review tool for situations where the agent has synthesized
something substantive (a summary, recap, document review, or brain-dump
processing) and needs the user to read it carefully and answer specific
questions tied to it. The agent writes a markdown document with embedded
`:::question` fences, runs `review.ts`, and the script blocks until the user
submits a response in the browser.

## Naming

The tool is **Digestify**. The user invokes it by saying the word — "digestify
this", "open a digestify", "send me a digestify". Use the same word back: _"I'll
digestify this and open it in your browser."_ This shared shorthand is
intentional; it lets the user opt in unambiguously without you guessing from
softer cues like "summarize" or "what do you think".

## Two Trigger Modes

### Explicit invocation (just fire)

The user said the magic word. Examples:

- "Digestify this and ask me what's missing."
- "Open a digestify with these questions."
- "Send me a digestify of where we landed."
- "Just digestify it."

Fire the tool. No clarifying questions; the user has already opted in.

### Suggested invocation (ask first)

You sense the situation matches a Digestify-shaped problem (see Common Patterns
below) but the user hasn't said the word. Examples of when this applies:

- You're about to write a 200+ word recap with 3 questions at the end.
- The user pasted a long doc and asked for a summary plus your reactions.
- You've been processing a brain-dump and have several clarifying questions you
  don't want to drop one-by-one in chat.

In these cases, **propose** Digestify; don't just open a browser:

> "I have a recap and four questions for you. Want me to digestify this so you
> can read it rendered in your browser and answer inline, or should I just paste
> it here?"

If they say yes, fire it. If they say no, deliver the content in chat as normal.
If they don't engage with the meta-question and just want chat — drop it and
continue in chat.

**Why ask first:** the browser pop-up is a context switch. For some users, in
some moments, that's exactly what they want. In others it's intrusive. When
you're not sure, ask.

## Common Patterns

The shapes that fit Digestify. Common thread: the agent has done substantive
synthesis the user needs to consume carefully, plus there are specific questions
only the user can answer. A single round of response closes the loop.

**Conversation recap.** A long Q&A or working session is winding down. You
summarize what was discussed and what remains undecided. The questions are the
open decisions you need before continuing.

**Brain-dump processing.** The user gave you unstructured input — a voice
transcript, rough notes, a wall of paragraphs. You return "here's what I
understood" plus questions about gaps, contradictions, or fuzzy parts. The user
reading your interpretation is the point; they catch where you went wrong and
answer what you couldn't resolve.

**Document review.** The user pointed you at a doc (proposal, spec, README,
external article). You return a summary of what's relevant for their purposes
plus questions about ambiguous parts.

**Multi-agent handoff.** Several agents (or one agent across many turns) have
been collaborating. The user is stepping back in. You produce a status recap
plus the specific decisions or inputs only they can supply.

If the conversation needs to continue iteratively after submit, do that in chat.
Digestify is single-round.

## Prerequisite

`review.ts` runs under [Bun](https://bun.sh) — assume the user has `bun` on
their PATH (it's the runtime this skill commits to). If `bun` is missing, the
Bash call fails fast with `command not found: bun`; surface that to the user and
stop. Don't try to install Bun for them.

## How It Works

1. You write markdown with `:::question` fences.
2. You invoke `scripts/review.ts` via the Bash tool (`bun run …`), passing the
   markdown on stdin (or `--file path.md`).
3. The script opens the user's browser to a local URL and **blocks** until the
   user submits.
4. On submit, the script prints a JSON response to stdout and exits 0.
5. You parse the JSON and continue the conversation with the answers.

The Bash tool call blocks for the duration of the review. Set a long enough Bash
timeout (default `--timeout 1800` = 30 min); shorten with `--timeout 600` if you
expect a quicker turnaround.

`--timeout` is an **idle** timeout, not absolute. Each user interaction (typing,
saving a comment, clicking the timer pill) resets the deadline. A user actively
working can stay past the original window; a session abandoned mid-review still
exits at the configured idle interval.

## Question Block Syntax

<!-- prettier-ignore -->
```
::: question id=scope
Should we include the migration step in this PR or split it?
:::
```

Rules:

- `id` is required, must be unique within the doc, alphanumeric / `-` / `_`.
- The body is markdown; it renders inside the question card.
- The body must be non-empty.
- Zero `:::question` blocks is **valid** — the page becomes a read-only /
  comment-only review (rendered markdown + Submit button + inline-comment flow,
  no question cards). The agent gets back `{"answers": {}, "comments": [...]}`
  on submit.

## Invocation

Two file-pointing flags exist; the distinction is **intent**, not function:

- `--reference PATH` — **the doc the user wants to read.** Existing material the
  user already has, not authored by you. Renders with a small filename caption
  (`> Reference: filename.md`) so the user knows what they're reading.
- `--file PATH` — **your authored content, in a file instead of stdin.**
  Functionally equivalent to piping content on stdin, more convenient for very
  long agent-authored docs.

When `--reference` is combined with stdin or `--file`, the reference body lands
first, then a labeled boundary marker (a double-line rule with "END OF
`<filename>`" centered on it), then your content. The boundary only appears when
both reference and agent content are present — reference-only mode shows just
the caption, no boundary.

**Tip on combining `--reference` with agent content:** Bash heredoc + pipeline
constructs (`cat <<EOF | review.ts ... EOF`) can trip the harness's command
parser and surface an extra approval gate. Cleaner pattern: write your
agent-authored content to a project-local file (e.g.
`.agents/digestify-questions.md` — `.agents/` is gitignored in this repo) and
pass it as `--file`, in a separate Bash call from any test runs.

| Use case                                  | Pattern                                |
| ----------------------------------------- | -------------------------------------- |
| Agent writes everything (doc + questions) | stdin or `--file`                      |
| Pure reading of an existing doc           | `--reference path` only                |
| Existing doc + agent's added questions    | `--reference path` + stdin (preferred) |
| Existing doc + lots of agent content      | `--reference path` + `--file` (rare)   |

**stdin — agent writes everything:**

```bash
cat <<'EOF' | bun run ${CLAUDE_PLUGIN_ROOT}/skills/digestify/scripts/review.ts --title "Proposal Review" --timeout 1800
# Foo proposal

Some context paragraphs explaining the proposal...

::: question id=scope
Should we include the migration in this PR?
:::

More context...

::: question id=naming
Pick a name: `FooManager`, `FooService`, or `FooCoordinator`?
:::
EOF
```

**`--file` — agent already wrote the doc to a file:**

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/skills/digestify/scripts/review.ts \
  --file /path/to/proposal-review.md \
  --title "Proposal Review" \
  --theme digestify \
  --timeout 1800
```

**`--reference` — point at an existing doc on disk (token-efficient):**

Use this when the user has an existing markdown doc (proposal, README, spec,
brain-dump notes) they want to read in the browser, with or without your added
questions. The reference file is read directly by `review.ts` — its content
**never passes through your context**, which matters for long docs.

Reference-only (pure reading + comments, no questions):

```bash
bun run ${CLAUDE_PLUGIN_ROOT}/skills/digestify/scripts/review.ts \
  --reference /path/to/long-proposal.md \
  --title "Read this proposal"
```

Reference + your questions (combine the doc with your added prompts):

```bash
cat <<'EOF' | bun run ${CLAUDE_PLUGIN_ROOT}/skills/digestify/scripts/review.ts \
  --reference /path/to/long-proposal.md \
  --title "Proposal review"
## My Questions

::: question id=concerns
Any concerns about Section 3?
:::

::: question id=missing
Anything missing you'd want before approving?
:::
EOF
```

When `--reference` is combined with stdin or `--file`, the reference body lands
first and your added content appends below.

Themes:

- `digestify` — branded pink/purple gummy review UI. Default.
- `cthulhu` — dark eldritch green/purple review UI with Cthulhu-style assets.
- `classic` — restrained baseline styling for lower-flair contexts.

## Response Format

Stdout JSON on successful submit:

```json
{
  "answers": {
    "scope": "Split it — migration deserves its own review.",
    "naming": "FooCoordinator"
  },
  "comments": [
    {
      "anchor": "the assumption that all clients support TLS 1.3",
      "text": "this isn't true for the embedded fleet"
    }
  ],
  "submitted_at": "2026-05-07T12:34:56Z"
}
```

- `answers`: keys are question `id`s. **Missing keys mean the user left that
  question blank** — treat as "no answer", not as an empty-string answer.
- `comments`: array (possibly empty) of text-anchored inline comments.
- `submitted_at`: ISO 8601 UTC timestamp.

## Exit Code Contract

| Code | Meaning                                      | What to do                                                                                                                                                |
| ---- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Submitted                                    | Parse stdout JSON, continue conversation                                                                                                                  |
| 2    | Bad input                                    | stderr explains; fix the markdown and retry                                                                                                               |
| 124  | Timeout                                      | Tell the user "the digestify timed out — want to try again? I can also restore your prior draft if you didn't lose anything." (See **Session Recovery**.) |
| 130  | User closed the tab _after typing something_ | Tell the user "I noticed you closed the tab without submitting — want me to relaunch and restore your draft, or continue another way?"                    |

**Note on 130 vs. 124:** the page only fires the `/cancel` beacon if the user
has typed into a textarea or saved a comment. Closing or refreshing a clean page
without interacting is intentionally treated as "still thinking", not a cancel —
those abandons hit the `--timeout` and exit `124` instead of `130`.

## Flags

- `--file PATH` — read agent-authored markdown from this file instead of stdin
- `--reference PATH` — point at an existing doc on disk; its content never
  passes through your context. Combines with stdin/`--file` (reference body
  first, agent content appended).
- `--title TEXT` — page/tab title (default `"Document Review"`)
- `--theme NAME` — visual theme: `digestify` (default), `cthulhu`, `classic`
- `--timeout SECONDS` — failsafe timeout (default `1800` / 30 min)
- `--no-open` — don't auto-open the browser; useful in headless / SSH setups
- `--port N` — bind specific port (default: random free port)
- `--host HOST` — bind host (default `127.0.0.1`)
- `--id SLUG` — stable session id. Auto-generated if omitted in the form
  `digestify-<rand>-p<port>` (the trailing `-p<port>` encodes the bound port so
  a relaunch with the same id reuses that port and the browser's prior draft
  survives via localStorage). Pass back verbatim to recover an interrupted
  session — see **Session Recovery** below.

The script prints `{"url": "...", "port": N, "session_id": "..."}` to stderr as
soon as it's listening, before opening the browser. **Capture the `session_id`**
in the conversation context so you can offer recovery if the user later asks.

## Session Recovery

If a Digestify call exits **124** (idle timeout) or **130** (user closed the
tab), and the user later says something like "wait, I had a session — can I get
it back?", you can recover their in-progress draft:

1. Look up the `session_id` you captured from the last launch's stderr JSON.
2. Re-invoke `review.ts` with the same `--id <session_id>` — everything else
   (reference path, file, etc.) the same as before.
3. The browser opens to a page that auto-restores the prior answers and comment
   chips, with a "Draft restored from earlier session" banner.

Mechanics, for context:

- The user's draft lives in browser `localStorage`, keyed by `session_id`.
- `localStorage` is partitioned by origin (host+port). The auto-generated id
  embeds the bound port (`-p<port>` suffix), and the script reuses that port on
  relaunch — same origin → same `localStorage` namespace → restore works.
- Drafts persist for 7 days then auto-prune on next page load.
- Restore needs the same browser, no cleared site data, and the encoded port to
  still be bindable. Best-effort: an emergency hatch, not a guarantee.

If port rebinding fails (rare — process holding the port), the relaunch errors
clearly and you can tell the user the draft isn't recoverable this time.

## Reporting Friction With This Tool

If you hit anything rough _while using Digestify itself_ — confusing skill
instructions, an unexpected exit code, the page not rendering as documented, the
question fence syntax tripping you up, a flag that didn't behave as the docs
claimed, or a feature you wished existed — file an issue upstream so it can be
fixed.

File a GitHub issue against the **Spellbook** repo
(`github.com/ichabodcole/spellbook`) — the home of this tool — so the maintainer
can triage it.

**This is feedback about the _tool_, not the document.** Things in scope:

- Bugs in `review.ts` (wrong exit code, server didn't bind, JSON shape off).
- Confusion about how to invoke it, how the syntax works, or what an error
  meant.
- The browser UI breaking, looking wrong, or behaving unexpectedly.
- A feature that would have made your task easier (e.g., "I wanted a
  multiple-choice question type").
- A user who told you "this thing in Digestify isn't working / is annoying"
  while they were using it — relay that upstream.

Things **not** in scope for this channel (don't file these as Digestify issues):

- The content of the markdown the user is reviewing.
- The project / proposal / question being asked _through_ Digestify.
- Anything about the broader task you're working on.

You don't have to do this every session — only when there's something concrete
worth surfacing. If everything went smoothly, just continue.

## Common Pitfalls

- **Don't fire on soft cues.** "Summarize this", "what do you need to know",
  "rephrase that" — these stay in chat. Fire only on the magic word, or after
  the user accepts a suggested-invocation prompt.
- **Don't forget unique `id`s.** Duplicate IDs exit 2.
- **Don't expect a multi-turn session.** One submit ends the session. Spawn a
  fresh Digestify for a follow-up.
- **Set Bash timeout high enough.** The default Bash tool timeout is short. Pass
  a long `timeout` (in ms) on the Bash call, or shorten `--timeout` to match.
