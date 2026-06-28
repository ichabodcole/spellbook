# Grapevine — Channel Lifecycle Implementation Plan

> **Status:** Archived (Implemented) — `open` auto-unarchive, `reset`, and
> `open --fresh` shipped and merged; 90 tests pass. Archived 2026-06-27.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a reused, long-lived team channel safe to convene → work → wrap →
re-convene: `open` auto-unarchives, a new `reset` snapshots-then-clears the log,
and `open --fresh` clears only when no seats are connected (never nukes a live
session).

**Architecture:** grapevine is a Bun daemon (owns
`~/.grapevine/channels/<name>.jsonl` logs + an in-memory `Channel` map with a
`subscribers` map) and a thin CLI that talks to it over HTTP. All three
behaviors are daemon-owned (the daemon holds the logs + the live-subscriber
truth); the CLI adds flags/verbs that call new or changed daemon endpoints.

**Tech Stack:** Bun, TypeScript, `node:fs`. Tests: `bun test` via the existing
tmpdir-HOME `bunRun` harness in `cli.test.ts`.

**Design record:** resolved live with the requester (dream-flute maestro) in the
`grapevine-lifecycle` channel. Resolved decisions are restated under "Resolved
design" below — that section is the spec.

## Resolved design (the spec)

1. **`open` auto-unarchives.** Opening an archived channel removes the archived
   marker and reopens it (no flag, no `409`). The convene-at-start bug is gone.
   Response carries `unarchived: true` when it did so.
2. **`reset <name> [--force]`** (primary verb). Snapshot the channel log to
   `~/.grapevine/archive/<name>-<ts>.jsonl`, print the path, then clear the live
   log (empty channel, same name). **Guard:** if the channel has live
   subscribers and `--force` is not given, refuse (`409`, names `--force`). The
   snapshot always precedes the clear, so even a forced reset is recoverable.
3. **`open --fresh <name>`** (sugar over the reset core). Open the channel and
   clear it **only when there are no live subscribers**; **no-op the clear when
   seats are present** (just open). This is the load-bearing safety property: a
   re-runnable/idempotent convene must never wipe a live session. Clean slate at
   true session start (nobody subscribed yet); safe no-op on a mid-session
   re-run.
4. **Snapshot mechanics:** `~/.grapevine/archive/<name>-<ts>.jsonl`, dir created
   on demand, path returned/printed. No retrieval/list verb this round.
5. **Clearing semantics:** a clear resets the log to empty and the in-memory
   channel (`next_id → 1`, `topic → null`, `last_activity → now`). The topic is
   cleared with the log; `open --fresh --topic <t>` re-applies it via the
   existing open-topic path (which only sets a topic when none is present).

Out of scope (explicit fast-follow): per-message **disposition/status**
(headline requirement: query-by-status; append-only `kind:"status"`; intake
channels). Not gating this release.

## Global Constraints

- **Branch:** all work lands on `feat/grapevine-channel-lifecycle` (off
  `develop`). Do NOT push or release — the maintainer (Cole) handles that. Merge
  to `develop` locally only at the end.
- **Runtime:** Bun. Tests:
  `bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts` (the suite
  spawns its own daemon under a tmpdir `GRAPEVINE_HOME`). Never npm/jest.
- **Version:** do NOT hand-edit `plugins/spellbook/.claude-plugin/plugin.json`.
  release-please bumps it from conventional commits. New behavior →
  `feat(grapevine): …` (minor). The plugin is at 1.8.0; this release is a minor
  bump.
- **No new spell, no rename, no removal** → the ward "synced listings" (roster)
  do NOT change. This is a _spell revision_: bun test green + new behavior
  tested, narrative banner, decay-ledger check, smoke test (handled in
  Finalize).
- **Format:** `bunx biome check --write` on changed `.ts`; prettier on changed
  `.md`. Do not run prettier on `.ts`.
