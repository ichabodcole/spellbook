// The open vocabularies a message carries: `via`, the gesture it came through,
// and a ref's `role`, what it is for. Each is free text checked against a list
// the kit starts and the app extends (`WorkspaceDaemonOptions.via` and
// `refRoles`). A value outside the list is stored as sent and answered with an
// advisory, never refused: a new button should not lose its message to a list
// nobody updated.

import type { MessageAbout } from "./protocol";

/**
 * The gestures the kit knows (the user, 2026-10-14): the composer (`chat`,
 * typed), and the kit's own buttons, each its own: "Ask the agent to describe"
 * an image (`describe`), "Ask the agent to fix" a profile warning (`fix`), and
 * "Ask the agent" about a note (`ask`, which the one-ask guard keys on with
 * `about.noteId`). An app builds one list from it,
 * `[...KIT_VIA, "pace"] as const`, passes it as `WorkspaceDaemonOptions.via`,
 * and derives its union type from the same list.
 */
export const KIT_VIA = ["chat", "describe", "fix", "ask"] as const;

/** What a ref is for, as the kit knows it. An app extends it in `WorkspaceDaemonOptions.refRoles`. */
export const KIT_REF_ROLES = ["reference"] as const;

/**
 * The most refs one message carries; past it they are dropped, and the
 * message's warning says how many. Story Studio's chip shows the same cap
 * (its `shell/messageRefs.ts`); this kit has no shell yet, and the panes'
 * cycle holds the two equal.
 */
export const MAX_REFS = 50;

/** The longest `via` stored: a gesture's name is a short word, and one longer is cut. */
export const VIA_MAX = 32;

/** A message's gesture: one without `via` predates the field, and came through the chat. */
export function messageVia(m: { via?: string }): string {
  return m.via ?? "chat";
}

/** A ref's role: none is `"reference"`. */
export function refRole(r: { role?: string }): string {
  return r.role ?? "reference";
}

/**
 * A `via` as stored: trimmed, and cut to `VIA_MAX` characters (`cut` says so).
 * Not a string, or empty, is none, which reads as `"chat"`.
 */
export function cleanVia(raw: unknown): { via: string | undefined; cut: boolean } {
  if (typeof raw !== "string") return { via: undefined, cut: false };
  const v = raw.trim();
  if (v === "") return { via: undefined, cut: false };
  return v.length > VIA_MAX ? { via: v.slice(0, VIA_MAX), cut: true } : { via: v, cut: false };
}

/**
 * The advisory for a `via` outside the list, or null when it is known (or
 * absent). `stored` says how it was kept: as sent, or cut to `VIA_MAX`.
 */
export function viaAdvisory(
  via: string | undefined,
  known: readonly string[],
  stored: "as sent" | "cut" = "as sent",
): string | null {
  if (via === undefined || known.includes(via)) return null;
  const how = stored === "cut" ? `cut to ${VIA_MAX} characters` : "as sent";
  return `via ${JSON.stringify(via)} is not one this app knows (${known.join(", ")}): the message was stored with it ${how}. Add it to the app's list (WorkspaceDaemonOptions.via) if it is real.`;
}

/** The advisory for ref roles outside the list, or null when every one is known. */
export function roleAdvisory(roles: readonly string[], known: readonly string[]): string | null {
  const unknown = [...new Set(roles.filter((r) => !known.includes(r)))];
  if (unknown.length === 0) return null;
  const named = unknown.map((r) => JSON.stringify(r)).join(", ");
  return `ref role ${named} is not one this app knows (${known.join(", ")}): the ref was stored with it as sent. Add it to the app's list (WorkspaceDaemonOptions.refRoles) if it is real.`;
}

/**
 * `about` keys the kit no longer writes but an old stored message may carry.
 * `entryIds` had no producer (no gesture sent it, no CLI verb took it) and was
 * removed (`kit-chat-about-chip`): kept reserved so an old message's value is
 * never read as an app's part.
 */
