# Grapevine — Per-Message Disposition / Triage Implementation Plan

> **Status:** Archived (Implemented) — mark/reopen/triage + `--status` filter
> shipped; released in plugin v1.13.0. Archived 2026-06-27.

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark a message in a long-lived intake channel with a disposition
(`acted-on` / `incorporated` / `wontfix` / …) so a triage loop can answer
"what's still open?" without re-litigating — with **query-by-status** as the
headline (the mark is just the substrate).

**Architecture:** A disposition is an append-only `kind:"status"` frame that
references a target message id (`target`) and carries a `disposition` string (+
optional note in `text`). The daemon only learns the new `kind` + a `mark`
endpoint that appends the frame; ALL the read-side logic (fold latest
disposition per target, badge, `--status` filter, `triage` grouping) lives
CLI-side reading the channel's full JSONL — the same whole-log-scan pattern
`grep` already uses. `tail` drops status frames (badges are a pull/read/triage
concern, not a live-stream one).

**Tech Stack:** Bun, TypeScript, `node:fs`. Tests: `bun test` via the
tmpdir-HOME `bunRun`/`spawnTail` harness in `cli.test.ts`.

**Design record:** resolved live with the requester (dream-flute maestro) in the
`grapevine-disposition` channel. The resolved decisions are restated under
"Resolved design" — that section is the spec.

## Resolved design (the spec)

1. **`mark <ch> <id> <disposition> [--note <text>] [--as/--from <alias>]`** —
   appends a `kind:"status"` frame
   `{ target: <id>, disposition: <string>, text: <note|"">, from, ts }`.
   Free-form disposition; the well-known enum
   (`acted-on`/`incorporated`/`wontfix`/`duplicate`) is just convention. `--as`
   mirrors `send`. The daemon validates the target id exists (a real, non-status
   message) → 404 otherwise.
2. **`reopen <ch> <id> [--note] [--as]`** — sugar for `mark … open`, bouncing a
   dispositioned item back to the open queue (the trail stays in the log).
3. **A message's disposition = its LATEST status frame** (highest id) targeting
   it. **"open" = no status frame yet OR latest disposition is `open`.**
4. **`pull <ch> [--since N] [--status S]`** — status frames are dropped from the
   message list; each remaining message gains a `disposition` field (+ `reopens`
   count). `--status S` filters to messages whose latest disposition is `S`
   (`--status open` = never-marked or reopened); `--status` scans the whole
   channel (it's a triage query, not a since-window).
5. **`triage <ch>`** — the daily driver: sugar over the fold, grouped — an
   `open` list on top (what to act on) + the dispositioned items grouped by
   status (for context).
6. **`read`** shows the message's disposition badge too. **`tail` drops
   `kind:"status"` frames** (no retro-badge). Watch-UI badge is a deferred
   fast-follow.
7. **Universal** — any message, any channel. No intake-channel gate.

## Global Constraints

- **Branch:** `feat/grapevine-disposition` (off `develop`). Do NOT push/release
  — Cole handles that; merge to `develop` locally at the end.
- **Runtime:** Bun. Tests:
  `bun test plugins/spellbook/skills/grapevine/scripts/cli.test.ts`.
- **Version:** no hand-edit of `plugin.json`; new behavior → `feat(grapevine):`
  (minor) via release-please. This is agent-facing → it earns a narrative
  **V1.9** banner (handled in Finalize).
- **No new spell / rename / removal** → ward synced listings unchanged.
- **Format:** biome on changed `.ts`; prettier on `.md`.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Status-frame shape (the contract)

`Message` gains two optional fields (daemon.ts + any shared type):
`target?: number` (the message this status is about) and `disposition?: string`.
A status frame:
`{ id, channel, from, text: <note>, ts, kind: "status", target, disposition }`.
Readers that don't understand `status` ignore it (forward-compatible, like
`in_reply_to`).

## File Structure

| File                  | Responsibility                                                                                                                                            | Tasks        |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `scripts/daemon.ts`   | `kind:"status"` in the type; `appendMessage` carries `target`/`disposition`; `POST /channels/:name/status` (validate target, append, broadcast)           | 1            |
| `scripts/cli.ts`      | `mark`/`reopen` verbs; `foldDispositions` helper; badge + status-frame-drop in `pull`/`read`; `tail` drops status; `--status` filter; `triage` verb; HELP | 1,2,3,4      |
| `scripts/cli.test.ts` | tests per task                                                                                                                                            | 1,2,3        |
| `SKILL.md`            | disposition/triage docs + V1.9 banner                                                                                                                     | 4 / Finalize |

