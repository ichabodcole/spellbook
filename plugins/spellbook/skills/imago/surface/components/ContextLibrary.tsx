import {
  LayoutGrid,
  Link2,
  Link2Off,
  MessageSquareText,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { entriesByKind, isLinked } from "../state/contextLibrary";
import { IMAGO_CONTEXT_DND } from "../state/fileIntake";
import type { ClientToServer, ContextEntry, ContextKind, ImagoState } from "../state/types";

type KindFilter = "all" | "prompt" | "style";

const KIND_FILTERS: { id: KindFilter; label: string; Icon: typeof LayoutGrid }[] = [
  { id: "all", label: "All", Icon: LayoutGrid },
  { id: "prompt", label: "Prompts", Icon: MessageSquareText },
  { id: "style", label: "Styles", Icon: Sparkles },
];

// The default linked set for a given kind — where "+ New" links new entries.
function defaultSet(kind: ContextKind): "active" | "quickPrompts" | null {
  if (kind === "style") return "active";
  if (kind === "prompt") return "quickPrompts";
  return null;
}

// Is this entry "active" in the relevant set for its kind?
function isActive(
  entry: ContextEntry,
  activeContextIds: string[],
  quickPromptIds: string[],
): boolean {
  if (entry.kind === "style") return isLinked(activeContextIds, entry.id);
  if (entry.kind === "prompt") return isLinked(quickPromptIds, entry.id);
  return false;
}

function NewEntryForm({
  kind,
  onSave,
  onCancel,
}: {
  kind: ContextKind;
  onSave: (name: string, content: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  return (
    <div className="border border-edge rounded-md p-2 flex flex-col gap-2 bg-surface-2">
      <input
        type="text"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full text-xs bg-surface-3 border border-edge rounded px-2 py-1 text-ink placeholder:text-faint"
      />
      <textarea
        placeholder={kind === "style" ? "Style description…" : "Prompt text…"}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={2}
        className="w-full text-xs bg-surface-3 border border-edge rounded px-2 py-1 text-ink placeholder:text-faint resize-none"
      />
      <div className="flex gap-1 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-2 py-0.5 rounded text-faint hover:text-ink hover:bg-surface-3"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            if (name.trim()) onSave(name.trim(), content.trim());
          }}
          className="text-xs px-2 py-0.5 rounded bg-accent text-accent-ink hover:opacity-90"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function EditEntryForm({
  entry,
  onSave,
  onCancel,
}: {
  entry: ContextEntry;
  onSave: (name: string, content: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(entry.name);
  const [content, setContent] = useState(entry.content);
  return (
    <div className="flex flex-col gap-2 mt-1">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full text-xs bg-surface-3 border border-edge rounded px-2 py-1 text-ink"
      />
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={2}
        className="w-full text-xs bg-surface-3 border border-edge rounded px-2 py-1 text-ink resize-none"
      />
      <div className="flex gap-1 justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs px-2 py-0.5 rounded text-faint hover:text-ink hover:bg-surface-3"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            if (name.trim()) onSave(name.trim(), content.trim());
          }}
          className="text-xs px-2 py-0.5 rounded bg-accent text-accent-ink hover:opacity-90"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function EntryCard({
  entry,
  activeContextIds,
  quickPromptIds,
  send,
}: {
  entry: ContextEntry;
  activeContextIds: string[];
  quickPromptIds: string[];
  send: (m: ClientToServer) => void;
}) {
  const [editing, setEditing] = useState(false);
  // two-step delete: null = idle, "confirm" = showing "Delete forever?" prompt
  const [deleteStep, setDeleteStep] = useState<null | "confirm">(null);
  const active = isActive(entry, activeContextIds, quickPromptIds);
  const linkSet = defaultSet(entry.kind);

  const handleLink = () => {
    if (!linkSet) return;
    if (active) {
      send({ type: "context.unlink", id: entry.id, set: linkSet });
    } else {
      send({ type: "context.link", id: entry.id, set: linkSet });
    }
  };

  const handleSaveEdit = (name: string, content: string) => {
    send({ type: "context.update", id: entry.id, name, content });
    setEditing(false);
  };

  const handleDelete = () => {
    if (deleteStep === "confirm") {
      send({ type: "context.delete", id: entry.id });
      setDeleteStep(null);
    } else {
      setDeleteStep("confirm");
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: drag source — dragStart, not click
    <div
      className={`rounded-md border p-2 flex flex-col gap-1 ${
        active ? "border-accent bg-surface-2" : "border-edge bg-surface-2"
      }`}
      draggable={entry.kind === "style"}
      onDragStart={
        entry.kind === "style"
          ? (e) => e.dataTransfer.setData(IMAGO_CONTEXT_DND, JSON.stringify({ id: entry.id }))
          : undefined
      }
    >
      <div className="flex items-start gap-1 min-w-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1">
            {entry.kind === "prompt" ? (
              <MessageSquareText className="w-3.5 h-3.5 shrink-0 text-faint" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 shrink-0 text-faint" />
            )}
            <span className="text-xs font-medium text-ink truncate">{entry.name}</span>
          </div>
          {!editing && (
            <p className="text-[11px] text-faint truncate mt-0.5">{entry.content || "—"}</p>
          )}
        </div>

        {/* action buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          {/* edit */}
          {!editing && deleteStep === null && (
            <button
              type="button"
              title="Edit"
              aria-label="Edit"
              onClick={() => setEditing(true)}
              className="p-1 rounded text-faint hover:text-ink hover:bg-surface-3"
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
          {/* link/unlink toggle */}
          {!editing && deleteStep === null && linkSet && (
            <button
              type="button"
              title={
                active
                  ? entry.kind === "prompt"
                    ? "Remove from quick prompts"
                    : "Remove from active context"
                  : entry.kind === "prompt"
                    ? "Link to quick prompts"
                    : "Link to active context"
              }
              aria-label={
                active
                  ? entry.kind === "prompt"
                    ? "Remove from quick prompts"
                    : "Remove from active context"
                  : entry.kind === "prompt"
                    ? "Link to quick prompts"
                    : "Link to active context"
              }
              onClick={handleLink}
              className={`p-1 rounded ${
                active
                  ? "text-accent hover:text-ink hover:bg-surface-3"
                  : "text-faint hover:text-ink hover:bg-surface-3"
              }`}
            >
              {active ? <Link2 className="w-3 h-3" /> : <Link2Off className="w-3 h-3" />}
            </button>
          )}
          {/* delete — two-step */}
          {!editing && deleteStep === null && (
            <button
              type="button"
              title="Delete"
              aria-label="Delete"
              onClick={() => setDeleteStep("confirm")}
              className="p-1 rounded text-faint hover:text-red-400 hover:bg-surface-3"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* style image preview */}
      {entry.image && !editing && (
        <img src={entry.image} alt={entry.name} className="w-full rounded object-cover max-h-24" />
      )}

      {/* inline edit form */}
      {editing && (
        <EditEntryForm entry={entry} onSave={handleSaveEdit} onCancel={() => setEditing(false)} />
      )}

      {/* two-step delete confirm */}
      {deleteStep === "confirm" && (
        <div className="flex items-center gap-2 mt-1">
          <span className="text-xs text-red-400 flex-1">Delete forever?</span>
          <button
            type="button"
            onClick={() => setDeleteStep(null)}
            className="text-xs px-2 py-0.5 rounded text-faint hover:text-ink hover:bg-surface-3"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="text-xs px-2 py-0.5 rounded bg-red-600 text-white hover:bg-red-700"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// The context library pane: a "Library" header + kind facet pills (All / Prompts
// / Styles), then entry cards. Mirrors GenerationsRail's structure/styling.
export function ContextLibrary({
  state,
  send,
}: {
  state: ImagoState;
  send: (m: ClientToServer) => void;
}) {
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  // which kind's "+ New" form is open (at most one at a time)
  const [addingKind, setAddingKind] = useState<ContextKind | null>(null);

  const shown = kindFilter === "all" ? state.library : entriesByKind(state.library, kindFilter);

  const handleAddNew = (kind: ContextKind, name: string, content: string) => {
    const set = defaultSet(kind);
    send({
      type: "context.add",
      kind,
      name,
      content,
      ...(set ? { link: set } : {}),
    });
    setAddingKind(null);
  };

  // Determine which kinds to show "+ New" buttons for in the current filter
  const addKinds: ContextKind[] =
    kindFilter === "all" ? ["prompt", "style"] : [kindFilter as ContextKind];

  return (
    <aside className="card flex flex-col min-h-0 h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-divider">
        <span className="section-title">Library</span>
      </div>

      {/* kind facet pills — icon-only, matches GenerationsRail FILTERS row */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-divider">
        {KIND_FILTERS.map((f) => (
          <button
            type="button"
            key={f.id}
            title={f.label}
            aria-label={f.label}
            onClick={() => {
              setKindFilter(f.id);
              setAddingKind(null);
            }}
            className={`p-1.5 rounded ${
              kindFilter === f.id
                ? "bg-accent text-accent-ink"
                : "text-faint hover:text-ink hover:bg-surface-3"
            }`}
          >
            <f.Icon className="w-4 h-4" />
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
        {shown.length === 0 && addingKind === null && (
          <p className="text-faint italic text-center mt-10 px-4">
            {kindFilter === "all"
              ? "no entries yet — add a prompt or style below"
              : `no ${kindFilter}s yet`}
          </p>
        )}

        {shown.map((entry) => (
          <EntryCard
            key={entry.id}
            entry={entry}
            activeContextIds={state.activeContextIds}
            quickPromptIds={state.quickPromptIds}
            send={send}
          />
        ))}

        {/* "+ New" affordances per visible kind */}
        {addKinds.map((kind) => (
          <div key={kind}>
            {addingKind === kind ? (
              <NewEntryForm
                kind={kind}
                onSave={(name, content) => handleAddNew(kind, name, content)}
                onCancel={() => setAddingKind(null)}
              />
            ) : (
              <button
                type="button"
                onClick={() => setAddingKind(kind)}
                className="w-full text-xs text-faint hover:text-ink flex items-center gap-1 py-1 px-1 rounded hover:bg-surface-3"
              >
                <Plus className="w-3 h-3" />
                <span>New {kind}</span>
              </button>
            )}
          </div>
        ))}
      </div>
    </aside>
  );
}