const RETIRED_ABOUT_KEYS = { entryIds: true } as const;

/** The kit's own `about` keys, which an app's part may not take. Every key, by type, and the retired ones. */
export const KIT_ABOUT_KEYS: ReadonlySet<string> = new Set<string>(
  Object.keys({
    doc: true,
    version: true,
    path: true,
    fromLine: true,
    toLine: true,
    text: true,
    docs: true,
    noteId: true,
    refs: true,
    ...RETIRED_ABOUT_KEYS,
  } satisfies Record<keyof MessageAbout | keyof typeof RETIRED_ABOUT_KEYS, true>),
);

/**
 * Names no app part may take, whatever the app says: `Object.prototype`'s own
 * (`__proto__`, `constructor`, `toString`, ...) and `prototype`. A part under
 * one would reach every reader of the stored message as a trap.
 */
export const RESERVED_PART_NAMES: ReadonlySet<string> = new Set<string>([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);

/** The most one app part may weigh, as JSON (UTF-8 bytes). Past it the part is dropped. */
export const APP_ABOUT_PART_MAX = 4 * 1024;
/** The most all of one message's app parts may weigh together, as JSON (UTF-8 bytes). */
export const APP_ABOUT_TOTAL_MAX = 16 * 1024;

/** An object literal's shape: its prototype is `Object.prototype` or none. Not an array, a string or a class instance. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** An app may name its part this: not a kit key, retired or not, and not a reserved name. */
const isAppPartName = (k: string): boolean => !KIT_ABOUT_KEYS.has(k) && !RESERVED_PART_NAMES.has(k);

/**
 * An `about`'s app parts, in the order it holds them: every key the kit does
 * not own and no reserved name, with a value. What the chip hands the app's
 * labeller. Anything but a plain object has none.
 */
export function appAboutParts(about: unknown): [string, unknown][] {
  if (!isPlainObject(about)) return [];
  return Object.entries(about).filter(([k, v]) => v !== undefined && isAppPartName(k));
}

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

/**
 * What an app's `hooks.messageAbout` gave, as the message keeps it: its parts
 * (`appAboutParts`), less each that JSON cannot carry (a BigInt, a cycle, a
 * function: it would make the message unstorable), each over
 * `APP_ABOUT_PART_MAX`, and, in order, each that would take the message past
 * `APP_ABOUT_TOTAL_MAX`. Each drop costs its part, never the message, and
 * `advice` says how many went and why, for the tail's `warning`.
 */
export function cleanAppAbout(given: unknown): { parts: [string, unknown][]; advice: string[] } {
  const parts: [string, unknown][] = [];
  let unserialisable = 0;
  let heavy = 0;
  let over = 0;
  let total = 0;
  for (const [k, v] of appAboutParts(given)) {
    let json: string | undefined;
    try {
      json = JSON.stringify(v);
    } catch {
      json = undefined;
    }
    if (json === undefined) {
      unserialisable++;
      continue;
    }
    const bytes = utf8Bytes(json);
    if (bytes > APP_ABOUT_PART_MAX) {
      heavy++;
      continue;
    }
    if (total + bytes > APP_ABOUT_TOTAL_MAX) {
      over++;
      continue;
    }
    total += bytes;
    // Stored as JSON reads it back, so what is kept is what a restore gives.
    parts.push([k, JSON.parse(json)]);
  }
  const n = (count: number) =>
    count === 1 ? "1 app about part was" : `${count} app about parts were`;
  const advice: string[] = [];
  if (unserialisable > 0)
    advice.push(`${n(unserialisable)} dropped: not JSON (a BigInt, a cycle, a function).`);
  if (heavy > 0) advice.push(`${n(heavy)} dropped: over ${APP_ABOUT_PART_MAX} bytes each.`);
  if (over > 0) advice.push(`${n(over)} dropped past ${APP_ABOUT_TOTAL_MAX} bytes in all.`);
  return { parts, advice };
}