All under `plugins/spellbook/skills/grapevine/`.

---

### Task 1: `kind:"status"` contract + `mark` + `reopen`

**Files:** `scripts/daemon.ts`, `scripts/cli.ts`, `scripts/cli.test.ts`.

**Interfaces:**

- daemon: `Message.kind` union gains `"status"`; `Message` gains optional
  `target?: number` + `disposition?: string`; `appendMessage` carries them
  through (via an optional `extra` arg spread into the message); new
  `POST /channels/:name/status` handler `{ from, target, disposition, note? }` →
  404 if `target` isn't an existing non-status message in the channel, else
  appends the frame and returns it.
- CLI: `mark <ch> <id> <disposition> [--note <text>]` (+ `--as/--from`);
  `reopen <ch> <id> [--note]` = `mark … open`.

- [ ] **Step 1: Write the failing tests**

```ts
test("mark appends a kind:status frame referencing the target (V1.9)", async () => {
  await bunRun(["open", "disp1"]);
  await bunRun(["send", "disp1", "--from", "a", "feedback item"]); // id 1
  const r = await bunRun([
    "mark",
    "disp1",
    "1",
    "incorporated",
    "--note",
    "shipped",
    "--as",
    "cole",
  ]);
  expect(r.code).toBe(0);
  const f = JSON.parse(r.stdout);
  expect(f.kind).toBe("status");
  expect(f.target).toBe(1);
  expect(f.disposition).toBe("incorporated");
  expect(f.from).toBe("cole");
  expect(f.text).toBe("shipped");
});

test("mark 404s on a nonexistent target (V1.9)", async () => {
  await bunRun(["open", "disp_x"]);
  const r = await bunRun(["mark", "disp_x", "999", "wontfix", "--as", "a"]);
  expect(r.code).not.toBe(0);
});

test("reopen appends a status frame with disposition open (V1.9)", async () => {
  await bunRun(["open", "disp2"]);
  await bunRun(["send", "disp2", "--from", "a", "item"]); // id 1
  await bunRun(["mark", "disp2", "1", "wontfix", "--as", "a"]);
  const r = await bunRun(["reopen", "disp2", "1", "--as", "a"]);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout).disposition).toBe("open");
});
```

- [ ] **Step 2: Run — expect FAIL** (`mark`/`reopen` undefined).

- [ ] **Step 3: Daemon — extend the type + appendMessage + add the endpoint**

In `daemon.ts`, extend the `Message` type:

```ts
type Message = {
  id: number;
  channel: string;
  from: string;
  text: string;
  ts: number;
  kind: "message" | "topic" | "announcement" | "status";
  in_reply_to?: number;
  target?: number; // status frames: the message this disposition is about
  disposition?: string; // status frames: the disposition value
};
```

Add an optional `extra` to `appendMessage` (keep existing positional args;
spread extra last so existing callers are unaffected):

```ts
function appendMessage(
  name: string,
  from: string,
  text: string,
  kind: Message["kind"] = "message",
  inReplyTo?: number,
  extra?: Partial<Pick<Message, "target" | "disposition">>
): Message {
  const ch = loadChannel(name);
  const msg: Message = {
    id: ch.next_id++,
    channel: name,
    from,
    text,
    ts: Date.now(),
    kind,
    ...(typeof inReplyTo === "number" ? { in_reply_to: inReplyTo } : {}),
    ...(extra ?? {}),
  };
  // …unchanged: append, topic-cache, fan-out, wait-drain, return…
}
```

Add the handler next to `POST /channels/:name/messages`:

```ts
if (sub === "/status" && method === "POST") {
  const body = await readJsonBody(req);
  if (
    !body ||
    typeof body.from !== "string" ||
    typeof body.target !== "number" ||
    typeof body.disposition !== "string"
  ) {
    return json(
      { error: "from, target, disposition required" },
      { status: 400 }
    );
  }
  // Target must be a real, non-status message in this channel.
  const exists = readBacklog(name, 0).some(
    (m) => m.id === body.target && m.kind !== "status"
  );
  if (!exists) {
    return json(
      { error: `no message ${body.target} in ${name}` },
      { status: 404 }
    );
  }
  const note = typeof body.note === "string" ? body.note : "";
  const m = appendMessage(name, body.from, note, "status", undefined, {
    target: body.target,
    disposition: body.disposition,
  });
  return json(m, { status: 201 });
}
```

