// `sameFileAt`, the read behind `fs.same`: a matching size is hashed as a
// STREAM (never the whole file read at once), and a file over the cap is
// refused before anything is read.
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, ftruncateSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempRoot } from "./testing";
import { SAME_FILE_MAX_BYTES, sameFileAt } from "./tree";

const root = tempRoot("same-file");
afterAll(() => rmSync(root, { recursive: true, force: true }));
const hex = (b: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

describe("sameFileAt", () => {
  test("a matching size is hashed chunk by chunk from the stream it opens", async () => {
    const path = join(root, "a.md");
    const text = "abc".repeat(1000);
    writeFileSync(path, text);
    const opened: string[] = [];
    let chunks = 0;
    // The real file's stream, re-cut into small chunks and counted.
    const open = (p: string) => {
      opened.push(p);
      const bytes = new TextEncoder().encode(text);
      return new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < bytes.length; i += 1000) {
            chunks++;
            c.enqueue(bytes.slice(i, i + 1000));
          }
          c.close();
        },
      });
    };
    expect(await sameFileAt(path, text.length, hex(text), open)).toEqual({
      exists: true,
      same: true,
    });
    expect(opened).toEqual([path]);
    expect(chunks).toBe(3);
    // A different size is answered without opening the file at all.
    expect(await sameFileAt(path, 2, hex("ab"), open)).toEqual({ exists: true, same: false });
    expect(opened).toHaveLength(1);
    // And the default opener streams the real file to the same answer.
    expect(await sameFileAt(path, text.length, hex(text))).toEqual({ exists: true, same: true });
  });

  test("over the cap it is refused unread, even when the file is that big", async () => {
    const path = join(root, "huge.bin");
    // Sparse: as large as claimed on disk, with nothing written.
    const fd = openSync(path, "w");
    ftruncateSync(fd, SAME_FILE_MAX_BYTES + 1);
    closeSync(fd);
    let opened = 0;
    const open = (p: string) => {
      opened++;
      return Bun.file(p).stream();
    };
    await expect(sameFileAt(path, SAME_FILE_MAX_BYTES + 1, "0".repeat(64), open)).rejects.toThrow(
      /not compared/,
    );
    expect(opened).toBe(0);
  });
});
