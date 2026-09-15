// The open document's frontmatter, shown rather than dumped (E32).
//
// ⛔ WHAT THIS SPELL KNOWS BY NAME IS A SHORT LIST, AND EVERYTHING ELSE IS
// STILL SHOWN. `type`, `status`, `tags` and `lifecycle` get their own
// treatment because the corpora actually carry them; every other key —
// `hivemind_source_id`, `applied_to`, a field invented tomorrow — renders as a
// labelled value. The spec requires a consumer to preserve what it does not
// understand (OKF 0.2 §11), and a reader that hides an unknown field is
// discarding it as far as the human is concerned.
//
// Derived values (trust, staleness) are the daemon's, computed on read: they
// are claims ABOUT the document, so a file asserting its own trust tier would
// be asserting the wrong thing.
import { cn } from "cn";
import { AlertTriangleIcon, BadgeCheckIcon, ClockIcon, UserCheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { DocMeta } from "../../backend/protocol";

/** OKF's three, plus whatever a producer actually wrote. */
const STATUS_TONE: Record<string, string> = {
  draft: "bg-attention/15 text-attention",
  stable: "bg-rubric/12 text-rubric",
  deprecated: "bg-danger/15 text-danger",
};

const TRUST_LABEL = {
  unverified: "unverified",
  "machine-confirmed": "machine-confirmed",
  "human-reviewed": "human-reviewed",
} as const;

/** Keys the header shows in its own way; the rest fall through to "other fields". */
const NAMED = new Set(["type", "title", "description", "status", "tags", "lifecycle", "verified"]);

/** A value from arbitrary YAML, as one line of text. */
export function showValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map(showValue).join(", ");
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${showValue(v)}`)
      .join(" · ");
  return String(value);
}

function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function MetaHeader({ meta }: { meta: DocMeta }) {
  const others = Object.entries(meta.fields).filter(([k]) => !NAMED.has(k));
  return (
    <header
      data-slot="meta-header"
      className="mb-6 flex flex-col gap-2 border-b border-edge pb-4 text-sm"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {meta.type ? (
          <Chip className="bg-surface-raised text-ink">{meta.type}</Chip>
        ) : (
          <Chip className="bg-surface-raised text-ink-faint">no type</Chip>
        )}
        <Chip className={STATUS_TONE[meta.status] ?? "bg-surface-raised text-ink-dim"}>
          {meta.status}
        </Chip>
        {meta.lifecycle && <Chip className="bg-surface-raised text-ink-dim">{meta.lifecycle}</Chip>}
        <Chip className="bg-surface-raised text-ink-dim">
          {meta.trust === "human-reviewed" ? (
            <UserCheckIcon aria-hidden className="size-3" />
          ) : meta.trust === "machine-confirmed" ? (
            <BadgeCheckIcon aria-hidden className="size-3" />
          ) : null}
          {TRUST_LABEL[meta.trust]}
        </Chip>
        {meta.stale && (
          <Chip className="bg-attention/15 text-attention">
            <ClockIcon aria-hidden className="size-3" />
            stale
          </Chip>
        )}
        {meta.date && <span className="text-[11px] text-ink-faint">{meta.date}</span>}
      </div>

      {meta.description && <p className="text-ink-dim">{meta.description}</p>}

      {meta.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {meta.tags.map((t) => (
            <Chip key={t} className="bg-bg text-ink-dim ring-1 ring-edge">
              #{t}
            </Chip>
          ))}
        </div>
      )}

      {others.length > 0 && (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {others.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-ink-faint">{k}</dt>
              <dd className="min-w-0 break-words text-ink-dim">{showValue(v)}</dd>
            </div>
          ))}
        </dl>
      )}

      {meta.error && (
        <p className="flex items-start gap-1.5 rounded-md border border-attention/40 bg-attention/10 px-2 py-1 text-xs text-ink">
          <AlertTriangleIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-attention" />
          <span>
            This document's frontmatter could not be read, so only its text is shown here:{" "}
            {meta.error}
          </span>
        </p>
      )}
    </header>
  );
}