(Marking is allowed on an archived channel — disposition is curation, not
conversation; no `archivedPath` check here.)

- [ ] **Step 4: CLI — `mark` + `reopen`**

Add `cmdMark`:

```ts
async function cmdMark(
  name: string,
  id: number,
  disposition: string,
  from: string,
  opts: { note?: string }
) {
  if (!name || !Number.isFinite(id) || !disposition)
    die(
      "usage: grapevine mark <channel> <id> <disposition> [--note <text>] [--as <alias>]"
    );
  const port = await ensureDaemon();
  const body: Record<string, unknown> = { from, target: id, disposition };
  if (opts.note !== undefined) body.note = opts.note;
  const { status, data } = await api<Message>(
    port,
    "POST",
    `/channels/${name}/status`,
    body
  );
  if (status >= 400 || !data)
    die((data as { error?: string })?.error ?? `HTTP ${status}`);
  printJson(data);
}
```

Wire `main`:

```ts
case "mark":
  await cmdMark(positional[0], parseInt(positional[1], 10), positional.slice(2).join(" "), resolveAlias(flags), { note: flags.note as string | undefined });
  return 0;
case "reopen":
  await cmdMark(positional[0], parseInt(positional[1], 10), "open", resolveAlias(flags), { note: flags.note as string | undefined });
  return 0;
```

(`note` is a value flag — not in BOOLEAN_FLAGS. `resolveAlias` handles
`--as/--from/GRAPEVINE_FROM`; a missing alias falls through to whatever `send`
does — mirror that. If `send` requires `from`, require it here too.)

- [ ] **Step 5: Run — expect PASS** (full suite).

- [ ] **Step 6: Commit**
      (`feat(grapevine): mark/reopen — append kind:status disposition frames`).
      biome first.

---

### Task 2: Disposition fold + badges in `pull`/`read`; `tail` drops status frames

**Files:** `scripts/cli.ts`, `scripts/cli.test.ts`.

**Interfaces:**

- `foldDispositions(name): Map<number, { disposition: string; from: string; ts: number; note: string; reopens: number }>`
  — reads the channel's full JSONL (like `cmdGrep`), and for each
  `kind:"status"` frame records it against `target`, keeping the LATEST (highest
  id). `reopens` = count of transitions into `open` after a non-open
  disposition.
- `pull`: drop `kind:"status"` frames from `messages`; annotate each remaining
  message with `disposition` (latest, or omitted if none) + `reopens`.
- `read`: annotate the single message likewise; `--text` shows a `[disposition]`
  prefix (`[incorporated]`, `[incorporated ↻1]` when reopens>0).
- `tail`: drop `kind:"status"` frames from the emitted JSONL.

- [ ] **Step 1: Write the failing tests**

```ts
test("pull drops status frames and badges the target's latest disposition (V1.9)", async () => {
  await bunRun(["open", "disp3"]);
  await bunRun(["send", "disp3", "--from", "a", "one"]); // id1
  await bunRun(["send", "disp3", "--from", "a", "two"]); // id2
  await bunRun(["mark", "disp3", "1", "wontfix", "--as", "a"]); // id3 (status)
  await bunRun(["mark", "disp3", "1", "incorporated", "--as", "a"]); // id4 (status) — latest wins
  const r = await bunRun(["pull", "disp3", "--since", "0"]);
  const msgs = JSON.parse(r.stdout).messages;
  // status frames are not in the list
  expect(msgs.every((m: { kind: string }) => m.kind !== "status")).toBe(true);
  expect(msgs.length).toBe(2);
  const m1 = msgs.find((m: { id: number }) => m.id === 1);
  expect(m1.disposition).toBe("incorporated"); // latest
  const m2 = msgs.find((m: { id: number }) => m.id === 2);
  expect(m2.disposition ?? null).toBe(null); // unmarked → no badge
});

test("tail drops status frames (V1.9)", async () => {
  await bunRun(["open", "disp4"]);
  await bunRun(["send", "disp4", "--from", "a", "item"]); // id1
  const { proc, output } = spawnTail("disp4");
  await sleep(400);
  await bunRun(["mark", "disp4", "1", "acted-on", "--as", "a"]);
  await bunRun(["send", "disp4", "--from", "a", "next"]);
  await sleep(300);
  proc.kill("SIGTERM");
  const lines = output()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  expect(lines.some((m) => m.kind === "status")).toBe(false);
  expect(lines.some((m) => m.text === "next")).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `foldDispositions`** (near `cmdGrep`, reusing its
      log-read pattern):

```ts
function foldDispositions(name: string) {
  const map = new Map<
    number,
    {
      disposition: string;
      from: string;
      ts: number;
      note: string;
      reopens: number;
    }
  >();
  const path = join(DATA_DIR, "channels", `${name}.jsonl`);
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      continue;
    }
    if (
      m.kind !== "status" ||
      typeof m.target !== "number" ||
      typeof m.disposition !== "string"
    )
      continue;
    const prev = map.get(m.target);
    const reopens =
      (prev?.reopens ?? 0) +
      (m.disposition === "open" && prev && prev.disposition !== "open" ? 1 : 0);
    map.set(m.target, {
      disposition: m.disposition,
      from: m.from,
      ts: m.ts,
      note: m.text,
      reopens,
    });
  }
  return map;
}
// "open" = no entry, or latest disposition is "open"
function isOpen(d?: { disposition: string }) {
  return !d || d.disposition === "open";
}
```

- [ ] **Step 4: Wire `pull`** — after fetching messages, fold + annotate + drop:

```ts
  const disp = foldDispositions(name);
  const annotated = (data?.messages ?? [])
    .filter((m) => m.kind !== "status")
    .map((m) => {
      const d = disp.get(m.id);
      return d ? { ...m, disposition: d.disposition, reopens: d.reopens } : m;
    });
  const cursor = ... // unchanged (last raw id)
  printJson({ ok: true, messages: annotated, cursor });
