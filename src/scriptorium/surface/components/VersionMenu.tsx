// The version list, hung off the status strip's version segment (E37).
//
// ⛔ WHY HERE AND NOT THE TOOLBAR. The strip already answers "where am I" —
// `Version: v1 · tighter prose` is the thing you read to know which version
// you are editing — so the list of versions belongs behind it rather than
// behind a second icon somewhere else. Operator uses a History button in its
// toolbar; our toolbar already carries Revert, Save and four mode buttons, and
// a seventh control there buys nothing the strip does not already offer.
//
// What IS taken from Operator's `VersionDropdown.vue`: the active version
// pinned to the top with a check, the author shown per row (its Sparkles/User
// pair — here it matters more, because the other author is the agent), and the
// LABEL as the identity with `vN` only as the fallback. What is deliberately
// not taken: its `maxVersionsPerDocument` limit and "approaching limit"
// warnings, which are a database quota; ours are files in a session folder.
//
// What Operator's menu cannot do and ours must: COMPARE. Switching to look is
// the only thing its dropdown offers, and we have a compare view — so a row
// offers both, and comparing does not change which version you are editing.
import { cn } from "cn";
import {
  BadgeCheckIcon,
  BookmarkPlusIcon,
  ChevronDownIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitCompareIcon,
  SparklesIcon,
  Trash2Icon,
  UserIcon,
} from "lucide-react";
import { Fragment, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import type { Version } from "../../backend/protocol";

/** The label is the identity; `vN` is what a version is called when unnamed. */
export function versionLabel(v: Version): string {
  const label = v.label?.trim();
  return label && label.length > 0 ? label : `v${v.n}`;
}

/** Newest first, except the ACTIVE one, which is always at the top. */
export function ordered(versions: Version[], active: number): Version[] {
  return [...versions].sort((a, b) => {
    if (a.n === active) return -1;
    if (b.n === active) return 1;
    return b.createdAt - a.createdAt;
  });
}

/**
 * The version as one read-only line for the status strip: the number, and as
 * much of the name as fits. Truncated HERE rather than by CSS, because the
 * strip is one nowrap row — a long name would push the counts off the end
 * instead of clipping itself.
 */
export function versionSummary(v: Version | undefined, active: number, max = 32): string {
  const label = v?.label?.trim();
  if (!label) return `v${active}`;
  // `trimEnd` so a cut landing on a space does not leave "a name far …".
  return `v${active} · ${label.length > max ? `${label.slice(0, max - 1).trimEnd()}…` : label}`;
}

const when = (ms: number) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(ms),
  );

