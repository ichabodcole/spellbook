// A path box with completion from the daemon's directory listing. Its main
// use adds a file or folder to the context BY PATH — the way to link the REAL
// file (E1): a web page never learns a dropped file's path, which is why a drop
// is a copy into the workspace instead (E23). The same box, folders only, sets
// the workspace.
import { cn } from "cn";
import { CornerDownLeftIcon, FileTextIcon, FolderIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Input } from "@/ui/input";
import type { FsListEntry } from "../../../backend/protocol";
import type { Listing } from "../../state/useDaemon";

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

export function AddPath({
  listDir,
  onAdd,
  placeholder = "Add a file or folder by path…",
  verb = "adds",
  foldersOnly = false,
  initialValue = "",
  autoFocus = false,
  onCancel,
}: {
  listDir: (path: string) => Promise<Listing>;
  onAdd: (path: string) => void;
  placeholder?: string;
  /** What Enter does, for the hint line ("adds", "sets"). */
  verb?: string;
  /** Offer folders only (setting the workspace). */
  foldersOnly?: boolean;
  initialValue?: string;
  autoFocus?: boolean;
  /** Escape on an already-empty box, or blur: the caller closes it. */
  onCancel?: () => void;
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
    <div className="relative border-t border-edge p-2">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder.replace(/…$/, "")}
        // Autofocus only when opened by an explicit "Change" click, which asks for the box.
        autoFocus={autoFocus}
        onBlur={() => {
          if (onCancel && !suggestions.length) onCancel();
        }}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
        spellCheck={false}
        className="h-8 font-mono text-xs"
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
      {(suggestions.length > 0 || error) && (
        <div className="absolute right-2 bottom-full left-2 z-10 mb-1 rounded-md border border-edge bg-surface-raised p-1 shadow-lg">
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
                // mousedown, not click: the input's blur must not win the race.
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
