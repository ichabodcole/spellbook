import { useCallback, useEffect, useRef, useState } from "react";
import { commentId, removeComment, stripIds, updateCommentText } from "./comments";
import {
  browserStorage,
  clearSnapshot,
  type DraftStorage,
  draftKey,
  loadSnapshot,
  pruneDrafts,
  restoreAnswers,
  restoreComments,
  saveSnapshot,
} from "./draft";
import { shouldHeartbeat, type TimerState, timerLabel, timerState } from "./timer";
import type { Answers, Comment, Payload } from "./types";

/**
 * The one hook. R2's "touches one thing" bin: the clock, `fetch`,
 * `localStorage`, `sendBeacon`. Everything it decides is decided by the pure
 * modules beside it, which is where the tests are.
 *
 * ⛔ EVERY GUARD READS A REF, NEVER A RENDER'S CLOSURE. `submitted` and
 * `expired` gate `markActivity` and `extendDeadline`, and both are also
 * rendered — so they exist twice, as state for the view and as a ref for the
 * handlers. A handler that closed over the render's value would use whatever
 * was true when the listener was installed, which is the defect class that bit
 * bounty (two filter chips in one tick) and grapevine (a dropped focus). The
 * old imperative page could not have it: it mutated one closure variable.
 */
export function useReview(payload: Payload, storage: DraftStorage = browserStorage) {
  const sessionId = payload.session_id || "digestify-anon";
  // No clamping, deliberately. If the agent passed a short timeout the
  // displayed countdown must match the SERVER's deadline, or the session dies
  // while the timer still reads minutes (template.html 977-981).
  const timeoutSeconds = payload.timeout_seconds || 1800;
  const timeoutMs = timeoutSeconds * 1000;
  const key = draftKey(sessionId);

  // ── boot: prune, then restore ───────────────────────────────────────────────
  const boot = useRef<{ answers: Answers; comments: Comment[]; restored: boolean } | null>(null);
  if (boot.current === null) {
    const now = Date.now();
    pruneDrafts(storage, now);
    const snapshot = loadSnapshot(storage, key, now);
    const ids = new Set(payload.questions.map((q) => q.id));
    boot.current = {
      answers: restoreAnswers(snapshot, ids),
      comments: restoreComments(snapshot),
      restored: snapshot !== null,
    };
  }

  // Answers live in a REF and the textareas are uncontrolled, exactly as the old
  // page had them. Nothing on screen depends on an answer's value, so making
  // them state would re-render the whole document on every keystroke for no
  // observable gain and every observable risk.
  const answers = useRef<Answers>({ ...boot.current.answers });
  const [comments, setComments] = useState<Comment[]>(boot.current.comments);
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const seq = useRef(boot.current.comments.length);

  const dirty = useRef(false);
  const startedAt = useRef(Date.now());

  const [submitted, setSubmitted] = useState(false);
  const submittedRef = useRef(false);
  const [expired, setExpired] = useState(false);
  const expiredRef = useRef(false);
  const markExpired = useCallback(() => {
    expiredRef.current = true;
    setExpired(true);
  }, []);

  const deadlineAt = useRef(Date.now() + timeoutMs);
  const lastHeartbeatAt = useRef(0);
  const [remaining, setRemaining] = useState(timeoutMs);
  const [justReset, setJustReset] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const persist = useCallback(() => {
    saveSnapshot(storage, key, answers.current, stripIds(commentsRef.current), Date.now());
  }, [storage, key]);

  /** Every user edit funnels through here: draft persist, deadline reset, a
   *  rate-limited heartbeat, and the one flag that decides whether closing the
   *  tab cancels the session. */
  const markActivity = useCallback(() => {
    // Once the client-side timer has declared the session expired, stop firing
    // heartbeats — background typing in a doomed tab must not prolong a session
    // the user thinks is dead, or post to a server that has already exited.
    if (submittedRef.current || expiredRef.current) return;
    dirty.current = true;
    const now = Date.now();
    deadlineAt.current = now + timeoutMs;
    persist();
    if (shouldHeartbeat(now, lastHeartbeatAt.current)) {
      lastHeartbeatAt.current = now;
      // Silent by contract: the typing path never surfaces a dead server.
      fetch("/heartbeat", { method: "POST" }).catch(() => {});
    }
  }, [persist, timeoutMs]);

  const setAnswer = useCallback(
    (id: string, value: string) => {
      if (value.trim()) answers.current[id] = value;
      else delete answers.current[id];
      markActivity();
    },
    [markActivity],
  );

  const addComment = useCallback(
    (anchor: string, text: string): string => {
      seq.current += 1;
      const id = commentId(seq.current);
      setComments((cs) => [...cs, { id, anchor, text }]);
      commentsRef.current = [...commentsRef.current, { id, anchor, text }];
      markActivity();
      return id;
    },
    [markActivity],
  );

  const editComment = useCallback(
    (id: string, text: string) => {
      commentsRef.current = updateCommentText(commentsRef.current, id, text);
      setComments(commentsRef.current);
      markActivity();
    },
    [markActivity],
  );

  const deleteComment = useCallback(
    (id: string) => {
      commentsRef.current = removeComment(commentsRef.current, id);
      setComments(commentsRef.current);
      markActivity();
    },
    [markActivity],
  );

  // ── the countdown ───────────────────────────────────────────────────────────
  const tick = useCallback(() => {
    if (submittedRef.current) return;
    const left = deadlineAt.current - Date.now();
    setRemaining(left);
    if (left <= 0) markExpired();
  }, [markExpired]);

  useEffect(() => {
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [tick]);

  /** Clicking (or Entering / Spacing) the pill ALWAYS resets the deadline and
   *  forces a heartbeat, bypassing the 5 s rate limit so the server gets the
   *  bump even if a typing-driven heartbeat just fired. */
  const extendDeadline = useCallback(() => {
    if (submittedRef.current || expiredRef.current) return;
    const now = Date.now();
    deadlineAt.current = now + timeoutMs;
    lastHeartbeatAt.current = now;
    fetch("/heartbeat", { method: "POST" }).catch(() => {
      // Server unreachable — likely already exited. Don't leave the user
      // staring at a fresh-looking countdown for a session that is dead. This
      // is the ONE place a network failure is shown.
      markExpired();
      setRemaining(0);
    });
    tick();
    setJustReset(true);
    setTimeout(() => setJustReset(false), 450);
  }, [markExpired, tick, timeoutMs]);

  // ── submit ──────────────────────────────────────────────────────────────────
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submit = useCallback(async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: answers.current,
          comments: stripIds(commentsRef.current),
        }),
      });
      if (!res.ok) throw new Error("submit failed");
      submittedRef.current = true;
      clearSnapshot(storage, key);
      setSubmitted(true);
    } catch (err) {
      setSubmitting(false);
      setSubmitError(err instanceof Error ? err.message : String(err));
    }
  }, [storage, key]);

  const clearSubmitError = useCallback(() => setSubmitError(null), []);

  // ── departure ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const onBeforeUnload = () => {
      if (submittedRef.current || !navigator.sendBeacon) return;
      // ALWAYS report the departure as a FACT, engaged or not. Without it, "a
      // human opened it, read it and left" and "nobody ever opened it" are
      // byte-identical to the agent — both exit 124 with empty stdout. /left is
      // RECORD-ONLY on the server; it never resolves the session, which is what
      // lets a clean close be reported without a refresh being able to end one.
      // Sent BEFORE /cancel so the record is queued first.
      navigator.sendBeacon(
        "/left",
        new Blob(
          [
            JSON.stringify({
              // ⚠ NAMES THE SESSION THIS PAGE WAS SERVED WITH. Recovery
              // re-binds the port encoded in the session id, so a relaunched
              // review lands on the SAME origin — which is what hands it the
              // same localStorage draft. The cost is that a stale tab is still
              // pointed at that origin, and its departure beacons reach the
              // daemon that REPLACED it. The id is how the far end tells the
              // two apart.
              sessionId,
              engaged: dirty.current,
              elapsedMs: Date.now() - startedAt.current,
              answered: Object.keys(answers.current).length,
              commented: commentsRef.current.length,
            }),
          ],
          { type: "application/json" },
        ),
      );
      // UNCHANGED: only an ENGAGED close cancels. house-style's exit-code
      // contract defines 130 as "closed tab after interacting", so this gate is
      // canon, not an accident — refreshing a clean page must not exit.
      // --timeout stays the failsafe for true abandons.
      if (dirty.current) {
        // The body was empty until 2026-09-08. A stale tab closing after the
        // agent relaunched the review would beacon here, hit the NEW daemon on
        // the re-bound port, and end a session the user had just been given
        // back — exit 130, "closed without submitting", on a review they never
        // touched. The id makes the route's guarantee explicit instead of
        // positional: /cancel ends THIS session, not whoever holds the port.
        navigator.sendBeacon(
          "/cancel",
          new Blob([JSON.stringify({ sessionId })], { type: "application/json" }),
        );
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [sessionId]);

  const state: TimerState = timerState(remaining);
  return {
    sessionId,
    restored: boot.current.restored,
    initialAnswers: boot.current.answers,
    comments,
    submitted,
    submitting,
    submitError,
    clearSubmitError,
    expired,
    justReset,
    timerText: timerLabel(remaining),
    timerState: state,
    setAnswer,
    addComment,
    editComment,
    deleteComment,
    extendDeadline,
    submit,
  };
}
