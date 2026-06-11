---
name: glamour
description:
  Compose a re-castable visual style from references. Use when the user wants to
  define, capture, or nail down a look / art direction / visual identity — "help
  me define a visual style", "build a style guide from these images", "what's
  the art direction for X", "capture the look I'm going for", "I have some
  reference images, help me find the style". Opens a standing browser studio: the
  user brings influence images + context (text/world docs) + intent, the agent
  synthesizes a deep understanding and produces a structured **style spec** (the
  durable artifact) plus representative generated images. Do NOT use for one-off
  image generation or editing where no reusable style spec is wanted.
---

# Glamour — compose a visual style

A **glamour** is an enchantment cast over appearance. The user brings influences
(reference images), context (world/brand docs), and intent; the agent
synthesizes the look and hands back a **re-castable style spec** +
representative imagery. The deliverable is the **spec**, not the pictures — the
images illustrate the look so future generation can reproduce it.

Kind: **conjuration** — a standing daemon with a 3-pane studio the user works
inside, holding state and snapshotting so a session can be restored. The agent
does the thinking (reading references, synthesizing, generating via
media-forge); the surface is the membrane where the user steers and the agent
reports.

## When to use

- "Define / capture / dial in a visual style (or art direction, look, visual
  identity) for X" — from a pile of references, world docs, or just a
  description.
- Open-ended exploration ("I don't know what I want, show me a range") as much
  as locking in a known look.

**Two modes — infer from intent, don't ask mechanically:**

- **Style-capture (default)** — the deliverable is the style spec; generated
  images are illustrative, not extractable. Most requests are this.
- **Asset-board** — the user wants discrete assets pulled _out_ (logos,
  stickers, icons, mascots) to use separately. Only here do the media-forge
  **transform** verbs (background-removal, cutout, vector) belong; offering them
  in style-capture mode misreads intent.

## Verbs

All verbs: `bun ${CLAUDE_PLUGIN_ROOT}/skills/glamour/scripts/cli.ts <verb>`. To
target a specific session, put `--session <id>` **after the verb and its flags**
(`cli.ts <verb> [args] --session <id>`) — the verb must be the first argument,
so a leading `--session` is misread as the verb and fails. Default is the most
recent session. `help` prints the full surface.

> **"no running session" but your daemon is alive?** The most-recent-session
> pointer (kept in the system temp dir, separate from the daemon) was lost — a
> second session or temp-dir cleanup can drop it. Recover by re-targeting
> explicitly: `--session <id>` (your id is in the `open` output, or run
> `sessions`). The daemon itself is fine.

