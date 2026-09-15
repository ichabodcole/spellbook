// Agent-presence indicator + a relative timestamp. Mirrors the t13 presenceHtml,
// now a real component (no dangerouslySetInnerHTML).
export function PresenceDot({ connected, when }: { connected: boolean; when: string }) {
  return (
    <div className="flex items-center gap-3">
      {connected ? (
        <span className="inline-flex items-center gap-1 text-[11px] text-positive">
          <span className="h-1.5 w-1.5 rounded-chip bg-positive" />
          agent connected
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-[11px] text-faint">
          <span className="h-1.5 w-1.5 rounded-chip border border-faint-2" />
          no agent
        </span>
      )}
      {when && <span className="text-[11px] text-faint">{when}</span>}
    </div>
  );
}
