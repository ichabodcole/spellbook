// The link picker: find a document or an image in the session, optionally say
// how this one relates to it, and the editor gets a markdown link to it (or an
// embed, for an image: `linkInsert.ts`). One card for every
// way in (Add link on a selection, Mod-Shift-K, `](` and `[[` typed), anchored
// where the link is being written.
//
// The list is ranked here, in the browser, with the header search's name
// scorer, because the daemon has already sent every target: a round trip per
// keystroke would make a completion lag behind the typing it completes.
//
// HEADINGS ARE A SECOND STEP (kit-heading-links-build). With a document
// highlighted, `#` (or the right arrow at the end of the search) lists that
// document's headings, asked for then and for that document alone; choosing one
// writes the link with the heading's anchor. Backspace on an empty search, or
// the left arrow at its start, goes back to the documents.
//
// A LINK WITH NO SELECTION UNDER IT TAKES ITS TEXT HERE. Inserting a link at the
// caret (the right-click menu's Insert a link, or the shortcut with nothing
// selected) has no words to wrap, so the card asks for them; left empty, the
// link reads as the document's name, as it always did.
//
// RELATIONS ARE OPTIONAL AND NEVER DEFAULTED. The vocabulary offered is what the
// session's documents already write in `?rel=` (the world's own words, most used
// first), and anything else can be typed. Choose none and the link is bare.

