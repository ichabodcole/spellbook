// Shared scaffolding for the workspace tests: a declared app, and a session
// over a temp folder. Not exported from the subpath, and not shipped.

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { BundleReference, BundleType } from "../lib/bundles.ts";
import { type AppDeclaration, SessionError, WorkspaceSession } from "./session";

/**
 * A small app for the tests. Its slot is at version 2: a version 1 slot held
 * `items` as a number, and `migrate` turns that into the list version 2 keeps.
 */
export const testApp: AppDeclaration = {
  name: "kit-test",
  slot: {
    version: 2,
    migrate(prev, prevVersion) {
      if (prevVersion === 0) return { renders: [] };
      if (prevVersion === 1) return { ...prev, renders: [], migrated: true };
      return prev;
    },
  },
};

/**
 * A bundle type of the tests' own, shaped like Atlas's canvas but named for
 * no app: the kit's tests register it, and `registerBundleType` is idempotent.
 */
export const TEST_BUNDLE: BundleType = {
  extension: ".boardbundle",
  type: "board",
  main: "board.board",
  format: "json",
  label: "board",
  mainTemplate: '{"nodes":[],"edges":[]}\n',
};

/**
 * A bundle type of the tests' own whose main file references other files,
 * to drive the link layer's references seam with no app: `pins.json` holds
 * one pin per line, `{"id":"p1","file":"places/glade.md","note":"…"}`, with
 * an optional `subpath`. A `./` path is the bundle's own; any other is read
 * from the entry's root, then from the folder the bundle sits in, and is
 * written from the entry's root.
 */
export const PIN_BUNDLE: BundleType = {
  extension: ".pinbundle",
  type: "pins",
  main: "pins.json",
  format: "json",
  label: "pin board",
  mainTemplate: '{"pins":[\n]}\n',
  references: {
    noun: "pin board",
    part: "pin",
    read(text) {
      const out: BundleReference[] = [];
      let at = 0;
      text.split("\n").forEach((line, i) => {
        const from = at;
        at += line.length + 1;
        const m = /^\s*(\{.*\})\s*,?\s*$/.exec(line);
        if (!m) return;
        let pin: unknown;
        try {
          pin = JSON.parse(m[1] as string);
        } catch {
          return;
        }
        const p = pin as { id?: unknown; file?: unknown; note?: unknown; subpath?: unknown };
        if (typeof p.id !== "string" || typeof p.file !== "string") return;
        out.push({
          raw: p.file,
          line: i + 1,
          from,
          to: from + line.length,
          id: p.id,
          ...(typeof p.note === "string" ? { label: p.note } : {}),
          ...(typeof p.subpath === "string" ? { subpath: p.subpath } : {}),
        });
      });
      return out;
    },
    candidates(raw, at) {
      if (raw.startsWith("./")) return [join(at.bundle, raw.slice(2))];
      return [join(at.entryRoot, raw), join(dirname(at.bundle), raw)];
    },
    write(to, at) {
      if (to.startsWith(`${at.bundle}/`)) return `./${relative(at.bundle, to)}`;
      if (!to.startsWith(`${at.entryRoot}/`)) return null;
      return relative(at.entryRoot, to);
    },
    swap(text, swap) {
      let count = 0;
      const lines = text.split("\n").map((line) => {
        const m = /^(\s*)(\{.*\})(\s*,?\s*)$/.exec(line);
        if (!m) return line;
        let pin: Record<string, unknown>;
        try {
          pin = JSON.parse(m[2] as string) as Record<string, unknown>;
        } catch {
          return line;
        }
        if (typeof pin.file !== "string") return line;
        const to = swap(pin.file);
        if (to === undefined || to === pin.file) return line;
        count++;
        return `${m[1]}${JSON.stringify({ ...pin, file: to })}${m[3]}`;
      });
      return { text: lines.join("\n"), count };
    },
  },
};

/** A pin board's text: one pin per line. */
export function pinsText(pins: Record<string, unknown>[]): string {
  return `{"pins":[\n${pins.map((p) => JSON.stringify(p)).join(",\n")}\n]}\n`;
}

