// The page's side of the native picker and of the copy's look-before-writing:
// `pickPaths` reads the daemon's `chosen` answer, and `fileAlreadyAt` asks
// `fs.same` with the hash of the file's BYTES (never its name), in the folder
// chosen, under the file's own name.
import { describe, expect, test } from "bun:test";
import { type Daemon, fileAlreadyAt, pickPaths, type ServerFrame } from "./daemonClient.ts";

/** A `request` that records what it was sent and answers with `reply`. */
function fakeRequest(reply: (op: Record<string, unknown>) => ServerFrame) {
  const sent: Record<string, unknown>[] = [];
  const request = (async (op: Record<string, unknown>) => {
    sent.push(op);
    return reply(op);
  }) as unknown as Daemon["request"];
  return { sent, request };
}

const hex = (bytes: string | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

describe("fileAlreadyAt", () => {
  test("asks fs.same with the folder, the file's name, its size and the SHA-256 of its bytes", async () => {
    const r = fakeRequest(() => ({ op: "fs.same", exists: true, same: true }) as ServerFrame);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    const at = await fileAlreadyAt(r.request, "/h/world", new File([bytes], "fox.png"));
    expect(at).toEqual({ exists: true, same: true });
    expect(r.sent).toEqual([
      { op: "fs.same", dir: "/h/world", name: "fox.png", size: 8, sha256: hex(bytes) },
    ]);
    // Two files of one name and different bytes are asked about by different hashes.
    await fileAlreadyAt(r.request, "/h/world", new File(["other"], "fox.png"));
    expect(r.sent[1]?.sha256).toBe(hex("other"));
    expect(r.sent[1]?.sha256).not.toBe(r.sent[0]?.sha256);
    expect(r.sent[1]?.sha256).not.toBe(hex("fox.png"));
  });

  test("a reply that is not fs.same is an error, not a guess", async () => {
    const r = fakeRequest(() => ({ op: "state" }) as unknown as ServerFrame);
    await expect(fileAlreadyAt(r.request, "/h", new File(["x"], "x.md"))).rejects.toThrow();
  });
});

describe("pickPaths", () => {
  test("sends the want and reads the paths of the chosen answer", async () => {
    const r = fakeRequest(
      () => ({ op: "chosen", paths: ["/h/a"], cancelled: false }) as ServerFrame,
    );
    expect(await pickPaths(r.request, "choose-folder")).toEqual(["/h/a"]);
    expect(r.sent).toEqual([{ op: "pick", want: "choose-folder" }]);
  });
});
