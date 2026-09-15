// ⛔ DOES THE DEPARTURE STILL REACH THE AGENT?
//
// The successor to `surface departure beacon (b4s)` in
// src/digestify/backend/review.test.ts (authored at
// plugins/spellbook/skills/digestify/scripts/review.test.ts until the Phase 5
// backend port relocated it), which text-searched
// the served <script> block for `"/left"` and `engaged: dirty`. The block is
// gone; the behaviour is not, and it is the one thing on this page whose only
// consumer is the AGENT rather than the human — so nothing on screen would look
// wrong if it were lost.
//
// What it protects, in the daemon's own words (the `POST /left` handler's own
// comment block — named by ROUTE rather than by line, because a line number is
// the wrong pin and the Phase 5 relocation moved every one of them): without the
// /left beacon, "a human opened it, read it and declined", "nobody ever opened
// it", "the tab crashed" and "they walked away" are ONE observable through a
// pipe — all four exit 124 with an empty stdout. /left is what separates them.
//
// It lives at src/digestify/, NOT inside surface/ (`@source "./"` scans that
// directory whole and a test there would change the shipped stylesheet), and
// not under plugins/ (a test there reaching into src/ is the relative escape
// out of the artifact boundary the import-boundary wards forbid — Gotcha 6).
//
// A presence check, NOT proof the beacon fires. Whether `beforeunload`
// dispatches is browser-only and stays so — behaviour inventory rows B1-B8.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const HOOK = readFileSync(join(import.meta.dir, "surface", "state", "useReview.ts"), "utf8");

describe("the departure beacons", () => {
  test("/left is beaconed, and it is beaconed BEFORE /cancel", () => {
    const left = HOOK.indexOf('"/left"');
    const cancel = HOOK.indexOf('"/cancel"');
    expect(left).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(-1);
    // Order in the source is the order in the handler; the record must be
    // queued first, because /cancel is what tears the session down.
    expect(left).toBeLessThan(cancel);
  });

  test("/left carries all four facts the daemon's envelope reports", () => {
    // review.ts's Departure type: engaged, elapsedMs, answered, commented. A
    // field dropped here becomes a `null` in the agent's envelope, which the
    // daemon documents as "the beacon arrived malformed" — a lie.
    for (const field of ["engaged:", "elapsedMs:", "answered:", "commented:"]) {
      expect(`${field} ${HOOK.includes(field)}`).toBe(`${field} true`);
    }
    expect(HOOK).toContain("dirty.current");
  });

  test("/cancel is gated on `dirty`, and /left is NOT", () => {
    // house-style pins exit 130 to "closed the tab AFTER interacting", so the
    // dirty gate on /cancel is canon, not incidental: a refresh of a clean page
    // must not end the session. /left has no gate at all — a departure is
    // reported whether the human engaged or not.
    const cancelBlock = HOOK.slice(HOOK.indexOf("if (dirty.current)"));
    expect(cancelBlock).toContain('"/cancel"');
    const leftBlock = HOOK.slice(HOOK.indexOf('"/left"'), HOOK.indexOf("if (dirty.current)"));
    expect(leftBlock).not.toContain("if (dirty");
  });

  test("a submitted review reports nothing, and a page with no sendBeacon reports nothing", () => {
    expect(HOOK).toContain("if (submittedRef.current || !navigator.sendBeacon) return;");
  });

  test("`dirty` is set in exactly one place — markActivity", () => {
    const writes = [...HOOK.matchAll(/dirty\.current\s*=/g)];
    expect(writes).toHaveLength(1);
    const before = HOOK.slice(0, writes[0]?.index ?? 0);
    expect(before.slice(before.lastIndexOf("const markActivity"))).toContain("markActivity");
  });
});
