---
name: magpie
description:
  Extract the individual visual assets out of a single composite image —
  moodboard, branding board, sticker sheet, style frame — each as its own PNG,
  with backgrounds removed where it makes sense. Use when the user says "magpie
  this", "extract the elements/assets from this board", "pull the
  icons/stickers/mascots out of this image", "separate the pieces of this
  composite", "give me each of these as its own file", or opens an asset board
  and wants the parts. Also worth proposing when the user has just received an
  AI-generated branding/style board and the next step is using its pieces. Opens
  a standing browser surface where the user reviews + steers the extraction
  while the agent does the cutting/removal. Do NOT use for a single-element
  image (nothing to separate) or a generic photo with no design-asset structure.
---

# Magpie — a co-presence asset-extraction surface

A magpie picks individual shiny things out of a busy collection. Hand it one
composite image and it returns each distinct asset as its own file —
illustrations and stickers get clean alpha, palettes and screenshots stay whole.
The deliverable is the **set of extracted assets** (a downloadable bundle); the
surface is where the human judges results and the agent does the work.

Kind: **conjuration** — a standing daemon with a browser surface the user works
inside, holding state and snapshotting so a session can be restored.

magpie is one leg of the image-work suite:

| Spell   | Job                                      |
| ------- | ---------------------------------------- |
| glamour | Compose the style spec from references   |
| imago   | Make / edit one image                    |
| magpie  | Extract discrete assets from a composite |

## When to use

- Direct asks: "magpie this", "extract the elements from this moodboard", "pull
  the stickers/icons/mascots out of this image", "separate these assets", "give
  me each of these as its own PNG".
