/**
 * The flagged Scriptorium's answer to the kit's pre-move slot
 * (`src/kit/context/preMove.ts`): before the context sidebar moves anything,
 * ask the kit daemon for its move plan (`scriptorium.move.plan`, built last
 * cycle in `../../backend/kit/wiki.ts`) and put it to the human: what moves,
 * whether it leaves its git working tree, and the links it would break, each
 * with the rewrite that would land it again. Nothing is rewritten: the frame
 * shows no relink offer yet (set-make-relink-offer), so the words promise only
 * what happens now, the chat line naming what still points at the old place.
 *
 * Kit path only (`SCRIPTORIUM_KIT=1`). The shipped surface does not import this
 * file; the interim frame (scriptorium-kit-interim-frame) passes it to
 * `ContextSidebar` as `beforeMove={scriptoriumBeforeMove(daemon, { userHome })}`.
 *
 * What it answers, the shipped surface's rule widened by the links:
 *   - the daemon refuses the plan (it refuses exactly what the move refuses):
 *     the refusal, so the move is not sent and the reason is the notice;
 *   - a single document that stays in its repository and breaks nothing: no
 *     question, the move goes at once;
 *   - otherwise: the plan, and the move waits for Move or Cancel.
 * A plan that cannot be fetched (the socket is down, or no answer in time)
 * rejects, and the sidebar asks the human without it: "Move anyway", with
 * `scriptoriumUncheckedMoveNote` naming what went unchecked.
 */

import type { ReactNode } from "react";
import { type Daemon, DaemonError } from "../../../kit/context/daemonClient";
import { baseName, shortPath } from "../../../kit/context/model";
import {
  type BeforeMove,
  PRE_MOVE_TIMEOUT_MS,
  type UncheckedMoveNote,
} from "../../../kit/context/preMove";
import type { ConfirmRequest } from "../../../kit/ui/ConfirmDialog";
import type { MovePlan } from "../../../kit/workspace/movePlan";

/** The kit's plan with the git half only Scriptorium's daemon adds (`wiki.ts` `movePlan`). */
export type ScriptoriumMovePlan = MovePlan & { repo: string | null; leavesRepo: boolean };

/** How many lines of each kind the dialog lists before it counts the rest. */
const LISTED = 6;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function listed<T>(items: readonly T[], line: (item: T, i: number) => ReactNode): ReactNode {
  const more = items.length - LISTED;
  return (
    <>
      {items.slice(0, LISTED).map(line)}
      {more > 0 && <span className="block pl-2">and {more} more</span>}
    </>
  );
}

/**
 * The plan in the human's words, or null when there is nothing to ask. Every
 * part is inline (`span`): the dialog's message is a paragraph.
 */
export function movePrompt(
  plan: ScriptoriumMovePlan,
  userHome: string | null,
): ConfirmRequest | null {
  const fixes = plan.links.reduce((n, d) => n + d.fixes.length, 0);
  const breaks = fixes + plan.wiki.length + plan.edges.length;
  if (!plan.folder && !plan.leavesRepo && breaks === 0) return null;
  const short = (p: string) => shortPath(p, userHome, 2);
  const message = (
    <>
      <span className="block">
        {plural(plan.docs, "document")} moved on disk, from {short(plan.from)} to {short(plan.into)}
        .
      </span>
      {breaks === 0 && <span className="mt-1 block">It breaks no links.</span>}
      {fixes > 0 && (
        <span className="mt-2 block">
          It breaks {plural(fixes, "link")} in {plural(plan.links.length, "document")}. They are
          left as they are; after the move, the chat names the links still pointing at the old
          place. Each is listed with the rewrite that would land it again.
          {listed(
            plan.links.flatMap((d) => d.fixes.map((f) => ({ d, f }))),
            ({ d, f }, i) => (
              <span key={`l${i}`} className="block pl-2 font-mono text-xs">
                {short(d.path)}
                {d.noun ? ` (${d.noun})` : ""}: {f.from} → {f.to}
              </span>
            ),
          )}
        </span>
      )}
      {plan.wiki.length > 0 && (
        <span className="mt-2 block">
          {plural(plan.wiki.length, "wiki link")} would no longer find{" "}
          {plan.wiki.length === 1 ? "its page" : "their pages"}. A wiki link names a page, so it is
          never rewritten.
          {listed(plan.wiki, (w, i) => (
            <span key={`w${i}`} className="block pl-2 font-mono text-xs">
              {short(w.path)}:{w.line} {w.raw}
            </span>
          ))}
        </span>
      )}
      {plan.edges.length > 0 && (
        <span className="mt-2 block">
          {plural(plan.edges.length, "frontmatter reference")} would point elsewhere. These are
          reported, never rewritten.
          {listed(plan.edges, (e, i) => (
            <span key={`e${i}`} className="block pl-2 font-mono text-xs">
              {short(e.source)}
              {e.key ? ` ${e.key}` : ""}: {e.raw}
            </span>
          ))}
        </span>
      )}
    </>
  );
  return {
    title: `Move “${plan.name}” into “${baseName(plan.into)}”?`,
    message,
    warning: plan.leavesRepo ? (
      <>
        This takes it <strong className="font-semibold">out of the git repository</strong>{" "}
        {plan.repo}. Git will see {plan.docs === 1 ? "the file" : "the files"} as deleted there
        until the move is committed.
      </>
    ) : undefined,
    confirmLabel: "Move",
    confirmClassName: "bg-rubric text-on-rubric hover:bg-rubric/90",
  };
}

/**
 * What went unchecked when the plan could not be fetched (Cole's ruling,
 * 2026-10-17: the human may still Move anyway, told what was not checked).
 * Passed to `ContextSidebar` as `uncheckedMoveNote`, beside `beforeMove`.
 */
export const scriptoriumUncheckedMoveNote: UncheckedMoveNote = () => (
  <>
    <span className="block">
      The links into and out of what moves were not checked. Any it breaks are named in the chat
      after the move.
    </span>
    <span className="mt-1 block">
      Nor was whether it leaves a git repository: if it does, git will see the files as deleted
      there until the move is committed.
    </span>
  </>
);

/**
 * The slot's function for a connected daemon client. `timeoutMs` bounds the
 * request itself; the sidebar has its own bound (`beforeMoveTimeoutMs`), and
 * this defaults to the same.
 */
export function scriptoriumBeforeMove(
  daemon: Pick<Daemon, "request">,
  opts: { userHome?: string | null; timeoutMs?: number } = {},
): BeforeMove {
  const timeoutMs = opts.timeoutMs ?? PRE_MOVE_TIMEOUT_MS;
  return async ({ path, into }) => {
    let frame: Awaited<ReturnType<Daemon["request"]>>;
    try {
      frame = await daemon.request({ op: "scriptorium.move.plan", path, into }, { timeoutMs });
    } catch (e) {
      // The daemon answered, and said no: the move would be refused the same way.
      if (e instanceof DaemonError) return { refused: e.message };
      throw e;
    }
    const plan = (frame as { plan?: ScriptoriumMovePlan }).plan;
    if (!plan) throw new Error("the daemon's answer carried no plan");
    return movePrompt(plan, opts.userHome ?? null);
  };
}
