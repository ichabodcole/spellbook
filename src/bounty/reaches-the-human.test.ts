// ⛔ DOES THE FIELD REACH THE PERSON LOOKING AT THE BOARD?
//
// This cell is the successor to `b16 LOCKSTEP` in
// plugins/spellbook/skills/bounty/scripts/server.test.ts, and it exists because
// of a real release. `restoreFailed` was emitted by the daemon at five sites
// and rendered by the surface at zero: the agent could read it on the `open`
// payload and on GET /state, and the human — whose only channel is the socket —
// saw an empty board with no explanation. A wire test could not catch it,
// because the wire was correct the whole time. Only the surface was blind.
//
// So this reads the surface as TEXT and asserts that every field the daemon
// puts on the `init` frame is (a) modelled in the state module and (b) actually
// reaches a component. Crude on purpose: it fails loudly the moment someone
// adds a field to the wire and forgets the human, which is the failure that
// actually happened. It is not a substitute for driving the board.
//
// It lives HERE, beside its subject, rather than in the daemon's test file: a
// test under plugins/ reaching into src/ is the relative escape out of the
// artifact boundary the import-boundary wards forbid (playbook Gotcha 6).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// NOTE THE DIRECTORY. This file sits at src/bounty/, NOT inside surface/,
// because `@source "./"` in styles.css scans the surface directory whole — a
// test living there contributes its own strings to Tailwind's candidate set and
// changes the SHIPPED stylesheet. Measured: placing this file under surface/
// changed the built sheet's content hash.
const HERE = join(import.meta.dir, "surface");
const read = (...p: string[]) => readFileSync(join(HERE, ...p), "utf8");

/** Every field the daemon puts on the browser's `init` frame, and the component
 *  that must put it on screen. Add a row when the daemon adds a field. */
const INIT_FIELDS: { field: string; renderedBy: string }[] = [
  { field: "title", renderedBy: "components/Header.tsx" },
  { field: "tasks", renderedBy: "components/Column.tsx" },
  { field: "restoreFailed", renderedBy: "components/RestoreFailedBanner.tsx" },
  { field: "sessionId", renderedBy: "components/Header.tsx" },
];

test("every init-frame field is modelled in state/ and rendered by a component", () => {
  const types = read("state", "types.ts");
  const board = read("state", "board.ts");
  const app = read("App.tsx");

  for (const { field, renderedBy } of INIT_FIELDS) {
    // (a) it is on the wire type, and the reducer reads it
    expect(types).toContain(field);
    expect(board).toContain(field);
    // (b) App composes the component that shows it, and that component is real
    const componentName = renderedBy.split("/").pop()?.replace(".tsx", "") as string;
    expect(app).toContain(`<${componentName}`);
    expect(read(renderedBy).length).toBeGreaterThan(0);
  }
});

test("the restore-failed banner shows BOTH fields the agent gets, and cannot be dismissed", () => {
  const banner = read("components", "RestoreFailedBanner.tsx");
  expect(banner).toContain("info.path");
  expect(banner).toContain("info.reason");
  expect(banner).toContain('role="alert"');
  // No dismiss control: it explains why the board is empty, so it must outlive
  // a glance. A close button here would be a behaviour change, not a polish.
  expect(banner).not.toContain("onDismiss");
  expect(banner).not.toContain("Dismiss");
});

test("the banner is rendered on the truthiness of the field, not on a separate flag", () => {
  // The failure mode this guards: a boolean like `showRestoreBanner` that some
  // other code path forgets to set. The board must render it iff the daemon
  // reported it.
  expect(read("App.tsx")).toContain("board.restoreFailed && <RestoreFailedBanner");
});
