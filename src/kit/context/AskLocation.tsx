// "Where should it go?": the ask for an app with no home workspace. With no
// workspace there is no folder a new document, a new folder or a dropped file
// can fall into unasked, so the context sidebar asks the app (its `askLocation`
// slot) and sends the place the human chose as the op's `dir`.
//
// `useAskLocation` is the kit's answer to that slot: a dialog listing every set
// and the folders inside it (the same places "Move to…" offers), searchable,
// with the place chosen last already highlighted, so making several documents
// in a row is one Enter each. The last place is held here, in the surface, for
// as long as the page lives: a session's surface is its own page, so nothing
// keyed by origin is needed, and a place that left the context is simply not
// highlighted. With `addFolder` it can also make room: a new folder at a full
// path (the daemon's `folder.add`), highlighted once the context shows it.
// With `pick` it also offers the OS's own folder dialog (the daemon opens it):
// the folder chosen is highlighted when the context shows it, and one outside
// every set is named with the act that brings it in (`addPlace`). A drop's ask
// may carry `original`: the dialog then also offers the OS's file dialog, and
// the file chosen there is added where it lives instead of copied.
import { Dialog } from "@base-ui/react/dialog";
import { FileIcon, FolderIcon, FolderOpenIcon, FolderTreeIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { bundlePlace } from "../lib/bundles.ts";
import { cn } from "../lib/cn.ts";
import { Button } from "../ui/button.tsx";
import { inertOutsideRef } from "../ui/inertOutside.ts";
import type { ContextEntry, PickAnswerWant } from "../workspace/protocol";
import { AddPath } from "./AddPath.tsx";
import type { Listing } from "./daemonClient.ts";
import { filterMoveTargets, joinPath, type MoveTarget, moveTargets, tildify } from "./model.ts";

/** One ask: what is being made or brought in, and the question the dialog puts. */
export type LocationAsk = {
  /** Decides which places can take it: a bundle is never made inside another one. */
  what: "document" | "folder" | "bundle" | "files";
  /** The dialog's title, in the sidebar's words ("Where should the new document go?"). */
  title: string;
  /**
   * For dropped files: the other way in, adding the original file where it
   * lives rather than copying it. A drop never names its file's path, so the
   * human picks it in the OS's file dialog; `add` takes the files chosen, and
   * the ask is then answered with null (nothing to copy). Offered only where
   * the dialog has a picker.
   */
  original?: { files: number; add: (paths: string[]) => void };
};

/**
 * The slot: ask the human where something goes. Resolves with the folder chosen
 * (a full path the context shows), or null when they backed out.
 */
export type AskLocation = (ask: LocationAsk) => Promise<string | null>;

/**
 * Open the OS's own picker (the daemon does it) and resolve with the paths
 * chosen, none when the dialog was dismissed; rejects with the refusal.
 * `pickPaths` in `./daemonClient.ts`, over the daemon's `request`.
 */
export type PickPaths = (want: PickAnswerWant) => Promise<string[]>;

/** Every place something can be created in or copied into: each set, then its folders. */
export function locationTargets(
  entries: readonly ContextEntry[],
  what: LocationAsk["what"] = "document",
): MoveTarget[] {
  const all = moveTargets(entries, null);
  return what === "bundle" ? all.filter((t) => bundlePlace(t.path) === null) : all;
}

/**
 * A path as typed, made the way the context names places: a leading `~/` made
 * whole, and `.`, `..` and doubled slashes resolved (`~/work/./notes` is
 * `/home/me/work/notes`), so the folder it makes can be found among them.
 */
export function placePath(typed: string, userHome: string | null): string {
  const path = typed.startsWith("~/") && userHome ? joinPath(userHome, typed.slice(2)) : typed;
  if (!path.startsWith("/")) return path;
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

export function LocationDialog({
  title,
  targets,
  preselect,
  userHome,
  listDir,
  addFolder,
  pick,
  addPlace,
  original,
  hint,
  onChoose,
  onClose,
}: {
  title: string;
  targets: readonly MoveTarget[];
  /** The place to highlight on opening (the last one chosen); ignored when it is not among `targets`. */
  preselect: string | null;
  userHome: string | null;
  listDir: (path: string) => Promise<Listing>;
  /**
   * Make a new folder at a full path; rejects with the refusal. What it resolves
   * with may carry the `path` made (the daemon's reply), which is looked for
   * too. Absent, not offered.
   */
  addFolder?: (path: string) => Promise<unknown>;
  /**
   * The OS's own picker. Given, a button opens its folder dialog; absent (a
   * system with none), no button.
   */
  pick?: PickPaths;
  /**
   * Add a folder outside every set to the context, as a set; rejects with the
   * refusal, which the dialog shows. Absent, not offered.
   */
  addPlace?: (path: string) => Promise<unknown>;
  /** The ask's `original`: offered as "Add the original file…" when there is a picker. */
  original?: LocationAsk["original"];
  /** The app's own words under the list: how else to make room. */
  hint?: ReactNode;
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => filterMoveTargets(targets, query), [targets, query]);
  // The highlight is held by path, so a snapshot that adds or drops a place
  // while the dialog is open never moves it onto another one.
  const [atPath, setAtPath] = useState<string | null>(() =>
    preselect && targets.some((t) => t.path === preselect) ? preselect : null,
  );
  const at = atPath === null ? -1 : shown.findIndex((t) => t.path === atPath);
  // A folder asked for by path, by every name it may show under: highlighted
  // once the context shows it.
  const [making, setMaking] = useState<readonly string[] | null>(null);
  const [makingSay, setMakingSay] = useState("Making");
  const [refusal, setRefusal] = useState<string | null>(null);
  // A folder the picker chose that no set shows: named, with the act that adds it.
  const [outside, setOutside] = useState<string | null>(null);
  // Which OS dialog is open, if one is: a second is not asked for meanwhile.
  const [picking, setPicking] = useState<PickAnswerWant | null>(null);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const made = making && targets.find((t) => making.includes(t.path));
    if (made) {
      setAtPath(made.path);
      // Back to the search, so the next Enter makes it there, not another folder.
      searchRef.current?.focus();
      setMaking(null);
    }
  }, [making, targets]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${at}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [at]);

  const search = (q: string) => {
    setQuery(q);
    // A search highlights its first match; clearing it highlights nothing.
    setAtPath(q.trim() === "" ? null : (filterMoveTargets(targets, q)[0]?.path ?? null));
  };
  const choose = (t: MoveTarget | undefined) => {
    if (!t) return;
    onChoose(t.path);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setAtPath(shown[Math.min(at + 1, shown.length - 1)]?.path ?? null);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAtPath(shown[Math.max(at - 1, 0)]?.path ?? null);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(shown[at]);
    }
  };
  // The OS's folder dialog. A dismissed one changes nothing; a folder the
  // context shows is highlighted, so Enter (or a click) puts it there.
  const browse = () => {
    if (!pick || picking) return;
    setPicking("choose-folder");
    pick("choose-folder").then(
      (paths) => {
        setPicking(null);
        const p = paths[0];
        // Dismissed: nothing changes, and the keyboard is back where it was.
        if (p === undefined) return searchRef.current?.focus();
        setRefusal(null);
        const at = targets.find((t) => t.path === p);
        if (at) {
          setOutside(null);
          setQuery("");
          setAtPath(at.path);
        } else setOutside(p);
        searchRef.current?.focus();
      },
      (e: unknown) => {
        setPicking(null);
        setRefusal(e instanceof Error ? e.message : String(e));
      },
    );
  };
  // The OS's file dialog, for a drop: the files chosen are added where they
  // live and the ask ends; a dismissed dialog leaves the ask as it was.
  const addOriginal = () => {
    if (!pick || !original || picking) return;
    setPicking("choose-file");
    pick("choose-file").then(
      (paths) => {
        setPicking(null);
        if (paths.length === 0) return;
        original.add(paths);
        onClose();
      },
      (e: unknown) => {
        setPicking(null);
        setRefusal(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const bringIn = (path: string) => {
    if (!addPlace) return;
    setOutside(null);
    setRefusal(null);
    setMakingSay("Adding");
    const names = [path];
    setMaking(names);
    addPlace(path).then(
      () => {},
      (e: unknown) => {
        // Still this ask: the line that waited on it goes, and the reason shows.
        setMaking((cur) => (cur === names ? null : cur));
        setRefusal(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const make = (typed: string) => {
    if (!addFolder) return;
    const full = placePath(typed, userHome);
    const names = [full];
    setRefusal(null);
    setQuery("");
    setMakingSay("Making");
    setMaking(names);
    addFolder(typed).then(
      (r) => {
        const said = (r as { path?: unknown } | null | undefined)?.path;
        // Still this ask (not a later one): also look for the name the maker gave.
        if (typeof said === "string" && said !== full)
          setMaking((cur) => (cur === names ? [full, said] : cur));
      },
      (e: unknown) => {
        setMaking(null);
        setRefusal(e instanceof Error ? e.message : String(e));
      },
    );
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
          // Base UI's trap lets Tab out; the page behind is made inert instead.
          ref={inertOutsideRef}
          data-slot="location-dialog"
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[70vh] w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 flex-col gap-2 rounded-xl border border-edge bg-surface p-3 text-ink shadow-lg duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <Dialog.Title className="truncate text-sm font-semibold text-ink">{title}</Dialog.Title>
          {pick && original && (
            <Button
              variant="outline"
              size="sm"
              className="justify-start"
              disabled={picking !== null}
              onClick={addOriginal}
            >
              <FileIcon />
              {picking === "choose-file"
                ? "Choosing…"
                : original.files > 1
                  ? "Add the original files…"
                  : "Add the original file…"}
            </Button>
          )}
          <input
            value={query}
            onChange={(e) => search(e.target.value)}
            onKeyDown={onKey}
            ref={searchRef}
            // biome-ignore lint/a11y/noAutofocus: the human asked to make something; choosing its place is the way on.
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
          {pick && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-start"
              disabled={picking !== null}
              onClick={browse}
            >
              <FolderOpenIcon />
              {picking === "choose-folder" ? "Choosing a folder…" : "Choose a folder…"}
            </Button>
          )}
          {outside && (
            <div className="flex flex-col gap-1 px-1 text-xs text-ink-faint">
              <p>{tildify(outside, userHome)} is not in a set yet.</p>
              {addPlace && (
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => bringIn(outside)}
                >
                  Add it as a set
                </Button>
              )}
            </div>
          )}
          {shown.length === 0 ? (
            <p className="px-1 py-2 text-xs text-ink-faint">
              {targets.length > 0
                ? "No set or folder matches."
                : addFolder
                  ? "There is no set to put it in yet. Make a folder at a path below, or add a folder to the context."
                  : "There is no set to put it in yet. Add a folder to the context first."}
            </p>
          ) : (
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              aria-label="Places"
              className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto"
            >
              {shown.map((t, i) => {
                const Icon = t.kind === "set" ? FolderTreeIcon : FolderIcon;
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
                    onMouseMove={() => setAtPath(t.path)}
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
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {addFolder && (
            <AddPath
              listDir={listDir}
              foldersOnly
              verb="makes it"
              placeholder="New folder at a path…"
              onAdd={make}
            />
          )}
          {making && (
            <p role="status" className="px-1 py-2 text-xs text-ink-faint">
              {makingSay} {making[0]}…
            </p>
          )}
          {refusal && <p className="px-2 py-1 text-xs text-attention">{refusal}</p>}
          {hint && <p className="px-1 py-2 text-xs text-ink-faint">{hint}</p>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The `askLocation` slot, ready to pass, and the dialog to render beside it.
 * One ask at a time: a second one answers the first with null.
 */
export function useAskLocation({
  entries,
  userHome,
  listDir,
  addFolder,
  pick,
  addPlace,
  hint,
}: {
  entries: readonly ContextEntry[];
  userHome: string | null;
  listDir: (path: string) => Promise<Listing>;
  addFolder?: (path: string) => Promise<unknown>;
  /** The OS's own picker; absent where the system has none, and its button with it. */
  pick?: PickPaths;
  /** Add a folder the picker chose, outside every set, to the context as a set; rejects with the refusal. */
  addPlace?: (path: string) => Promise<unknown>;
  hint?: ReactNode;
}): { askLocation: AskLocation; dialog: ReactNode; last: string | null } {
  const [asking, setAsking] = useState<{
    ask: LocationAsk;
    answer: (dir: string | null) => void;
    seq: number;
  } | null>(null);
  const seq = useRef(0);
  const [last, setLast] = useState<string | null>(null);
  const pending = useRef<((dir: string | null) => void) | null>(null);

  const askLocation = useCallback<AskLocation>(
    (ask) =>
      new Promise<string | null>((resolve) => {
        pending.current?.(null);
        const answer = (dir: string | null) => {
          if (pending.current !== answer) return;
          pending.current = null;
          setAsking(null);
          resolve(dir);
        };
        pending.current = answer;
        setAsking({ ask, answer, seq: ++seq.current });
      }),
    [],
  );
  // An ask still open when the surface goes is answered, so nothing waits on it.
  useEffect(() => () => pending.current?.(null), []);

  const targets = useMemo(
    () => (asking ? locationTargets(entries, asking.ask.what) : []),
    [entries, asking],
  );
  const dialog = asking ? (
    <LocationDialog
      key={asking.seq}
      title={asking.ask.title}
      targets={targets}
      preselect={last}
      userHome={userHome}
      listDir={listDir}
      addFolder={addFolder}
      pick={pick}
      addPlace={addPlace}
      original={asking.ask.original}
      hint={hint}
      onChoose={(dir) => {
        setLast(dir);
        asking.answer(dir);
      }}
      onClose={() => asking.answer(null)}
    />
  ) : null;
  return { askLocation, dialog, last };
}
