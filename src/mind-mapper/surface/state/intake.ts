// P2.1 — intake (plan/circe.md P2.1), the imago/glamour fileIntake shape
// (surface/state/fileIntake.ts in imago) ported to documents instead of
// images: three entry points converging on one wire call, matching the
// intake contract (ratified vine msg 4).
//
// Wire confirmed against the real POST /ingest (server.ts, commit 9695611,
// vine msg 25) — NOT the shape first guessed at msg 23: JSON body is
// `{title, text}` (not `content`), multipart fields are `title` + `file`
// only. R4 K1 killed the ingest kind defaults ("story"/"ramble" are dead):
// a fresh doc is UNTYPED (kind null, no badge) until someone asserts a kind
// via `doc kind` / POST /doc/:id/kind — the old flagged-not-blocking note
// about default tags is resolved by that honesty, not by a kind param here.

export type IngestJsonPost = (body: { title: string; text: string }) => Promise<void>;
export type IngestFilePost = (form: FormData) => Promise<void>;

const TEXT = /\.(md|txt|markdown)$/i;

// "hollowbrook-notes_v2.md" -> "hollowbrook notes v2" — pure, no DOM. Used
// as the doc title when a dropped file carries no explicit title of its own.
export function titleFromFilename(name: string): string {
  const stem = name.replace(/\.[^./\\]+$/, "");
  return stem.replace(/[-_]+/g, " ").trim();
}

// Drag/drop or file-pick intake, one doc per dropped file. Non-text files are
// skipped (mind-mapper docs are markdown/text per Claim B — there's no image
// intake here, unlike imago's). A file that fails to read degrades silently
// per-file rather than aborting the whole drop.
export async function ingestFiles(files: FileList | null, post: IngestFilePost): Promise<void> {
  for (const f of Array.from(files ?? [])) {
    if (!TEXT.test(f.name) && f.type && !f.type.startsWith("text/")) continue;
    try {
      const form = new FormData();
      form.set("title", titleFromFilename(f.name));
      form.set("file", f, f.name);
      await post(form);
    } catch (err) {
      console.error("mind-mapper: failed to ingest file", f.name, err);
    }
  }
}

// Brain-dump textarea intake.
export async function ingestText(title: string, text: string, post: IngestJsonPost): Promise<void> {
  const t = title.trim();
  if (!t || !text.trim()) return;
  await post({ title: t, text });
}

// "+ new document" intake — an empty doc (see the wire note above re: its
// tagged kind until the server supports an override).
export async function ingestBlank(title: string, post: IngestJsonPost): Promise<void> {
  const t = title.trim();
  if (!t) return;
  await post({ title: t, text: "" });
}
