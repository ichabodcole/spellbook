// Unit tests for materializeSource — decode a data-URL → write the file, derive
// size + sha. No daemon; just the pure-ish server helper over a temp dir.

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeSource } from "../surface/state/source.server";

// a real 1×1 PNG (so Bun.Image.metadata() reads a genuine size)
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const DATA_URL = `data:image/png;base64,${PNG_1x1}`;

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "magpie-src-"));
}

test("materializeSource writes the file and derives an absolute path, size, sha", async () => {
  const dir = tmp();
  try {
    const source = await materializeSource(dir, "board.png", DATA_URL);
    expect(source.path).toBe(join(dir, "board.png"));
    expect(existsSync(source.path)).toBe(true);
    expect(source.size).toEqual([1, 1]);
    expect(source.sha).toHaveLength(16);
    expect(source.sha).toMatch(/^[0-9a-f]{16}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("materializeSource sanitizes a traversal-y name down to a basename", async () => {
  const dir = tmp();
  try {
    const source = await materializeSource(dir, "../../etc/evil.png", DATA_URL);
    expect(source.path).toBe(join(dir, "evil.png"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("materializeSource falls back to source.png for an empty/dotfile name", async () => {
  const dir = tmp();
  try {
    const source = await materializeSource(dir, "", DATA_URL);
    expect(source.path).toBe(join(dir, "source.png"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("materializeSource rejects an empty payload", async () => {
  const dir = tmp();
  try {
    await expect(materializeSource(dir, "x.png", "data:image/png;base64,")).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
