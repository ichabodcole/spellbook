// The fixture app's daemon launcher: what `open` spawns. Three lines of its own.
import { runWorkspaceDaemon } from "../server";
import { fixtureDaemon } from "./app";

process.exitCode = await runWorkspaceDaemon(
  process.argv.slice(2),
  (flags) => fixtureDaemon({ ...flags }),
  "kit-fixture",
);
