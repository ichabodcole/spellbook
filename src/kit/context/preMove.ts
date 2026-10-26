// THE PRE-MOVE SLOT: an app's chance to show the human what a move would change
// before it happens. The sidebar moves at once (`onStructure({op:"move"})`); a
// daemon hook can refuse a move, but it cannot ask the human anything. With
// this slot, an app answers a move with words for a confirm dialog, and the
// move waits for the human's Move or Cancel. An app that does not fill it moves
// exactly as before.
//
// Every move the sidebar makes comes through here: "Move to…", a row dragged
// onto a set or folder, and a row dragged onto the list or a set's way back.
//
// Kit code, new in Spellbook (Story Studio has no such slot): offered back.

import type { ReactNode } from "react";
import type { ConfirmRequest } from "../ui/ConfirmDialog.tsx";
import { baseName } from "./model.ts";

/** A move the human asked for, before it is sent: both absolute paths. */
export type PendingMove = { path: string; into: string };

/**
 * What the app answers a move with:
 *   - a confirm dialog's words: shown, and the move waits for the human;
 *   - `{ refused }`: the move would be refused (the app checked), so it is not
 *     sent and the reason is the sidebar's notice;
 *   - null: nothing to ask, so the move goes at once.
 * Throwing (or rejecting) means the app could not check: see `askBeforeMove`.
 */
export type BeforeMoveAnswer = ConfirmRequest | { refused: string } | null;

export type BeforeMove = (move: PendingMove) => BeforeMoveAnswer | Promise<BeforeMoveAnswer>;

/** How long the sidebar waits for an app's answer before asking without it. */
export const PRE_MOVE_TIMEOUT_MS = 5000;

/** What the sidebar does with a move once the slot (and the human) have answered. */
export type MoveVerdict = { go: true } | { go: false; notice?: string };

/**
 * What the app says went unchecked when its check could not be made: the
 * fallback dialog's warning, in the app's own words (the kit cannot know what
 * an app's check looks at). Absent, the dialog says only that the move was not
 * checked.
 */
export type UncheckedMoveNote = (move: PendingMove) => ReactNode;

/**
 * The check could not be made (it failed, or did not answer in time): the human
 * still chooses (Cole's ruling, 2026-10-17). Moving at once would skip the look
 * the app asked for; refusing would leave the human unable to move while the
 * app is slow or down. So the dialog says the move was not checked, names what
 * went unchecked when the app says (`note`), and Cancel (and Escape) is the
 * way out.
 */
export function uncheckedMovePrompt(
  move: PendingMove,
  why: string,
  note?: UncheckedMoveNote,
): ConfirmRequest {
  const warning = note?.(move);
  return {
    title: `Move “${baseName(move.path)}” into “${baseName(move.into)}”?`,
    message: `What this move would change could not be checked first (${why}). It can still be moved.`,
    ...(warning ? { warning } : {}),
    confirmLabel: "Move anyway",
  };
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Ask the app, then the human. Resolves `{ go: true }` when the move should be
 * sent. The timeout is the sidebar's own, so an app's slot that never answers
 * cannot hold a move for ever; an answer that comes after it is ignored.
 */
export async function askBeforeMove(
  move: PendingMove,
  beforeMove: BeforeMove,
  confirm: (request: ConfirmRequest) => Promise<boolean>,
  timeoutMs: number = PRE_MOVE_TIMEOUT_MS,
  uncheckedNote?: UncheckedMoveNote,
): Promise<MoveVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer: BeforeMoveAnswer;
  try {
    answer = await Promise.race([
      Promise.resolve().then(() => beforeMove(move)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${Math.round(timeoutMs / 100) / 10} s`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (e) {
    return (await confirm(uncheckedMovePrompt(move, why(e), uncheckedNote)))
      ? { go: true }
      : { go: false };
  } finally {
    clearTimeout(timer);
  }
  if (answer === null) return { go: true };
  if ("refused" in answer) return { go: false, notice: answer.refused };
  return (await confirm(answer)) ? { go: true } : { go: false };
}
