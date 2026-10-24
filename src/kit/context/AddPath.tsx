// A path box with completion from the daemon's directory listing. Its use adds a
// file or folder to the context BY PATH, the way to link the real file: a web
// page never learns a dropped file's path, which is why a drop is a copy into the
// session instead. The buttons beside it open the OS's own picker (the daemon
// does it; a browser picker gives content and a name, never a path).

import { CornerDownLeftIcon, FileTextIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import type { FsListEntry } from "../workspace/protocol";
import type { Listing } from "./daemonClient.ts";

const MAX_SUGGESTIONS = 8;

/** A daemon listing error in words (the raw text is `ENOENT: no such file or directory, scandir …`). */
export function friendlyListError(raw: string, dir: string): string {
  if (/ENOENT/.test(raw)) return `No folder at ${dir}`;
  if (/EACCES|EPERM/.test(raw)) return `Not allowed to read ${dir}`;
  if (/ENOTDIR/.test(raw)) return `${dir} is a file, not a folder`;
  return raw;
}

/** Split a typed path into the directory to list and the name prefix to match. */
export function splitForCompletion(typed: string): { dir: string; prefix: string } | null {
  if (!typed.startsWith("/") && !typed.startsWith("~")) return null;
  if (typed === "~") return { dir: "~", prefix: "" };
  const i = typed.lastIndexOf("/");
  if (i === -1) return null;
  return { dir: i === 0 ? "/" : typed.slice(0, i), prefix: typed.slice(i + 1) };
}

/** The field's own words, and the ones a narrow field shows. */
export const ADD_PLACEHOLDER = "Type a path to add…";
export const ADD_PLACEHOLDER_SHORT = "Add a path…";

/**
 * Which placeholder the field shows: the full one while it fits the field's
 * text box, else the short one, so a narrow column shows "Add a path…" whole
 * rather than "Type a path t…". Widths in CSS pixels; a width not known yet
 * (no layout, no canvas) keeps the full one.
 */
export function placeholderFor(
  full: string,
  short: string | undefined,
  fullWidth: number | null,
  room: number | null,
): string {
  if (short === undefined || fullWidth === null || room === null || room <= 0) return full;
  return fullWidth <= room ? full : short;
}

/** The width `text` takes in `el`'s font, and the room its text box has; null without layout or canvas. */
function measure(el: HTMLInputElement, text: string): { width: number; room: number } | null {
  const ctx = document.createElement("canvas").getContext?.("2d");
  if (!ctx || el.clientWidth === 0) return null;
  const cs = getComputedStyle(el);
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const room =
    el.clientWidth - Number.parseFloat(cs.paddingLeft) - Number.parseFloat(cs.paddingRight);
  return { width: ctx.measureText(text).width, room };
}

export function AddPath({
  listDir,
  onAdd,
  placeholder = ADD_PLACEHOLDER,
  shortPlaceholder = placeholder === ADD_PLACEHOLDER ? ADD_PLACEHOLDER_SHORT : undefined,
  verb = "adds",
  foldersOnly = false,
  initialValue = "",
  autoFocus = false,
  onCancel,
  className,
  onPick,
  openDown = false,
}: {
  listDir: (path: string) => Promise<Listing>;
  onAdd: (path: string) => void;
  placeholder?: string;
  /**
   * Shown instead while `placeholder` does not fit the field, as in a narrow
   * column. The default placeholder has one; a caller's own has none unless given.
   */
  shortPlaceholder?: string;
  /** What Enter does, for the hint line ("adds", "sets"). */
  verb?: string;
  /** Offer folders only. */
  foldersOnly?: boolean;
  initialValue?: string;
  autoFocus?: boolean;
  /** Escape on an already-empty box, or focus leaving it: the caller closes it. */
  onCancel?: () => void;
  className?: string;
  /**
   * Open the OS's own picker (the daemon does it — a browser picker gives
   * content and a name, never a path). Absent: no button.
   */
  onPick?: (kind: "file" | "folder") => void;
  /** Open the suggestion list DOWNWARD — for a box at the top of its panel. */
  openDown?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  // The suggestions carry the value they were computed FOR: a Tab or Enter
  // inside the debounce would otherwise complete from the previous keystroke's
  // list (verify pass: `/` then `Us`+Tab gave `/Applications/`).
  const [listed, setListed] = useState<{ forValue: string; entries: FsListEntry[] }>({
    forValue: "",
    entries: [],
  });
  const suggestions = listed.forValue === value ? listed.entries : [];
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(-1);
  const listId = useId();
  const seq = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  // The placeholder that fits, read again whenever the field changes width.
  const [shown, setShown] = useState(placeholder);
  useEffect(() => {
    const el = field.current;
    const fit = () => {
      const m = el ? measure(el, placeholder) : null;
      setShown(placeholderFor(placeholder, shortPlaceholder, m?.width ?? null, m?.room ?? null));
    };
    fit();
    if (!el || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(fit);
    watch.observe(el);
    return () => watch.disconnect();
  }, [placeholder, shortPlaceholder]);

  useEffect(() => {
    const split = splitForCompletion(value);
    if (!split) {
      setListed({ forValue: value, entries: [] });
      setError(null);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const listing = await listDir(split.dir);
      if (mine !== seq.current) return; // a newer keystroke owns the list
      const p = split.prefix.toLowerCase();
      setListed({
        forValue: value,
        entries: listing.entries
          .filter((e) => (!foldersOnly || e.dir) && e.name.toLowerCase().startsWith(p))
          .slice(0, MAX_SUGGESTIONS),
      });
      setError(
        listing.error && split.prefix === "" ? friendlyListError(listing.error, split.dir) : null,
      );
      setHighlight(-1);
    }, 120);
    return () => clearTimeout(t);
  }, [value, listDir, foldersOnly]);

  const complete = (e: FsListEntry) => {
    // Build on the directory as TYPED — a leading `~` stays a `~`, never expanded on them.
    const dir = splitForCompletion(value)?.dir ?? "";
    setValue(`${dir === "/" ? "" : dir}/${e.name}${e.dir ? "/" : ""}`);
  };

  const submit = (path: string) => {
    const p = path.trim().replace(/\/+$/, "");
    if (!p) return;
    onAdd(p);
    setValue("");
  };

  return (
    <div className={cn("relative flex items-center gap-1 border-t border-edge p-2", className)}>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        ref={field}
        placeholder={shown}
        // Named by the full placeholder whichever is shown.
        aria-label={placeholder.replace(/…$/, "")}
        // Autofocus only when opened by an explicit "Change" click, which asks for the box.
        autoFocus={autoFocus}
        onBlur={() => {
          if (onCancel && !suggestions.length) onCancel();
        }}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
        spellCheck={false}
        className="h-8 min-w-0 flex-1 font-mono text-xs"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && suggestions.length) {
            e.preventDefault();
            setHighlight((h) => (h + 1) % suggestions.length);
          } else if (e.key === "ArrowUp" && suggestions.length) {
            e.preventDefault();
            setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1));
          } else if (e.key === "Tab" && suggestions.length) {
            const pick = suggestions[highlight >= 0 ? highlight : 0];
            if (pick) {
              e.preventDefault();
              complete(pick);
            }
          } else if (e.key === "Enter") {
            e.preventDefault();
            const pick = highlight >= 0 ? suggestions[highlight] : undefined;
            submit(pick ? pick.path : value);
          } else if (e.key === "Escape") {
            // First Escape closes the suggestions; only a second clears the path.
            if (suggestions.length || error) {
              setListed({ forValue: "", entries: [] });
              setError(null);
            } else if (onCancel) onCancel();
            else setValue("");
          }
        }}
      />
      {onPick && !foldersOnly && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onPick("file")}
          aria-label="Choose documents with the file picker"
          title="Choose documents with the file picker"
        >
          <FileTextIcon />
        </Button>
      )}
      {onPick && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onPick("folder")}
          aria-label="Choose a folder with the file picker"
          title="Choose a folder with the file picker"
        >
          <FolderOpenIcon />
        </Button>
      )}
      {(suggestions.length > 0 || error) && (
        <div
          className={cn(
            "absolute right-2 left-2 z-10 rounded-md border border-edge bg-surface-raised p-1 shadow-lg",
            openDown ? "top-full mt-1" : "bottom-full mb-1",
          )}
        >
          {error && <p className="px-2 py-1 text-xs text-attention">{error}</p>}
          <div
            id={listId}
            role="listbox"
            aria-label="Matching files and folders"
            className="max-h-64 overflow-auto"
          >
            {suggestions.map((s, i) => (
              <div
                key={s.path}
                id={`${listId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === highlight}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 font-mono text-xs text-ink-dim",
                  i === highlight ? "bg-edge text-ink" : "hover:bg-edge/60",
                )}
                // mousedown, not click: the input losing focus must not win the race.
                onMouseDown={(e) => {
                  e.preventDefault();
                  if (s.dir) complete(s);
                  else submit(s.path);
                }}
              >
                {s.dir ? (
                  <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                ) : (
                  <FileTextIcon aria-hidden className="size-3.5 shrink-0" />
                )}
                <span className="truncate">{s.name}</span>
                {s.dir && <span className="ml-auto text-ink-faint">/</span>}
              </div>
            ))}
          </div>
          <p className="flex items-center gap-1 px-2 pt-1 text-[10px] text-ink-faint">
            <CornerDownLeftIcon aria-hidden className="size-3" /> {verb} · Tab completes
          </p>
        </div>
      )}
    </div>
  );
}
