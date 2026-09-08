// The wire's nouns, as a COPY.
//
// Playbook R2: "wire types are a ~20-line copy in `state/types.ts` when the
// backend ships as source and shares nothing … they are an import from
// `shared/` only when a Phase 1 seam exists." Digestify has no seam and needs
// none — `scripts/review.ts` imports nothing outside its own folder (Contract 3
// row 1, re-measured 2026-09-07), and an import from `plugins/…/scripts/` would
// be a surface→backend reach the import-boundary wards forbid.
//
// `Payload` is the exact object `review.ts` JSON-stringifies into the page's
// `<script id="payload">` tag (review.ts 27–34, 432–435).

export type Question = { id: string; prompt: string };

export type Payload = {
  title: string;
  theme: string;
  markdown: string;
  questions: Question[];
  session_id: string;
  timeout_seconds: number;
};

export type ThemeName = "digestify" | "cthulhu" | "classic";

/** One stamp line on a question card. `small` renders the second, smaller line
 *  cthulhu uses ("Eldritch" over "knowledge"). */
export type StampLine = { text: string; small?: boolean };

/** The half of a theme that is NOT css: assets, brand text, button copy and the
 *  stamp. Every asset field may be the empty string, and classic's all are —
 *  the empty-string branches are behaviour, not a missing value. */
export type Theme = {
  logoSrc: string;
  brand: string;
  submit: string;
  submitting: string;
  mascotSrc: string;
  sentMascotSrc: string;
  stampLines: StampLine[];
};

/** A comment as the page holds it. `id` is client-only and is stripped both at
 *  persist and at submit (template.html 963, 1071, 1448). */
export type Comment = { id: string; anchor: string; text: string };

/** A comment as it crosses the wire and as it is persisted — no id. */
export type WireComment = { anchor: string; text: string };

export type Answers = Record<string, string>;

/** What `localStorage["digestify:<session id>"]` holds. */
export type DraftSnapshot = {
  answers: Answers;
  comments: WireComment[];
  savedAt: number;
};

/** The body of POST /submit. */
export type SubmitBody = { answers: Answers; comments: WireComment[] };

/** The body of the POST /left beacon (review.ts 380–397). */
export type DepartureBody = {
  /** The session this page was served with — see CancelBody. */
  sessionId: string;
  engaged: boolean;
  elapsedMs: number;
  answered: number;
  commented: number;
};

/** The body of the POST /cancel beacon.
 *
 *  `sessionId` names the session the departing page belongs to. The daemon
 *  ignores a beacon that names a DIFFERENT session, because port re-binding on
 *  recovery means a stale tab's departure can reach the daemon that replaced
 *  it. A beacon carrying no id at all is still honoured, so the route stays
 *  callable by hand. */
export type CancelBody = { sessionId: string };
