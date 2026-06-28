# Grapevine `announce` Implementation Plan

> **Status:** Archived (Implemented) — `announce` verb shipped and merged
> (cli.ts/daemon.ts + watch UI; 3 tests pass). Archived 2026-06-27.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `grapevine announce <text> [--channels a,b,c]` verb that
broadcasts one `kind:"announcement"` message to many channels in a single call.

**Architecture:** One new daemon route `POST /announce` resolves a target
channel set (default: all active in-memory channels; with `--channels`: exactly
those named, loading idle ones), then reuses the existing `appendMessage(...)`
per channel for append + live fan-out. The CLI `announce` verb mirrors `send`'s
body-reading (positional / `--stdin` / `--body-file`) and leaked-invocation
guard, and prints a per-channel recipient receipt. The watch UI renders the new
`kind` distinctively via CSS only.

**Tech Stack:** Bun, TypeScript, `bun test`; biome for `.ts`; daemon is
`daemon.ts` (Bun.serve HTTP + JSONL channels), CLI is `cli.ts`, watch surface is
`watch.html` (Alpine). Spec: `docs/projects/grapevine-announce/design.md`.

---

## File Structure

- **Modify** `plugins/spellbook/skills/grapevine/scripts/daemon.ts`
  - `Message.kind` union (`:91`) and `appendMessage`'s `kind` param (`:240`):
    add `"announcement"`.
  - New top-level route `POST /announce` (insert after the `POST /channels`
    block that ends at `:448`, before the `chMatch` block at `:454`).
- **Modify** `plugins/spellbook/skills/grapevine/scripts/cli.ts`
  - New `AnnounceReceipt` type (near `SendReceipt`, `:64`).
  - New `cmdAnnounce(...)` (after `cmdSend`, `:386`).
  - New `case "announce":` in the verb switch (after the `send` case, `:1099`).
  - Broaden `LEAKED_SEND_RE` (`:1004`) to also catch a leaked `announce`
    invocation.
- **Modify** `plugins/spellbook/skills/grapevine/scripts/cli.test.ts` — new
  tests (append to the existing `describe` block).
- **Modify** `plugins/spellbook/skills/grapevine/scripts/watch.html` — add
  `.msg.kind-announcement` CSS (mirror `.msg.kind-topic` at `:257`).
- **Modify** `plugins/spellbook/skills/grapevine/SKILL.md` — verb table row,
  `kind:"announcement"` note, move "cross-channel `announce`" out of the
  Deferred banner.
- **Modify** `docs/projects/grapevine-backlog/backlog.md` — mark the announce
  item shipped.

All daemon-level tests are CLI-driven through the existing harness (`bunRun` /
`bunRunStdin` / `spawnTail`) — the repo's established pattern; do not add a new
test harness.

---

## Task 1: `announce` default fan-out (active channels) — endpoint + CLI verb

Delivers an end-to-end `announce <text>` that broadcasts to every active
(in-memory) channel. `--channels` comes in Task 2.

**Files:**

- Modify: `plugins/spellbook/skills/grapevine/scripts/daemon.ts` (`:91`, `:240`,
  new route ~`:449`)
- Modify: `plugins/spellbook/skills/grapevine/scripts/cli.ts` (`AnnounceReceipt`
  ~`:64`, `cmdAnnounce` ~`:386`, `case "announce"` ~`:1099`)
- Test: `plugins/spellbook/skills/grapevine/scripts/cli.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe(...)` block in `cli.test.ts`:

```ts
test("announce broadcasts to all active channels with a kind:announcement frame", async () => {
  // Two active channels, each with one subscriber tail.
  const a = spawnTail("ann_a", ["--as", "alice"]);
  const b = spawnTail("ann_b", ["--as", "bob"]);
  await sleep(400); // let subscriptions land + load the channels

  const r = await bunRun([
    "announce",
    "--from",
    "lead",
    "ship is going down in 5",
  ]);
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.ok).toBe(true);

  // Both active channels are in the receipt, each with 1 recipient (the tail).
  const byName = Object.fromEntries(
    parsed.channels.map((c: { name: string; recipients: number }) => [
      c.name,
      c.recipients,
    ])
  );
  expect(byName.ann_a).toBe(1);
  expect(byName.ann_b).toBe(1);
  expect(parsed.total_recipients).toBe(2);

  // The stderr echo reports the spread.
  expect(r.stderr).toContain("# announced → ");

  // Each tail actually received the announcement frame.
  await sleep(300);
  for (const out of [a.output(), b.output()]) {
    const line = out.split("\n").find((l) => l.includes("ship is going down"));
    expect(line).toBeDefined();
    expect(JSON.parse(line as string).kind).toBe("announcement");
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
`cd plugins/spellbook/skills/grapevine/scripts && bun test cli.test.ts -t "announce broadcasts to all active"`
Expected: FAIL — the `announce` verb is unknown (CLI exits non-zero / "unknown
command"), so `r.code` ≠ 0.

- [ ] **Step 3: Add `"announcement"` to the daemon message kind**

In `daemon.ts`, change the `Message.kind` union at `:91`:

```ts
kind: "message" | "topic" | "announcement";
```

And `appendMessage`'s `kind` parameter at `:240`:

```ts
  kind: "message" | "topic" | "announcement" = "message",
