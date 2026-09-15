import type { Answers, Comment, DraftSnapshot, WireComment } from "./types";

/** ⛔ STORAGE IS INJECTED, NOT REACHED FOR.
 *
 *  Playbook R2: the persistence rules run under `bun test` against a Map. Every
 *  one of the five silent branches below (L4, L5, L7, L12, L13 in the behaviour
 *  inventory) is a `catch {}` whose whole observable is that nothing happens —
 *  and a stubbed global that throws proves the stub works, not the code. This
 *  interface is deliberately narrower than `Storage`: `keys()` is what the
 *  prune sweep needs and `Object.keys(localStorage)` is what the old page used. */
export interface DraftStorage {
  keys(): string[];
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** The real one. Every method may throw — private browsing, quota, a policy
 *  that disables storage entirely — and every CALLER below is what swallows it. */
export const browserStorage: DraftStorage = {
  keys: () => Object.keys(localStorage),
  get: (k) => localStorage.getItem(k),
  set: (k, v) => {
    localStorage.setItem(k, v);
  },
  remove: (k) => {
    localStorage.removeItem(k);
  },
};

export const KEY_PREFIX = "digestify:";
/** Seven days (template.html 983). */
export const LS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The draft key for a session. Origin-scoped by the browser, and the origin
 *  includes the PORT — which is why an auto-generated session id carries its
 *  bound port and why a relaunch rebinds it (review.ts 255–258). */
export const draftKey = (sessionId: string): string => KEY_PREFIX + sessionId;

/**
 * Drop every `digestify:` draft older than the TTL, so a user's storage does
 * not accumulate across sessions. A value that will not parse is REMOVED, not
 * skipped (template.html 995–997) — the inner catch is a repair, the outer one
 * is "storage is unavailable and the page still works".
 */
export function pruneDrafts(storage: DraftStorage, now: number): void {
  try {
    for (const k of storage.keys()) {
      if (!k.startsWith(KEY_PREFIX)) continue;
      try {
        const v = JSON.parse(storage.get(k) || "{}") as Partial<DraftSnapshot>;
        if (!v.savedAt || now - v.savedAt > LS_TTL_MS) storage.remove(k);
      } catch {
        storage.remove(k);
      }
    }
  } catch {
    // localStorage may be disabled (private browsing, quota, policy) — recovery
    // is best-effort and the rest of the page still works.
  }
}

/** The snapshot for this session, or null. A corrupt, unparseable, undated or
 *  expired snapshot all read the same way: null, silently. */
export function loadSnapshot(
  storage: DraftStorage,
  key: string,
  now: number,
): DraftSnapshot | null {
  try {
    const raw = storage.get(key);
    if (!raw) return null;
    const snap = JSON.parse(raw) as DraftSnapshot | null;
    if (snap?.savedAt && now - snap.savedAt <= LS_TTL_MS) return snap;
  } catch {
    // unparseable — boot clean
  }
  return null;
}

/** Best-effort write. Called on EVERY input event, not on a debounce. */
export function saveSnapshot(
  storage: DraftStorage,
  key: string,
  answers: Answers,
  comments: WireComment[],
  now: number,
): void {
  try {
    storage.set(key, JSON.stringify({ answers, comments, savedAt: now }));
  } catch {
    // quota / disabled storage — best-effort
  }
}

/** Best-effort removal, on a successful submit. */
export function clearSnapshot(storage: DraftStorage, key: string): void {
  try {
    storage.remove(key);
  } catch {
    // same as saveSnapshot: never break the sent screen over storage
  }
}

/**
 * Only restore answers whose question id STILL EXISTS in the current payload.
 * If the agent rewrote the markdown between recovery attempts, stale ids would
 * otherwise leak into the submit payload and confuse the agent on the receiving
 * end (template.html 1022–1029).
 */
export function restoreAnswers(
  snapshot: DraftSnapshot | null,
  questionIds: ReadonlySet<string>,
): Answers {
  const out: Answers = {};
  for (const [k, v] of Object.entries(snapshot?.answers ?? {})) {
    if (questionIds.has(k)) out[k] = v;
  }
  return out;
}

/** Restore comments, dropping any without BOTH an anchor and a text, and
 *  re-minting ids `c1…cN` — the persisted form carries none. */
export function restoreComments(snapshot: DraftSnapshot | null): Comment[] {
  const out: Comment[] = [];
  for (const c of snapshot?.comments ?? []) {
    if (c?.anchor && c.text) out.push({ id: `c${out.length + 1}`, anchor: c.anchor, text: c.text });
  }
  return out;
}
