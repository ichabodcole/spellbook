// The restore command's launcher (`kitLauncher`): `bun` on the
// skill's CLI launcher beside the daemon's bundle, with the session's home when
// one was given; none where no launcher sits beside the daemon.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../../../kit/workspace/testing";
import { kitLauncher } from "./server";

const root = tempRoot("scriptorium-kit-launcher");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A skill folder: `dist/` (the daemon's own folder) beside `scripts/cli.ts`. */
function skill(name: string) {
  const at = join(root, name);
  mkdirSync(join(at, "dist"), { recursive: true });
  mkdirSync(join(at, "scripts"), { recursive: true });
  writeFileSync(join(at, "scripts", "cli.ts"), "");
  return at;
}

describe("kitLauncher", () => {
  test("bun on the CLI launcher beside the bundle, with no variable", () => {
    const at = skill("plain");
    expect(kitLauncher(join(at, "dist"), {})).toBe(`bun ${join(at, "scripts", "cli.ts")}`);
  });

  test("a SCRIPTORIUM_HOME the daemon was given rides along, resolved", () => {
    const at = skill("homed");
    expect(kitLauncher(join(at, "dist"), { SCRIPTORIUM_HOME: "/tmp/x/../scratch" })).toBe(
      `SCRIPTORIUM_HOME=/tmp/scratch bun ${join(at, "scripts", "cli.ts")}`,
    );
  });

  test("a path the shell would split is quoted", () => {
    const at = skill("with space");
    expect(kitLauncher(join(at, "dist"), {})).toBe(`bun '${join(at, "scripts", "cli.ts")}'`);
  });

  test("none where no launcher sits beside the daemon, as when run from source", () => {
    expect(kitLauncher(join(root, "nowhere", "dist"), {})).toBeUndefined();
    expect(kitLauncher(import.meta.dir, {})).toBeUndefined();
  });
});
