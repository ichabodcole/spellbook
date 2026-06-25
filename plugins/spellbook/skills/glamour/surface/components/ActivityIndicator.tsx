export function ActivityIndicator({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-fuchsia-300">
      <span className="flex items-end gap-0.5" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="block h-3 w-0.5 origin-bottom rounded-full bg-fuchsia-400"
            style={{
              animation: "equalize 0.9s ease-in-out infinite",
              animationDelay: `${i * 0.12}s`,
            }}
          />
        ))}
      </span>
      <span>{label || "thinking…"}</span>
    </div>
  );
}
