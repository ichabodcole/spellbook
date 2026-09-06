// C4–C11 — the left rail: one row per channel, the active / new / archived
// states, the subscriber count, and the close button with its confirmation
// (an AlertDialog with the same text as the original confirm; it still
// forces a choice).

import { cn } from "cn";
import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/ui/alert-dialog";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { channelHref } from "../state/channel";
import { closeConfirmText } from "../state/feed";
import type { ChannelRow } from "../state/types";

export function ChannelRail({
  channels,
  current,
  onClose,
}: {
  channels: ChannelRow[];
  current: string;
  onClose: (name: string) => void;
}) {
  const [pending, setPending] = useState<string | null>(null);
  return (
    <aside className="overflow-y-auto border-r border-edge bg-surface px-[18px] py-4">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
        Channels
      </h2>
      <ul className="m-0 list-none p-0">
        {channels.length === 0 && (
          <li className="px-2 py-1.5 font-mono text-xs italic text-ink-dim">no channels yet</li>
        )}
        {channels.map((c) => {
          const active = c.name === current;
          return (
            <li key={c.name} className="p-0">
              <div
                className={cn(
                  "group flex items-center gap-0.5 rounded-md transition-colors hover:bg-surface-raised",
                  active && "bg-surface-raised",
                  c.isNew && "animate-flash",
                )}
              >
                <a
                  href={channelHref(c.name)}
                  className={cn(
                    "flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1.5 font-mono text-xs text-ink no-underline",
                    active && "font-semibold text-leaf-soft",
                  )}
                >
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      // C14 — muted whenever archived, active or not.
                      c.archived && "text-ink-dim",
                    )}
                  >
                    {c.name}
                  </span>
                  <span className="ml-1.5 flex shrink-0 items-center gap-1">
                    {c.archived && (
                      <span className="text-[10px]" title="archived — read-only">
                        🔒
                      </span>
                    )}
                    <Badge variant={active ? "count-live" : "count"}>{c.subscribers}</Badge>
                  </span>
                </a>
                <Button
                  variant="destructive-ghost"
                  size="icon-xs"
                  className="opacity-0 group-hover:opacity-100"
                  title={`Close channel “${c.name}” (deletes message log)`}
                  onClick={() => setPending(c.name)}
                >
                  🗑
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close channel</AlertDialogTitle>
            <AlertDialogDescription>{pending && closeConfirmText(pending)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) onClose(pending);
                setPending(null);
              }}
            >
              Close channel
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
