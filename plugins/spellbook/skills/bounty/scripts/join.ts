#!/usr/bin/env bun

// LAUNCHER, not the participant. The implementation is authored at
// `src/bounty/backend/join.ts` and ships BUILT at `../dist/join.js`
// (backend convergence Phase 4; entry set derived per D43).
//
// WHY THIS FILE EXISTS AT THIS EXACT PATH. `join.ts` is a CALLER-FACING ENTRY —
// SKILL.md names it twice and tells a joining agent to spawn it directly — and
// it is the THIRD entry that made D43 necessary: until 2026-09-09 `src/build.ts`
// hard-coded `cli` and `server`, and this file had no way to exist. The entry
// set is now derived from the launchers, so THIS FILE is what puts `join` in the
// build. `grimoire/launcher-pairing-ward.test.ts` checks the pairing in both
// directions.
//
// ADD NO LOGIC BELOW. Anything written here ships UNBUILT beside a built
// artifact and is invisible to the backend's own tests.
//
// ⛔ ⚠ THIS LAUNCHER IS THE **DAEMON** SHAPE, AND THE PLAYBOOK'S OWN EXAMPLE
// SAYS OTHERWISE. Phase B's B2 names this very file as a CLI shape ("pick by
// what the entry IS"), and by stdout contract that is right: join writes JSON
// lines a caller parses, and the write most at risk is the terminal
// `disconnected` frame emitted on the line before `main` returns. But the CLI
// shape was MEASURED HERE AND IT HANGS — `process.exitCode` + a natural return
// leaves the idle-timeout cell running to a 15 s test timeout, because a
// natural exit waits for the loop to drain and this file's WebSocket is not
// guaranteed closed on every exit path. The `process.exit` does DOUBLE DUTY:
// draining the payload is broken, but force-terminating a live socket is
// load-bearing. Shipping a hang to fix a truncation is a bad trade.
//
// So the P0 (#77/#78) drained-exit defect is CARRIED ACROSS THIS PORT
// UNCHANGED, deliberately — the honest fix is a lifecycle change (close the
// socket on every path, then return naturally) and is carded separately. The
// exit stays family E-terminal in `grimoire/exit-site-inventory.test.ts`, at
// this address, exactly as before the port.
//
// `run()` takes NO ARGUMENTS on purpose — see `scripts/cli.ts` for why.
import { run } from "../dist/join.js";

const exitCode = await run();
process.exit(exitCode);
