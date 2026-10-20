// An image's "Linked from", in the viewer's footer (the kit-image-embeds item):
// how many embeds and links land on the open image, and, opened, each one's
// document and line. The shell asks for it (`link.backlinks` by the image's
// path) and draws it here; the document pane's foot list is `Backlinks`.

import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu.tsx";
import type { Backlinks as BacklinksData, BacklinkView } from "../workspace/protocol";

/** The folder part of a shown path, with its trailing slash, or "" at the root. */
function folderOf(shown: string): string {
  const slash = shown.lastIndexOf("/");
  return slash === -1 ? "" : shown.slice(0, slash + 1);
}

/**
 * An image's "Linked from", in the viewer's footer: how many links and embeds
 * land on it, and, opened, each one's document and line. A footer item rather
 * than the document's foot list, since the viewer has no foot to scroll to;
 * nothing at all when nothing uses the image.
 */
export function ImageLinkedFrom({
  data,
  onOpen,
}: {
  data: BacklinksData | null;
  onOpen: (b: BacklinkView) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!data || data.count === 0) return null;
  const label = `Linked from ${data.count === 1 ? "1 place" : `${data.count} places`}`;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        data-slot="image-linked-from"
        aria-label={`${label}: open one`}
        className="flex h-5 shrink-0 items-center gap-1 rounded-sm px-1.5 text-ink-dim outline-none hover:bg-surface-raised hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {label}
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 text-ink-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-80">
        <div className="max-h-72 overflow-y-auto py-0.5">
          {data.backlinks.map((b) => (
            <DropdownMenuItem
              key={`${b.source}:${b.from}`}
              data-slot="image-backlink"
              data-source={b.source}
              onClick={() => {
                setOpen(false);
                onOpen(b);
              }}
              className="flex-col items-start gap-0 py-1"
            >
              <span className="flex w-full items-baseline gap-2 text-xs">
                <span className="truncate font-medium text-ink">
                  {b.name.replace(/\.(md|markdown|txt)$/i, "")}
                </span>
                <span className="truncate text-[11px] text-ink-faint">{folderOf(b.shown)}</span>
                <span className="ml-auto shrink-0 text-[11px] text-ink-faint">
                  {b.embed ? "shown" : "linked"}, line {b.line}
                </span>
              </span>
              <span className="w-full truncate text-[11px] text-ink-faint">{b.context}</span>
            </DropdownMenuItem>
          ))}
        </div>
        {data.truncated && (
          <p className="px-2 py-1 text-[11px] text-ink-faint">
            Showing the first {data.backlinks.length} of {data.count}.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
