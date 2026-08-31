import { Images, Library } from "lucide-react";

export type LibraryPane = "images" | "context";

const PANES: { id: LibraryPane; label: string; Icon: typeof Images }[] = [
  { id: "images", label: "Images", Icon: Images },
  { id: "context", label: "Context Library", Icon: Library },
];

// A skinny vertical icon rail that toggles between the Images pane and the
// Context Library pane. Mirrors the icon-pill idiom from GenerationsRail's
// FILTERS row — active item gets bg-accent text-accent-ink.
export function LibrarySwitcher({
  pane,
  onChange,
}: {
  pane: LibraryPane;
  onChange: (p: LibraryPane) => void;
}) {
  return (
    <div className="flex flex-col items-center gap-1 py-2">
      {PANES.map((p) => (
        <button
          type="button"
          key={p.id}
          title={p.label}
          aria-label={p.label}
          onClick={() => onChange(p.id)}
          className={`p-1.5 rounded ${
            pane === p.id
              ? "bg-accent text-accent-ink"
              : "text-faint hover:text-ink hover:bg-surface-3"
          }`}
        >
          <p.Icon className="w-4 h-4" />
        </button>
      ))}
    </div>
  );
}
