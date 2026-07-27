// P1 — CLI read-path verbs against a live spawned daemon (matches server.test.ts's style).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_DIR = import.meta.dir;
const CLI_SCRIPT = join(SCRIPT_DIR, "cli.ts");
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "mind-mapper-cli-test-"));
});

afterAll(async () => {
  // best-effort teardown: kill whatever daemon this test spun up
  try {
    const { readFileSync } = await import("node:fs");
    const pid = Number.parseInt(readFileSync(join(home, "daemon.pid"), "utf8").trim(), 10);
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  rmSync(home, { recursive: true, force: true });
});

async function runCli(
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", CLI_SCRIPT, ...args], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("open spawns the daemon and prints its url", async () => {
  const { code, stdout } = await runCli("open", "--no-open");
  expect(code).toBe(0);
  expect(JSON.parse(stdout).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

test("state on a projectless store exits 2 with the needs-project shape (no auto-mint)", async () => {
  const { code, stdout } = await runCli("state");
  expect(code).toBe(2);
  expect(JSON.parse(stdout)).toEqual({ error: "needs-project", projects: [] });
});

test("open --project refuses an unknown id — open never mints a project", async () => {
  const { code, stderr } = await runCli("open", "--no-open", "--project", "never-was");
  expect(code).toBe(2);
  expect(stderr).toContain("unknown project: never-was");
});

test("projects --create Default makes the store usable unscoped (the legacy default shape)", async () => {
  const created = await runCli("projects", "--create", "Default");
  expect(created.code).toBe(0);
  expect(JSON.parse(created.stdout).id).toBe("default");

  const { code, stdout } = await runCli("state");
  expect(code).toBe(0);
  expect(JSON.parse(stdout).project.id).toBe("default");
});

test("open --project appends ?project= to the printed url", async () => {
  const { code, stdout } = await runCli("open", "--no-open", "--project", "default");
  expect(code).toBe(0);
  expect(JSON.parse(stdout).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?project=default$/);
});

test("ingest + propose + ratify seed the dataset the read-path verbs use", async () => {
  const ingest = Bun.spawn(
    [process.execPath, "run", CLI_SCRIPT, "ingest", "--title", "Ramble 01", "--stdin"],
    {
      env: { ...process.env, MIND_MAPPER_HOME: home },
      stdin: new Response("Maren keeps the bakery. Edda keeps the mill.").body,
      stdout: "pipe",
    },
  );
  const doc = JSON.parse(await new Response(ingest.stdout).text()) as { id: string };
  await ingest.exited;
  expect(doc.id).toBe("ramble-01");

  const propose = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "propose-node", "--stdin"], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdin: new Response(
      JSON.stringify({
        draft: { title: "Maren", synopsis: "the baker" },
        evidence: { docId: "ramble-01", span: "Maren keeps the bakery" },
      }),
    ).body,
    stdout: "pipe",
  });
  const proposal = JSON.parse(await new Response(propose.stdout).text()) as { id: string };
  await propose.exited;

  const ratified = await runCli("ratify", proposal.id, "--ruling", "canon");
  expect(ratified.code).toBe(0);
});

test("state returns the project snapshot with the created data", async () => {
  const { code, stdout } = await runCli("state");
  expect(code).toBe(0);
  const state = JSON.parse(stdout) as { nodes: unknown[]; project: { id: string } };
  expect(state.project.id).toBe("default");
  expect(state.nodes.length).toBeGreaterThan(0);
});

test("state --skeleton strips synopsis/content, keeps ids/titles/degree", async () => {
  const { code, stdout } = await runCli("state", "--skeleton");
  expect(code).toBe(0);
  const skeleton = JSON.parse(stdout) as {
    nodes: Array<Record<string, unknown>>;
  };
  expect(skeleton.nodes.length).toBeGreaterThan(0);
  for (const n of skeleton.nodes) {
    expect(n.synopsis).toBeUndefined();
    expect(typeof n.degree).toBe("number");
    expect(typeof n.id).toBe("string");
  }
});

test("projects lists the created default project", async () => {
  const { code, stdout } = await runCli("projects");
  expect(code).toBe(0);
  const body = JSON.parse(stdout) as { projects: Array<{ id: string }> };
  expect(body.projects.map((p) => p.id)).toContain("default");
});

