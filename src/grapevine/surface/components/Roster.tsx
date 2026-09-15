// S1–S2 — "On the line": one row per visible subscriber, coloured by alias,
// labelled (you) / (human) / plain.

import { aliasColor, subLabel } from "../state/feed";

export function Roster({
  subscribers,
  humans,
  alias,
}: {
  subscribers: string[];
  humans: string[];
  alias: string;
}) {
  return (
    <>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-dim">
        On the line
      </h2>
      <ul className="m-0 list-none p-0">
        {subscribers.length === 0 && (
          <li className="py-1 font-mono text-xs italic text-ink-dim">
            no one currently subscribed
          </li>
        )}
        {subscribers.map((a) => (
          <li
            key={a}
            className="flex items-center gap-2 py-1 font-mono text-xs"
            style={{ color: aliasColor(a) }}
          >
            <span className="h-2 w-2 rounded-full bg-current" />
            <span>{subLabel(a, alias, humans)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