- **Daemon may use `Date.now()` / fs** freely (it is the IO/time owner —
  grapevine has no purity rule like glamour's reducers).
- **Commit trailer** on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

| File                  | Responsibility                                                                              | Tasks   |
| --------------------- | ------------------------------------------------------------------------------------------- | ------- |
| `scripts/daemon.ts`   | `ARCHIVE_DIR`; `snapshotAndClear()` core; `open` auto-unarchive + `fresh`; `reset` endpoint | 1, 2, 3 |
| `scripts/cli.ts`      | `open --fresh` flag; `reset` verb + `cmdReset`; `fresh` in `BOOLEAN_FLAGS`; HELP            | 2, 3, 4 |
| `scripts/cli.test.ts` | tests for auto-unarchive, reset (+guard), open --fresh                                      | 1, 2, 3 |
| `SKILL.md`            | document the three behaviors; narrative banner                                              | 4       |

All paths under `plugins/spellbook/skills/grapevine/`.

---

### Task 1: `open` auto-unarchives

**Files:**

- Modify: `scripts/daemon.ts` — the `POST /channels` handler (the archived-check
  at ~lines 423-424).
- Test: `scripts/cli.test.ts` — flip the re-open-lock assertion in the existing
  archive test (~lines 335-365); add a focused auto-unarchive test.

**Interfaces:**

- Produces: `POST /channels` on an archived channel now succeeds, removes the
  `<name>.archived` marker, sets `ch.archived = false`, and returns the normal
  open payload plus `unarchived: true`.

- [ ] **Step 1: Update the existing archive test to the new behavior**

In `cli.test.ts`, the test
`"archive makes a channel read-only; unarchive restores (V1.7)"` currently
asserts the name is locked from re-open:

```ts
// the name is locked from re-open
const reopen = await bunRun(["open", "test_arch"]);
expect(reopen.code).not.toBe(0);
```

Replace that block with the new contract — `open` auto-unarchives:

```ts
// open auto-unarchives (the convene-at-start path): reopening a retired
// channel brings it back rather than failing.
const reopen = await bunRun(["open", "test_arch"]);
expect(reopen.code).toBe(0);
expect(JSON.parse(reopen.stdout).channel.unarchived).toBe(true);
// and it is writable again immediately
const afterReopen = await bunRun(["send", "test_arch", "--from", "a", "back"]);
expect(afterReopen.code).toBe(0);
```

(The later `unarchive` portion of the test still works — unarchive on an
already-unarchived channel is covered separately; if the remaining lines of the
test re-archive/unarchive, leave them. Read the whole test and keep its other
assertions intact.)

- [ ] **Step 2: Add a focused auto-unarchive test**

Add near the other lifecycle tests:

```ts
test("open auto-unarchives an archived channel (V1.8)", async () => {
  await bunRun(["open", "au_chan"]);
  await bunRun(["send", "au_chan", "--from", "a", "hi"]);
  expect(
    JSON.parse((await bunRun(["archive", "au_chan"])).stdout).archived
  ).toBe(true);

  const reopen = await bunRun(["open", "au_chan"]);
  expect(reopen.code).toBe(0);
  expect(JSON.parse(reopen.stdout).channel.unarchived).toBe(true);

  // history is intact (auto-unarchive does NOT clear)
  const pull = await bunRun(["pull", "au_chan", "--since", "0"]);
  expect(JSON.parse(pull.stdout).messages.length).toBe(1);

  // list no longer shows it archived
  const ch = JSON.parse((await bunRun(["list"])).stdout).channels.find(
    (c: { name: string; archived?: boolean }) => c.name === "au_chan"
  );
  expect(ch.archived).toBe(false);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
`bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts -t "auto-unarchive"`
Expected: FAIL — open still returns `409 archived`.

- [ ] **Step 4: Implement auto-unarchive in the daemon**

In `scripts/daemon.ts`, the `POST /channels` handler currently has:

```ts
if (existsSync(archivedPath(body.name))) {
  return json({ error: "archived", channel: body.name }, { status: 409 });
}
const ch = loadChannel(body.name);
```

Replace with auto-unarchive (mirrors the `/unarchive` handler's marker-removal +
double-check):

```ts
// Auto-unarchive: the obvious verb does the obvious thing, so a
// convene-at-start wrapper never breaks on a channel a prior session retired.
let unarchived = false;
const ap = archivedPath(body.name);
if (existsSync(ap)) {
  try {
    unlinkSync(ap);
  } catch {}
  if (existsSync(ap)) {
    return json(
      { error: "unarchive failed — marker still present", channel: body.name },
      { status: 500 }
    );
  }
  unarchived = true;
}
const ch = loadChannel(body.name);
if (unarchived) ch.archived = false;
```

Then add `unarchived` to the success response object:

```ts
return json({
  name: ch.name,
  created_at: ch.created_at,
  message_count: ch.next_id - 1,
  subscribers: visibleSubs(ch).length,
  topic: ch.topic,
  unarchived,
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts` Expected:
PASS (the new tests + the updated archive test + all existing).

- [ ] **Step 6: Commit**

```bash
bunx biome check --write plugins/spellbook/skills/grapevine/scripts/daemon.ts plugins/spellbook/skills/grapevine/scripts/cli.test.ts
git add -A && git commit -m "feat(grapevine): open auto-unarchives an archived channel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: `reset` — snapshot-then-clear with the live-subscriber guard

**Files:**

- Modify: `scripts/daemon.ts` — add `ARCHIVE_DIR`; add `snapshotAndClear()`; add
  the `POST /channels/:name/reset` handler.
- Modify: `scripts/cli.ts` — add `cmdReset`; wire the `reset` verb; HELP.
- Test: `scripts/cli.test.ts` — reset clears + snapshots; the live-subscriber
  guard refuses without `--force` and proceeds with it.

**Interfaces:**

- Produces (daemon):
  - `ARCHIVE_DIR = join(DATA_DIR, "archive")`.
  - `snapshotAndClear(name: string): string | null` — copies the log to
    `ARCHIVE_DIR/<name>-<Date.now()>.jsonl`, truncates the live log to empty,
    resets the in-memory channel (`next_id=1`, `topic=null`,
    `last_activity=now`). Returns the snapshot path, or `null` if there was no
    log to snapshot. Does NOT check subscribers (callers apply their own guard).
  - `POST /channels/:name/reset` with body `{ force?: boolean }` →
    `409 {error:"live", channel, subscribers}` if live subs and not forced; else
    `{ ok:true, channel, snapshot, cleared:true }`.
- Produces (CLI): `reset <name> [--force]` verb; `cmdReset(name, { force })`.

- [ ] **Step 1: Write the failing tests**

Add to `cli.test.ts`. Note the live-guard test spawns a real `tail` subscriber
using the suite's tracked-process pattern (`spawn` + `TRACKED_PROCS`):

```ts
test("reset snapshots then clears the log (V1.8)", async () => {
  await bunRun(["open", "rs_chan"]);
  await bunRun(["send", "rs_chan", "--from", "a", "one"]);
  await bunRun(["send", "rs_chan", "--from", "a", "two"]);

  const res = await bunRun(["reset", "rs_chan"]);
  expect(res.code).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(out.cleared).toBe(true);
  expect(typeof out.snapshot).toBe("string");
  expect(existsSync(out.snapshot)).toBe(true); // snapshot written under ~/.grapevine/archive

  // live log is now empty
  const pull = await bunRun(["pull", "rs_chan", "--since", "0"]);
  expect(JSON.parse(pull.stdout).messages.length).toBe(0);

  // snapshot holds the prior two messages
  const snap = readFileSync(out.snapshot, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  expect(snap.length).toBe(2);
});

test("reset refuses a live channel without --force, proceeds with it (V1.8)", async () => {
  await bunRun(["open", "rs_live"]);
  await bunRun(["send", "rs_live", "--from", "a", "live one"]);

  // a real subscriber makes the channel "live"
  const tail = spawn(
    process.execPath,
    [CLI, "tail", "rs_live", "--as", "seat"],
    {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  TRACKED_PROCS.add(tail);
  await sleep(400); // let the tail subscribe

  const blocked = await bunRun(["reset", "rs_live"]);
  expect(blocked.code).not.toBe(0);
  expect(blocked.stderr).toContain("--force");
  // history survives the refused reset
  expect(
    JSON.parse((await bunRun(["pull", "rs_live", "--since", "0"])).stdout)
      .messages.length
  ).toBe(1);

  const forced = await bunRun(["reset", "rs_live", "--force"]);
  expect(forced.code).toBe(0);
  expect(JSON.parse(forced.stdout).cleared).toBe(true);

  tail.kill("SIGTERM");
  TRACKED_PROCS.delete(tail);
});
```

Ensure the test file imports `readFileSync`/`existsSync` from `node:fs` and
`spawn` from `node:child_process` (check the existing imports — `spawn`, `HOME`,
`CLI`, `TRACKED_PROCS`, `sleep` already exist; add `readFileSync` if missing).

- [ ] **Step 2: Run tests to verify they fail**

Run:
`bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts -t "reset"`
Expected: FAIL — no `reset` verb / endpoint.

- [ ] **Step 3: Add `ARCHIVE_DIR` + `snapshotAndClear()` in the daemon**

In `scripts/daemon.ts`, near `CHANNELS_DIR` (lines 67-74):

```ts
const ARCHIVE_DIR = join(DATA_DIR, "archive");
```

Confirm the imports include `copyFileSync`, `mkdirSync`, `writeFileSync`,
`existsSync` from `node:fs` (add any missing). Then add the core (place near the
other channel helpers, e.g. after `archivedPath`):

```ts
// Snapshot a channel's log to the archive dir, then clear the live log. Returns
// the snapshot path, or null if there was nothing to snapshot. No subscriber
// guard here — callers (reset / open --fresh) apply their own.
function snapshotAndClear(name: string): string | null {
  const p = channelPath(name); // validates the name
  let snapshot: string | null = null;
  if (existsSync(p)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    snapshot = join(ARCHIVE_DIR, `${name}-${Date.now()}.jsonl`);
    copyFileSync(p, snapshot);
    writeFileSync(p, "");
  }
  const ch = channels.get(name);
  if (ch) {
    ch.next_id = 1;
    ch.topic = null;
    ch.last_activity = Date.now();
  }
  return snapshot;
}
```

- [ ] **Step 4: Add the `reset` endpoint**

In the per-channel handler block of `daemon.ts` (alongside `/archive`,
`/unarchive`), add:

```ts
if (sub === "/reset" && method === "POST") {
  const body = (await readJsonBody(req)) ?? {};
  const ch = channels.get(name);
  const liveSubs = ch ? ch.subscribers.size : 0;
  if (liveSubs > 0 && body.force !== true) {
    return json(
      { error: "live", channel: name, subscribers: liveSubs },
      { status: 409 }
    );
  }
  const snapshot = snapshotAndClear(name);
  return json({
    ok: true,
    channel: name,
    snapshot,
    cleared: snapshot !== null,
  });
}
```

(Guard counts ALL connections — `ch.subscribers.size`, including lurking watch
tabs — so a reset never clears under any live presence. `readJsonBody` is the
existing body parser used by `POST /channels`.)

- [ ] **Step 5: Add the CLI `reset` verb**

In `scripts/cli.ts`, add (near `cmdArchive`):

```ts
async function cmdReset(name: string, opts: { force?: boolean }) {
  if (!name) die("usage: grapevine reset <name> [--force]");
  const port = await ensureDaemon();
  const body: Record<string, boolean> = {};
  if (opts.force) body.force = true;
  const { status, data } = await api<{ error?: string; subscribers?: number }>(
    port,
    "POST",
    `/channels/${name}/reset`,
    body
  );
  if (status === 409 && data?.error === "live") {
    die(
      `channel has ${data.subscribers} live subscriber(s) — refusing to clear a live session. Re-run with --force to clear anyway (the log is snapshotted first).`
    );
  }
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, ...data });
}
```

Wire it in the `main` dispatch switch (near `archive`):

```ts
    case "reset":
      await cmdReset(positional[0], { force: flags.force === true });
      return 0;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts` Expected:
PASS.

- [ ] **Step 7: Commit**

```bash
bunx biome check --write plugins/spellbook/skills/grapevine/scripts/daemon.ts plugins/spellbook/skills/grapevine/scripts/cli.ts plugins/spellbook/skills/grapevine/scripts/cli.test.ts
git add -A && git commit -m "feat(grapevine): reset verb — snapshot-then-clear with live-subscriber guard

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `open --fresh` (sugar over the reset core)

**Files:**

- Modify: `scripts/daemon.ts` — `POST /channels` honors `fresh: true` (clears
  only when no live subscribers; reuses `snapshotAndClear`).
- Modify: `scripts/cli.ts` — `open --fresh` flag → `fresh` in the open body; add
  `"fresh"` to `BOOLEAN_FLAGS`.
- Test: `scripts/cli.test.ts` — open --fresh clears a dormant channel; no-ops
  the clear on a live one.

**Interfaces:**

- Consumes: `snapshotAndClear` (Task 2), the auto-unarchive `open` (Task 1).
- Produces: `POST /channels` with `{ fresh: true }` → if the channel has no live
  subscribers, snapshot+clear before opening (response carries `cleared: true` +
  `snapshot`); if seats are present, open WITHOUT clearing (`cleared: false`).
  CLI: `open --fresh <name>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("open --fresh clears a dormant channel's history (V1.8)", async () => {
  await bunRun(["open", "of_chan"]);
  await bunRun(["send", "of_chan", "--from", "a", "stale one"]);
  await bunRun(["send", "of_chan", "--from", "a", "stale two"]);

  const fresh = await bunRun(["open", "of_chan", "--fresh"]);
  expect(fresh.code).toBe(0);
  expect(JSON.parse(fresh.stdout).channel.cleared).toBe(true);

  expect(
    JSON.parse((await bunRun(["pull", "of_chan", "--since", "0"])).stdout)
      .messages.length
  ).toBe(0);
});

test("open --fresh does NOT clear a live channel (idempotent-convene guard) (V1.8)", async () => {
  await bunRun(["open", "of_live"]);
  await bunRun(["send", "of_live", "--from", "a", "in flight"]);

  const tail = spawn(
    process.execPath,
    [CLI, "tail", "of_live", "--as", "seat"],
    {
      env: { ...process.env, GRAPEVINE_HOME: HOME },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  TRACKED_PROCS.add(tail);
  await sleep(400);

  const fresh = await bunRun(["open", "of_live", "--fresh"]);
  expect(fresh.code).toBe(0);
  expect(JSON.parse(fresh.stdout).channel.cleared).toBe(false); // seats present → no clear
  expect(
    JSON.parse((await bunRun(["pull", "of_live", "--since", "0"])).stdout)
      .messages.length
  ).toBe(1);

  tail.kill("SIGTERM");
  TRACKED_PROCS.delete(tail);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts -t "fresh"`
Expected: FAIL — `--fresh` is ignored, history not cleared / `cleared` absent.

- [ ] **Step 3: Honor `fresh` in the daemon `open` handler**

In `scripts/daemon.ts` `POST /channels`, AFTER the auto-unarchive block (Task 1)
and BEFORE `const ch = loadChannel(body.name)`, insert the fresh-clear:

```ts
// open --fresh: clear the channel for a new session, but ONLY when no seats
// are connected. A re-runnable convene must never wipe a live session.
let cleared = false;
let snapshot: string | null = null;
if (body.fresh === true) {
  const existing = channels.get(body.name);
  const liveSubs = existing ? existing.subscribers.size : 0;
  if (liveSubs === 0) {
    snapshot = snapshotAndClear(body.name);
    cleared = true;
  }
}
const ch = loadChannel(body.name);
if (unarchived) ch.archived = false;
```

(The existing `const ch = loadChannel(...)` line moves below this block — keep a
single declaration. `cleared` is reported even when there was nothing to
snapshot; `cleared:false` only when seats were present.)

Then extend the success response with the fresh fields:

```ts
return json({
  name: ch.name,
  created_at: ch.created_at,
  message_count: ch.next_id - 1,
  subscribers: visibleSubs(ch).length,
  topic: ch.topic,
  unarchived,
  cleared,
  snapshot,
});
```

(The optional-topic-on-open block that follows is unchanged — after a fresh
clear `ch.topic` is `null`, so `open --fresh --topic <t>` re-applies the topic
through the existing path.)

- [ ] **Step 4: Add `--fresh` to the CLI**

In `scripts/cli.ts`: add `"fresh"` to the `BOOLEAN_FLAGS` set. Extend
`cmdOpen`'s opts + body:

```ts
async function cmdOpen(
  name: string,
  opts: { topic?: string; from?: string; fresh?: boolean }
) {
  if (!name) die("usage: grapevine open <name> [--topic <text>] [--fresh]");
  const port = await ensureDaemon();
  const body: Record<string, string | boolean> = { name };
  if (opts.topic !== undefined) body.topic = opts.topic;
  if (opts.from !== undefined) body.from = opts.from;
  if (opts.fresh) body.fresh = true;
  const { status, data } = await api<OpenResponse>(
    port,
    "POST",
    "/channels",
    body
  );
  if (status >= 400) die(data?.error ?? `HTTP ${status}`);
  printJson({ ok: true, channel: data });
}
```

Update the `open` dispatch case to pass `fresh`:

```ts
    case "open":
      await cmdOpen(positional[0], {
        topic: flags.topic as string | undefined,
        from: resolveAlias(flags),
        fresh: flags.fresh === true,
      });
      return 0;
```

If `OpenResponse` is a typed interface, add
`unarchived?: boolean; cleared?: boolean; snapshot?: string | null` to it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts` Expected:
PASS (full suite).

- [ ] **Step 6: Commit**

```bash
bunx biome check --write plugins/spellbook/skills/grapevine/scripts/daemon.ts plugins/spellbook/skills/grapevine/scripts/cli.ts plugins/spellbook/skills/grapevine/scripts/cli.test.ts
git add -A && git commit -m "feat(grapevine): open --fresh — clear a dormant channel, never a live one

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Documentation — SKILL.md + HELP

**Files:**

- Modify: `scripts/cli.ts` — the HELP/usage text block.
- Modify: `SKILL.md` — document the three behaviors; refresh the usage list.

**Interfaces:** none (docs).

- [ ] **Step 1: Update CLI HELP**

In `scripts/cli.ts`, find the HELP usage block (the multi-line string listing
verbs). Add/adjust:

```
  open <name> [--topic <text>] [--fresh]   open/create (auto-unarchives; --fresh clears a dormant channel)
  reset <name> [--force]                   snapshot the log → ~/.grapevine/archive, then clear it
```

Keep the existing alphabetical/grouping style of the block.

- [ ] **Step 2: Document in SKILL.md**

Add a short "Channel lifecycle" subsection (near the verb reference / the
archive/close docs) covering: `open` auto-unarchives; `reset` snapshots-then-
clears (path under `~/.grapevine/archive/`); `open --fresh` clears only a
dormant channel and is a safe no-op when seats are connected (built for an
idempotent convene-at-start ritual). One worked example:

```
# convene at session start — clean slate if nobody's connected, safe no-op if they are
grapevine open team-channel --fresh

# wrap a session by hand (explicit) — snapshot kept under ~/.grapevine/archive
grapevine reset team-channel
```

- [ ] **Step 3: Build-sanity + full suite**

Run: `bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts` (still
green) and `bun plugins/spellbook/skills/grapevine/scripts/cli.ts help` (HELP
renders, shows the new verbs).

- [ ] **Step 4: Commit**

```bash
bunx biome check --write plugins/spellbook/skills/grapevine/scripts/cli.ts
npx prettier --write plugins/spellbook/skills/grapevine/SKILL.md
git add -A && git commit -m "docs(grapevine): document open --fresh, reset, and open auto-unarchive

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Finalize (controller-run — ward + the dream-flute ping)

Not subagent tasks. After Task 4's review is clean:

- [ ] Whole-branch review (opus) over the branch range, including the already-
      committed watch-sidebar fix (`6eea5c0`).
- [ ] **ward (revising an existing spell):** `bun test` green ✓; new behavior
      tested ✓; **narrative banner** — decide V1.8 "channel lifecycle" banner in
      `SKILL.md` (the spell's internal version, separate from plugin semver) and
      update it; **decay-ledger** check (`grimoire/decay-ledger.md` — the
      "conjuration through a daemon + thin CLI" row may re-walk); capture any
      mage judgment in `grimoire/scenarios/`; the synced **roster listings do
      NOT change** (no new/renamed/removed spell). Plugin version: confirm the
      conventional commits will drive the minor bump (no hand-edit).
- [ ] **Smoke test (live, from the dev tree):** restart the daemon from the dev
      tree (check `doctor` for live subscribers first — the
      `grapevine-lifecycle` design channel has a live tail; coordinate), then
      exercise: `open` on an archived channel auto-unarchives; `reset` writes a
      snapshot under `~/.grapevine/archive/` and clears; `open --fresh` clears a
      dormant channel and no-ops a live one; and visually confirm the **watch
      sidebar** widen + long-name truncation (a deliberately long-named channel,
      no horizontal scrollbar). Confirm no zombie processes.
- [ ] Merge to `develop` locally (do NOT push/release — Cole handles that).
- [ ] Post to the `grapevine-lifecycle` channel that the bundle shipped, so the
      dream-flute team can pull the update.

## Self-Review

**Spec coverage:** auto-unarchive (Task 1) ✓; `reset` snapshot-then-clear +
force guard (Task 2) ✓; `open --fresh` no-clear-when-live (Task 3) ✓; snapshot
path + dir-on-demand (Task 2 `snapshotAndClear`) ✓; docs (Task 4) ✓; sidebar fix
(already committed) folded into Finalize review + smoke ✓; disposition correctly
deferred ✓.

**Type/contract consistency:** `snapshotAndClear(name): string | null` is used
identically by the `reset` endpoint and the `open` fresh path. The
live-subscriber guard reads `ch.subscribers.size` (all connections) in both the
`reset` endpoint and the `open --fresh` path. `fresh`/`force` are boolean flags;
`force` already in `BOOLEAN_FLAGS`, `fresh` added in Task 3. Open response gains
`unarchived`/`cleared`/`snapshot`; the CLI `OpenResponse` type is widened to
match.

**Ordering:** Task 1 establishes the auto-unarchive + the `ch` declaration
shape; Task 2 builds `snapshotAndClear` (needed by Task 3); Task 3 inserts the
fresh block between Task 1's unarchive block and the `loadChannel` call — so 1 →
2 → 3 avoids collisions in the `open` handler.