test("projects --create makes a new project, addressable via state --project", async () => {
  const created = await runCli("projects", "--create", "Second Idea");
  expect(created.code).toBe(0);
  expect(JSON.parse(created.stdout).id).toBe("second-idea");

  const { stdout } = await runCli("state", "--project", "second-idea");
  const state = JSON.parse(stdout) as { project: { id: string }; nodes: unknown[] };
  expect(state.project.id).toBe("second-idea");
  expect(state.nodes).toEqual([]);
});

test("tail streams events as one JSON line each (smoke: exits cleanly on empty stream)", async () => {
  // No events fire in the read-path phase (ingest lands P2), so this pins the
  // transport: the process starts, connects, and can be killed cleanly —
  // full patch-delivery coverage lives in events.test.ts + server.test.ts.
  const proc = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "tail"], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  await new Promise((r) => setTimeout(r, 300));
  proc.kill();
  await proc.exited;
  expect(true).toBe(true); // reaching here means it didn't crash on startup
});

test("ingest --stdin stores a doc, addressable via state", async () => {
  const proc = Bun.spawn(
    [process.execPath, "run", CLI_SCRIPT, "ingest", "--title", "CLI Idea", "--stdin"],
    {
      env: { ...process.env, MIND_MAPPER_HOME: home },
      stdin: new Response("dictated via stdin").body,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout).title).toBe("CLI Idea");

  const state = await runCli("state");
  const parsed = JSON.parse(state.stdout) as { docs: Array<{ title: string }> };
  expect(parsed.docs.map((d) => d.title)).toContain("CLI Idea");
});

test("propose-node --stdin round-trips a draft + evidence", async () => {
  const proc = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "propose-node", "--stdin"], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdin: new Response(
      JSON.stringify({ draft: { title: "Tam" }, evidence: { docId: "ramble-01" } }),
    ).body,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  const proposal = JSON.parse(stdout) as { kind: string; status: string };
  expect(proposal).toMatchObject({ kind: "node", status: "pending" });
});

test("propose-edge with wrong endpoint keys succeeds but mirrors the daemon warning to stderr", async () => {
  const proc = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "propose-edge", "--stdin"], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdin: new Response(JSON.stringify({ draft: { from: "a", to: "b" }, evidence: {} })).body,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code).toBe(0); // accepted — opacity holds
  expect(JSON.parse(stdout)).toMatchObject({ kind: "edge", status: "pending" });
  expect(stderr).toContain('"source"/"target"');
});

test("send appends a conversation message", async () => {
  const { code, stdout } = await runCli("send", "hello", "from", "cli");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ role: "agent", text: "hello from cli" });
});

test("search finds a node hit", async () => {
  const { code, stdout } = await runCli("search", "Maren");
  expect(code).toBe(0);
  const body = JSON.parse(stdout) as { hits: Array<{ kind: string }> };
  expect(body.hits[0]?.kind).toBe("node");
});

test("neighbors returns the local hood", async () => {
  const { code, stdout } = await runCli("neighbors", "maren");
  expect(code).toBe(0);
  const body = JSON.parse(stdout) as { neighbors: unknown[] };
  expect(Array.isArray(body.neighbors)).toBe(true);
});

test("ratify accepts a proposal end to end (propose -> ratify -> node in state)", async () => {
  const proposeProc = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "propose-node", "--stdin"], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdin: new Response(JSON.stringify({ draft: { title: "Widow's Teeth" }, evidence: {} })).body,
    stdout: "pipe",
  });
  const proposal = JSON.parse(await new Response(proposeProc.stdout).text()) as { id: string };
  await proposeProc.exited;

  const { code, stdout } = await runCli("ratify", proposal.id, "--ruling", "canon");
  expect(code).toBe(0);
  const result = JSON.parse(stdout) as { status: string; nodeId: string };
  expect(result.status).toBe("ratified");

  const state = await runCli("state");
  const parsed = JSON.parse(state.stdout) as { nodes: Array<{ id: string; title: string }> };
  expect(parsed.nodes.some((n) => n.id === result.nodeId && n.title === "Widow's Teeth")).toBe(
    true,
  );
});

