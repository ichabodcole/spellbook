// The fixture app's CLI launcher: the kit's verbs plus one of its own (`demo`).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkspaceCli } from "../verbs";
import { fixtureApp, fixtureSessionsRoot } from "./app";

export const cli = createWorkspaceCli({
  app: fixtureApp,
  summary: "the workspace fixture",
  daemon: {
    command: "bun",
    args: ["run", join(dirname(fileURLToPath(import.meta.url)), "server.ts")],
  },
  sessionsRoot: fixtureSessionsRoot,
  version: () => ({ name: "kit-fixture", version: "0.0.0" }),
  commands: (h) => [
    {
      name: "demo",
      flags: [...h.SESSION],
      positionals: [{ name: "title", required: false }],
      describe: "queue a demo job (a daemon task with a runner)",
      run: async (inv) => {
        h.printJson(
          await h.postCmd(h.sessionOf(inv), {
            op: "kit-fixture.demo",
            ...(inv.pos[0] ? { title: inv.pos[0] } : {}),
          }),
        );
      },
    },
    {
      name: "ping",
      flags: [...h.SESSION],
      positionals: [],
      describe: "emit the fixture's own event",
      run: async (inv) => {
        h.printJson(await h.postCmd(h.sessionOf(inv), { op: "kit-fixture.ping" }));
      },
    },
  ],
});

if (import.meta.main) process.exitCode = await cli.run(process.argv.slice(2));
