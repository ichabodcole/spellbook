// The escape hatch's rule (`./hatch.ts`): `SCRIPTORIUM_SHIPPED=1` is the earlier
// Scriptorium, refused once any session in the home is in the kit's shape. The
// launcher-level drive (exit 2, the envelope, both entries) is in
// `./kit/kit.integration.test.ts`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceSession } from "../../kit/workspace/session";
import { kitShaped, kitShapedSessions, shippedHatchOn, shippedHatchRefusal } from "./hatch";
import { scriptoriumApp } from "./kit/app";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "scriptorium-hatch-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const shipped = (id: string) => ({
  format: 1,
  sessionId: id,
  createdAt: 1_757_000_000_000,
  context: [],
  docs: [],
  openDoc: null,
  chat: [],
});
const put = (id: string, manifest: unknown) => {
  mkdirSync(join(home, "sessions", id), { recursive: true });
  writeFileSync(
    join(home, "sessions", id, "manifest.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
};

describe("the hatch variable", () => {
  test("is exactly 1", () => {
    expect(shippedHatchOn({ SCRIPTORIUM_SHIPPED: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1"])
      expect([v, shippedHatchOn({ SCRIPTORIUM_SHIPPED: v })]).toEqual([v, false]);
  });
});

describe("the kit's shape, as the shipped reader refuses it", () => {
  test("appName, or a createdAt that is not a number", () => {
    expect(kitShaped(JSON.stringify(shipped("a")))).toBe(false);
    expect(kitShaped(JSON.stringify({ ...shipped("a"), appName: "scriptorium" }))).toBe(true);
    expect(kitShaped(JSON.stringify({ ...shipped("a"), createdAt: "2026-10-20T00:00:00Z" }))).toBe(
      true,
    );
  });

  test("an unreadable manifest is not counted", () => {
    for (const t of ["", "{", "null", "[]", "3"]) expect([t, kitShaped(t)]).toEqual([t, false]);
  });
});

describe("the refusal", () => {
  test("an empty home, or one with no sessions folder, is not refused", () => {
    expect(shippedHatchRefusal(home)).toBeNull();
    expect(shippedHatchRefusal(join(home, "not-there"))).toBeNull();
  });

  test("a home of shipped sessions only is not refused", () => {
    put("a", shipped("a"));
    put("b", shipped("b"));
    mkdirSync(join(home, "sessions", "no-manifest"));
    put("broken", "{ not json");
    expect(shippedHatchRefusal(home)).toBeNull();
  });

  test("one converted session closes it, and the refusal names it and says what to do", () => {
    put("a", shipped("a"));
    put("conv", { ...shipped("conv"), appName: "scriptorium", createdAt: "2026-10-20T00:00:00Z" });
    writeFileSync(
      join(home, "sessions", "conv", "manifest.pre-migrate.json"),
      JSON.stringify(shipped("conv")),
    );
    const r = shippedHatchRefusal(home);
    expect(r?.message).toContain("SCRIPTORIUM_SHIPPED=1 is closed: 1 session in");
    expect(r?.message).toContain("(e.g. conv)");
    expect(r?.hint).toContain("unset SCRIPTORIUM_SHIPPED");
    expect(r?.hint).toContain("manifest.pre-migrate.json");
  });

  test("a session started on the current Scriptorium closes it too, with no pre-migrate file", () => {
    put("a", shipped("a"));
    const s = WorkspaceSession.create(join(home, "sessions"), scriptoriumApp);
    expect(kitShapedSessions(home)).toEqual([s.id]);
    expect(shippedHatchRefusal(home)?.message).toContain(`(e.g. ${s.id})`);
  });

  test("counts every kit-shaped session", () => {
    put("k1", { ...shipped("k1"), appName: "scriptorium" });
    put("k2", { ...shipped("k2"), createdAt: "2026-10-20T00:00:00Z" });
    put("s", shipped("s"));
    expect(kitShapedSessions(home)).toEqual(["k1", "k2"]);
    expect(shippedHatchRefusal(home)?.message).toContain("2 sessions in");
  });
});
