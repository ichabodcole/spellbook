import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

/**
 * The sticky foot: the ambient mascot and the one destructive-ish control.
 *
 * The old page used a native `window.confirm`. This is the registry's
 * AlertDialog with the SAME text and the same forced choice — a browser agent
 * can drive it, which `confirm` never allowed.
 *
 * Closing is non-destructive: the agent already has every change live and the
 * daemon snapshots canonical state, so this ends the session and nothing else.
 */
export function BoardFooter({ onClose }: { onClose: () => void }) {
  return (
    <div className="mt-6 flex max-w-[1200px] items-center gap-2">
      {/* The asset path is a RUNTIME style, not a Tailwind arbitrary value: an
          `url()` inside the stylesheet is a build input Bun resolves off disk,
          and this file is served by the daemon, not bundled. */}
      <div
        aria-hidden="true"
        style={{ backgroundImage: "url(/assets/mascot.webp)" }}
        className="mr-1.5 size-9 bg-contain bg-center bg-no-repeat opacity-35"
      />
      <div className="flex-1" />
      <AlertDialog>
        <AlertDialogTrigger render={<Button size="lg">Close board</Button>} />
        <AlertDialogContent className="border-edge-hover bg-surface">
          <AlertDialogTitle>Close this board?</AlertDialogTitle>
          <AlertDialogDescription>
            The agent can reopen it later from a snapshot.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onClose}>Close board</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
