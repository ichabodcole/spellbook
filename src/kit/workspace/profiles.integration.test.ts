// A document's profile over a real daemon, as the surface asks for it: the
// `profile` frame answers the sender with what the agent's `profile` verb
// prints, read from the active version (an unsaved edit counts), each warning
// with its fix in words; a profile file changed on disk pushes
// `context.changed`, and the next ask sees the new rule.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon } from "./fixtures/app";
import { FakeSurface, waitUntil } from "./fixtures/harness";
import type { ServerOp } from "./protocol";
import type { WorkspaceDaemon } from "./server";
import { seedDocs, tempRoot } from "./testing";

let root: string;
let docs: string;
let daemon: WorkspaceDaemon;
let surface: FakeSurface;

const LOCATION = {
  kind: "location",
  label: "Location",
  properties: {
    type: { const: "location" },
    description: { type: "string", minLength: 1, description: "One sentence." },
    status: { enum: ["draft", "stable"] },
  },
  required: ["type", "description", "status"],
};

const writeProfile = (body: unknown) => {
  mkdirSync(join(docs, "set", "_meta", "profiles"), { recursive: true });
  writeFileSync(
    join(docs, "set", "_meta", "profiles", "location.json"),
    JSON.stringify(body, null, 2),
  );
};

beforeEach(async () => {
  root = tempRoot("workspace-profile");
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  docs = seedDocs(root);
  writeProfile(LOCATION);
  writeFileSync(
    join(docs, "set", "a.md"),
    "---\ntype: location\ntitle: A\nstatus: final\n---\n# A\n",
  );
  daemon = fixtureDaemon({ tmp, platform: "darwin", reveal: () => {} });
  await daemon.start();
  surface = new FakeSurface();
  await surface.connect(daemon.port);
  surface.send({ op: "context.add", path: join(docs, "set") });
  await waitUntil("context", () => surface.state.context.length === 1);
  surface.send({ op: "open", path: join(docs, "set", "a.md") });
  await surface.waitFor((m) => m.op === "version.text" && m.doc === "a");
});
afterEach(async () => {
  surface.close();
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

const rid = (m: ServerOp) => (m as { requestId?: unknown }).requestId;
let asked = 0;
const ask = async (doc: string) => {
  const id = `p${++asked}`;
  surface.send({ op: "profile", doc, rid: id } as never);
  return (await surface.waitFor((m) => m.op === "profile" && rid(m) === id)) as Extract<
    ServerOp,
    { op: "profile" }
  >;
};

describe("profile", () => {
  test("answers the sender with the label, the file and the warnings, each with a fix", async () => {
    const r = await ask("a");
    expect(r).toMatchObject({
      doc: "a",
      match: "matched",
      label: "Location",
      canon: true,
      sourceShown: "_meta/profiles/location.json",
    });
    expect(r.warnings.map((w) => [w.field, w.rule, w.fix])).toEqual([
      ["description", "required", "add `description` to the frontmatter (One sentence.)"],
      ["status", "enum", "set `status` to one of draft, stable"],
    ]);
  });

  test("carries the kind's canon: false over the socket", async () => {
    writeProfile({ ...LOCATION, canon: false });
    expect(await ask("a")).toMatchObject({ match: "matched", label: "Location", canon: false });
  });

  test("reads the active version: an unsaved edit counts, as the agent's verb counts it", async () => {
    surface.send({
      op: "edit",
      doc: "a",
      version: 1,
      text: "---\ntype: location\ndescription: Here.\nstatus: draft\n---\n# A\n",
    });
    // The edit and the ask travel the same socket, in order.
    expect((await ask("a")).warnings).toEqual([]);
  });

  test("a profile file changed on disk pushes context.changed, and the next ask sees it", async () => {
    expect((await ask("a")).warnings).toHaveLength(2);
    const seen = surface.frames.length;
    writeProfile({
      ...LOCATION,
      required: ["type"],
      properties: { type: LOCATION.properties.type },
    });
    await surface.waitFor((m) => m.op === "context.changed" && surface.frames.indexOf(m) >= seen);
    expect((await ask("a")).warnings).toEqual([]);
  });

  test("an unknown op's refusal offers profile among the surface's ops", async () => {
    surface.send({ op: "profile.nope", rid: "bad-op" } as never);
    const r = await surface.waitFor((m) => m.op === "error" && rid(m) === "bad-op");
    expect((r as { choices?: string[] }).choices).toContain("profile");
  });

  test("an unknown document is refused by name", async () => {
    surface.send({ op: "profile", doc: "nope", rid: "bad-p" } as never);
    const r = await surface.waitFor((m) => m.op === "error" && rid(m) === "bad-p");
    expect(String((r as { message?: string }).message)).toContain("nope");
  });
});
