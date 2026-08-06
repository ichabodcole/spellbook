// The map key — a cartographic legend card. Tier and provenance are the two
// distinctions the whole surface hangs on; the key teaches them at a glance.

export function MapKey() {
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-10 rounded-lg border border-edge bg-surface/90 px-3 py-2 text-[11px] leading-relaxed backdrop-blur">
      <div className="mb-1 text-[10px] uppercase tracking-widest text-ink-faint">Map key</div>
      <div className="grid grid-cols-2 gap-x-4">
        <div>
          <span className="text-canon">■</span> canon
          <br />
          <span className="text-thread-tier">■</span> thread
          <br />
          <span className="text-story-local">■</span> story-local
          <br />
          <span className="text-background-tier opacity-60">■</span> background (steeping)
        </div>
        <div className="text-ink-dim">
          →─ asserted
          <br />
          <span className="tracking-tighter">· · ·</span> derived
          <br />
          <span className="text-pending">╌ ╌</span> proposed
          <br />─ mutual (no arrow)
        </div>
      </div>
    </div>
  );
}
