// The offer after a rename or move that broke links: "2 links in 2 documents
// still point at where glade.md was", with Update, Show and Leave. A bar, not a
// toast: it waits on a decision, and a toast is for "that happened, carry on".
// It lives under the context's undo arrows because accepting it joins the act
// those arrows undo. It goes when either party answers it, or when anything
// else changes the context's shape. Answered from the keyboard, focus goes to
// the undo arrow (`focusAfter`), which is what now takes the act back, rather
// than falling to the page when the bar goes.

import { useRef, useState } from "react";
import { linkPlacesText } from "../lib/bundles.ts";
import { Button } from "../ui/button.tsx";
import type { RelinkOffer } from "../workspace/protocol";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function RelinkBar({
  offer,
  onUpdate,
  onLeave,
  focusAfter,
}: {
  offer: RelinkOffer;
  onUpdate: () => void;
  onLeave: () => void;
  /** Where focus goes once the bar is answered, when focus was inside it. */
  focusAfter?: () => void;
}) {
  const [shown, setShown] = useState(false);
  const bar = useRef<HTMLElement>(null);
  const links = plural(offer.count, "link");
  const answer = (act: () => void) => () => {
    const inside = bar.current?.contains(document.activeElement) ?? false;
    act();
    if (inside) focusAfter?.();
  };
  return (
    <section
      ref={bar}
      data-slot="relink-bar"
      aria-label="Links to update"
      className="mx-2 mb-2 rounded-md border border-attention/50 bg-surface-raised px-2.5 py-2 text-xs text-ink"
    >
      <p>
        {links} in {linkPlacesText(offer.docs)} still {offer.count === 1 ? "points" : "point"} at
        where <span className="font-medium">{offer.what}</span> was
        {offer.wiki.length > 0 && `, and ${plural(offer.wiki.length, "wiki link")} it can't update`}
        .
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Button size="xs" onClick={answer(onUpdate)} data-action="relink-update">
          Update {links}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={shown}
          onClick={() => setShown((v) => !v)}
          data-action="relink-show"
        >
          {shown ? "Hide" : "Show"}
        </Button>
        <Button size="xs" variant="ghost" onClick={answer(onLeave)} data-action="relink-leave">
          Leave them
        </Button>
      </div>
      {shown && (
        <ul data-slot="relink-list" className="mt-2 max-h-48 space-y-1.5 overflow-y-auto">
          {offer.docs.map((d) => (
            <li key={d.path}>
              <div className="truncate font-medium" title={d.path}>
                {d.noun ? `the ${d.noun} ${d.shown}` : d.shown}
              </div>
              <ul className="space-y-0.5 pl-2 text-ink-faint">
                {d.fixes.map((f, i) => (
                  // The same link can be written twice on one line: its place in the list keys it.
                  // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed for the offer's life
                  <li key={i} className="break-all">
                    {d.noun ? "" : `line ${f.line}: `}
                    {f.label && d.noun ? `${f.label}: ` : ""}
                    <code>{f.from}</code> → <code className="text-ink">{f.to}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
          {offer.wiki.map((w, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the list is fixed for the offer's life
            <li key={`wiki-${i}`} className="break-all text-ink-faint">
              <span className="font-medium text-ink">{w.shown}</span> line {w.line}:{" "}
              <code>[[{w.raw}]]</code> can't be updated
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
