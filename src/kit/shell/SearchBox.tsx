// The header's search box: type, see documents whose names match and lines whose
// text matches, choose one, and the document opens at the match.
//
// Two groups, because there are two kinds of answer. "Documents" is fuzzy on
// names, the jump list for when you know what the thing is called. "In text" is
// an exact phrase with its line, the find list for when you remember what you
// wrote and not where. Its hits are grouped under their file, with a count, so
// many hits in one file read as one place and not as a list of the same name.
//
// The daemon answers; this does not search. That is what lets a result come from
// a document's ACTIVE VERSION, including an edit not saved yet, rather than from
// the file on disk.

import { FileTextIcon, ImageIcon, SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ServerFrame } from "../context/daemonClient.ts";
import { cn } from "../lib/cn.ts";
import { onMac } from "../lib/platform.ts";
import type { ClientOp, SearchReport, SearchResult } from "../workspace/protocol";

/** Typing pause before asking: long enough not to search every keystroke. */
export const SEARCH_DEBOUNCE_MS = 140;
/** How many results one ask wants. */
const ASK_LIMIT = 30;

// Whether this is a Mac, where the shortcut is Cmd-K and Ctrl-K belongs to the editor.
export { onMac };

/**
 * Is this key event the search shortcut? Cmd-K on a Mac, Ctrl-K elsewhere. On a
 * Mac, Ctrl-K is the editor's own "delete to the end of the line", so it is left
 * alone there.
 */
