// A chat line names a document as the sidebar shows it (`set/rel`), never by
// the agent's slug. Two documents with one file name get the slugs `beta` and
// `beta-2`; the human never sees `beta-2` anywhere else, so a line that said
// "v2 of beta-2" told them nothing. The events keep the slug: it is the
// agent's handle.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { cmd, collectEvents, FakeSurface, waitUntil, writeUntilSeen } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let daemon: WorkspaceDaemon | null;
let surface: FakeSurface | null;

beforeEach(() => {
  root = tempRoot("workspace-chat-names");
  mkdirSync(join(root, "tmp"), { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  for (const set of ["docs", "other"]) {
    mkdirSync(join(root, set), { recursive: true });
    writeFileSync(join(root, set, "beta.md"), `# Beta in ${set}\n`);
  }
  daemon = null;
  surface = null;
});
afterEach(async () => {
  surface?.close();
  if (daemon) await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

const chat = (s: FakeSurface) => s.state.chat.map((m) => m.text);

test("two documents with one file name: the chat names each by its set and path, not its slug", async () => {
  daemon = fixtureDaemon({ tmp: join(root, "tmp") });
  await daemon.start();
  const s = new FakeSurface();
  surface = s;
  await s.connect(daemon.port);
  s.send({ op: "context.add", path: join(root, "docs") });
  s.send({ op: "context.add", path: join(root, "other") });
  await waitUntil("two sets", () => s.state.context.length === 2);
  s.send({ op: "open", path: join(root, "docs", "beta.md") });
  await waitUntil("docs/beta open", () => s.state.docs.length === 1);
  s.send({ op: "open", path: join(root, "other", "beta.md") });
  await waitUntil("other/beta open", () => s.state.docs.length === 2);
  const second = s.state.docs.find((d) => d.original === join(root, "other", "beta.md"));
  expect(second?.slug).toBe("beta-2");

  const r = await cmd(daemon.url, { op: "version.new", doc: "beta-2", label: "tighter" });
  expect(r.status).toBe(200);
  await waitUntil("the created line", () =>
    chat(s).includes("Agent created v2 of other/beta.md from v1: tighter."),
  );
  const a = await cmd(daemon.url, { op: "activate", doc: "beta-2", version: 2 });
  expect(a.status).toBe(200);
  await waitUntil("the activated line", () =>
    chat(s).includes("Agent made v2 of other/beta.md active (was v1)."),
  );
  // No human line names a document by the agent's slug.
  expect(chat(s).some((t) => t.includes("beta-2"))).toBe(false);

  // An outside write to the active version: the human reads the sidebar's
  // name, the agent's event keeps the slug it can pass back to --doc.
  const t = collectEvents(daemon.url);
  try {
    const active = s.state.docs.find((d) => d.slug === "beta-2")?.versions[1]?.path ?? "";
    const ev = await writeUntilSeen(
      "active.outside",
      () => writeFileSync(active, "# Written from outside\n"),
      () => t.events.find((e) => e.type === "system" && e.fact === "active.outside"),
    );
    expect(String(ev.text).startsWith("v2 of beta-2 is the active version")).toBe(true);
    await waitUntil("the chat line", () =>
      chat(s).some((x) => x.startsWith("v2 of other/beta.md is the active version")),
    );
  } finally {
    await t.stop();
  }
});
