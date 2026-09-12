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
  GitCompareIcon,
  SparklesIcon,
  UserIcon,
} from "lucide-react";
import { useState } from "react";
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
}: {
  versions: Version[];
  active: number;
  onActivate: (n: number) => void;
  onCompare: (n: number) => void;
  onNewVersion: () => void;
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
      <DropdownMenuTrigger
        className={cn(
          "flex items-baseline gap-1 rounded-sm px-1 text-ink outline-none",
          "hover:bg-surface-raised focus-visible:ring-2 focus-visible:ring-ring/60",
        )}
        aria-label={`Version ${active}${current?.label ? ` — ${current.label}` : ""}: ${versions.length} version${versions.length === 1 ? "" : "s"}`}
      >
        <span className="tabular-nums">
          v{active}
          {current?.label ? ` · ${current.label}` : ""}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <div className="border-b border-edge px-2 py-1.5">
          <p className="text-sm font-medium text-ink">Versions</p>
          <p className="text-xs text-ink-faint">
            Choosing one makes it the version you edit and Save writes.
          </p>
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {rows.map((v) => (
            <DropdownMenuItem
              key={v.n}
              onClick={() => onActivate(v.n)}
              disabled={v.n === active}
              className="flex-col items-start gap-0.5"
            >
              <span className="flex w-full items-center gap-1.5">
                {v.n === active ? (
                  <BadgeCheckIcon aria-hidden className="size-3.5 shrink-0 text-rubric" />
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
                <span>{when(v.createdAt)}</span>
                {v.n !== active && (
                  // ⛔ Comparing must NOT activate. The whole point of reading a
                  // version first is to decide, and a menu that switched you to
                  // whatever you wanted to look at would make that impossible.
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpen(false);
                      onCompare(v.n);
                    }}
                    className="ml-auto flex items-center gap-1 rounded-sm px-1 py-0.5 text-ink-dim hover:bg-bg hover:text-ink"
                  >
                    <GitCompareIcon aria-hidden className="size-3" />
                    Compare
                  </button>
                )}
              </span>
            </DropdownMenuItem>
          ))}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            setOpen(false);
            onNewVersion();
          }}
        >
          <BookmarkPlusIcon aria-hidden className="size-3.5" />
          New version from v{active}…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
