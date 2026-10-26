// Which page is which, over a real daemon: an app hears which page's socket
// closed (`VerbCall.surface`, `hooks.onSurfaceClose`). What a page points at
// (`about.refs`, and a subject it names) is `messageViaRefs.test.ts`.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDaemon, fixtureVerbs } from "./fixtures/app";
import { FakeSurface, waitUntil } from "./fixtures/harness";
import type { WorkspaceDaemon } from "./server";
import { tempRoot } from "./testing";

let root: string;
let world: string;
let daemon: WorkspaceDaemon;
const closed: string[] = [];
const callers: string[] = [];

beforeEach(async () => {
  root = tempRoot("pointed");
  world = join(root, "world");
  mkdirSync(join(world, "places"), { recursive: true });
  writeFileSync(join(world, "places", "cave.md"), "# Cave\n");
  writeFileSync(join(world, "stair.md"), "# Stair\n");
  writeFileSync(join(root, "outside.md"), "# Not in the context\n");
  mkdirSync(join(root, "tmp"));
  process.env.KIT_FIXTURE_HOME = join(root, "home");
  closed.length = 0;
  callers.length = 0;
  daemon = fixtureDaemon({
    tmp: join(root, "tmp"),
    verbs: {
      ...fixtureVerbs,
      "kit-fixture.whoami": (_ctx, _args, call) => {
        callers.push(call.surface ?? "none");
        return {};
      },
    },
    hooks: { onSurfaceClose: (surface) => closed.push(surface) },
  });
  await daemon.start();
});
afterEach(async () => {
  await daemon.stop();
  rmSync(root, { recursive: true, force: true });
});

test("a page's verb calls carry its id, and the app hears when that page's socket closes", async () => {
  const a = new FakeSurface();
  const b = new FakeSurface();
  await a.connect(daemon.port);
  await b.connect(daemon.port);
  for (const [page, n] of [
    [a, 1],
    [b, 2],
    [a, 3],
  ] as const) {
    page.send({ op: "kit-fixture.whoami" } as never);
    await waitUntil(`call ${n}`, () => callers.length === n);
  }
  expect(callers[0]).toBe(callers[2] as string);
  expect(callers[1]).not.toBe(callers[0] as string);
  a.close();
  await waitUntil("a's close", () => closed.length === 1);
  expect(closed).toEqual([callers[0] as string]);
  b.close();
  await waitUntil("b's close", () => closed.length === 2);
  expect(closed[1]).toBe(callers[1] as string);
});