test("zone loop round-trips through the CLI: create → propose --zone → promote → guarded delete", async () => {
  const created = await runCli("zone", "create", "Messy", "Ideas");
  expect(created.code).toBe(0);
  expect(JSON.parse(created.stdout)).toEqual({ id: "messy-ideas", name: "Messy Ideas" });

  const listed = await runCli("zone", "list");
  expect(JSON.parse(listed.stdout).zones).toEqual([{ id: "messy-ideas", name: "Messy Ideas" }]);

  const propose = Bun.spawn(
    [process.execPath, "run", CLI_SCRIPT, "propose-node", "--stdin", "--zone", "messy-ideas"],
    {
      env: { ...process.env, MIND_MAPPER_HOME: home },
      stdin: new Response(JSON.stringify({ draft: { title: "Wisp" }, evidence: {} })).body,
      stdout: "pipe",
    },
  );
  const proposal = JSON.parse(await new Response(propose.stdout).text()) as {
    id: string;
    zoneId: string;
  };
  await propose.exited;
  expect(proposal.zoneId).toBe("messy-ideas");

  // Ratify-of-zoned refused (R1: the typed 409 body passes through verbatim);
  // promote moves it to the main queue.
  const refused = await runCli("ratify", proposal.id, "--ruling", "thread");
  expect(refused.code).toBe(2);
  expect(JSON.parse(refused.stdout)).toEqual({ error: "zoned", zoneId: "messy-ideas" });
  const promoted = await runCli("promote", proposal.id);
  expect(promoted.code).toBe(0);
  expect(JSON.parse(promoted.stdout)).toEqual({ id: proposal.id });

  // Zone is empty now (move, not duplicate) — delete needs no --yes; a
  // populated one would 409 without it (exercised at the server tier).
  const deleted = await runCli("zone", "delete", "messy-ideas");
  expect(deleted.code).toBe(0);

  const ratified = await runCli("ratify", proposal.id, "--ruling", "thread");
  expect(ratified.code).toBe(0);
});

test("lens set/clear round-trips through state", async () => {
  const set = await runCli("lens", "set", "--node", "maren", "--depth", "1");
  expect(set.code).toBe(0);

  const withLens = await runCli("state");
  expect(JSON.parse(withLens.stdout).lens).toMatchObject({ nodeId: "maren", depth: 1 });

  const clear = await runCli("lens", "clear");
  expect(clear.code).toBe(0);
  const cleared = await runCli("state");
  expect(JSON.parse(cleared.stdout).lens).toBeNull();
});

test("lens set --doc round-trips; --node/--doc exclusive at parse time", async () => {
  const both = await runCli("lens", "set", "--node", "maren", "--doc", "ramble-01");
  expect(both.code).toBe(2);
  expect(both.stderr).toContain("not both");

  const set = await runCli("lens", "set", "--doc", "ramble-01");
  expect(set.code).toBe(0);
  expect(JSON.parse(set.stdout)).toEqual({
    owner: "agent",
    nodeId: null,
    depth: null,
    docId: "ramble-01",
  });
  const clear = await runCli("lens", "clear");
  expect(clear.code).toBe(0);
});

test("look-here fires without persisting lens state", async () => {
  const { code } = await runCli("look-here", "maren");
  expect(code).toBe(0);
  const state = await runCli("state");
  expect(JSON.parse(state.stdout).lens).toBeNull();
});

test("doc <id> prints the doc envelope", async () => {
  const { code, stdout } = await runCli("doc", "ramble-01");
  expect(code).toBe(0);
  const doc = JSON.parse(stdout) as { id: string; content: string };
  expect(doc.id).toBe("ramble-01");
  expect(doc.content.length).toBeGreaterThan(0);
});

test("mark round-trips: cli mark → state carries the mark", async () => {
  const { code, stdout } = await runCli(
    "mark",
    "ramble-01",
    "--status",
    "analyzed",
    "--note",
    "checked, nothing new",
  );
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    docId: "ramble-01",
    mark: { author: "agent", status: "analyzed", note: "checked, nothing new" },
  });

  const state = await runCli("state");
  const parsed = JSON.parse(state.stdout) as {
    docs: Array<{ id: string; mark?: { status: string } }>;
  };
  expect(parsed.docs.find((d) => d.id === "ramble-01")?.mark?.status).toBe("analyzed");
});

