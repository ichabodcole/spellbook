// The version list, a button beside the document's name.
//
// Its shape is the active version pinned to the top with a check, the author shown
// per row (the other author is the agent, so it matters), and the LABEL as the
// identity with `vN` only as the fallback. A row offers Compare as well as
// switching, and comparing does not change which version the human is editing.

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
import { cn } from "../lib/cn.ts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/index.ts";
import type { Version } from "../workspace/protocol";

/** The label is the identity; `vN` is what a version is called when unnamed. */
export function versionLabel(v: Pick<Version, "n" | "label">): string {
  const label = v.label?.trim();
  return label && label.length > 0 ? label : `v${v.n}`;
}

/**
 * Who a version reads as made by. A version the daemon preserved from a write to the
 * active file is stored as the agent's (the writer was not the human), but nobody
 * chose to propose it, so the menu says what it is instead.
 */
export function authorLabel(v: Pick<Version, "by" | "label">): string {
  if (v.label?.startsWith("outside write")) return "Outside write";
  return v.by === "agent" ? "Agent" : "You";
}

/** Newest first, except the ACTIVE one, which is always at the top. */
export function ordered(versions: Version[], active: number): Version[] {
  return [...versions].sort((a, b) => {
    if (a.n === active) return -1;
    if (b.n === active) return 1;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.n - a.n;
  });
}

/**
 * The version as one read-only line for the status strip: the number, and as much
 * of the name as fits. Truncated here rather than by CSS, because the strip is one
 * nowrap row and a long name would push the counts off the end.
 */
export function versionSummary(
  v: Pick<Version, "label"> | undefined,
  active: number,
  max = 32,
): string {
  const label = v?.label?.trim();
  if (!label) return `v${active}`;
  // `trimEnd` so a cut landing on a space does not leave "a name far …".
  return `v${active} · ${label.length > max ? `${label.slice(0, max - 1).trimEnd()}…` : label}`;
}

const when = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
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
  /** Remove a version and its file: never the active one, so never offered on it. */
  onDelete: (n: number) => void;
  /** Show this version's file in the file manager: offered on every row. */
  onReveal: (n: number) => void;
}) {
  const rows = ordered(versions, active);
  const current = versions.find((v) => v.n === active);
  // Controlled so Compare can close it. The row's own click closes the menu for
  // free, but Compare is a button inside that row and has to stop the click from
  // reaching it (otherwise looking at a version would switch to it), which stops
  // the close too.
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {/* It has to look like a button: a border, a height that matches the header's
          other controls, and a chevron. The number only; the name is in the menu. */}
      <DropdownMenuTrigger
        className={cn(
          "flex h-7 shrink-0 items-center gap-1 rounded-md border border-edge px-2",
          "text-xs text-ink outline-none hover:bg-surface-raised",
          "focus-visible:ring-2 focus-visible:ring-ring/60",
        )}
        aria-label={`Version ${active}${current?.label ? `: ${current.label}` : ""}, ${versions.length} version${versions.length === 1 ? "" : "s"}`}
      >
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
                // Not `disabled`: that says "unavailable" when the row means "you
                // are here", and it would make every control inside the row inert,
                // including Reveal on the version people ask about most.
                onClick={() => v.n !== active && onActivate(v.n)}
                aria-current={v.n === active ? "true" : undefined}
                className={cn(
                  "flex-col items-start gap-0.5 py-1.5",
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
                  {v.by === "agent" ? (
                    <SparklesIcon aria-hidden className="size-3 shrink-0" />
                  ) : (
                    <UserIcon aria-hidden className="size-3 shrink-0" />
                  )}
                  <span className="whitespace-nowrap">
                    {authorLabel(v)}, {when(v.createdAt)}
                  </span>
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
                    // Comparing must not activate. The point of reading a version
                    // first is to decide, and a menu that switched you to whatever
                    // you wanted to look at would make that impossible.
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
                    // Offered only on a version that is not active, which is the
                    // same rule the daemon enforces: the UI does not show an action
                    // the wire would refuse.
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
        {/* Two items, because there are two intentions. The first is the default
            because it is what "new version" means to a human who has just decided to
            change something: they expect to be IN it. */}
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
