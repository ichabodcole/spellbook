// The flagged Scriptorium's shell storage over the daemon's prefs: debounced per
// key, read-your-own-write until the snapshot agrees, keys fitted to the daemon's
// rule, nothing sent after an end, and the view mode's shipped default.

import { describe, expect, test } from "bun:test";
import {
  LINE_NUMBERS_KEY,
  PREF_DEBOUNCE_MS,
  prefKey,
  prefsStorage,
  VIEW_MODE_KEY,
} from "./prefsStorage";

/** A daemon's prefs, with what the adapter wrote, in order. */
function fake(initial: Record<string, string> = {}) {
  const prefs: Record<string, string> = { ...initial };
  const writes: [string, string][] = [];
  let over = false;
  const storage = prefsStorage({
    read: () => prefs,
    write: (k, v) => writes.push([k, v]),
    ended: () => over,
    delayMs: 20,
  });
  return {
    prefs,
    writes,
    storage,
    end: () => {
      over = true;
    },
    /** The daemon took the writes and sent a snapshot with them. */
    land: () => {
      for (const [k, v] of writes) prefs[k] = v;
    },
  };
}
const pause = (ms = 40) => new Promise<void>((r) => setTimeout(r, ms));

describe("prefsStorage", () => {
  test("a burst on one key is one write, of the last value; each key has its own pause", async () => {
    const f = fake();
    // A held key: commits a few milliseconds apart, each inside the pause.
    for (let i = 0; i < 30; i++) {
      f.storage.setItem("panes:open", `{"context":${i}}`);
      await pause(1);
    }
    f.storage.setItem("tab", "notes");
    expect(f.writes).toEqual([]);
    await pause();
    expect(f.writes).toEqual([
      ["panes:open", '{"context":29}'],
      ["tab", "notes"],
    ]);
  });

  test("the page reads its own value until the snapshot agrees, then follows the prefs again", async () => {
    const f = fake({ theme: "dark" });
    f.storage.setItem("theme", "light");
    // Before the write is sent, and after it is sent but before the snapshot shows it.
    expect(f.storage.getItem("theme")).toBe("light");
    await pause();
    expect(f.writes).toEqual([["theme", "light"]]);
    expect(f.storage.getItem("theme")).toBe("light");
    f.land();
    expect(f.storage.getItem("theme")).toBe("light");
    // Another session's choice arrives with a later snapshot.
    f.prefs.theme = "dark";
    expect(f.storage.getItem("theme")).toBe("dark");
  });

  test("the layout library's key is shortened to fit the daemon's rule, and read back by the same name", async () => {
    const f = fake();
    const long = "react-resizable-panels:panes:context:centre:chat";
    expect(prefKey(long)).toBe("panes:panes:context:centre:chat");
    f.storage.setItem(long, '{"context":20,"centre":60,"chat":20}');
    await pause();
    expect(f.writes.map(([k]) => k)).toEqual(["panes:panes:context:centre:chat"]);
    f.land();
    expect(f.storage.getItem(long)).toBe('{"context":20,"centre":60,"chat":20}');
  });

  test("a key or value the daemon would refuse is kept for this page and never sent", async () => {
    const f = fake();
    f.storage.setItem("Upper", "x");
    f.storage.setItem("big", "x".repeat(4097));
    await pause();
    expect(f.writes).toEqual([]);
    expect(f.storage.getItem("Upper")).toBe("x");
    expect(f.storage.getItem("big")?.length).toBe(4097);
  });

  test("after an end nothing is sent, and the page keeps its choice to itself", async () => {
    const f = fake({ [VIEW_MODE_KEY]: "raw" });
    f.end();
    f.storage.setItem(VIEW_MODE_KEY, "split");
    await pause();
    f.storage.flush();
    expect(f.writes).toEqual([]);
    expect(f.storage.getItem(VIEW_MODE_KEY)).toBe("split");
  });

  test("a value the prefs already hold is not written again", async () => {
    const f = fake({ tab: "chat" });
    f.storage.setItem("tab", "chat");
    await pause();
    expect(f.writes).toEqual([]);
  });

  test("flush sends what is pending at once", () => {
    const f = fake();
    f.storage.setItem(LINE_NUMBERS_KEY, "on");
    f.storage.flush();
    expect(f.writes).toEqual([[LINE_NUMBERS_KEY, "on"]]);
    f.storage.flush();
    expect(f.writes.length).toBe(1);
  });

  test("the view mode opens rendered when none is kept, and a shipped compare reads as rendered", () => {
    expect(fake().storage.getItem(VIEW_MODE_KEY)).toBe("rendered");
    expect(fake({ [VIEW_MODE_KEY]: "compare" }).storage.getItem(VIEW_MODE_KEY)).toBe("rendered");
    expect(fake({ [VIEW_MODE_KEY]: "split" }).storage.getItem(VIEW_MODE_KEY)).toBe("split");
    expect(fake({ [VIEW_MODE_KEY]: "raw" }).storage.getItem(VIEW_MODE_KEY)).toBe("raw");
    // Any other key reads exactly what is kept, absent as null.
    expect(fake().storage.getItem(LINE_NUMBERS_KEY)).toBeNull();
  });

  test("the default pause is the one the integration notes asked for", () => {
    expect(PREF_DEBOUNCE_MS).toBe(250);
  });
});
