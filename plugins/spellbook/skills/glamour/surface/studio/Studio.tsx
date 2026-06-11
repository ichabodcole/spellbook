// surface/studio/Studio.tsx
import type { ClientToServer, GlamourState } from "../state/types";
import { AnalysisStudio } from "./AnalysisStudio";
import { DirectionStudio } from "./DirectionStudio";
import { GatherStudio } from "./GatherStudio";
import { PromptsStudio } from "./PromptsStudio";
import { SpecGallery } from "./SpecGallery";
import { VariantsStudio } from "./VariantsStudio";

export function Studio({
  state,
  send,
  selInf,
  selCtx,
  onSelInf,
  onSelCtx,
}: {
  state: GlamourState;
  send: (m: ClientToServer) => void;
  selInf: string | null;
  selCtx: string | null;
  onSelInf: (id: string | null) => void;
  onSelCtx: (id: string | null) => void;
}) {
  switch (state.phase) {
    case "gather":
      return (
        <GatherStudio
          state={state}
          send={send}
          selInf={selInf}
          selCtx={selCtx}
          onSelInf={onSelInf}
          onSelCtx={onSelCtx}
        />
      );
    case "analysis":
      return <AnalysisStudio state={state} send={send} />;
    case "direction":
      return <DirectionStudio state={state} send={send} />;
    case "prompts":
      return <PromptsStudio state={state} send={send} />;
    case "variants":
      return <VariantsStudio state={state} send={send} />;
    case "spec":
      return <SpecGallery state={state} />;
    default:
      return null;
  }
}