- Proactive (propose, don't fire): the user just got an AI-generated branding /
  style board and the natural next step is using its pieces — "Want me to magpie
  that board into separate asset files?"

Not for a single-element image (just rename it) or a generic photo — magpie is
for **composites of distinct visual assets**, not generic image segmentation.

## The surface — a four-phase process

The user drops a composite and the two of you work through it across a linear
**top-bar stepper**. Each phase is an open→close exercise: the user steers, you
do the work, the user **seals** the phase (conversationally — see the loop), and
the sealed output feeds the next.

```
Intake  →  Slice  →  Remove  →  Export
drop +     fine-tune  remove      bundle +
discover   the cuts   backgrounds download
```

- **Intake** — the user drops a composite; you discover its elements. Auto-seals
  to Slice once elements land.
- **Slice** — an editable bounding-box canvas + a slices rail. The user nudges /
  resizes / renames / retypes / drops boxes or draws a missed one; you cut the
  boxes into raw crops (box-exact). The box **is** the only padding control.
- **Remove** — a gallery of cutouts on a backdrop swatch. The user asks for
  background removal, compares the resulting **versions** (one row per model
  tried), picks the winner, and flags any that need a different model.
- **Export** — pick which assets to include, then build a downloadable bundle
  (`assets/` + `crops/` + `manifest.json` + a self-contained `gallery.html`).

**Co-presence model: the human judges _results_, the agent picks _models_ and
does the work.** The bounding boxes and version rows are shared **game pieces**
— the user manipulates them to show you what they mean; you read that state and
act.

## Verbs

All verbs: `bun ${CLAUDE_PLUGIN_ROOT}/skills/magpie/scripts/cli.ts <verb>`. Verb
first; pass `--session <id>` **after the verb** to target a specific session
(default: most recent). `help` prints the full surface.

> **`${CLAUDE_PLUGIN_ROOT}` unset?** Some harnesses leave it empty, turning
> `${VAR}/skills/…` into `/skills/…` so bun fails with "module not found."
> Substitute the absolute path to this skill's `scripts/cli.ts`.

> **"no running session" but the daemon is alive?** The most-recent-session
> pointer (system temp dir, separate from the daemon) was lost. Recover with
> `--session <id>` (id is in the `open` output).

| Verb                                                                                                | What it does                                                                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `open [--title ..] [--intent ..] [--no-open] [--timeout S] [--restore <id\|path>]`                  | Spawn the daemon (opens the browser); prints `{port, session_id, files_dir}`                                        |
| `sessions`                                                                                          | List saved (resumable) sessions                                                                                     |
| `tail [--since N]`                                                                                  | Stream user events as JSONL — run via Monitor (see Operating rule)                                                  |
| `state [--full]`                                                                                    | State snapshot — lean by default; `--full` for raw                                                                  |
| `say <text…> [--stdin]`                                                                             | Post agent dialogue into the conversation (`--stdin` for piped NL text)                                             |
| `ask <text…> [--options "a\|b"]`                                                                    | Ask the user a question in-thread                                                                                   |
| `status on [text…] \| status off`                                                                   | Toggle the "magpie working" spinner                                                                                 |
| `source <imagePath>`                                                                                | Register the composite under review (computes sha + size)                                                           |
| `discover`                                                                                          | Run discovery on the current source → post the breakdown (needs `OPENROUTER_API_KEY`)                               |
| `extract [--ids a,b] [--remove] [--alpha auto\|all\|none] [--pad N] [--model <m>] [--label <name>]` | Cut slices — crop-only by default; `--remove` adds rembg; `--model` picks a removal model                           |
| `export [--ids a,b]`                                                                                | Build the downloadable bundle → `magpie-bundle.zip`, served for download                                            |
| `element-add --bbox "x1,y1,x2,y2" [--name ..] [--type ..]` · `element-remove <id>`                  | Box / un-box a region (source px)                                                                                   |
| `cmd [--stdin]`                                                                                     | POST a raw AgentCommand JSON body (the escape hatch — e.g. `elements.set`, `phase.set`, a `say` with an inline CTA) |
| `close` · `info` · `help`                                                                           | Shut the session (writes snapshot) · session JSON · full verb list                                                  |

## Operating rule: Monitor the tail (imperatives-only)

**Subscribe to the event stream and react the instant the user hands you work.**
Run via the Monitor tool:

```
bun ${CLAUDE_PLUGIN_ROOT}/skills/magpie/scripts/cli.ts tail
```

The tail pushes **imperatives only** — the moves where the user hands you work:
`say`, `source.added`, `extract`, `removeBg`, `retryRemoval`, `phase.advance`,
`phase.set`, `submit`, + lifecycle. **Ambient editing is NOT pushed** — box
moves/renames/retypes/draws/drops, the re-run flag, version picks, and the
backdrop swatch all mutate state silently. Don't wait for them; **read `state`
when an imperative fires** to see the current boxes / flags / chosen versions.

After `open`, stay quiet until the user does something. **Conversation is the
primary channel** — the user mostly steers by talking to you; on-surface buttons
are shortcuts for the same conversational acts (so don't expect a click for
every move).

## The loop — what to do on each imperative

| Imperative                                    | Do                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source.added {path}`                         | The user dropped a composite. `status on "discovering…"`, then `discover` (Gemini via `OPENROUTER_API_KEY`) — it posts the breakdown and auto-advances to Slice. Surface the element count + spend.                                                                                                 |
| `extract {ids?}`                              | Cut raw crops: `extract` (all) or `extract --ids <ids>` (a re-cut subset). Crop-only — the box is the slice.                                                                                                                                                                                        |
| `removeBg {ids?}`                             | Remove backgrounds with rembg: `extract --remove --ids <ids>` (absent ids → all alpha-eligible; the kept-whole types — palette / screenshot / typography — are skipped, never alpha'd). Lands as a `rembg` version.                                                                                 |
| `retryRemoval {ids}`                          | "Try a different model." For each flagged item, read its `versions[]` to see what's been tried, pick an **unused** model, and run it (see Background removal). Lands as a new version row; the flag auto-clears.                                                                                    |
| `phase.advance {phase}` / `phase.set {phase}` | Context, not an action — the user sealed/stepped to a phase. Note where they are (re-cuts likely after a back-step).                                                                                                                                                                                |
| `export {ids?}`                               | Build the bundle: `export --ids <ids>`. It zips the chosen assets and the surface lights up a Download link.                                                                                                                                                                                        |
| `say {text}`                                  | Respond in the thread (`say`). When you sense the user is ready to move on, you can advance for them (`cmd` → `{"type":"phase.set","phase":"<next>"}`) and/or offer a one-click CTA (`cmd` → `{"type":"say","text":"…","action":{"label":"Move to Remove →","command":{"type":"phase.advance"}}}`). |

Discover needs the source's on-disk path — read it from `state` (`source.path`).
To inspect the board's pixels yourself, `Read` that path.

## Background removal — local + cloud, discovered not hardcoded

The `extract --remove` path runs **rembg** locally (default model). The alpha
policy is **type-driven** (`--alpha auto`, the default under `--remove`):
removal runs only on **illustration / sticker / icon / wordmark**; **palette /
screenshot / typography are always kept whole** (flat color rembg would destroy)
— `extract --remove` skips them, so those stay as their raw crop. For
`retryRemoval`, run a genuinely **different** model — never re-run the same one:

- **A different rembg model** (local, free): `extract --remove --model <name>` —
  rembg ships a model zoo (`isnet-general-use`, `birefnet-general`, `u2netp`,
  …).
- **A cloud model** (often the cleanest edges):
  `extract --remove --model <id> --label <friendly>`, where `<id>` is a
  media-forge bg-remove model id (a provider path like
  `fal-ai/bria/background/remove`). **Discover the available ids** —
  `media-forge models list --format json`, the entries whose `operations`
  include `bg-remove` — don't hardcode them; the catalog drifts. `media-forge`
  (also `mf`) must be on PATH.

The cli routes by id shape (a `/` → media-forge, else rembg). The version's
`model` label is what the user sees in the strip; `--label` sets a friendly one.
**Models are never baked into the UI** — they appear only as labels on produced
versions, and adding one needs no app change.

## Session lifecycle

`close` snapshots the session to `$MAGPIE_HOME/snapshots/<session_id>.json`
(default `~/.magpie`). Restore with `open --restore <id>`. The Export view shows
the restore command. **Read the final state from the snapshot, not a live
`closed` event** — `close` shuts the daemon immediately and the event can race
the shutdown; treat the tail stream ending as end-of-session.

## Prerequisites & limits

- **Bun** on PATH — the daemon serves a Bun-bundled React surface; the first
  `open` triggers the bundle build (can take a few seconds cold).
- **`OPENROUTER_API_KEY`** — required for `discover` (Gemini 3.5 Flash
  identifies the elements; ~$0.01–0.03/board). If missing, `discover` fails fast
  — surface it and stop; do not install a key.
- **Python 3.11+ with `Pillow` + `rembg`** — required for cutting + local
  background removal (`pip install Pillow rembg`). The first rembg run downloads
  a model (~176MB); each additional rembg model downloads on first use.
- **`media-forge` CLI** — optional, only for cloud background removal. Without
  it, local rembg removal works fully.
- **`$MAGPIE_HOME`** (default `~/.magpie`) — where snapshots are written.
- The magpie family identity is **warm cream + iridescent indigo + treasure
  gold** (the export `gallery.html`); keep it intact across the family.

## Feedback touchpoint

At a natural close, surface friction so the tool improves:

- **Agent friction** — if a verb misbehaved, the state/event shape fought you,
  or the loop guidance was unclear, file a GitHub issue against the
  **Spellbook** repo (`github.com/ichabodcole/spellbook`).
- **Human** — when the user is on the surface, offer once (easy to skip):
  "anything about magpie itself feel off or worth improving?" Route what they
  say to the same issues.

This is feedback about the **tool**, not the assets being extracted.
