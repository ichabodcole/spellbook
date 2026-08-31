import { AlertTriangle, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AddProjectModal } from "./components/AddProjectModal";
import { CountBadge } from "./components/CountBadge";
import { EmptyState } from "./components/EmptyState";
import { Header } from "./components/Header";
import { ProjectCard } from "./components/ProjectCard";
import { QuietRow } from "./components/QuietRow";
import { partition, zoneOf } from "./state/board";
import { useReflectAttention } from "./state/useReflectAttention";
import { useSession } from "./state/useSession";

export function App() {
  const { state, connected, send } = useSession();
  const [now, setNow] = useState(() => Date.now());
  const [pokedId, setPokedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [quietOpen, setQuietOpen] = useState(true);
  const pokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A gentle tick so relative timestamps stay fresh and a card slips idle→stale
  // on its own clock between server pushes.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const poke = useCallback(
    (id: string) => {
      send({ type: "poke", id });
      setPokedId(id);
      if (pokeTimer.current) clearTimeout(pokeTimer.current);
      pokeTimer.current = setTimeout(() => setPokedId((cur) => (cur === id ? null : cur)), 1500);
    },
    [send],
  );

  const projects = state?.projects ?? [];
  const title = state?.title ?? "Observatory";
  const { attention, active, quiet } = partition(projects, now);
  useReflectAttention(attention.length, title);

  if (!state) {
    return (
      <main className="mx-auto max-w-5xl p-8">
        <p className="text-muted text-sm">
          {connected ? "Waiting for the observatory…" : "Connecting to the observatory…"}
        </p>
      </main>
    );
  }

  return (
    <>
      <Header
        title={title}
        connected={connected}
        counts={{ attention: attention.length, active: active.length, quiet: quiet.length }}
        hasProjects={projects.length > 0}
        onAdd={() => setAdding(true)}
      />

      <main className="mx-auto max-w-5xl px-5 py-5">
        {projects.length === 0 ? (
          <EmptyState onAdd={() => setAdding(true)} />
        ) : (
          <div className="space-y-7">
            {attention.length > 0 && (
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-attention-icon" aria-hidden="true" />
                  <h2 className="text-sm font-semibold text-attention-ink">Needs you</h2>
                  <CountBadge n={attention.length} tone="attention" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {attention.map((p) => (
                    <ProjectCard
                      key={p.id}
                      p={p}
                      tone="attention"
                      poked={pokedId === p.id}
                      onPoke={() => poke(p.id)}
                      now={now}
                    />
                  ))}
                </div>
              </section>
            )}

            {active.length > 0 && (
              <section>
                <div className="mb-2 flex items-center gap-2">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-chip bg-positive opacity-50" />
                    <span className="relative inline-flex h-2 w-2 rounded-chip bg-positive" />
                  </span>
                  <h2 className="text-sm font-semibold text-ink">Active</h2>
                  <CountBadge n={active.length} tone="active" />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {active.map((p) => (
                    <ProjectCard
                      key={p.id}
                      p={p}
                      tone="active"
                      poked={pokedId === p.id}
                      onPoke={() => poke(p.id)}
                      now={now}
                    />
                  ))}
                </div>
              </section>
            )}

            {quiet.length > 0 && (
              <section>
                <button
                  type="button"
                  onClick={() => setQuietOpen((v) => !v)}
                  className="mb-2 flex items-center gap-2 text-muted hover:text-ink-2 transition-colors"
                >
                  <span className={`transition-transform ${quietOpen ? "" : "-rotate-90"}`}>
                    <ChevronDown className="w-4 h-4" aria-hidden="true" />
                  </span>
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted">
                    Quiet
                  </span>
                  <CountBadge n={quiet.length} tone="quiet" />
                  <span className="text-faint text-xs">idle &amp; stale</span>
                </button>
                {quietOpen && (
                  <div className="space-y-2">
                    {quiet.map((p) => (
                      <QuietRow key={p.id} p={p} zone={zoneOf(p, now)} now={now} />
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </main>

      <footer className="mx-auto max-w-5xl px-5 pb-10 pt-2 text-faint text-[11px]">
        astrolabe · the observatory stands until dismissed
      </footer>

      <AddProjectModal
        open={adding}
        onClose={() => setAdding(false)}
        projectCount={projects.length}
      />
    </>
  );
}
