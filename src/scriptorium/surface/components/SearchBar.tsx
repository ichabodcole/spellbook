// The header's search bar (E59) — Cole's shape: "a search bar in the header,
// centered… if you start typing we'll give you a list of files where there's a
// match, and you can click one and it opens that file."
//
// ⛔ TWO GROUPS, BECAUSE THERE ARE TWO KINDS OF ANSWER. "Documents" is fuzzy on
// names — the jump list, for when you know what the thing is called. "In text"
// is an exact phrase match with the line it is on — the find list, for when you
// remember what you wrote and not where. Collapsing them into one ranked list
// would mean either fuzzy-matching prose (noise, and no trustworthy line
// numbers) or refusing to fuzzy-match names at all.
//
// ⚠ THE DAEMON ANSWERS; THIS DOES NOT SEARCH. Which is what lets the results
// include a document's ACTIVE VERSION rather than the file on disk — see
// `Session.searchAll`.
import { cn } from "cn";
import { FileTextIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SearchReport } from "../../backend/protocol";

/** Typing pause before asking. Long enough not to search every keystroke. */
const DEBOUNCE_MS = 140;

export function SearchBar({
  report,
  onQuery,
  onOpen,
}: {
  /** The daemon's last answer, whatever it was for. */
  report: SearchReport | null;
  /** Ask; an empty string means "stop, I am done". */
  onQuery: (query: string) => void;
  /**
   * Open a result. `at` is the offsets of the hit, present only for a text
   * match — the document then opens AND scrolls to it.
   */
  onOpen: (target: { slug?: string; path: string; at?: { from: number; to: number } }) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);

  // Debounced ask. Clearing the box tells the daemon to stop rather than
  // leaving a stale answer behind it.
  useEffect(() => {
    const q = query.trim();
    if (q === "") {
      onQuery("");
      return;
    }
    const t = setTimeout(() => onQuery(q), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, onQuery]);

  // ⌘K focuses it from anywhere — the shortcut every search box in every tool
  // has, and cheaper to support than to explain its absence.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        field.current?.focus();
        field.current?.select();
        return;
      }
      if (e.key === "Escape" && open) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  // ⛔ A STALE ANSWER IS DROPPED, NOT SHOWN. Replies are asynchronous and the
  // human keeps typing, so an answer for "mar" must not be rendered under a box
  // that now reads "maren" — the results would be for a question they have
  // already moved past, which is worse than an empty pane.
  const q = query.trim();
  const fresh = report && report.query === q ? report : null;
  const showing = open && q !== "";
  const nothing = fresh !== null && fresh.documents.length === 0 && fresh.text.length === 0;

  return (
    <div ref={box} className="relative w-full max-w-md">
      <div className="flex items-center gap-1.5 rounded-md border border-edge bg-bg px-2 py-1">
        <SearchIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
        <input
          ref={field}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search documents (⌘K)"
          aria-label="Search documents"
          spellCheck={false}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-xs text-ink outline-none",
            "placeholder:text-ink-faint",
          )}
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
            <XIcon className="size-3" />
          </button>
        )}
      </div>

      {showing && (
        <div
          // Results are a listbox of two groups; the container scrolls so a
          // common word cannot push the pane off the screen.
          className={cn(
            "absolute top-full right-0 left-0 z-50 mt-1 max-h-[60vh] overflow-auto",
            "rounded-md border border-edge bg-surface-raised shadow-lg",
          )}
        >
          {fresh === null ? (
            <p className="px-3 py-2 text-xs text-ink-faint">Searching…</p>
          ) : nothing ? (
            <p className="px-3 py-2 text-xs text-ink-dim">
              Nothing matches <span className="font-mono text-ink">{q}</span>.
            </p>
          ) : (
            <>
              {fresh.documents.length > 0 && (
                <section>
                  <h2 className="px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide text-ink-faint uppercase">
                    Documents
                  </h2>
                  {fresh.documents.map((d) => (
                    <button
                      key={`name:${d.path}`}
                      type="button"
                      onClick={() => {
                        onOpen({ path: d.path, ...(d.slug ? { slug: d.slug } : {}) });
                        setOpen(false);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-bg"
                    >
                      <FileTextIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
                      <span className="truncate text-ink">{d.name}</span>
                      {d.title && d.title !== d.name && (
                        <span className="truncate text-ink-faint">{d.title}</span>
                      )}
                    </button>
                  ))}
                </section>
              )}

              {fresh.text.length > 0 && (
                <section className="border-t border-edge">
                  <h2 className="px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide text-ink-faint uppercase">
                    In text ({fresh.count}
                    {/* A capped answer must not read as a complete one. */}
                    {fresh.truncated ? "+" : ""})
                  </h2>
                  {fresh.text.map((t) => (
                    <div key={`text:${t.path}`}>
                      <p className="truncate px-3 pt-1.5 text-[11px] text-ink-dim">
                        {t.name}
                        {t.version !== undefined && (
                          <span className="text-ink-faint"> · v{t.version}</span>
                        )}
                      </p>
                      {t.hits.map((h) => (
                        <button
                          key={`${t.path}:${h.from}`}
                          type="button"
                          onClick={() => {
                            onOpen({
                              path: t.path,
                              ...(t.slug ? { slug: t.slug } : {}),
                              at: { from: h.from, to: h.to },
                            });
                            setOpen(false);
                          }}
                          className="flex w-full items-baseline gap-2 px-3 py-1 text-left hover:bg-bg"
                        >
                          <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                            {h.line}
                          </span>
                          <span className="truncate font-mono text-[11px] text-ink">
                            {h.text.trim()}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