import { ChevronLeftIcon, FileTextIcon, HashIcon, ImageIcon, LinkIcon, XIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { placeCard } from "../chat/NoteAtSelection.tsx";
import { cn } from "../lib/cn.ts";
import { decodePath } from "../lib/linkTarget.ts";
import type {
  HeadingOffer,
  KindRelationUse,
  LinkTarget,
  RelationOffer,
} from "../workspace/protocol";
import {
  hasRelation,
  type LinkKind,
  normaliseRelation,
  type RankedRelation,
  rankHeadings,
  rankRelations,
  rankTargets,
  stem,
  suggestRelations,
} from "./linkInsert.ts";

const CARD_W = 320;
/** How many unchosen relations are offered at once. */
const SUGGESTIONS = 12;

export function LinkPicker({
  at,
  kind,
  quote,
  initialQuery = "",
  targets,
  relations,
  byKind = [],
  vocabulary = false,
  failure,
  onHeadings,
  onChoose,
  onClose,
}: {
  at: { x: number; y: number };
  kind: LinkKind;
  /** The text being linked, for `wrap` over a selection; empty otherwise. */
  quote: string;
  /** What the search box starts with: keys typed after `](` or `[[` before the picker opened. */
  initialQuery?: string;
  /** Every document a link can point at; null while they are being asked for. */
  targets: LinkTarget[] | null;
  /** The relations the session already uses, and those its vocabulary declares. */
  relations: readonly RelationOffer[];
  /** How links into each kind use each relation: what the target in view ranks them by. */
  byKind?: readonly KindRelationUse[];
  /** Whether a vocabulary is in force: only then is a used relation "not declared". */
  vocabulary?: boolean;
  /** Why the targets could not be had, when they could not. */
  failure: string | null;
  /** A document's headings, for the second step; absent, `#` is only a character. */
  onHeadings?: (target: LinkTarget) => Promise<HeadingOffer[]>;
  /**
   * A choice: the target, the relations, the heading when one was chosen, and
   * the link's text when one was typed (a link at the caret only).
   */
  onChoose: (
    target: LinkTarget,
    relations: string[],
    heading?: HeadingOffer,
    label?: string,
  ) => void;
  /** Closed without a choice (Escape, a click outside), with what the search box held. */
  onClose: (query: string) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const queryRef = useRef(query);
  queryRef.current = query;
  const [active, setActive] = useState(0);
  const [chosen, setChosen] = useState<string[]>([]);
  const [relText, setRelText] = useState("");
  /** The link's text, asked for only when there is no selection to be it. */
  const labelled = kind === "wrap" && quote === "";
  const [label, setLabel] = useState("");
  const card = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const listId = useId();

  const ranked = useMemo(() => rankTargets(targets ?? [], query), [targets, query]);
  /** The second step: the document whose headings are listed, and the search to go back to. */
  const [step, setStep] = useState<{
    target: LinkTarget;
    headings: HeadingOffer[] | null;
    failure: string | null;
    back: string;
  } | null>(null);
  const rankedHeadings = useMemo(
    () => (step?.headings ? rankHeadings(step.headings, query) : []),
    [step, query],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the best match.
  useEffect(() => setActive(0), [query]);

  // Placed again once the targets and the relations arrive: the card is short
  // while they are asked for, and with a relation list it grows enough to run
  // off the bottom of the window from where the short card was placed.
  const loaded = targets !== null;
  const hasRelations = relations.length > 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `loaded` and `hasRelations` change the card's height, which is what is measured.
  useLayoutEffect(() => {
    if (!card.current) return;
    setPos(
      placeCard(at, card.current.offsetHeight, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [at, loaded, hasRelations]);

  useEffect(() => {
    // The caret at the end, so a key typed before the picker opened is followed, not preceded.
    const f = field.current;
    f?.focus();
    f?.setSelectionRange(f.value.length, f.value.length);
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (card.current && !card.current.contains(e.target as Node)) onClose(queryRef.current);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [onClose]);

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, listId]);

  const addRelation = (typed: string) => {
    const r = normaliseRelation(typed);
    if (r !== "" && !hasRelation(chosen, r)) setChosen((c) => [...c, r]);
    setRelText("");
  };

  /** What is chosen, and what is typed in the relation field but not yet added: it is on screen. */
  const relationsNow = () => {
    const pending = normaliseRelation(relText);
    return pending !== "" && !hasRelation(chosen, pending) ? [...chosen, pending] : chosen;
  };

  const labelNow = () => (labelled && label.trim() !== "" ? label.trim() : undefined);
  const choose = (t: LinkTarget | undefined) => {
    if (t) onChoose(t, relationsNow(), undefined, labelNow());
  };
  const chooseHeading = (h: HeadingOffer | undefined) => {
    if (step && h) onChoose(step.target, relationsNow(), h, labelNow());
  };
  /** Enter, or Enter in the relation field: the row in view, in whichever step. */
  const chooseActive = () =>
    step ? chooseHeading(rankedHeadings[active]) : choose(ranked[active]);

  /** Into the second step for the highlighted document; false when it has no headings to ask for. */
  const enterHeadings = (): boolean => {
    const t = ranked[active];
    if (!t || t.image || !onHeadings || failure || targets === null) return false;
    setStep({ target: t, headings: null, failure: null, back: query });
    setQuery("");
    setActive(0);
    onHeadings(t)
      .then((headings) => setStep((s) => (s && s.target.path === t.path ? { ...s, headings } : s)))
      .catch((e: unknown) =>
        setStep((s) =>
          s && s.target.path === t.path
            ? { ...s, failure: e instanceof Error ? e.message : String(e) }
            : s,
        ),
      );
    return true;
  };
  const leaveHeadings = () => {
    if (!step) return;
    setQuery(step.back);
    setStep(null);
    field.current?.focus();
  };

  const listShown = step
    ? step.headings !== null && rankedHeadings.length > 0
    : !failure && targets !== null && ranked.length > 0;
  const rows = step ? rankedHeadings.length : ranked.length;
  // Ranked for the target in view: the one Enter would link to.
  const targetKind = step ? step.target.kind : listShown ? ranked[active]?.kind : undefined;
  const ordered = useMemo(
    () => rankRelations(relations, byKind, targetKind),
    [relations, byKind, targetKind],
  );
  const suggestions = suggestRelations(ordered, chosen, relText, SUGGESTIONS);

  const onCardKey = (e: React.KeyboardEvent) => {
    if (e.key === "Tab") {
      // Focus stays in the card: Tab past the last control comes round to the
      // first, and Shift-Tab before the first to the last.
      const stops = [
        ...(card.current?.querySelectorAll<HTMLElement>("input, button:not([tabindex='-1'])") ??
          []),
      ];
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!first || !last) return;
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
      return;
    }
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose(queryRef.current);
  };

  const onFieldKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const f = e.currentTarget;
    const atEnd = f.selectionStart === f.value.length && f.selectionEnd === f.value.length;
    const atStart = f.selectionStart === 0 && f.selectionEnd === 0;
    if (!step && (e.key === "#" || (e.key === "ArrowRight" && atEnd))) {
      if (enterHeadings()) e.preventDefault();
      return;
    }
    if (step && ((e.key === "Backspace" && query === "") || (e.key === "ArrowLeft" && atStart))) {
      e.preventDefault();
      leaveHeadings();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows === 0) return;
      const by = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + by + rows) % rows);
    } else if (e.key === "Enter") {
      e.preventDefault();
      chooseActive();
    }
  };

  const onRelationKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // A relation being typed is added first; Enter on an empty field links.
      if (relText.trim() !== "") addRelation(relText);
      else chooseActive();
    } else if (e.key === ",") {
      e.preventDefault();
      addRelation(relText);
    } else if (e.key === "Backspace" && relText === "" && chosen.length > 0) {
      setChosen((c) => c.slice(0, -1));
    }
  };

  const shownQuote = quote.replace(/\s+/gu, " ").trim();

  return (
    <div
      ref={card}
      data-slot="link-picker"
      role="dialog"
      aria-label="Add a link"
      onKeyDown={onCardKey}
      style={{ left: pos?.left ?? at.x, top: pos?.top ?? at.y, width: CARD_W }}
      className={cn(
        "fixed z-50 flex flex-col rounded-md border border-edge bg-surface-raised text-ink shadow-lg",
        pos ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-edge px-2 py-1.5">
        <LinkIcon aria-hidden className="size-3.5 shrink-0 text-ink-faint" />
        <input
          ref={field}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFieldKey}
          placeholder={
            step
              ? `A heading in ${stem(step.target.name)}…`
              : kind === "wrap" && shownQuote
                ? `Link “${shownQuote}” to…`
                : "Link to…"
          }
          aria-label={step ? "Find a heading to link to" : "Find a document to link to"}
          role="combobox"
          aria-expanded={listShown}
          aria-controls={listShown ? listId : undefined}
          aria-activedescendant={listShown ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
        />
      </div>
      {/* Not a tab stop: the field drives the list (aria-activedescendant). */}
      <div tabIndex={-1} className="max-h-60 overflow-auto p-1">
        {step ? (
          <HeadingStep
            listId={listId}
            name={stem(step.target.name)}
            headings={step.headings}
            ranked={rankedHeadings}
            failure={step.failure}
            active={active}
            onActive={setActive}
            onBack={leaveHeadings}
            onChoose={chooseHeading}
          />
        ) : failure ? (
          <p className="px-2 py-1.5 text-xs text-ink-dim">
            The documents could not be listed: {failure}
          </p>
        ) : targets === null ? (
          <p className="px-2 py-1.5 text-xs text-ink-faint">Listing documents…</p>
        ) : ranked.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-ink-dim">
            {targets.length === 0
              ? "No other documents or images in this session."
              : "Nothing matches."}
          </p>
        ) : (
          <div role="listbox" id={listId} aria-label="Documents and images">
            {ranked.map((t, i) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the field owns the keyboard (aria-activedescendant); a row is only clicked.
              <div
                key={t.path}
                id={`${listId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                data-path={t.path}
                onMouseMove={() => setActive(i)}
                // A press must not take focus from the field before the click lands.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(t)}
                className={cn(
                  "flex cursor-pointer items-baseline gap-2 rounded-sm px-2 py-1 text-xs",
                  i === active && "bg-bg",
                )}
              >
                {t.image ? (
                  <ImageIcon
                    aria-hidden
                    data-kind="image"
                    className="size-3.5 shrink-0 translate-y-0.5 text-ink-faint"
                  />
                ) : (
                  <FileTextIcon
                    aria-hidden
                    className="size-3.5 shrink-0 translate-y-0.5 text-ink-faint"
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ink">{stem(t.name)}</span>
                  {t.description && (
                    <span
                      data-slot="picker-description"
                      className="block truncate text-[11px] text-ink-dim"
                    >
                      {t.description}
                    </span>
                  )}
                  <span className="block truncate font-mono text-[10px] text-ink-faint">
                    {t.shown}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1 border-t border-edge px-2 py-1.5">
        {labelled && (
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              chooseActive();
            }}
            placeholder="Link text (the document's name if empty)"
            aria-label="Link text"
            autoComplete="off"
            data-slot="link-label"
            className="w-full bg-transparent text-[11px] text-ink outline-none placeholder:text-ink-faint"
          />
        )}
        <div className="flex flex-wrap items-center gap-1">
          {chosen.map((r) => (
            <span
              key={r}
              data-slot="link-relation"
              className="inline-flex items-center gap-0.5 rounded-sm bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink"
            >
              {r}
              <button
                type="button"
                aria-label={`Remove the relation ${r}`}
                onClick={() => setChosen((c) => c.filter((x) => x !== r))}
                className="rounded-sm text-ink-faint hover:text-ink"
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            </span>
          ))}
          <input
            value={relText}
            onChange={(e) => setRelText(e.target.value)}
            onKeyDown={onRelationKey}
            placeholder={chosen.length === 0 ? "Relation (optional)" : "Another relation"}
            aria-label="Relation"
            spellCheck={false}
            autoComplete="off"
            className="min-w-24 flex-1 bg-transparent font-mono text-[11px] text-ink outline-none placeholder:font-sans placeholder:text-ink-faint"
          />
        </div>
        {suggestions.length > 0 && (
          <div
            className="-mx-1 flex max-h-36 flex-col overflow-y-auto"
            data-slot="link-relations-in-use"
          >
            {suggestions.map((r) => (
              <RelationRow
                key={r.rel}
                r={r}
                vocabulary={vocabulary}
                onAdd={() => addRelation(r.rel)}
              />
            ))}
          </div>
        )}
        <span className="text-[10px] text-ink-faint">
          {step
            ? `↵ to link · ⌫ for documents · tab for ${labelled ? "its text" : "a relation"} · esc to close`
            : `↵ to link · # for headings · tab for ${labelled ? "its text" : "a relation"} · esc to close`}
        </span>
      </div>
    </div>
  );
}

/**
 * The headings above a repeated one, which its anchor names it by
 * (`How lenses work#Stacking lenses`): shown beside it, so two rows with one
 * text can be told apart. Null for a heading whose text is its own.
 */
function parentOf(h: HeadingOffer): string | null {
  const parts = decodePath(h.anchor).split("#");
  return parts.length > 1 ? parts.slice(0, -1).join(" › ") : null;
}

/**
 * The second step's list: back to the documents, then the document's headings,
 * indented by level, in its order (or best first for what is typed).
 */
function HeadingStep({
  listId,
  name,
  headings,
  ranked,
  failure,
  active,
  onActive,
  onBack,
  onChoose,
}: {
  listId: string;
  name: string;
  headings: HeadingOffer[] | null;
  ranked: HeadingOffer[];
  failure: string | null;
  active: number;
  onActive: (i: number) => void;
  onBack: () => void;
  onChoose: (h: HeadingOffer) => void;
}) {
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        data-slot="picker-headings-back"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onBack}
        className="flex w-full items-center gap-1 rounded-sm px-2 py-1 text-left text-[11px] text-ink-dim hover:bg-bg"
      >
        <ChevronLeftIcon aria-hidden className="size-3 shrink-0" />
        <span className="truncate">{name}</span>
      </button>
      {failure ? (
        <p className="px-2 py-1.5 text-xs text-ink-dim">
          The headings could not be listed: {failure}
        </p>
      ) : headings === null ? (
        <p className="px-2 py-1.5 text-xs text-ink-faint">Listing headings…</p>
      ) : ranked.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-ink-dim">
          {headings.length === 0 ? "No headings in this document." : "Nothing matches."}
        </p>
      ) : (
        <div role="listbox" id={listId} aria-label="Headings">
          {ranked.map((h, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the field owns the keyboard (aria-activedescendant); a row is only clicked.
            <div
              key={h.line}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              data-heading={h.text}
              onMouseMove={() => onActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChoose(h)}
              style={{ paddingLeft: `${8 + (Math.min(h.level, 6) - 1) * 10}px` }}
              className={cn(
                "flex cursor-pointer items-baseline gap-1.5 rounded-sm py-1 pr-2 text-xs",
                i === active && "bg-bg",
              )}
            >
              <HashIcon aria-hidden className="size-3 shrink-0 translate-y-0.5 text-ink-faint" />
              <span className="min-w-0 flex-1 truncate text-ink">{h.text}</span>
              {parentOf(h) && (
                <span
                  data-slot="heading-parent"
                  title={`Under ${parentOf(h)}`}
                  className="max-w-[45%] shrink-0 truncate text-[10px] text-ink-faint"
                >
                  {parentOf(h)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** "1 link", "6 links". */
const links = (n: number) => `${n} link${n === 1 ? "" : "s"}`;

/**
 * One relation on offer: its name as `?rel=` writes it and, when the world's
 * vocabulary declares it, its label beside it and what it means on a second
 * line. One the world uses but its vocabulary does not declare says so. One
 * used between documents of these two kinds before is marked "usual here".
 */
function RelationRow({
  r,
  vocabulary,
  onAdd,
}: {
  r: RankedRelation;
  vocabulary: boolean;
  onAdd: () => void;
}) {
  const undeclared = vocabulary && !r.declared;
  const usual = r.here > 0 || r.into > 0;
  const why = [
    r.here > 0 ? `${links(r.here)} between documents of these two kinds` : "",
    r.into > r.here ? `${links(r.into)} into this kind` : "",
    `${links(r.count)} in all`,
  ].filter(Boolean);
  return (
    <button
      type="button"
      data-relation={r.rel}
      data-declared={r.declared ? "" : undefined}
      title={`${r.means ? `${r.means}\n` : ""}Used on ${why.join(", ")}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAdd}
      className="flex w-full flex-col rounded-sm px-1.5 py-0.5 text-left outline-none hover:bg-bg focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <span className="flex w-full items-baseline gap-1.5">
        <span className="shrink-0 font-mono text-[11px] text-ink">{r.rel}</span>
        {r.declared && r.label && r.label !== r.rel && (
          <span className="truncate text-[11px] text-ink-dim">{r.label}</span>
        )}
        {undeclared && (
          <span data-slot="relation-undeclared" className="shrink-0 text-[10px] text-attention">
            used, not declared
          </span>
        )}
        {usual && (
          <span data-slot="relation-usual" className="ml-auto shrink-0 text-[10px] text-ink-faint">
            usual here
          </span>
        )}
      </span>
      {r.means && (
        // Cut to one line in the list; whole on hover, so a long meaning can be read.
        <span
          data-slot="relation-means"
          title={r.means}
          className="block w-full truncate text-[10px] text-ink-faint"
        >
          {r.means}
        </span>
      )}
    </button>
  );
}
