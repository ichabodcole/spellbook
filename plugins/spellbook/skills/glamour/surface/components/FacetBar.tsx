import type { ReactNode } from "react";
import type { ItemKind, LibraryItem } from "../state/types";
import { VALID_KIND } from "../state/types";

const LABEL: Record<ItemKind, string> = {
  ref: "References",
  context: "Context",
  gen: "Generated",
  style: "Styles",
};

export function FacetBar({
  library,
  facet,
  onPick,
  trailing,
}: {
  library: LibraryItem[];
  facet: ItemKind | "all";
  onPick: (f: ItemKind | "all") => void;
  trailing?: ReactNode;
}) {
  const live = library.filter((i) => !i.archived);
  const count = (k: ItemKind) => live.filter((i) => i.kind === k).length;
  const pill = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs transition-colors ${
      active ? "bg-fuchsia-600 text-white" : "bg-white/5 text-slate-300 hover:bg-white/10"
    }`;

  return (
    <div className="flex items-center gap-2 border-b border-white/10 px-5 py-2">
      <button type="button" className={pill(facet === "all")} onClick={() => onPick("all")}>
        All · {live.length}
      </button>
      {VALID_KIND.map((k) => (
        <button type="button" key={k} className={pill(facet === k)} onClick={() => onPick(k)}>
          {LABEL[k]} · {count(k)}
        </button>
      ))}
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}