```

(Compute `cursor` from the daemon's raw list as today, so the since-cursor still
advances past status frames.)

- [ ] **Step 5: Wire `read`** — fold, attach `disposition`/`reopens`; in
      `--text` mode prefix `[disposition]` / `[disposition ↻N]` when present.

- [ ] **Step 6: Wire `tail`** — in the SSE frame loop,
      `if (payload.kind === "status") continue;` (drop before the
      self-echo/truncation logic).

- [ ] **Step 7: Run — expect PASS** (full suite).

- [ ] **Step 8: Commit**
      (`feat(grapevine): fold disposition badges into pull/read; tail drops status frames`).

---

### Task 3: `--status` filter + `triage` verb

**Files:** `scripts/cli.ts`, `scripts/cli.test.ts`.

**Interfaces:**

- `pull <ch> --status <value>` — full-channel scan: list messages whose latest
  disposition matches `value` (`open` = `isOpen`); status frames excluded;
  badges attached. (`--status` is a value flag — NOT in BOOLEAN_FLAGS.)
- `triage <ch>` — full-channel:
  `{ ok, open: [...], by_status: { <disp>: [...] } }`, each message badged.
  `open` = `isOpen` messages (what to act on); `by_status` groups the rest for
  context.

- [ ] **Step 1: Write the failing tests**

```ts
test("pull --status filters by latest disposition; open = unmarked-or-reopened (V1.9)", async () => {
  await bunRun(["open", "disp5"]);
  await bunRun(["send", "disp5", "--from", "a", "one"]); // id1
  await bunRun(["send", "disp5", "--from", "a", "two"]); // id2
  await bunRun(["send", "disp5", "--from", "a", "three"]); // id3
  await bunRun(["mark", "disp5", "1", "incorporated", "--as", "a"]);
  await bunRun(["mark", "disp5", "2", "wontfix", "--as", "a"]);
  await bunRun(["reopen", "disp5", "2", "--as", "a"]); // id2 back to open

  const open = JSON.parse(
    (await bunRun(["pull", "disp5", "--status", "open"])).stdout
  )
    .messages.map((m: { id: number }) => m.id)
    .sort();
  expect(open).toEqual([2, 3]); // 2 reopened, 3 never marked
  const inc = JSON.parse(
    (await bunRun(["pull", "disp5", "--status", "incorporated"])).stdout
  ).messages.map((m: { id: number }) => m.id);
  expect(inc).toEqual([1]);
});

