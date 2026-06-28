// surface/components/PhaseStepper.tsx
// The top-bar process spine: a horizontal stepper over the linear phases
// (Intake → Slice → Remove → Export). Status is DERIVED from state.phase — phases
// before the cursor are sealed (gold ✓ = a captured artifact), the cursor is
// active (accent), after is upcoming (muted). Sealed steps (except Intake — you
// can't un-drop a board) are clickable for back-nav (phase.set, ambient). The gold
// reuses magpie's treasure-gold identity token; the end re-skin can split out a
// dedicated --color-sealed if wanted.
import {
  Check,
  ChevronRight,
  Eraser,
  ImageUp,
  Lock,
  type LucideIcon,
  Package,
  Scissors,
} from "lucide-react";
import { type ClientToServer, PHASES, type PhaseKey } from "../state/types";

type PhaseMeta = {
  key: PhaseKey;
  label: string;
  icon: LucideIcon;
  blurb: string;
  artifact: string;
};

// Presentation only — labels/icons/copy never live in state.
const PHASE_META: PhaseMeta[] = [
  {
    key: "intake",
    label: "Intake",
    icon: ImageUp,
    blurb: "drop a composite",
    artifact: "the board",
  },
  {
    key: "slice",
    label: "Slice",
    icon: Scissors,
    blurb: "fine-tune the cuts",
    artifact: "confirmed crops",
  },
  {
    key: "remove",
    label: "Remove",
    icon: Eraser,
    blurb: "remove backgrounds",
    artifact: "chosen cutouts",
  },
  {
    key: "export",
    label: "Export",
    icon: Package,
    blurb: "bundle the assets",
    artifact: "asset bundle",
  },
];

type Status = "sealed" | "active" | "upcoming";

export function PhaseStepper({
  phase,
  send,
}: {
  phase: PhaseKey;
  send: (m: ClientToServer) => void;
}) {
  const cursor = PHASES.indexOf(phase);
  const sealedCount = Math.max(0, cursor);

  return (
    <div className="flex items-center gap-1 px-4 py-2.5 border-b border-divider overflow-x-auto shrink-0">
      {PHASE_META.map((p, i) => {
        const status: Status = i < cursor ? "sealed" : i === cursor ? "active" : "upcoming";
        const Icon = p.icon;
        const clickable = status === "sealed" && p.key !== "intake";

        const circle = (
          <span
            className="relative flex items-center justify-center w-6 h-6 rounded-full shrink-0"
            style={{
              background:
                status === "sealed"
                  ? "var(--color-sealed)"
                  : status === "active"
                    ? "var(--color-accent)"
                    : "var(--color-surface-3)",
            }}
          >
            {status === "sealed" ? (
              <Check className="w-3.5 h-3.5" style={{ color: "var(--color-accent-fg)" }} />
            ) : (
              <Icon
                className="w-3.5 h-3.5"
                style={{
                  color: status === "active" ? "var(--color-accent-fg)" : "var(--color-faint)",
                }}
              />
            )}
          </span>
        );

        const labels = (
          <div className="leading-tight text-left">
            <div
              className="text-sm font-semibold"
              style={{ color: status === "upcoming" ? "var(--color-faint)" : "var(--color-ink)" }}
            >
              {p.label}
            </div>
            <div
              className="text-[10px]"
              style={{
                color: status === "active" ? "var(--color-accent-ink)" : "var(--color-faint)",
              }}
            >
              {status === "sealed" ? `${p.artifact} ✓` : status === "active" ? p.blurb : ""}
            </div>
          </div>
        );

        const inner = (
          <div
            className={`flex items-center gap-2.5 px-2.5 py-1 rounded-lg ${
              status === "active" ? "bg-accent/15" : ""
            }`}
          >
            {circle}
            {labels}
          </div>
        );

        return (
          <div key={p.key} className="flex items-center gap-1 shrink-0">
            {clickable ? (
              <button
                type="button"
                title={`Step back to ${p.label}`}
                onClick={() => send({ type: "phase.set", phase: p.key })}
                className="rounded-lg hover:bg-surface-3 transition-colors"
              >
                {inner}
              </button>
            ) : (
              inner
            )}
            {i < PHASE_META.length - 1 && (
              <ChevronRight
                className="w-4 h-4 shrink-0"
                style={{ color: "var(--color-edge-strong)" }}
              />
            )}
          </div>
        );
      })}
      <span
        className="ml-auto shrink-0 flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full"
        style={{
          color: "var(--color-sealed)",
          border: "1px solid var(--color-edge-strong)",
        }}
      >
        <Lock className="w-3 h-3" /> {sealedCount} / {PHASE_META.length} sealed
      </span>
    </div>
  );
}