/** Write a pin board by hand, with its pins. */
export function writePinBoard(dir: string, name: string, pins: Record<string, unknown>[]): string {
  const abs = join(dir, `${name}${PIN_BUNDLE.extension}`);
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, "info.json"), `${JSON.stringify({ title: name }, null, 2)}\n`);
  writeFileSync(join(abs, PIN_BUNDLE.main), pinsText(pins));
  return abs;
}

/** Write a bundle of the test type by hand, as an agent or another app would. */
export function writeBundle(
  dir: string,
  name: string,
  info: Record<string, unknown> | null,
  main = '{"nodes":[{"id":"a","type":"text","text":"lantern"}],"edges":[]}\n',
): string {
  const abs = join(dir, `${name}${TEST_BUNDLE.extension}`);
  mkdirSync(join(abs, "assets"), { recursive: true });
  if (info) writeFileSync(join(abs, "info.json"), `${JSON.stringify(info, null, 2)}\n`);
  writeFileSync(join(abs, TEST_BUNDLE.main), main);
  writeFileSync(join(abs, "assets", "fox.png"), "not really a png");
  return abs;
}

/**
 * An expandable bundle type of the tests' own, shaped like a stage: its
 * documents in a `docs/` member folder, and files of its own beside them
 * (`audio/`, written by the type, never by a structure act). Its `validate`
 * warns of every file at the top that is neither its main file nor
 * `info.json`.
 */
export const SHELF_BUNDLE: BundleType = {
  extension: ".shelfbundle",
  type: "shelf",
  main: "shelf.json",
  format: "json",
  label: "shelf",
  mainTemplate: '{"order":[]}\n',
  expand: {
    members: ["docs"],
    validate: (listing) =>
      listing.files
        .filter((f) => !f.includes("/") && f !== "shelf.json" && f !== "info.json")
        .map((f) => ({ message: `${f} is not where a shelf keeps anything`, path: f })),
  },
};

/**
 * Write a shelf by hand: `info.json`, `shelf.json`, two documents in `docs/`
 * and a render with its record in `audio/01-arrival/`. Returns its folder.
 */
export function writeShelf(dir: string, name: string, title?: string): string {
  const abs = join(dir, `${name}${SHELF_BUNDLE.extension}`);
  mkdirSync(join(abs, "docs"), { recursive: true });
  mkdirSync(join(abs, "audio", "01-arrival"), { recursive: true });
  writeFileSync(
    join(abs, "info.json"),
    `${JSON.stringify({ version: 1, type: "shelf", title: title ?? name }, null, 2)}\n`,
  );
  writeFileSync(
    join(abs, SHELF_BUNDLE.main),
    '{"order":[{"doc":"docs/01-arrival.md"},{"doc":"docs/02-the-keeper.md"}]}\n',
  );
  writeFileSync(join(abs, "docs", "01-arrival.md"), "# Arrival\n\nThe boat came in at dusk.\n");
  writeFileSync(join(abs, "docs", "02-the-keeper.md"), "# The keeper\n\nShe kept the light.\n");
  writeFileSync(join(abs, "audio", "01-arrival", "take.mp3"), "not really an mp3");
  writeFileSync(join(abs, "audio", "01-arrival", "take.json"), '{"voice":"a"}\n');
  return abs;
}

/** A temp root, with `realpath` applied: macOS's tmpdir is a symlink, and paths are compared exactly as written. */
export function tempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
}

/** The documents every workspace test starts from, under `<root>/docs`. */
export function seedDocs(root: string): string {
  const docs = join(root, "docs");
  mkdirSync(join(docs, "set", "part"), { recursive: true });
  writeFileSync(join(docs, "set", "a.md"), "# A\n\none\n");
  writeFileSync(join(docs, "set", "part", "b.md"), "# B\n");
  writeFileSync(join(docs, "set", "skip.png"), "not a doc");
  writeFileSync(join(docs, "solo.md"), "# Solo\n");
  writeFileSync(join(docs, "sibling.md"), "# Sibling\n");
  return docs;
}

/** Run `fn` and return the `SessionError` it must throw. */
export function refusal(fn: () => unknown): SessionError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SessionError) return e;
    throw e;
  }
  throw new Error("expected a SessionError");
}

/** A session whose context is the whole docs folder, so any document in it may be opened. */
export function inContext(sessions: string, docs: string): WorkspaceSession {
  const s = WorkspaceSession.create(sessions, testApp);
  s.addContext(docs);
  return s;
}