test("doc delete round-trips: cited exits 2 with the 409 body, --force removes the doc", async () => {
  const ingest = Bun.spawn(
    [process.execPath, "run", CLI_SCRIPT, "ingest", "--title", "Doomed", "--stdin"],
    {
      env: { ...process.env, MIND_MAPPER_HOME: home },
      stdin: new Response("doomed prose").body,
      stdout: "pipe",
    },
  );
  const doc = JSON.parse(await new Response(ingest.stdout).text()) as { id: string };
  await ingest.exited;

  const propose = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "propose-node", "--stdin"], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdin: new Response(JSON.stringify({ draft: { title: "D" }, evidence: { docId: doc.id } }))
      .body,
    stdout: "pipe",
  });
  await propose.exited;

  const cited = await runCli("doc", "delete", doc.id);
  expect(cited.code).toBe(2);
  expect(JSON.parse(cited.stdout)).toMatchObject({
    error: "cited",
    citedBy: { nodes: 0, proposals: 1 },
  });

  const forced = await runCli("doc", "delete", doc.id, "--force");
  expect(forced.code).toBe(0);
  expect(JSON.parse(forced.stdout)).toEqual({ ok: true, id: doc.id });

  const state = await runCli("state");
  const parsed = JSON.parse(state.stdout) as { docs: Array<{ id: string }> };
  expect(parsed.docs.map((d) => d.id)).not.toContain(doc.id);
});

test("activity posts a casting-loop state; a bad state exits 2 with usage", async () => {
  const ok = await runCli("activity", "thinking");
  expect(ok.code).toBe(0);
  expect(JSON.parse(ok.stdout)).toEqual({ ok: true, state: "thinking" });

  const bad = await runCli("activity", "pondering");
  expect(bad.code).toBe(2);
  expect(bad.stderr).toContain("received|thinking|idle");
});

test("an unrecognized flag exits 2 with a clean message, not a stack-trace crash", async () => {
  const { code, stderr } = await runCli("ingest", "--help");
  expect(code).toBe(2);
  expect(stderr).toContain("mind-mapper:");
  expect(stderr).not.toContain("at ");
});

// Round 5 (CLI1) — propose-batch mints nodes and resolves local edge refs in
// one call; read fetches a full message by id.
test("propose-batch --stdin resolves local refs and returns the ref→id map", async () => {
  const proc = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "propose-batch", "--stdin"], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdin: new Response(
      JSON.stringify({
        nodes: [
          { ref: "x", draft: { title: " Port town" } },
          { ref: "y", draft: { title: "Salt trade" } },
        ],
        edges: [{ draft: { source: "x", target: "y", label: "runs on" } }],
      }),
    ).body,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  const body = JSON.parse(stdout) as {
    refToId: Record<string, string>;
    proposals: Array<{ kind: string; draft: { source?: string; target?: string } }>;
  };
  expect(typeof body.refToId.x).toBe("string");
  const edge = body.proposals.find((p) => p.kind === "edge");
  expect(edge?.draft.source).toBe(body.refToId.x);
  expect(edge?.draft.target).toBe(body.refToId.y);
});

test("propose-batch without --stdin exits 2 with usage", async () => {
  const { code, stderr } = await runCli("propose-batch");
  expect(code).toBe(2);
  expect(stderr).toContain("--stdin");
});

test("read <id> returns the full message row; unknown id exits 2", async () => {
  const sent = await runCli("send", "a durable line", "--role", "agent");
  const message = JSON.parse(sent.stdout) as { id: string };

  const read = await runCli("read", message.id);
  expect(read.code).toBe(0);
  expect(JSON.parse(read.stdout)).toMatchObject({ text: "a durable line", role: "agent" });

  const missing = await runCli("read", "no-such-message");
  expect(missing.code).toBe(2);
  expect(JSON.parse(missing.stdout)).toMatchObject({ error: "unknown message" });
});

// Round 5 (SG1) — node anchor round-trips through the CLI.
test("node anchor --to sets a parent, --clear resets to top-level", async () => {
  // Two fresh nodes via propose + ratify.
  async function ratify(title: string): Promise<string> {
    const p = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "propose-node", "--stdin"], {
      env: { ...process.env, MIND_MAPPER_HOME: home },
      stdin: new Response(JSON.stringify({ draft: { title }, evidence: {} })).body,
      stdout: "pipe",
    });
    const { id } = JSON.parse(await new Response(p.stdout).text()) as { id: string };
    await p.exited;
    const r = await runCli("ratify", id, "--ruling", "canon");
    return (JSON.parse(r.stdout) as { nodeId: string }).nodeId;
  }
  const parent = await ratify("Anchor Parent");
  const child = await ratify("Anchor Child");

  const anchored = await runCli("node", "anchor", child, "--to", parent);
  expect(anchored.code).toBe(0);
  expect(JSON.parse(anchored.stdout)).toEqual({ nodeId: child, anchorNodeId: parent });

  const state = await runCli("state");
  const parsed = JSON.parse(state.stdout) as {
    nodes: Array<{ id: string; anchorNodeId: string | null; submapChildCount: number }>;
  };
  expect(parsed.nodes.find((n) => n.id === child)?.anchorNodeId).toBe(parent);
  expect(parsed.nodes.find((n) => n.id === parent)?.submapChildCount).toBe(1);

  const cleared = await runCli("node", "anchor", child, "--clear");
  expect(cleared.code).toBe(0);
  expect(JSON.parse(cleared.stdout)).toEqual({ nodeId: child, anchorNodeId: null });
});