```

- [ ] **Step 4: Add the `POST /announce` route**

In `daemon.ts`, insert this block immediately after the
`if (path === "/channels" && method === "POST") { ... }` block (which ends at
`:448`) and before the `chMatch` block:

```ts
if (path === "/announce" && method === "POST") {
  const body = await readJsonBody(req);
  if (!body || typeof body.from !== "string" || typeof body.text !== "string") {
    return json({ error: "from and text required" }, { status: 400 });
  }
  const requested: string[] | undefined = Array.isArray(body.channels)
    ? body.channels.filter((c: unknown): c is string => typeof c === "string")
    : undefined;

  const delivered: { name: string; recipients: number }[] = [];
  const skipped: { name: string; reason: string }[] = [];

  // Resolve the target set.
  let targets: string[];
  if (requested) {
    // Explicit targeting: named channels regardless of activity. Archived →
    // skip (read-only). Unknown (not loaded and no on-disk log) → skip.
    targets = [];
    for (const name of requested) {
      let onDisk = false;
      try {
        onDisk = existsSync(channelPath(name));
      } catch {
        // invalid channel name → treat as unknown
      }
      if (existsSync(archivedPath(name))) {
        skipped.push({ name, reason: "archived" });
      } else if (channels.has(name) || onDisk) {
        targets.push(name);
      } else {
        skipped.push({ name, reason: "unknown" });
      }
    }
  } else {
    // Default: every active (in-memory) channel, minus archived. Archived
    // in-memory channels are silently excluded — the caller didn't name them.
    targets = [...channels.keys()].filter(
      (name) => !channels.get(name)?.archived
    );
  }

  for (const name of targets) {
    appendMessage(name, body.from, body.text, "announcement");
    const ch = channels.get(name);
    const vis = ch ? visibleSubs(ch) : [];
    const recipients = vis.reduce(
      (n, sub) => (sub.alias !== body.from ? n + 1 : n),
      0
    );
    delivered.push({ name, recipients });
  }

  const total_recipients = delivered.reduce((n, d) => n + d.recipients, 0);
  return json({ ok: true, channels: delivered, skipped, total_recipients });
}
```

- [ ] **Step 5: Add the `AnnounceReceipt` type in the CLI**

In `cli.ts`, near `SendReceipt` (`:64`), add:

```ts
// POST /announce — cross-channel broadcast receipt.
type AnnounceReceipt = {
  ok: boolean;
  channels: { name: string; recipients: number }[];
  skipped: { name: string; reason: string }[];
  total_recipients: number;
  error?: string;
};
```

- [ ] **Step 6: Add `cmdAnnounce`**

In `cli.ts`, after `cmdSend` (ends `:386`), add:

```ts
async function cmdAnnounce(
  from: string,
  text: string,
  channels: string[] | undefined,
  opts: { quiet?: boolean }
) {
  if (!from || !text) die("usage: grapevine announce --from <alias> <text...>");
  const port = await ensureDaemon();
  const body: { from: string; text: string; channels?: string[] } = {
    from,
    text,
  };
  if (channels && channels.length) body.channels = channels;
  const { status, data } = await api<AnnounceReceipt>(
    port,
    "POST",
    "/announce",
    body
  );
  if (status >= 400 || !data) die(data?.error ?? `HTTP ${status}`);
  // Target echo on stderr — fires even under --quiet, mirroring send's safety signal.
  process.stderr.write(
    `# announced → ${data.channels.length} channel(s) · ${data.total_recipients} recipient(s)\n`
  );
  if (opts.quiet) return;
  const out: Record<string, unknown> = {
    ok: true,
    channels: data.channels,
    total_recipients: data.total_recipients,
  };
  if (data.skipped && data.skipped.length) out.skipped = data.skipped;
  if (data.channels.length === 0)
    out.warning = "no active channels to announce to";
  printJson(out);
}
```

- [ ] **Step 7: Add the `case "announce"` verb**

In `cli.ts`, in the `switch (cmd)` block, add this case right after the
`case "send": { ... }` block (ends `:1099`):

```ts
    case "announce": {
      const from = resolveAlias(flags);
      const hasInlineText = positional.length > 0;
      let text: string;
      if (flags["body-file"]) {
        const path = flags["body-file"] as string;
        const file = Bun.file(path);
        if (!(await file.exists())) die(`announce: --body-file not found: ${path}`);
        text = (await file.text()).replace(/\n$/, "");
      } else if (flags.stdin || (!hasInlineText && !process.stdin.isTTY)) {
        const buf: Buffer[] = [];
        for await (const chunk of process.stdin) buf.push(chunk as Buffer);
        text = Buffer.concat(buf).toString("utf-8").replace(/\n$/, "");
      } else {
        text = positional.join(" ");
      }
      if (!from)
        die("announce: identity required — pass --from/--as <alias> or set GRAPEVINE_FROM env var");
      if (!flags.force && looksLikeLeakedSend(text)) {
        die(
          "announce: that body looks like a leaked grapevine invocation (a fumbled " +
            "heredoc?). Nothing was sent. Pipe the real body via --stdin or " +
            "--body-file <path>, or pass --force to send it anyway.",
        );
      }
      const channels = flags.channels
        ? (flags.channels as string)
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean)
        : undefined;
      await cmdAnnounce(from, text, channels, { quiet: !!flags.quiet });
      return 0;
    }
```

- [ ] **Step 8: Run the test to verify it passes**

Run:
`cd plugins/spellbook/skills/grapevine/scripts && bun test cli.test.ts -t "announce broadcasts to all active"`
Expected: PASS.

- [ ] **Step 9: Run the full grapevine suite + biome**

Run:
`cd /Users/colereed/Projects/Spellbook && bun test plugins/spellbook/skills/grapevine/ && bunx biome check plugins/spellbook/skills/grapevine/scripts/daemon.ts plugins/spellbook/skills/grapevine/scripts/cli.ts plugins/spellbook/skills/grapevine/scripts/cli.test.ts`
Expected: all tests PASS; biome clean.

- [ ] **Step 10: Commit**

```bash
git add plugins/spellbook/skills/grapevine/scripts/daemon.ts \
        plugins/spellbook/skills/grapevine/scripts/cli.ts \
        plugins/spellbook/skills/grapevine/scripts/cli.test.ts
