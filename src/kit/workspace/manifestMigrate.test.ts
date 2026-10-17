// The whole-manifest migrate (`AppDeclaration.migrateManifest`): it runs before
// the format check and the foreign-manifest guard, lazily and per session; a
// refusal says why and writes nothing; a conversion is checked like any stored
// manifest, written once, and keeps what it replaced. Version files never move.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ManifestMigrateContext,
  type MigrateManifest,
  PRE_MIGRATE_FILE,
} from "./manifestMigrate";
import { type AppDeclaration, contentHash, WorkspaceSession } from "./session";
import { refusal, seedDocs, tempRoot, testApp } from "./testing";

let root: string;
let sessions: string;
let docs: string;

beforeEach(() => {
  root = tempRoot("workspace-manifest-migrate");
  sessions = join(root, "sessions");
  docs = seedDocs(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A foreign manifest: an old writer's shape the kit refuses as it stands. */
function plantOld(id: string, extra: Record<string, unknown> = {}): string {
  mkdirSync(join(sessions, id, "docs", "solo"), { recursive: true });
  writeFileSync(join(sessions, id, "docs", "solo", "v1.md"), "# Solo, as v1\n");
  const path = join(sessions, id, "manifest.json");
  writeFileSync(
    path,
    JSON.stringify({
      format: "old",
      sessionId: id,
      born: 1_791_971_430_501,
      lines: [{ id: "m-1", speaker: "human", said: "hello", at: 1_791_971_430_600 }],
      file: join(docs, "solo.md"),
      ...extra,
    }),
  );
  return path;
}

/** The kit manifest the old one converts to: one document, one message. */
function convertOld(raw: Record<string, unknown>, at: ManifestMigrateContext) {
  if (raw.format !== "old") return null;
  if (raw.broken) throw new Error("its `broken` field says so");
  const iso = (ms: unknown) => new Date(Number(ms)).toISOString();
  const lines = raw.lines as { id: string; speaker: string; said: string; at: number }[];
  return {
    manifest: {
      format: 1,
      sessionId: at.sessionId,
      appName: testApp.name,
      createdAt: iso(raw.born),
      workspace: join(at.dir, "imported"),
      context: [],
      docs: [
        {
          slug: "solo",
          name: "solo.md",
          original: raw.file,
          entryId: null,
          rel: null,
          ext: ".md",
          versions: [{ n: 1, by: "human", createdAt: iso(raw.born) }],
          active: 1,
          nextVersion: 2,
          notes: [],
          originalHash: contentHash(readFileSync(String(raw.file), "utf8")),
          admitted: false,
          outsideChanged: false,
        },
      ],
      openDoc: "solo",
      chat: lines.map((l) => ({
        id: l.id,
        from: l.speaker,
        type: "message",
        text: l.said,
        ts: iso(l.at),
      })),
      tasks: [],
      app: { version: 2, renders: [] },
    },
    note: "Converted from the old writer.",
  };
}

const migrating = (hook: MigrateManifest = convertOld): AppDeclaration => ({
  ...testApp,
  migrateManifest: hook,
});
const manifestOf = (id: string) =>
  JSON.parse(readFileSync(join(sessions, id, "manifest.json"), "utf8")) as Record<string, unknown>;

describe("a whole-manifest migrate", () => {
  test("runs before the format check: an old manifest restores, converted", () => {
    const path = plantOld("old-1");
    const before = readFileSync(path, "utf8");
    // Without the hook, the kit refuses it on its format.
    expect(refusal(() => WorkspaceSession.restore(sessions, testApp, "old-1")).message).toContain(
      "manifest format",
    );
    expect(readFileSync(path, "utf8")).toBe(before);

    const s = WorkspaceSession.restore(sessions, migrating(), "old-1");
    expect(s.messages().map((m) => [m.from, m.text])).toEqual([["human", "hello"]]);
    // Nothing else to settle: the conversion alone is why the manifest is written.
    expect(s.restoreReport.outside).toEqual([]);
    expect(s.restoreReport.manifestMigrated).toEqual({
      note: "Converted from the old writer.",
      kept: join(sessions, "old-1", PRE_MIGRATE_FILE),
    });
    // Written once, in the kit's shape; the original's bytes are kept beside it.
    const m = manifestOf("old-1");
    expect(m.format).toBe(1);
    expect(m.appName).toBe(testApp.name);
    expect(readFileSync(join(sessions, "old-1", PRE_MIGRATE_FILE), "utf8")).toBe(before);
  });

  test("the version files never move, and their bytes are unchanged", () => {
    plantOld("old-v");
    const v1 = join(sessions, "old-v", "docs", "solo", "v1.md");
    const s = WorkspaceSession.restore(sessions, migrating(), "old-v");
    expect(readFileSync(v1, "utf8")).toBe("# Solo, as v1\n");
    expect(readdirSync(join(sessions, "old-v", "docs", "solo"))).toEqual(["v1.md"]);
    expect(s.readVersion("solo", 1).text).toBe("# Solo, as v1\n");
  });

  test("a manifest it cannot convert is refused with its reason, and nothing is written", () => {
    const path = plantOld("old-x", { broken: true });
    const before = readFileSync(path, "utf8");
    const listing = readdirSync(join(sessions, "old-x")).sort();
    const e = refusal(() => WorkspaceSession.restore(sessions, migrating(), "old-x"));
    expect(e.status).toBe(409);
    expect(e.message).toContain("could not be converted for kit-test");
    expect(e.message).toContain("its `broken` field says so");
    expect(e.message).toContain("Nothing was changed");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(join(sessions, "old-x")).sort()).toEqual(listing);
  });

  test("what it returns is checked like a stored manifest: a bad conversion is refused, unwritten", () => {
    const path = plantOld("old-bad");
    const before = readFileSync(path, "utf8");
    const sloppy = (raw: Record<string, unknown>, at: ManifestMigrateContext) => {
      const out = convertOld(raw, at);
      if (out) out.manifest.tasks = "none" as unknown as [];
      return out;
    };
    const e = refusal(() => WorkspaceSession.restore(sessions, migrating(sloppy), "old-bad"));
    expect(e.status).toBe(409);
    expect(e.message).toContain("`tasks` is not a list");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(join(sessions, "old-bad"))).not.toContain(PRE_MIGRATE_FILE);
    // And one still in the old writer's shape is refused by the guard.
    const lazy = () => ({ manifest: { format: 1, sessionId: "old-bad", createdAt: 1 } });
    expect(
      refusal(() => WorkspaceSession.restore(sessions, migrating(lazy), "old-bad")).status,
    ).toBe(409);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("something that is not a manifest is refused", () => {
    plantOld("old-nil");
    for (const out of [{ manifest: null }, { manifest: [] }, { manifest: 3 }]) {
      const hook = () => out as unknown as { manifest: Record<string, unknown> };
      const e = refusal(() => WorkspaceSession.restore(sessions, migrating(hook), "old-nil"));
      expect(e.message).toContain("not a manifest");
    }
  });

  test("a hook that edits what it was given and then refuses leaves nothing behind", () => {
    const path = plantOld("old-edit");
    const before = readFileSync(path, "utf8");
    const editsThenThrows = (raw: Record<string, unknown>) => {
      raw.format = 1;
      throw new Error("changed my mind");
    };
    const e = refusal(() =>
      WorkspaceSession.restore(sessions, migrating(editsThenThrows), "old-edit"),
    );
    expect(e.message).toContain("changed my mind");
    expect(readFileSync(path, "utf8")).toBe(before);
    // Edited and then said "nothing to do": the restore reads what is stored,
    // not the hook's edit, so the old format is still refused.
    const editsThenNull = (raw: Record<string, unknown>) => {
      Object.assign(
        raw,
        convertOld(raw, { sessionId: "old-edit", dir: "", sessionsRoot: "" })?.manifest,
      );
      return null;
    };
    expect(
      refusal(() => WorkspaceSession.restore(sessions, migrating(editsThenNull), "old-edit"))
        .message,
    ).toContain("manifest format");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("lazy and per session: it sees only the session restored, with that session's folder", () => {
    plantOld("old-a");
    plantOld("old-b");
    const seen: ManifestMigrateContext[] = [];
    const hook = (raw: Record<string, unknown>, at: ManifestMigrateContext) => {
      seen.push(at);
      return convertOld(raw, at);
    };
    WorkspaceSession.restore(sessions, migrating(hook), "old-a");
    expect(seen).toEqual([
      { sessionId: "old-a", dir: join(sessions, "old-a"), sessionsRoot: sessions },
    ]);
    // The other session was not touched.
    expect(manifestOf("old-b").format).toBe("old");
    // A new session is never handed to it.
    WorkspaceSession.create(sessions, migrating(hook));
    expect(seen).toHaveLength(1);
  });

  test("null leaves a kit manifest as it is: nothing converted, nothing kept", () => {
    const s = WorkspaceSession.create(sessions, testApp);
    const path = join(s.dir, "manifest.json");
    const before = readFileSync(path, "utf8");
    const r = WorkspaceSession.restore(sessions, migrating(), s.id);
    expect(r.restoreReport.manifestMigrated).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readdirSync(s.dir)).not.toContain(PRE_MIGRATE_FILE);
  });

  test("a converted session restores again as the kit's own, and the original stays kept", () => {
    const path = plantOld("old-2");
    const original = readFileSync(path, "utf8");
    WorkspaceSession.restore(sessions, migrating(), "old-2");
    const again = WorkspaceSession.restore(sessions, migrating(), "old-2");
    expect(again.restoreReport.manifestMigrated).toBeUndefined();
    expect(again.messages().map((m) => m.text)).toEqual(["hello"]);
    expect(readFileSync(join(sessions, "old-2", PRE_MIGRATE_FILE), "utf8")).toBe(original);
  });

  test("an old manifest put back and used is converted again, and what it replaced is the copy kept", () => {
    const path = plantOld("old-3");
    WorkspaceSession.restore(sessions, migrating(), "old-3");
    // Someone put the old manifest back, and the old writer went on using it.
    const putBack = JSON.stringify({
      ...JSON.parse(readFileSync(join(sessions, "old-3", PRE_MIGRATE_FILE), "utf8")),
      lines: [{ id: "m-2", speaker: "human", said: "said since", at: 1_791_971_430_700 }],
    });
    writeFileSync(path, putBack);
    const s = WorkspaceSession.restore(sessions, migrating(), "old-3");
    expect(s.messages().map((m) => m.text)).toEqual(["said since"]);
    expect(readFileSync(join(sessions, "old-3", PRE_MIGRATE_FILE), "utf8")).toBe(putBack);
  });
});
