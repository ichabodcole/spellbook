// "Move to…": one dialog for every row, in the list and in a set's tree. The
// workspace first, then every set and the folders inside it, with a search box
// across all of them. A menu cannot hold a search box well (its items take the
// focus a box needs), so the menu item opens this instead.
import { Dialog } from "@base-ui/react/dialog";
import { FolderIcon, FolderTreeIcon, HomeIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { baseName, filterMoveTargets, type MoveTarget, shortPath } from "./model.ts";

export function MoveToDialog({
  path,
  targets,
  userHome,
  onMove,
  onClose,
}: {
  /** What is being moved: an absolute path. */
  path: string;
  targets: readonly MoveTarget[];
  userHome: string | null;
  onMove: (into: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  // Nothing is chosen until the human says so: an arrow key, a search, or a
  // pointer. Enter on an untouched dialog does nothing, so a reflex Enter can
  // never carry something into the first place listed.
  const [at, setAt] = useState(-1);
  const shown = useMemo(() => filterMoveTargets(targets, query), [targets, query]);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  // A search highlights its first match; clearing it highlights nothing again.
  useEffect(() => setAt(query.trim() === "" ? -1 : 0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${at}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [at]);

  const choose = (t: MoveTarget | undefined) => {
    if (!t) return;
    onMove(t.path);
    onClose();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAt((i) => Math.min(i + 1, shown.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAt((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[at]);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 isolate z-50 bg-black/30 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <Dialog.Popup
          data-slot="move-to-dialog"
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[70vh] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-xl border border-edge bg-surface p-3 text-ink shadow-lg duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <Dialog.Title className="truncate text-sm font-semibold text-ink">
            Move {baseName(path)} to
          </Dialog.Title>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKey}
            // biome-ignore lint/a11y/noAutofocus: the human asked to choose a folder; the search is the way in.
            autoFocus
            placeholder="Search sets and folders…"
            aria-label="Search sets and folders"
            role="combobox"
            aria-expanded={shown.length > 0}
            aria-controls={shown.length > 0 ? listId : undefined}
            aria-activedescendant={shown[at] ? `${listId}-${at}` : undefined}
            spellCheck={false}
            className="h-8 w-full min-w-0 rounded-md border border-edge bg-bg px-2 text-sm text-ink outline-none placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-ring/60"
          />
          {shown.length === 0 ? (
            <p className="px-1 py-2 text-xs text-ink-faint">
              {targets.length === 0
                ? "There is no other set to move this into."
                : "No set or folder matches."}
            </p>
          ) : (
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Places to move to"
              className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto"
            >
              {shown.map((t, i) => {
                const Icon =
                  t.kind === "workspace"
                    ? HomeIcon
                    : t.kind === "set"
                      ? FolderTreeIcon
                      : FolderIcon;
                return (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the field owns the keyboard (aria-activedescendant); a row is only clicked.
                  <div
                    key={t.path}
                    id={`${listId}-${i}`}
                    data-index={i}
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === at}
                    title={t.path}
                    onMouseMove={() => setAt(i)}
                    // The input keeps the focus: a click chooses, nothing else.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(t)}
                    className={cn(
                      "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5",
                      i === at && "bg-surface-raised",
                    )}
                  >
                    <Icon aria-hidden className="size-4 shrink-0 text-ink-faint" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{t.label}</span>
                      {t.kind === "workspace" && (
                        <span className="truncate font-mono text-[11px] text-ink-dim">
                          {shortPath(t.path, userHome)}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
