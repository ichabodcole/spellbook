// P1.5 — minimal project picker (plan/circe.md), backed by daedalus's
// GET/POST /projects (already live in server.ts — no CLI round-trip needed
// from the browser, it's a plain REST pair). A header dropdown: pick a saved
// project or create a new one by title; picking re-mounts useProjectState by
// changing the selected id (App owns that state, this component is dumb).

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectMeta } from "./types";
import { Button } from "./ui/button";

export function ProjectPicker({
  currentId,
  onSelect,
}: {
  currentId: string | undefined;
  onSelect: (id: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (creating) titleInputRef.current?.focus();
  }, [creating]);

  // Stable identity (useCallback, no deps) — `refresh` re-entering the
  // mount effect's dependency array must never itself retrigger that effect.
  const refresh = useCallback(
    () =>
      fetch("/projects")
        .then((r) => r.json())
        .then((body: { projects: ProjectMeta[] }) => setProjects(body.projects))
        .catch(() => {
          // A peripheral fetch failure never takes the board down — the
          // picker just stays with whatever it last had (possibly empty).
        }),
    [],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = () => {
    const t = title.trim();
    if (!t) return;
    const id = t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    fetch("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, title: t }),
    })
      .then((r) => r.json())
      .then((meta: ProjectMeta) => {
        setTitle("");
        setCreating(false);
        refresh();
        onSelect(meta.id);
      })
      .catch(() => {
        /* the create button staying enabled is the retry affordance */
      });
  };

  if (creating) {
    return (
      <div className="flex items-center gap-1.5">
        <input
          ref={titleInputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") setCreating(false);
          }}
          placeholder="new project title…"
          aria-label="New project title"
          className="w-40 rounded border border-edge bg-surface px-1.5 py-0.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none"
        />
        <Button
          size="auto"
          className="px-2 py-0.5 text-xs"
          onClick={create}
          disabled={!title.trim()}
        >
          create
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5 text-xs">
      <select
        aria-label="Project"
        value={currentId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        className="rounded border border-edge bg-surface px-1.5 py-0.5 text-ink"
      >
        {/* No current selection (the pick-or-create landing): an inert
            placeholder row keeps the first real project pickable — a select
            whose value already shows the first option never fires onChange
            for it. */}
        {currentId === undefined && (
          <option value="" disabled>
            pick a project…
          </option>
        )}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        size="auto"
        className="px-1.5 py-0.5 text-ink-dim"
        onClick={() => setCreating(true)}
      >
        + new
      </Button>
    </div>
  );
}
