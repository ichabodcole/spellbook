// A closed stdout pipe, through a kit CLI's real process: `<cli> schema | true`
// under pipefail used to end in Bun's EPIPE stack and exit 1. The registry's
// dispatch now ends it at 0 with nothing on stderr (`exitOnBrokenPipe`).
//
// The CLI is run from SOURCE (`../cli.ts`, through a launcher written here the
// way `scripts/cli.ts` runs the bundle), so the test sees this tree's code
// without a build.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "../../../kit/workspace/testing";

const root = tempRoot("scriptorium-closed-pipe");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
const launcher = join(root, "cli.ts");
writeFileSync(
  launcher,
  `import { run } from ${JSON.stringify(join(import.meta.dir, "..", "cli.ts"))};\nprocess.exitCode = await run();\n`,
);

describe("a closed stdout pipe", () => {
  // `true` exits long before Bun boots, so the CLI always writes to a closed pipe.
  for (const verb of ["schema", "version"]) {
    test(`${verb} | true exits 0 with nothing on stderr`, async () => {
      const p = Bun.spawn(
        ["bash", "-c", `set -o pipefail; '${process.execPath}' '${launcher}' ${verb} | true`],
        {
          stdout: "pipe",
          stderr: "pipe",
          cwd: root,
          env: { ...process.env, SCRIPTORIUM_HOME: home, TMPDIR: root },
        },
      );
      const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
      expect([code, err]).toEqual([0, ""]);
    });
  }
});