export function isSearchShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  mac: boolean = onMac(),
): boolean {
  if (e.key.toLowerCase() !== "k" || e.shiftKey || e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/** One file's text hits, under the name the list shows for it. */
export type TextGroup = { key: string; label: string; hits: SearchResult[] };

/** What the file's heading says: an image's description, a bundle, or the document's name. */
function fileLabel(r: SearchResult): string {
  const imageName = r.image ? r.image.slice(r.image.lastIndexOf("/") + 1) : null;
  const name = imageName
    ? `${imageName} · description`
    : r.bundle
      ? `in the ${r.bundle.label} ${r.bundle.name}`
      : r.name;
  return !imageName && r.version !== null ? `${name} · v${r.version}` : name;
}

/**
 * The results as the list draws them: the name matches as they came, then the
 * text hits grouped by file, each file where its first hit was and its hits in
 * the order they came. `ordered` is the same results in drawn order, which is
 * the order the arrows walk.
 */
export function groupResults(results: readonly SearchResult[]): {
  names: SearchResult[];
  files: TextGroup[];
  ordered: SearchResult[];
} {
  const names = results.filter((r) => r.kind === "name");
  const byFile = new Map<string, TextGroup>();
  for (const r of results) {
    if (r.kind !== "text") continue;
    const group = byFile.get(r.path);
    if (group) group.hits.push(r);
    else byFile.set(r.path, { key: r.path, label: fileLabel(r), hits: [r] });
  }
  const files = [...byFile.values()];
  return { names, files, ordered: [...names, ...files.flatMap((f) => f.hits)] };
}

export function SearchBox({
  request,
  connected,
  onOpen,
  className,
}: {
  /** The daemon's request, so the answer is awaited and a stale one can be told apart. */
  request: (op: ClientOp) => Promise<ServerFrame>;
  connected: boolean;
  /** Open a result: the shell decides how (open the document, then show the match). */
  onOpen: (result: SearchResult) => void;
  /** Added to the box's own classes (the shell's quiet fade). */
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<SearchReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  // Focus is asked for by a counter, because a collapsed box has no input on screen
  // until the render that opens it.
  const [focusSeq, setFocusSeq] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const listId = useId();
  const mac = onMac();
  const q = query.trim();

  // The shortcut works from anywhere, the editor included, so it is caught on the
  // way down.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isSearchShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
      setFocusSeq((n) => n + 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (focusSeq === 0) return;
    field.current?.focus();
    field.current?.select();
  }, [focusSeq]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  // A debounced ask. The reply for "mar" must not be shown under a box that now
  // reads "maren", so a reply is kept only if its query is still the box's.
  useEffect(() => {
    if (q === "") {
      setReport(null);
      setFailure(null);
      return;
    }
    if (!connected) return;
    let current = true;
    const t = setTimeout(() => {
      request({ op: "search", query: q, limit: ASK_LIMIT })
        .then((frame) => {
          if (!current) return;
          setFailure(null);
          setReport(frame as unknown as SearchReport);
          setActive(0);
        })
        .catch((e: unknown) => {
          if (current) setFailure(e instanceof Error ? e.message : String(e));
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [q, connected, request]);

  const fresh = report && report.query === q ? report : null;
  const grouped = groupResults(fresh?.results ?? []);
  const results = grouped.ordered;
  const showing = open && q !== "";

  const choose = useCallback(
    (r: SearchResult) => {
      setOpen(false);
      field.current?.blur();
      onOpen(r);
    },
    [onOpen],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      // Closing the results is this box's; the shell's own Escape must not also act.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      field.current?.blur();
      return;
    }
    if (!showing || results.length === 0) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active];
      if (r) choose(r);
    }
  };

  useEffect(() => {
    if (!showing) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [showing, active, listId]);

  return (
    // The box takes the top bar's middle column, centred. Narrower than 9rem it is an
    // icon that opens the input (a click or the shortcut), laid over the bar while it
    // is in use, so it never covers the title or the session's buttons at rest.
    <div
      ref={box}
      data-slot="search-box"
      className={cn("@container relative flex h-6 min-w-6 flex-1 justify-center", className)}
    >
      <button
        type="button"
        aria-label="Search documents"
        title={`Search (${mac ? "⌘K" : "Ctrl K"})`}
        onClick={() => {
          setOpen(true);
          setFocusSeq((n) => n + 1);
        }}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-faint outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60 @min-[9rem]:hidden [&_svg]:size-3.5",
          open && "hidden",
        )}
      >
        <SearchIcon aria-hidden />
      </button>
      <div
        className={cn(
          "h-6 w-full max-w-md items-center gap-1.5 rounded-md border border-edge bg-bg px-2 focus-within:ring-2 focus-within:ring-ring/60 @max-[9rem]:absolute @max-[9rem]:top-0 @max-[9rem]:left-1/2 @max-[9rem]:z-50 @max-[9rem]:-translate-x-1/2 @max-[9rem]:w-56",
          open ? "flex" : "hidden @min-[9rem]:flex",
        )}
      >
        <SearchIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
        <input
          ref={field}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={`Search (${mac ? "⌘K" : "Ctrl K"})`}
          aria-label="Search documents"
          role="combobox"
          aria-expanded={showing}
          aria-controls={listId}
          aria-activedescendant={showing && results.length > 0 ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
        />
        {q !== "" && (
          <button
            type="button"
            aria-label="Clear the search"
            onClick={() => {
              setQuery("");
              setOpen(false);
              field.current?.focus();
            }}
            className="shrink-0 rounded-sm p-0.5 text-ink-faint hover:text-ink"
          >
            <XIcon aria-hidden className="size-3" />
          </button>
        )}
      </div>

      {showing && (
        <div
          data-slot="search-results"
          className="absolute top-full left-1/2 z-50 mt-1 -translate-x-1/2 max-h-[60vh] w-[min(30rem,90vw)] overflow-auto rounded-md border border-edge bg-surface-raised shadow-lg"
        >
          {failure ? (
            <p className="px-3 py-2 text-xs text-ink-dim">The search failed: {failure}</p>
          ) : !connected ? (
            <p className="px-3 py-2 text-xs text-ink-dim">The workspace daemon is not answering.</p>
          ) : fresh === null ? (
            <p className="px-3 py-2 text-xs text-ink-faint">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-dim">
              Nothing matches <span className="font-mono text-ink">{q}</span>.
            </p>
          ) : (
            <div role="listbox" id={listId} aria-label="Search results">
              {grouped.names.length > 0 && (
                <div>
                  <h2 className="px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide text-ink-faint uppercase">
                    Documents
                  </h2>
                  {grouped.names.map((r, i) => (
                    <Row
                      key={`name:${r.path}`}
                      id={`${listId}-${i}`}
                      result={r}
                      active={i === active}
                      onHover={() => setActive(i)}
                      onChoose={() => choose(r)}
                    />
                  ))}
                </div>
              )}
              {grouped.files.length > 0 && (
                <h2 className="px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide text-ink-faint uppercase">
                  In text ({results.length - grouped.names.length}
                  {fresh.truncated ? ", and more" : ""})
                </h2>
              )}
              {grouped.files.map((f) => (
                <div key={f.key} data-slot="search-file">
                  <div className="flex items-baseline gap-2 px-3 pt-1 text-[11px]">
                    <span className="min-w-0 truncate text-ink">{f.label}</span>
                    <span data-slot="search-file-count" className="shrink-0 text-ink-faint">
                      {f.hits.length}
                    </span>
                  </div>
                  {f.hits.map((r) => {
                    const i = results.indexOf(r);
                    return (
                      <Row
                        key={`text:${r.path}:${r.from ?? ""}`}
                        id={`${listId}-${i}`}
                        result={r}
                        fileLabel={f.label}
                        active={i === active}
                        onHover={() => setActive(i)}
                        onChoose={() => choose(r)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  id,
  result: r,
  fileLabel,
  active,
  onHover,
  onChoose,
}: {
  id: string;
  result: SearchResult;
  /** A text hit's file, drawn as the group's heading above it: here only for a screen reader. */
  fileLabel?: string;
  active: boolean;
  onHover: () => void;
  onChoose: () => void;
}) {
  // A hit in an image's description stands for the image: its name, its icon,
  // and choosing it opens the image.
  const imageName = r.image ? r.image.slice(r.image.lastIndexOf("/") + 1) : null;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the input owns the keyboard (aria-activedescendant); a row is only clicked.
    <div
      id={id}
      role="option"
      tabIndex={-1}
      aria-selected={active}
      data-kind={r.kind}
      data-image={r.image ? "" : undefined}
      onMouseMove={onHover}
      // A press must not move focus out of the input before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onChoose}
      className={cn(
        "flex cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left text-xs",
        active && "bg-bg",
      )}
    >
      {r.kind === "name" ? (
        <>
          {imageName ? (
            <ImageIcon aria-hidden className="size-3.5 shrink-0 translate-y-0.5 text-ink-faint" />
          ) : (
            <FileTextIcon
              aria-hidden
              className="size-3.5 shrink-0 translate-y-0.5 text-ink-faint"
            />
          )}
          <span className="truncate text-ink">{imageName ?? r.name}</span>
          {imageName ? (
            <span className="shrink-0 text-ink-faint">description</span>
          ) : r.bundle ? (
            <span className="shrink-0 text-ink-faint">{r.bundle.label}</span>
          ) : (
            r.version !== null && <span className="shrink-0 text-ink-faint">v{r.version}</span>
          )}
        </>
      ) : (
        <>
          <span className="w-7 shrink-0 text-right font-mono text-[10px] text-ink-faint">
            {r.line}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-dim">
            <Highlighted text={r.snippet ?? ""} from={r.snippetFrom} to={r.snippetTo} />
            {fileLabel && <span className="sr-only">, in {fileLabel}</span>}
          </span>
        </>
      )}
    </div>
  );
}

/** A snippet with the match marked. Without offsets it is shown plain. */
export function Highlighted({ text, from, to }: { text: string; from?: number; to?: number }) {
  if (from === undefined || to === undefined || from >= to || to > text.length) return <>{text}</>;
  return (
    <>
      {text.slice(0, from)}
      <mark data-slot="search-match" className="rounded-sm bg-attention/30 text-ink">
        {text.slice(from, to)}
      </mark>
      {text.slice(to)}
    </>
  );
}
