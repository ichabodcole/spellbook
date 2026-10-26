// Search over a real daemon: the active version as the session holds it, the
// wire (POST /cmd and the WebSocket), ranking, the limit, and the empty query.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, FakeSurface, waitUntil } from "./fixtures/harness";
import type { SearchReport } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
let surface: FakeSurface;

beforeEach(async () => {
  root = tempRoot("workspace-search");
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  writeFileSync(join(docs, "set", "bridge-keeper.md"), "# Keeper\n\nstands on the bridge\n");
  writeFileSync(join(docs, "set", "part", "ledger.md"), "# Ledger\n\nthe Bridge toll is two\n");
  daemon = fixtureDaemon({ tmp, platform: "darwin", reveal: () => {} });
  await daemon.start();
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  surface.send({ op: "context.add", path: join(docs, "set") });
  await waitUntil("context", () => surface.state.context.length === 1);
});
afterEach(async () => {
  surface.close();
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

const search = async (body: Record<string, unknown>) => {
  const r = await cmd(daemon.url, { op: "search", ...body });
  return { status: r.status, body: r.body as unknown as SearchReport };
};

describe("search", () => {
  test("a name match is fuzzy and a text match is exact and case-insensitive", async () => {
    const { status, body } = await search({ query: "bkpr" });
    expect(status).toBe(200);
    expect(body.results.map((r) => [r.kind, r.name])).toEqual([["name", "bridge-keeper.md"]]);

    const text = await search({ query: "BRIDGE TOLL" });
    expect(text.body.results).toHaveLength(1);
    expect(text.body.results[0]).toMatchObject({
      kind: "text",
      name: "ledger.md",
      slug: null,
      version: null,
      line: 3,
      column: 5,
      snippet: "the Bridge toll is two",
    });
    expect(text.body.results[0]?.path).toBe(join(docs, "set", "part", "ledger.md"));
  });

  test("it reads the ACTIVE version as the session holds it, not the file on disk", async () => {
    surface.send({ op: "open", path: join(docs, "set", "a.md") });
    await surface.waitFor((m) => m.op === "version.text");
    surface.send({ op: "edit", doc: "a", version: 1, text: "# A\n\nthe lantern is lit\n" });
    await waitUntil("dirty", () => surface.state.docs.find((d) => d.slug === "a")?.dirty);
    expect(readFileSync(join(docs, "set", "a.md"), "utf8")).toBe("# A\n\none\n");

    const hit = await search({ query: "lantern" });
    expect(hit.body.results).toHaveLength(1);
    expect(hit.body.results[0]).toMatchObject({
      kind: "text",
      slug: "a",
      name: "a.md",
      version: 1,
      line: 3,
      column: 5,
      snippet: "the lantern is lit",
    });
    // The saved text is gone from what the session shows.
    expect((await search({ query: "one" })).body.results.some((r) => r.slug === "a")).toBe(false);

    // A new active version is what is searched from then on.
    surface.send({ op: "version.new", doc: "a", activate: true });
    await waitUntil("v2", () => surface.state.docs.find((d) => d.slug === "a")?.active === 2);
    expect((await search({ query: "lantern" })).body.results[0]?.version).toBe(2);
  });

  test("names rank before text, best name first, and the limit caps the whole list", async () => {
    const all = await search({ query: "bridge" });
    expect(all.body.results.map((r) => [r.kind, r.name])).toEqual([
      ["name", "bridge-keeper.md"],
      ["text", "ledger.md"],
      ["text", "bridge-keeper.md"],
    ]);
    expect(all.body.truncated).toBe(false);

    const capped = await search({ query: "bridge", limit: 2 });
    expect(capped.body.count).toBe(2);
    expect(capped.body.truncated).toBe(true);
    expect(capped.body.results.map((r) => r.kind)).toEqual(["name", "text"]);
  });

  test("an empty or blank query is a usage refusal, and nothing matching is an answer", async () => {
    const empty = await search({ query: "   " });
    expect(empty.status).toBe(400);
    expect((empty.body as unknown as { error: string }).error).toContain("empty");
    const none = await search({ query: "zzzzqqq" });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ results: [], count: 0, truncated: false });
  });

  test("the surface asks over the WebSocket and gets search.results, echoing its rid", async () => {
    surface.send({ op: "search", query: "keeper", limit: 5, rid: 7 } as never);
    const reply = await surface.waitFor((m) => m.op === "search.results");
    expect(reply).toMatchObject({ op: "search.results", query: "keeper", requestId: 7 });
    expect((reply as unknown as SearchReport).results[0]).toMatchObject({
      kind: "name",
      name: "bridge-keeper.md",
    });
  });
});