test("node anchor with neither --to nor --clear exits 2 with usage", async () => {
  const { code, stderr } = await runCli("node", "anchor", "some-id");
  expect(code).toBe(2);
  expect(stderr).toContain("--to");
});

// Round 5 (IC-c) — proposal zone <id> --to / --clear round-trips.
test("proposal zone moves a pending proposal into a zone and back through the CLI", async () => {
  const created = await runCli("zone", "create", "Sandbox");
  expect(created.code).toBe(0);

  const p = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "propose-node", "--stdin"], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdin: new Response(JSON.stringify({ draft: { title: "Sandbox Wisp" }, evidence: {} })).body,
    stdout: "pipe",
  });
  const { id } = JSON.parse(await new Response(p.stdout).text()) as { id: string };
  await p.exited;

  const into = await runCli("proposal", "zone", id, "--to", "sandbox");
  expect(into.code).toBe(0);
  expect(JSON.parse(into.stdout)).toEqual({ id, zoneId: "sandbox" });

  const back = await runCli("proposal", "zone", id, "--clear");
  expect(back.code).toBe(0);
  expect(JSON.parse(back.stdout)).toEqual({ id, zoneId: null });
});

// Round 6 (RB/DEL) CLI round-trips — a dedicated project keeps the shared
// default's seeded dataset out of the assertions.
async function runCliStdin(
  args: string[],
  body: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", CLI_SCRIPT, ...args], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdin: new Response(body).body,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("ratify-batch --stdin ratifies a node+edge set and returns the idMap", async () => {
  await runCli("projects", "--create", "R6 Batch");
  const a = JSON.parse(
    (
      await runCliStdin(
        ["propose-node", "--stdin", "--project", "r6-batch"],
        JSON.stringify({ draft: { title: "A" } }),
      )
    ).stdout,
  ) as { id: string };
  const b = JSON.parse(
    (
      await runCliStdin(
        ["propose-node", "--stdin", "--project", "r6-batch"],
        JSON.stringify({ draft: { title: "B" } }),
      )
    ).stdout,
  ) as { id: string };
  const e = JSON.parse(
    (
      await runCliStdin(
        ["propose-edge", "--stdin", "--project", "r6-batch"],
        JSON.stringify({ draft: { source: a.id, target: b.id, label: "rel" } }),
      )
    ).stdout,
  ) as { id: string };
  const { code, stdout } = await runCliStdin(
    ["ratify-batch", "--stdin", "--project", "r6-batch"],
    JSON.stringify({ ruling: "canon", ids: [e.id, a.id, b.id] }),
  );
  expect(code).toBe(0);
  const body = JSON.parse(stdout) as { idMap: Record<string, string> };
  expect(body.idMap[a.id]).toBeDefined();
  const state = JSON.parse((await runCli("state", "--project", "r6-batch")).stdout) as {
    edges: unknown[];
  };
  expect(state.edges).toHaveLength(1);
});

test("node delete --force and proposal delete round-trip via the CLI", async () => {
  await runCli("projects", "--create", "R6 Del");
  const p = JSON.parse(
    (
      await runCliStdin(
        ["propose-node", "--stdin", "--project", "r6-del"],
        JSON.stringify({ draft: { title: "Solo" } }),
      )
    ).stdout,
  ) as { id: string };
  const ratified = JSON.parse(
    (await runCli("ratify", p.id, "--ruling", "canon", "--project", "r6-del")).stdout,
  ) as { nodeId: string };
  const del = await runCli("node", "delete", ratified.nodeId, "--force", "--project", "r6-del");
  expect(del.code).toBe(0);
  expect(JSON.parse(del.stdout)).toEqual({ ok: true, id: ratified.nodeId });

  // A leftover pending proposal → proposal delete drops it.
  const p2 = JSON.parse(
    (
      await runCliStdin(
        ["propose-node", "--stdin", "--project", "r6-del"],
        JSON.stringify({ draft: { title: "raw" } }),
      )
    ).stdout,
  ) as { id: string };
  const pdel = await runCli("proposal", "delete", p2.id, "--project", "r6-del");
  expect(pdel.code).toBe(0);
  const state = JSON.parse((await runCli("state", "--project", "r6-del")).stdout) as {
    proposals: Array<{ id: string }>;
    nodes: unknown[];
  };
  // p2 (the raw pending proposal) is gone; the ratified proposal p survives as
  // history (node delete leaves result_node_id), and its node was force-deleted.
  expect(state.proposals.some((pr) => pr.id === p2.id)).toBe(false);
  expect(state.nodes).toHaveLength(0);
});

