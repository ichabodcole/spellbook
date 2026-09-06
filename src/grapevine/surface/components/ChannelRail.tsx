// C4–C11 — the left rail: one row per channel, the active / new / archived
// states, the subscriber count, and the close button with its confirmation
// (an AlertDialog with the same text as the original confirm; it still
// forces a choice). L1 — every row carries a context menu (right-click,
// Shift+F10) with the lifecycle verbs; L2 — the `+` opens the create dialog;
// L4 — the _Show archived_ switch.

import { cn } from "cn";
import { PlusIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/ui/context-menu";
import { Field, FieldLabel } from "@/ui/field";
import { Switch } from "@/ui/switch";
import { channelHref } from "../state/channel";
import { closeConfirmText } from "../state/feed";
import { archiveLabel, type CreateOutcome } from "../state/lifecycle";
import type { ChannelRow } from "../state/types";
import { CreateChannelDialog } from "./CreateChannelDialog";

// L6 — the keyboard's menu key fires a native `contextmenu` event, which the
// trigger already answers; Shift+F10 does not on every platform (macOS has no
// such binding; measured: zero events through Chrome). Synthesise one at the
// focused row so the same menu opens from the keyboard everywhere.
function openMenuOnShiftF10(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "F10" || !e.shiftKey) return;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: r.left + 24,
      clientY: r.top + r.height / 2,
    }),
  );
}

export function ChannelRail({
  channels,
  hiddenCount,
  showArchived,
  onShowArchived,
  current,
  onClose,
  onArchive,
  onUnarchive,
  onEditTopic,
  onCreate,
  onUnarchiveAndGo,
  signer,
}: {
  channels: ChannelRow[];
  hiddenCount: number;
  showArchived: boolean;
  onShowArchived: (on: boolean) => void;
  current: string;
  onClose: (name: string) => void;
  onArchive: (name: string) => void;
  onUnarchive: (name: string) => void;
  onEditTopic: (name: string) => void;
  onCreate: (name: string, topic: string) => Promise<CreateOutcome>;
  onUnarchiveAndGo: (name: string) => Promise<void>;
  signer: string | null;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const switchId = useId();
  const plusRef = useRef<HTMLButtonElement | null>(null);
  // The menu's trigger is the row div, which is not focusable, so Base UI has
  // nowhere to return focus after an item is chosen (Escape returns it to the
  // link on its own, because that is where it came from). Each row's link is
  // kept by name and refocused after an item runs — the row is still there
  // after archive/unarchive; after Delete… the dialog owns focus.
  // When the filter (L4) hides the row the act just archived, the link is
  // gone by the next frame — focus goes to the switch instead, which is the
  // control that brings the row back.
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const switchRef = useRef<HTMLElement | null>(null);
  const refocus = (name: string) => {
    requestAnimationFrame(() => linkRefs.current.get(name)?.focus());
  };
  // The row hides on the poll AFTER the refocus (the link still exists at the
  // next frame), so the hand-off happens where the link leaves: its ref is
  // cleared while it is still the active element.
  const linkRef = (name: string) => (el: HTMLAnchorElement | null) => {
    if (el) {
      linkRefs.current.set(name, el);
      return;
    }
    const gone = linkRefs.current.get(name);
    linkRefs.current.delete(name);
    if (gone && document.activeElement === gone) switchRef.current?.focus();
  };
  return (
    <aside className="overflow-y-auto border-r border-edge bg-surface px-[18px] py-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="m-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
          Channels
        </h2>
        <Button
          variant="ghost"
          size="icon-xs"
          ref={plusRef}
          aria-label="New channel"
          title="New channel"
          onClick={() => setCreating(true)}
        >
          <PlusIcon />
        </Button>
      </div>
      <Field orientation="horizontal" className="mb-3 items-center">
        <Switch
          ref={switchRef}
          id={switchId}
          size="sm"
          checked={showArchived}
          onCheckedChange={(on) => onShowArchived(on)}
        />
        <FieldLabel htmlFor={switchId} className="text-xs font-normal text-ink-dim">
          Show archived
          {hiddenCount > 0 && <span className="font-mono">({hiddenCount} hidden)</span>}
        </FieldLabel>
      </Field>
      <ul className="m-0 list-none p-0">
        {channels.length === 0 && (
          <li className="px-2 py-1.5 font-mono text-xs italic text-ink-dim">no channels yet</li>
        )}
        {channels.map((c) => {
          const active = c.name === current;
          return (
            <li key={c.name} className="p-0">
              <ContextMenu>
                <ContextMenuTrigger
                  render={
                    <div
                      className={cn(
                        "group flex items-center gap-0.5 rounded-md transition-colors hover:bg-surface-raised",
                        active && "bg-surface-raised",
                        c.isNew && "animate-flash",
                      )}
                    />
                  }
                  onKeyDown={openMenuOnShiftF10}
                >
                  <a
                    ref={linkRef(c.name)}
                    href={channelHref(c.name)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center justify-between rounded-md px-2 py-1.5 font-mono text-xs text-ink no-underline outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
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
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    title={`Close channel “${c.name}” (deletes message log)`}
                    onClick={() => setPending(c.name)}
                  >
                    🗑
                  </Button>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuGroup>
                    <ContextMenuItem onClick={() => onEditTopic(c.name)}>
                      Edit topic
                    </ContextMenuItem>
                    <ContextMenuItem
                      onClick={() => {
                        if (c.archived) onUnarchive(c.name);
                        else onArchive(c.name);
                        refocus(c.name);
                      }}
                    >
                      {archiveLabel(c.archived)}
                    </ContextMenuItem>
                  </ContextMenuGroup>
                  <ContextMenuSeparator />
                  <ContextMenuGroup>
                    <ContextMenuItem variant="destructive" onClick={() => setPending(c.name)}>
                      Delete…
                    </ContextMenuItem>
                  </ContextMenuGroup>
                </ContextMenuContent>
              </ContextMenu>
            </li>
          );
        })}
      </ul>
      <CreateChannelDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={onCreate}
        onUnarchive={onUnarchiveAndGo}
        finalFocus={plusRef}
        signer={signer}
      />
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