> `${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's install path in Claude Code.
> If it's unset in your shell (some harnesses leave it empty), substitute the
> absolute path to this skill's `scripts/cli.ts` — an empty value silently turns
> `${VAR}/skills/…` into `/skills/…` and `bun` fails with "module not found".

| Verb                                                                                          | What it does                                                                                    |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `open [--title ..] [--intent ..] [--no-open] [--timeout S] [--restore <id\|path>]`            | Spawn the daemon (opens the browser); prints session JSON (`port`, `session_id`, `files_dir`)   |
| `sessions`                                                                                    | List saved, resumable sessions                                                                  |
| `tail [--since N]`                                                                            | Stream user events as JSONL — **wrap with Monitor** (see below)                                 |
| `state [--full]`                                                                              | State snapshot — **lean by default** (image/text blobs stripped); `--full` for raw incl. base64 |
| `intent <text…>`                                                                              | Set/replace the intent                                                                          |
| `read <influenceId> <text…>`                                                                  | Post your per-image analysis (advances phase → analysis)                                        |
| `phase <gather\|analysis\|direction\|prompts\|variants\|spec>`                                | Set the phase explicitly                                                                        |
| `direction <text…> [--revision N]`                                                            | Post the synthesized direction (→ direction)                                                    |
| `prompts "<p1>" "<p2>" …`                                                                     | Post the generation prompts (→ prompts)                                                         |
| `variant (--url <u> \| --file <p> \| --src <dataurl>) [--prompt ..] [--label ..] [--round N]` | Add a generated variant (→ variants; image is optimized server-side)                            |
| `variants-clear`                                                                              | Clear variants and increment the round                                                          |
| `spec [--understanding ..] [--recreate ..] [--model ..] [--modules "palette=on,…"]`           | Write the style spec (→ spec). Flags are **space-form only**                                    |
| `cost <text…>`                                                                                | Set the cumulative-spend display                                                                |
| `handoff <text…> \| handoff --clear`                                                          | Raise/clear the "questions in your terminal" banner before a terminal `AskUserQuestion`         |
| `narrate [--kind info\|working\|result\|error] <text…>`                                       | Append to the agent activity feed the user sees                                                 |
| `status on [text…] \| status off`                                                             | Toggle the "agent working" spinner                                                              |
| `say <text…>`                                                                                 | Ephemeral toast                                                                                 |
| `close` / `info` / `help`                                                                     | End the session / print session JSON / usage                                                    |

The user can only add **influences and context** from the browser (drag-drop) —
the agent never adds those. Everything else (reads, direction, prompts,
variants, spec) the agent posts.

## Run it push-based — Monitor the tail, don't poll

The single most important operating rule: **subscribe to the event stream and
react the instant the user acts.** Run `cli.ts tail` as a long-lived background
process and wake on each new line — in Claude Code that's the **Monitor** tool
(it backgrounds a command and turns each new stdout line into a fresh turn); in
any runtime the shape is "tail in the background, react per line." Filter to the
events that need an agent response:

```
tail -f <tail output> | grep -E '"type":"(nudge|feedback|steer|generate|submit|note|direction\.correct)"'
```

Polling `state` only when you happen to check leaves the user staring at a
spinner. Read the matching event's full payload from the tail output (event
notifications truncate long text) or from `state`.

## The flow

`gather → analysis → direction → prompts → variants → spec`. The phase
**auto-advances** when you post the matching artifact (`read` → analysis,
`direction` → direction, `prompts` → prompts, first `variant` → variants, `spec`
→ spec), so post content for the phase you're in and let it carry.

- **gather** — the user drops influences + context from the browser and
  annotates (aspects, star, notes); **you cannot add them** — there is no agent
  verb for it, so after `open` you wait in `gather` until they appear. Watch for
  them: influences/contexts populate in `state` as the user drops, and `note`
  events arrive on the tail. Don't post `read`s until `state.influences` is
  non-empty (a `read` for an unknown influence id silently no-ops with
  `ok:true`). To read images, `Read` the on-disk `path` of each influence
  (vision needs real pixels); read context files at their `path` too.
- **analysis** — post a `read` for **each** influence (the phase flips to
  analysis on the first). The user reviews and may send **batched corrections**
  (a `feedback` event, `scope:"analysis"`) — revise your reads and re-post.
- **direction** — post the synthesized `direction`. The user accepts, or sends
  `direction.correct` with `mode: "correct"` (that's wrong) vs `"augment"` (yes,
  and…) — honor the distinction.
- **prompts** — post `prompts`. User comments (batched `feedback`,
  `scope:"prompts"`) or triggers `generate`.
- **variants** — on `generate`, produce images via media-forge and post each as
  a `variant` (with `--prompt`, `--label`, `--round`). The user likes / sets one
  canonical / sends `steer` notes; on a steer+generate, produce the next round.
- **spec** — post the `spec`: the `understanding` (core look); the four modules
  `palette` / `consistency` / `motifs` / `dosdonts` (toggle via
  `--modules "palette=on,motifs=off"`, each carries its own `content`); a
  `--recreate` prompt; and a pinned `--model`. Pass flags **space-form**
  (`--understanding "…"`, never `--understanding=…`). The user picks the
  canonical image and exports.

When you must fall back to a terminal `AskUserQuestion`, raise a `handoff`
banner first so the user knows to look there, and `handoff --clear` after.

## The handoff is via the snapshot, not the submit event

`submit` ends the session **and shuts the daemon down** — the live `submit`/
`closed` event races that shutdown and is often lost. So: treat the daemon going
away (the tail stream ends and won't reconnect / the session file disappears) as
end-of-session, and read the final spec from the saved snapshot
(`$GLAMOUR_HOME/snapshots/<session_id>.json`, default `~/.glamour`). Never block
waiting on a live `submit`.

## Prompts and model routing

- **Prompts are self-contained visual descriptions.** Strip invented proper
  nouns the image model has no reference for (character/place names); describe
  what's visually in frame. If a name must appear, specify it as visible
  signage. Each prompt restates all the visual context it needs — no bleeding
  context from one prompt to the next.
- **Consistency:** carry the same STYLE + PALETTE prompt-blocks verbatim across
  different subjects to hold one coherent look; `--ref` is for _same-character_
  poses/expressions, not style.
- **Routing:** explore cheap (e.g. grok-imagine, klein) → finalize on a clean
  instruction-follower (nano-banana-2). Exact model ids, the content-type →
  model matrix, per-model prompt structure, transform verbs, cost, and CLI
  gotchas live in `references/mediaforge.md` (it ships with the skill). Read it
  before generating; don't reproduce it here.

## Prerequisites & limits

- **Bun** on PATH (the daemon serves a Bun-bundled React surface; first `open`
  builds it). Restore with `open --restore <id>`.
- **`media-forge` CLI** on PATH — generation runs through it (see
  `references/mediaforge.md`); it's a separate tool the user installs, so
  confirm it with `media-forge status` / `media-forge ping` before relying on
  it. Without it the gather → direction → prompts → spec flow still works, but
  the variants phase can't generate; tell the user if it's missing.
- The session snapshot lives at `$GLAMOUR_HOME/snapshots/<session_id>.json`
  (default `~/.glamour`).
- Report spend via media-forge's `usage summary` / `jobs get` — the `generate`
  response alone doesn't carry per-job cost; surface it with `cost`.

## Feedback touchpoint

At a natural close, surface friction so the tool improves:

- **Agent friction** — if a verb misbehaved, the state/event shape fought you,
  or the flow was unclear, file a GitHub issue against the **Spellbook** repo
  (`github.com/ichabodcole/spellbook`).
- **Human** — when the user is on the surface, offer once (easy to skip):
  "anything about glamour itself feel off or worth improving?" Route what they
  say to the same issues.

This is feedback about the **tool**, not the style being composed.