git commit -m "feat(grapevine): announce — broadcast to all active channels"
```

---

## Task 2: `--channels` targeting + skip archived/unknown

The daemon route already honors `body.channels` (built in Task 1, Step 4). This
task adds CLI plumbing coverage and locks the targeting/skip behavior with
tests.

**Files:**

- Test: `plugins/spellbook/skills/grapevine/scripts/cli.test.ts`
- (No new daemon/CLI code — Task 1 already wired `--channels` through.)

- [ ] **Step 1: Write the failing test**

Append to the `describe` block in `cli.test.ts`:

```ts
test("announce --channels targets named channels, skips unknown/archived, ignores other active", async () => {
  // tc_a active (tail), tc_b idle (exists on disk, no tail), tc_c active (tail, NOT named),
  // tc_arch archived, tc_missing never created.
  const a = spawnTail("tc_a", ["--as", "alice"]);
  const c = spawnTail("tc_c", ["--as", "carol"]);
  await bunRun(["open", "tc_b"]); // on disk, idle, no subscriber
  await bunRun(["open", "tc_arch"]);
  await bunRun(["archive", "tc_arch"]);
  await sleep(400);

  const r = await bunRun([
    "announce",
    "--from",
    "lead",
    "--channels",
    "tc_a,tc_b,tc_arch,tc_missing",
    "reconvene in main",
  ]);
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout);

  const delivered = parsed.channels.map((x: { name: string }) => x.name).sort();
  expect(delivered).toEqual(["tc_a", "tc_b"]); // named + resolvable
  const byName = Object.fromEntries(
    parsed.channels.map((x: { name: string; recipients: number }) => [
      x.name,
      x.recipients,
    ])
  );
  expect(byName.tc_a).toBe(1); // alice tailing
  expect(byName.tc_b).toBe(0); // idle, no subscriber, but still delivered to its log

  const skipped = Object.fromEntries(
    parsed.skipped.map((x: { name: string; reason: string }) => [
      x.name,
      x.reason,
    ])
  );
  expect(skipped.tc_arch).toBe("archived");
  expect(skipped.tc_missing).toBe("unknown");

  // tc_c was active but NOT named → must not receive it.
  await sleep(300);
  expect(c.output()).not.toContain("reconvene in main");
  expect(a.output()).toContain("reconvene in main");
});
```

- [ ] **Step 2: Run the test to verify it passes (behavior already
      implemented)**

Run:
`cd plugins/spellbook/skills/grapevine/scripts && bun test cli.test.ts -t "announce --channels targets"`
Expected: PASS. If it FAILS, the gap is in Task 1's daemon target-resolution or
the CLI `--channels` split — fix there, not by weakening the test.

- [ ] **Step 3: Add a leaked-invocation guard test for announce, and broaden the
      guard**

First broaden the guard regex in `cli.ts` (`:1004`) so a fumbled `announce`
heredoc is caught too:

```ts
const LEAKED_SEND_RE =
  /(?:^|\n)[ \t]*bun\b[^\n]*\bcli\.ts\b[^\n]*\b(?:send|announce)\b/;
```

Then append this test to `cli.test.ts`:

```ts
test("announce refuses a leaked invocation body (no --force)", async () => {
  await bunRun(["open", "ann_guard"]);
  const leaked = 'bun /path/to/cli.ts announce --from lead "hi"';
  const r = await bunRunStdin(
    ["announce", "--from", "lead", "--channels", "ann_guard", "--stdin"],
    leaked
  );
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("leaked grapevine invocation");
  // Nothing was posted.
  const list = await bunRun(["list"]);
  const ch = JSON.parse(list.stdout).channels.find(
    (c: { name: string }) => c.name === "ann_guard"
  );
  expect(ch.message_count).toBe(0);
});
```

- [ ] **Step 4: Run the new tests**

Run:
`cd plugins/spellbook/skills/grapevine/scripts && bun test cli.test.ts -t "announce"`
Expected: all `announce` tests PASS.

- [ ] **Step 5: Run the full suite + biome**

Run:
`cd /Users/colereed/Projects/Spellbook && bun test plugins/spellbook/skills/grapevine/ && bunx biome check plugins/spellbook/skills/grapevine/scripts/cli.ts plugins/spellbook/skills/grapevine/scripts/cli.test.ts`
Expected: PASS; biome clean.

- [ ] **Step 6: Commit**

```bash
git add plugins/spellbook/skills/grapevine/scripts/cli.ts \
        plugins/spellbook/skills/grapevine/scripts/cli.test.ts