// Round 7 (TAGS) — the tags verb round-trips wholesale-set and clear against a
// PENDING proposal; tags ride /state.
test("tags --set then --clear round-trips through the CLI", async () => {
  const p = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "propose-node", "--stdin"], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdin: new Response(JSON.stringify({ draft: { title: "Taggable CLI" }, evidence: {} })).body,
    stdout: "pipe",
  });
  const { id } = JSON.parse(await new Response(p.stdout).text()) as { id: string };
  await p.exited;

  const set = await runCli("tags", id, "--set", JSON.stringify(["alpha", "beta"]));
  expect(set.code).toBe(0);
  expect(JSON.parse(set.stdout)).toEqual({ targetId: id, tags: ["alpha", "beta"] });

  const state = await runCli("state");
  const parsed = JSON.parse(state.stdout) as { proposals: Array<{ id: string; tags?: string[] }> };
  expect(parsed.proposals.find((pr) => pr.id === id)?.tags).toEqual(["alpha", "beta"]);

  const cleared = await runCli("tags", id, "--clear");
  expect(cleared.code).toBe(0);
  expect(JSON.parse(cleared.stdout)).toEqual({ targetId: id, tags: [] });

  const usage = await runCli("tags", id);
  expect(usage.code).toBe(2);
  expect(usage.stderr).toContain("--set");
});

// Round 7 (TAGS) — propose-node --stdin with a top-level `tags` key must
// forward the tags into the POST body (the single-verb CLI path bug cassandra's
// cold gate caught: the route + batch attach tags, the single verb silently
// dropped them). Drives the doc's "add tags to any propose-node stdin body".
test("propose-node --stdin forwards top-level tags onto the pending proposal", async () => {
  const p = Bun.spawn([process.execPath, "run", CLI_SCRIPT, "propose-node", "--stdin"], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    stdin: new Response(
      JSON.stringify({ draft: { title: "Tagged at propose" }, evidence: {}, tags: ["gamma"] }),
    ).body,
    stdout: "pipe",
  });
  const proposal = JSON.parse(await new Response(p.stdout).text()) as {
    id: string;
    tags?: string[];
  };
  await p.exited;
  // The minted proposal echoes the tags (not tags:null — the bug's signature).
  expect(proposal.tags).toEqual(["gamma"]);

  const state = await runCli("state");
  const parsed = JSON.parse(state.stdout) as { proposals: Array<{ id: string; tags?: string[] }> };
  expect(parsed.proposals.find((pr) => pr.id === proposal.id)?.tags).toEqual(["gamma"]);
});

// Round 9 (Job Queue) — the `job` verb threads every field into the POST body
// (the R7 body-mirror scar) across create/update/claim/subtask/list/delete.
test("job verb: create/update/claim/subtask/list/delete round-trip the body shape", async () => {
  const created = await runCli(
    "job",
    "create",
    "--title",
    "CLI job",
    "--deliverable",
    "doc:out",
    "--detail",
    "notes",
  );
  expect(created.code).toBe(0);
  const job = JSON.parse(created.stdout) as {
    id: string;
    status: string;
    deliverable: string;
    detail: string;
  };
  // Every flag threaded through — not dropped (the mirror-drift signature).
  expect(job.status).toBe("queued");
  expect(job.deliverable).toBe("doc:out");
  expect(job.detail).toBe("notes");

  const updated = await runCli("job", "update", job.id, "--status", "running");
  expect(JSON.parse(updated.stdout).status).toBe("running");

  const claimed = await runCli("job", "claim", job.id, "--owner", "cli-agent");
  expect(JSON.parse(claimed.stdout).claimedBy).toBe("cli-agent");

  const sub = await runCli("job", "subtask", job.id, "--add", "step one");
  const subtasks = JSON.parse(sub.stdout).subtasks as Array<{ id: string; label: string }>;
  expect(subtasks[0]?.label).toBe("step one");
  const checked = await runCli("job", "subtask", job.id, "--check", subtasks[0]?.id as string);
  expect((JSON.parse(checked.stdout).subtasks as Array<{ done: boolean }>)[0]?.done).toBe(true);

  const listed = await runCli("job", "list");
  expect(
    (JSON.parse(listed.stdout).jobs as Array<{ id: string }>).some((j) => j.id === job.id),
  ).toBe(true);

  const del = await runCli("job", "delete", job.id);
  expect(del.code).toBe(0);
  expect(JSON.parse(del.stdout)).toEqual({ ok: true, id: job.id });

  // Guards: create without a title, claim without an owner, unknown sub.
  expect((await runCli("job", "create")).code).toBe(2);
  expect((await runCli("job", "claim", "x")).code).toBe(2);
  expect((await runCli("job", "bogus")).code).toBe(2);
});