test("triage groups open on top + dispositioned by status (V1.9)", async () => {
  await bunRun(["open", "disp6"]);
  await bunRun(["send", "disp6", "--from", "a", "one"]); // id1
  await bunRun(["send", "disp6", "--from", "a", "two"]); // id2
  await bunRun(["mark", "disp6", "1", "incorporated", "--as", "a"]);
  const t = JSON.parse((await bunRun(["triage", "disp6"])).stdout);
  expect(t.open.map((m: { id: number }) => m.id)).toEqual([2]);
  expect(t.by_status.incorporated.map((m: { id: number }) => m.id)).toEqual([
    1,
  ]);
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement.** Add a shared `loadChannelMessagesBadged(name)` that
      reads the full log, drops status frames, and annotates each message via
      `foldDispositions` (reuse from Task 2). Then:
  - `cmdTriage(name)`: split badged messages into `open` (isOpen) vs grouped
    `by_status` (keyed by latest disposition);
    `printJson({ ok, open, by_status })`.
  - `pull --status <value>`: when `flags.status` is set, use the full-log badged
    list, filter (`value === "open" ? isOpen(d) : d?.disposition === value`),
    print `{ ok, messages, cursor: <lastId> }`. When `--status` absent, the
    Task-2 since-window path is unchanged. Wire `main`: a `triage` case; in the
    `pull` case pass `status: flags.status`. Refresh HELP.

- [ ] **Step 4: Run — expect PASS** (full suite, twice for the tail test in T2's
      file timing).

- [ ] **Step 5: Commit**
      (`feat(grapevine): pull --status filter + triage verb`).

---

### Task 4: Documentation — HELP + SKILL.md

**Files:** `scripts/cli.ts` (HELP), `SKILL.md`.

- [ ] **Step 1:** HELP lists `mark <ch> <id> <disposition> [--note]`,
      `reopen <ch> <id>`, `triage <ch>`, and `pull … [--status <value>]`. Match
      the existing `# comment` formatting.
- [ ] **Step 2:** SKILL.md — a "Disposition / triage" subsection (near the verb
      table): mark/reopen, the open-queue model, `triage` as the daily driver,
      `--status` as the power-tool, the badge in pull/read,
      status-frames-are-folded (not chat bubbles), tail drops them, universal
      scope. Worked example:

```
grapevine mark grapevine-feedback 11 incorporated --note "shipped in 1.9"
grapevine triage grapevine-feedback     # the open queue, grouped
grapevine pull grapevine-feedback --status wontfix
grapevine reopen grapevine-feedback 7   # bounce it back to open
```

Do NOT touch the V1.x banner here (Finalize handles the V1.9 bump).

- [ ] **Step 3:** `cli.ts help` renders; suite green. biome + prettier.
- [ ] **Step 4: Commit**
      (`docs(grapevine): document mark/reopen/triage + --status`).

---

## Finalize (controller-run)

- [ ] Whole-branch review (opus) over the branch range.
- [ ] **Kick the tires with maestro** on `grapevine-feedback` (a real intake
      channel) before merge — per maestro's offer. Mark a couple of real items,
      run `triage`, confirm the loop feels right; fold any quick feedback.
- [ ] **ward (spell revision):** bun test green; **narrative banner → V1.9
      (disposition / triage)** — agent-facing, earns its own milestone (V1.8
      compressed into Earlier); capture a scenario if a real judgment emerged;
      decay-ledger check; roster unchanged; version via release-please.
- [ ] **Live smoke (isolated temp HOME, dev tree):** mark → pull badge → tail
      drops status → `--status open`/`incorporated` → `triage` groups → `reopen`
      moves it back to open. No zombies.
- [ ] Merge to `develop`; Cole pushes + release.
- [ ] After release: `roll` production (now a one-command verb) on Cole's go.

## Self-Review

**Spec coverage:** mark/reopen (T1) ✓; fold + badges + tail-drop (T2) ✓;
`--status` + triage (T3) ✓; docs (T4) ✓; maestro dogfood + V1.9 banner + smoke
(Finalize) ✓.

**Consistency:** `foldDispositions` (T2) reused by `pull`/`read` and by
`triage`/`--status` (T3). Status-frame shape (`kind:"status"`, `target`,
`disposition`, note-in-`text`) identical across the daemon endpoint, the fold,
and the tests. `--status`/`note` are value flags (not BOOLEAN_FLAGS); the daemon
change is minimal (type + appendMessage extra + one endpoint) — all query logic
is CLI-side full-log reads (the `grep` precedent), so no since-window
correctness traps.

**Risk note:** `pull` default path stays daemon-fetched + since-cursor
(unchanged) — Task 2 only annotates/drops on top. `--status`/`triage` are
explicit full-scans (whole-channel, like grep), which is correct for triage.
`tail` dropping status frames means live watchers don't see disposition events
as bubbles (by design; watch-UI badge is the deferred fast-follow).
