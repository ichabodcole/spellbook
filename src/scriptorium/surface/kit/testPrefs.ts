// Test support for the kit page's tests: the daemon's prefs, written before the
// daemon starts, where the kit path keeps them (`$SCRIPTORIUM_HOME/kit/prefs.json`,
// beside `kit/sessions`). Imported by tests only.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Seed the prefs under `home` (the test's SCRIPTORIUM_HOME). The page opens a
 * document rendered on first use, as the shipped app does; a file whose tests
 * type into the raw editor seeds `{ "doc:view": "raw" }` here, so each test
 * starts there without a click.
 */
export function seedPrefs(home: string, prefs: Record<string, string>): void {
  mkdirSync(join(home, "kit"), { recursive: true });
  writeFileSync(join(home, "kit", "prefs.json"), `${JSON.stringify(prefs, null, 2)}\n`);
}

/**
 * Seed them again between tests, once the last page's writes have landed: a page
 * sends what is still in its debounce as it unmounts, and the daemon takes it a
 * moment later, so seeding at once would be written over. The daemon reads its
 * prefs fresh, so the next page's first snapshot carries the seed.
 */
export async function reseedPrefs(home: string, prefs: Record<string, string>): Promise<void> {
  await Bun.sleep(60);
  seedPrefs(home, prefs);
}

/** The prefs as the daemon keeps them on disk. */
export function keptPrefs(home: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(home, "kit", "prefs.json"), "utf8"));
  } catch {
    return {};
  }
}
