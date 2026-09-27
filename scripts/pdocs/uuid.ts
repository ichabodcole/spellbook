// UUIDv7 — the `id` `pdocs` writes on a work item.
//
// Version 7 rather than 4 because its first 48 bits are the creation time in
// milliseconds: ids sort in the order the items were filed, which is what a
// backlog wants when nothing else orders it. No dependency — sixteen bytes and
// two bit masks (RFC 9562 §5.7).

/** A UUID, lowercase and hyphenated — the one form `pdocs` writes and compares.
 *  Any version: an id written by another tool (a v4) is still an id. */
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

const RAND_BITS = 74n;
const RAND_MAX = (1n << RAND_BITS) - 1n;

/** Ten random bytes as the 74 random bits of a UUIDv7 (version and variant
 *  bits masked out). */
function randomBits(bytes: Uint8Array): bigint {
  let r = BigInt((bytes[0] as number) & 0x0f); // rand_a, top 4 bits
  r = (r << 8n) | BigInt(bytes[1] as number); // rand_a, low 8 bits
  r = (r << 6n) | BigInt((bytes[2] as number) & 0x3f); // rand_b, top 6 bits
  for (let i = 3; i < 10; i++) r = (r << 8n) | BigInt(bytes[i] as number);
  return r;
}

/** The string for a 48-bit millisecond timestamp and 74 random bits. */
function encode(ms: number, r: bigint): string {
  const b = new Uint8Array(16);
  // 48-bit big-endian milliseconds. Division, not shifts: JS shifts are 32-bit.
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  const randA = Number(r >> 62n); // 12 bits
  b[6] = 0x70 | (randA >> 8); // version 7
  b[7] = randA & 0xff;
  let randB = r & ((1n << 62n) - 1n);
  for (let i = 15; i >= 9; i--) {
    b[i] = Number(randB & 0xffn);
    randB >>= 8n;
  }
  b[8] = 0x80 | Number(randB & 0x3fn); // variant 10
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The last id this process minted without pinned randomness. */
let last: { ms: number; r: bigint } | null = null;

/**
 * A UUIDv7. `now` and `random` are parameters so a test can pin the output;
 * callers pass neither. `random` supplies the 74 random bits (ten bytes, the
 * version and variant bits masked over).
 *
 * MONOTONIC within a process (RFC 9562 §6.2, method 2): without pinned
 * `random`, an id minted in the same millisecond as the last one — or after
 * the clock stepped back — reuses the last timestamp and adds one to the last
 * random bits, so ids sort in the order they were filed even inside one
 * millisecond. A fresh millisecond draws fresh bits with the top one clear,
 * leaving room to increment. With `random` given, the output is exactly the
 * inputs.
 */
export function uuidv7(now: number = Date.now(), random?: Uint8Array): string {
  if (!Number.isInteger(now) || now < 0 || now >= 2 ** 48)
    throw new RangeError(`uuidv7: timestamp ${now} does not fit in 48 bits`);
  if (random !== undefined) {
    if (random.length < 10) throw new RangeError("uuidv7: needs ten random bytes");
    return encode(now, randomBits(random));
  }

  const fresh = () => randomBits(crypto.getRandomValues(new Uint8Array(10))) >> 1n;
  let ms = now;
  let r: bigint;
  if (last !== null && ms <= last.ms) {
    ms = last.ms;
    r = last.r + 1n;
    if (r > RAND_MAX) {
      // Out of room in this millisecond: borrow the next one.
      ms += 1;
      r = fresh();
    }
  } else r = fresh();
  last = { ms, r };
  return encode(ms, r);
}