git commit -m "feat(grapevine): announce --channels targeting + leaked-invocation guard"
```

---

## Task 3: Watch UI — render `kind:"announcement"` distinctively

`watch.html` already applies a `kind-announcement` CSS class automatically
(`:565`, `'kind-' + (m.kind || 'message')`). This task only adds the CSS,
mirroring the existing `.msg.kind-topic` treatment.

**Files:**

- Modify: `plugins/spellbook/skills/grapevine/scripts/watch.html` (CSS near
  `:257`)

- [ ] **Step 1: Add announcement CSS**

In `watch.html`, after the existing `.msg.kind-topic .body { ... }` /
`.msg.kind-topic .from { ... }` rules (around `:257`–`:265`), add:

```css
/* Cross-channel announcement — a full-width accent banner so it reads as
         "everyone, not just this channel". Distinct from kind-topic. */
.msg.kind-announcement {
  border-left: 3px solid var(--accent, #c98a2b);
  background: rgba(201, 138, 43, 0.08);
  border-radius: 6px;
  padding: 6px 10px;
}
.msg.kind-announcement .from::after {
  content: " · announced";
  opacity: 0.6;
  font-style: italic;
}
```

(If `--accent` is not a defined CSS var in this file, substitute the file's
existing accent color; check the `:root` block at the top of `watch.html`.)

- [ ] **Step 2: Manual visual verification**

This is a surface change with no automated test (consistent with the repo —
`watch.html` has no unit tests). Verify by hand:

```bash
# Terminal 1: start a daemon + open the watch
bun plugins/spellbook/skills/grapevine/scripts/cli.ts open vis_check
bun plugins/spellbook/skills/grapevine/scripts/cli.ts watch vis_check   # opens the browser
# Terminal 2: fire an announcement
bun plugins/spellbook/skills/grapevine/scripts/cli.ts announce --from lead "visual check: banner please"
```

Expected: the message appears in the `vis_check` channel with the accent
banner + "· announced" on the author — visually distinct from a normal message
and from a topic. Then close:
`bun plugins/spellbook/skills/grapevine/scripts/cli.ts close vis_check`.

- [ ] **Step 3: Commit**

```bash
git add plugins/spellbook/skills/grapevine/scripts/watch.html
git commit -m "feat(grapevine): watch renders kind:announcement as an accent banner"
```

---

## Task 4: Docs — SKILL.md + backlog

**Files:**

- Modify: `plugins/spellbook/skills/grapevine/SKILL.md`
- Modify: `docs/projects/grapevine-backlog/backlog.md`

- [ ] **Step 1: Add the `announce` verb to the SKILL.md verb table**

In the grapevine `SKILL.md` "Verbs" table, add a row (match the existing column
shape):

```
| `cli.ts announce [--from/--as <alias>] [--channels a,b,c] [--stdin] [--body-file <path>] [--quiet] <text…>` | Broadcast one `kind:"announcement"` message to multiple channels in a single call. Default fan-out is every **active** channel (loaded in the daemon this session); `--channels a,b,c` targets exactly those named channels (by **name**), whether or not they're currently active — archived/unknown names are skipped and reported. Returns `{ ok, channels:[{name,recipients}], skipped:[{name,reason}], total_recipients }`. Reuses `send`'s stdin/`--body-file` safety + leaked-invocation guard. Sender is the invoker (no special "system" identity). |
```

- [ ] **Step 2: Note the new `kind` and un-defer announce in the V1.x banner**

In `SKILL.md`: where the message shape / kinds are documented, add
`"announcement"` alongside `"message"`/`"topic"`. In the V1.x banner's
**Deferred** list, remove "cross-channel `announce`" (it's now shipped); leave
the other deferred items.

- [ ] **Step 3: Mark the backlog item shipped**

In `docs/projects/grapevine-backlog/backlog.md`, update the "Cross-channel
broadcast (`announce` verb)" item: change its status line to **Shipped** with
today's date, and add a one-line pointer to `docs/projects/grapevine-announce/`.

- [ ] **Step 4: Prettier + drift check**

Run:
`cd /Users/colereed/Projects/Spellbook && bunx prettier --write plugins/spellbook/skills/grapevine/SKILL.md docs/projects/grapevine-backlog/backlog.md`
Then sanity-check the roster is unchanged (no new spell, so no
marketplace/README sync needed): Run:
`ls plugins/spellbook/skills/ | grep -v README` Expected: same spell set as
before — `announce` is a verb, not a new spell.

- [ ] **Step 5: Commit**

```bash
git add plugins/spellbook/skills/grapevine/SKILL.md docs/projects/grapevine-backlog/backlog.md
git commit -m "docs(grapevine): document announce verb + mark backlog item shipped"
```

---

## Final wrap (after all tasks)

- [ ] Full suite green:
      `cd /Users/colereed/Projects/Spellbook && bun test plugins/spellbook/skills/grapevine/`
- [ ] Smoke test from the dev tree (ward):
      `bun plugins/spellbook/skills/grapevine/scripts/cli.ts open smoke && bun plugins/spellbook/skills/grapevine/scripts/cli.ts announce --from lead --channels smoke "smoke" && bun plugins/spellbook/skills/grapevine/scripts/cli.ts close smoke`
      — expect a receipt with `smoke` delivered.
- [ ] The version bump rides release-please via the `feat(grapevine)` commits —
      do **not** hand-edit any version (per `ward`).
- [ ] Merge `feat/grapevine-announce` → develop (the project's branch→develop
      flow); hand the push + release to Cole.

---

## Self-Review

**Spec coverage** (against `design.md`):

- CLI surface
  (`announce <text> [--channels] [--as] [--stdin] [--body-file] [--quiet]`) →
  Task 1 Steps 6–7. ✓
- Default = active channels → Task 1 Step 4 (`else` branch) + test Task 1
  Step 1. ✓
- `--channels` = named regardless of activity → Task 1 Step 4 (`requested`
  branch) + test Task 2 Step 1. ✓
- Archived/unknown skipped + reported → Task 1 Step 4 + test Task 2 Step 1. ✓
- `kind:"announcement"` frame → Task 1 Steps 3–4; tail asserts kind in Task 1
  Step 1. ✓
- Daemon-side fan-out reusing `appendMessage`, no new persistence → Task 1
  Step 4. ✓
- Receipt shape `{ok, channels, skipped, total_recipients}` → Task 1 Steps 4–6.
  ✓
- `recipients` = visibleSubs minus sender (send parity) → Task 1 Step 4
  (`reduce`). ✓
- stdin/body-file + leaked-guard reuse → Task 1 Step 7 + Task 2 Step 3 (guard
  broadened + tested). ✓
- Empty active set → clean no-op → Task 1 Step 6 (`warning`, zero counts; no
  error). ✓
- Watch UI distinct render → Task 3. ✓
- Docs (SKILL.md verb/kind/banner, backlog) → Task 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every
run step shows the command + expected result. ✓

**Type consistency:** `AnnounceReceipt.channels`/`.skipped`/`.total_recipients`
match the daemon's `json({ ok, channels, skipped, total_recipients })` (Task 1
Step 4) and `cmdAnnounce`'s reads (Step 6). `kind:"announcement"` is added in
both the `Message` union and `appendMessage` param (Step 3).
`looksLikeLeakedSend` (existing function name) is reused; only its regex is
broadened (Task 2 Step 3). ✓

**Note on test placement:** all tests are CLI-driven via the existing
`bunRun`/`bunRunStdin`/`spawnTail` harness — the spec's "unit (daemon-level)"
intent is realized as the repo's established CLI-integration tests, not a new
harness.