export function VersionMenu({
  versions,
  active,
  onActivate,
  onCompare,
  onNewVersion,
  onDelete,
  onReveal,
}: {
  versions: Version[];
  active: number;
  onActivate: (n: number) => void;
  onCompare: (n: number) => void;
  onNewVersion: (intent: "branch" | "snapshot") => void;
  /** E41: remove a version and its file — never the active one, so never offered on it. */
  onDelete: (n: number) => void;
  /** E44: show this version's file in the file manager — offered on EVERY row. */
  onReveal: (n: number) => void;
}) {
  const rows = ordered(versions, active);
  const current = versions.find((v) => v.n === active);
  // ⛔ CONTROLLED so Compare can close it. The row's own click closes the menu
  // for free, but Compare is a button INSIDE that row and has to stop the
  // click from reaching it (otherwise looking at a version would switch to
  // it) — which stops the close too, leaving the menu sitting over the
  // comparison it just opened.
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* ⛔ IT HAS TO LOOK LIKE A BUTTON. In the status strip this was a bare
          span with a hover state, sitting among read-only values — "it's just
          not something I look towards" (Cole). A border, a height that matches
          the header's other controls, and a chevron: the affordance is the
          point, not the decoration. */}
      <DropdownMenuTrigger
        className={cn(
          "flex h-7 shrink-0 items-center gap-1 rounded-md border border-edge px-2",
          "text-xs text-ink outline-none hover:bg-surface-raised",
          "focus-visible:ring-2 focus-visible:ring-ring/60",
        )}
        aria-label={`Version ${active}${current?.label ? ` — ${current.label}` : ""}: ${versions.length} version${versions.length === 1 ? "" : "s"}`}
      >
        {/* ⛔ THE NUMBER ONLY (Cole, E38). The name used to ride along here and
            it competed with the DOCUMENT's title two inches to the right —
            "they can almost start to run together or just be a lot of text".
            The name is not lost: it is in the menu this opens, and read-only in
            the status strip. */}
        <span className="font-medium tabular-nums">v{active}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-ink-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <div className="border-b border-edge px-2 py-1.5">
          <p className="text-sm font-medium text-ink">Versions</p>
          <p className="text-xs text-ink-faint">
            Choosing one makes it the version you edit and Save writes.
          </p>
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {rows.map((v, i) => (
            <Fragment key={v.n}>
              {i > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                // ⛔ NOT `disabled`, and E39's reasoning is why (E44). Disabling
                // said "unavailable" when the row means "you are here" — and it
                // also made every control INSIDE the row inert, which killed
                // Reveal on the one version people ask about most. `aria-current`
                // states the fact instead of forbidding the act, and selecting
                // the row you are already in is simply nothing.
                onClick={() => v.n !== active && onActivate(v.n)}
                aria-current={v.n === active ? "true" : undefined}
                className={cn(
                  "flex-col items-start gap-0.5 py-1.5",
                  // ⛔ THE ACTIVE ROW IS HIGHLIGHTED, NOT MUTED (Cole, E39).
                  // `disabled` is the right SEMANTICS — you cannot switch to
                  // where you already are — but shadcn renders it at 50%
                  // opacity, which says "unavailable" when the thing it needs
                  // to say is "you are here". The pointer-events-none half of
                  // `disabled` is kept; the dimming is overridden, and the row
                  // gains the accent instead.
                  v.n === active && "bg-selected/14 ring-1 ring-selected/30",
                )}
              >
                <span className="flex w-full items-center gap-1.5">
                  {v.n === active ? (
                    <BadgeCheckIcon aria-hidden className="size-3.5 shrink-0 text-selected" />
                  ) : (
                    <span aria-hidden className="size-3.5 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">
                    {versionLabel(v)}
                  </span>
                  {v.label && <span className="shrink-0 text-[11px] text-ink-faint">v{v.n}</span>}
                </span>
                <span className="flex w-full items-center gap-1.5 pl-5 text-xs text-ink-faint">
                  {v.author === "agent" ? (
                    <SparklesIcon aria-hidden className="size-3 shrink-0" />
                  ) : (
                    <UserIcon aria-hidden className="size-3 shrink-0" />
                  )}
                  <span className="whitespace-nowrap">{when(v.createdAt)}</span>
                  {/* ⛔ ON EVERY ROW, THE ACTIVE ONE INCLUDED. "Where is this
                      thing?" is the question this answers (Cole), and it is
                      asked most often about the version being edited. */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      onReveal(v.n);
                    }}
                    aria-label={`Show ${versionLabel(v)} in the file manager`}
                    title={`Show v${v.n}.md in the file manager`}
                    className={cn(
                      "flex items-center rounded-sm px-1 py-0.5 text-ink-dim hover:bg-bg hover:text-ink",
                      v.n === active && "ml-auto",
                    )}
                  >
                    <FolderOpenIcon aria-hidden className="size-3" />
                  </button>
                  {v.n !== active && (
                    // ⛔ Comparing must NOT activate. The whole point of reading
                    // a version first is to decide, and a menu that switched you
                    // to whatever you wanted to look at would make that
                    // impossible.
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        onCompare(v.n);
                      }}
                      className="flex items-center gap-1 rounded-sm px-1 py-0.5 text-ink-dim hover:bg-bg hover:text-ink"
                    >
                      <GitCompareIcon aria-hidden className="size-3" />
                      Compare
                    </button>
                  )}
                  {v.n !== active && (
                    // Offered ONLY on a version that is not active, which is
                    // the same rule the daemon enforces (E41) — the UI does
                    // not show an action the wire would refuse.
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        onDelete(v.n);
                      }}
                      aria-label={`Delete ${versionLabel(v)}`}
                      title={`Delete ${versionLabel(v)}`}
                      className="flex items-center rounded-sm px-1 py-0.5 text-ink-faint hover:bg-bg hover:text-danger"
                    >
                      <Trash2Icon aria-hidden className="size-3" />
                    </button>
                  )}
                </span>
              </DropdownMenuItem>
            </Fragment>
          ))}
        </div>
        <DropdownMenuSeparator />
        {/* ⛔ TWO ITEMS, BECAUSE THERE ARE TWO INTENTIONS (E42). The first is
            the default because it is what "new version" means to a human who
            has just decided to change something: they expect to be IN it. The
            second is the older behaviour, kept because "mark this and keep
            typing" is a real thing to want and branching labels it backwards. */}
        <DropdownMenuItem
          onClick={() => {
            setOpen(false);
            onNewVersion("branch");
          }}
        >
          <GitBranchIcon aria-hidden className="size-3.5" />
          New version from v{active} and edit it…
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            setOpen(false);
            onNewVersion("snapshot");
          }}
        >
          <BookmarkPlusIcon aria-hidden className="size-3.5" />
          Snapshot v{active}, keep editing it…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