// Round 7 (PORT) — `open --port N` forwards the flag through ensureDaemon into
// the daemon's spawn args; the server binds it and writes N to daemon.port.
// Uses its own fresh HOME so no live daemon short-circuits the port (the
// live-daemon-ignores-N wrinkle) — and its own daemon teardown.
test("open --port N binds the daemon to N (forwarded through ensureDaemon)", async () => {
  // Grab a free port by opening an ephemeral server, reading its port, closing.
  const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const wanted = probe.port; // Bun.serve().port is number | undefined — narrow once
  probe.stop(true);
  if (wanted === undefined) throw new Error("probe server did not report a port");

  const portHome = mkdtempSync(join(tmpdir(), "mind-mapper-cli-port-test-"));
  try {
    const proc = Bun.spawn(
      [process.execPath, "run", CLI_SCRIPT, "open", "--no-open", "--port", String(wanted)],
      { env: { ...process.env, MIND_MAPPER_HOME: portHome }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    // The printed url carries the requested port, and so does the discovery file.
    expect(JSON.parse(stdout).url).toBe(`http://127.0.0.1:${wanted}`);
    const { readFileSync } = await import("node:fs");
    const written = Number.parseInt(readFileSync(join(portHome, "daemon.port"), "utf8").trim(), 10);
    expect(written).toBe(wanted);
  } finally {
    try {
      const { readFileSync } = await import("node:fs");
      const pid = Number.parseInt(readFileSync(join(portHome, "daemon.pid"), "utf8").trim(), 10);
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    rmSync(portHome, { recursive: true, force: true });
  }
});

// ── Round 11 — the channel + the activity-message tie, at the CLI wire ───────
// (the body-mirror scar: a field added to a shared route must be threaded into
// EVERY verb that posts to it, with a per-verb round-trip row.)

test("send --kind mirrors the daemon's unknown-channel advisory to stderr", async () => {
  const known = await runCli("send", "a canvas ramble", "--kind", "canvas", "--role", "user");
  expect(known.code).toBe(0);
  expect(JSON.parse(known.stdout)).toMatchObject({ kind: "canvas", role: "user" });
  expect(known.stderr).not.toContain("warning");

  const typo = await runCli("send", "typo channel", "--kind", "cavnas", "--role", "user");
  expect(typo.code).toBe(0);
  expect(typo.stderr).toContain("warning");
  expect(typo.stderr).toContain("canvas");
});

test("activity --message forwards the messageId, and /state reports the tie", async () => {
  const sent = await runCli("send", "tie me", "--role", "user");
  const message = JSON.parse(sent.stdout) as { id: string };

  const posted = await runCli("activity", "thinking", "--message", message.id);
  expect(posted.code).toBe(0);
  const state = JSON.parse((await runCli("state")).stdout) as {
    activity: { state: string; messageId?: string } | null;
  };
  expect(state.activity).toMatchObject({ state: "thinking", messageId: message.id });

  // Closing the ladder clears it (no `done` state — idle is the terminal).
  await runCli("activity", "idle");
  const cleared = JSON.parse((await runCli("state")).stdout) as { activity: unknown };
  expect(cleared.activity).toBeNull();
});

// ── Round 12 — the new verbs at the CLI wire ────────────────────────────────
// The body-mirror discipline again: a hand-written body-builder is a MIRROR of
// the route's field set, and mirrors drift silently — so every new field gets a
// per-verb round-trip row here, not just a route test.

async function runCliBody(
  body: unknown,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", CLI_SCRIPT, ...args], {
    env: { ...process.env, MIND_MAPPER_HOME: home },
    // Always hand a spawned CLI an explicit stdin — the piped-stdin default
    // otherwise inherits the runner's never-EOF stdin and blocks forever.
    stdin: new Response(typeof body === "string" ? body : JSON.stringify(body)).body,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test("propose-batch returns a batchId and `state --batch` narrows to that act", async () => {
  const batched = await runCliBody(
    { nodes: [{ ref: "n1", draft: { title: "R12 Alpha" } }] },
    "propose-batch",
    "--stdin",
  );
  expect(batched.code).toBe(0);
  const { batchId } = JSON.parse(batched.stdout) as { batchId: string };
  expect(typeof batchId).toBe("string");

  // A single propose JOINS the act when the stdin body names it (the body
  // mirror: batchId must be threaded into propose-node's explicit field list).
  const joined = await runCliBody(
    { draft: { source: "a", target: "b", label: "late" }, evidence: {}, batchId },
    "propose-edge",
    "--stdin",
  );
  expect(joined.code).toBe(0);
  expect(JSON.parse(joined.stdout)).toMatchObject({ batchId });

  const narrowed = await runCli("state", "--batch", batchId);
  expect(narrowed.code).toBe(0);
  const state = JSON.parse(narrowed.stdout) as { proposals: Array<{ batchId: string }> };
  expect(state.proposals).toHaveLength(2);
  expect(state.proposals.every((p) => p.batchId === batchId)).toBe(true);

  const unknown = await runCli("state", "--batch", "no-such-batch");
  expect(unknown.code).toBe(2);
  expect(JSON.parse(unknown.stdout).error).toContain("DELETED");
});

test("node edit sets a synopsis on a live node — by flag and by --stdin", async () => {
  const proposed = await runCliBody(
    { draft: { title: "R12 Editable" }, evidence: {} },
    "propose-node",
    "--stdin",
  );
  const { id } = JSON.parse(proposed.stdout) as { id: string };
  const ruled = await runCli("ratify", id, "--ruling", "canon");
  expect(ruled.code).toBe(0);
  const nodeId = (JSON.parse(ruled.stdout) as { nodeId: string }).nodeId;

  const byFlag = await runCli("node", "edit", nodeId, "--synopsis", "set by flag");
  expect(byFlag.code).toBe(0);
  expect(JSON.parse(byFlag.stdout)).toMatchObject({ id: nodeId, synopsis: "set by flag" });

  // Prose belongs on stdin — and the patch must not blank the other field.
  const byStdin = await runCliBody({ synopsis: "set by stdin" }, "node", "edit", nodeId, "--stdin");
  expect(byStdin.code).toBe(0);
  expect(JSON.parse(byStdin.stdout)).toMatchObject({
    title: "R12 Editable",
    synopsis: "set by stdin",
  });

  const noFields = await runCli("node", "edit", nodeId);
  expect(noFields.code).toBe(2);
  expect(noFields.stderr).toContain("tier is the human's ruling");
});

test("delete-batch clears a set in one call and is all-or-nothing", async () => {
  const batched = await runCliBody(
    {
      nodes: [
        { ref: "a", draft: { title: "R12 Doomed A" } },
        { ref: "b", draft: { title: "R12 Doomed B" } },
      ],
    },
    "propose-batch",
    "--stdin",
  );
  const { proposals } = JSON.parse(batched.stdout) as { proposals: Array<{ id: string }> };
  const ids = proposals.map((p) => p.id);

  const bad = await runCliBody({ ids: [...ids, "ghost"] }, "delete-batch", "--stdin");
  expect(bad.code).toBe(2);
  expect(JSON.parse(bad.stdout).error).toContain("ghost");

  const ok = await runCliBody({ ids }, "delete-batch", "--stdin");
  expect(ok.code).toBe(0);
  expect(JSON.parse(ok.stdout)).toEqual({ deleted: ids });

  const usage = await runCli("delete-batch");
  expect(usage.code).toBe(2);
  expect(usage.stderr).toContain("look before you sweep");
});

test("changes --since returns a delta that names what it cannot see", async () => {
  const first = await runCli("changes", "--since", "0");
  expect(first.code).toBe(0);
  const delta = JSON.parse(first.stdout) as { now: number; notCovered: string[] };
  expect(delta.notCovered.join(" ")).toContain("DELETIONS");

  const missing = await runCli("changes");
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain("notCovered");
});
