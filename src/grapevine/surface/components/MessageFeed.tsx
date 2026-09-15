// F1 + the scrolling column the hook measures for E3; the composer and the
// archived note are sticky at its foot (P1, P2).

import type { RefObject } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/ui/empty";
import type { Message } from "../state/types";
import { MessageRow } from "./MessageRow";

export function MessageFeed({
  streamRef,
  messages,
  msgById,
  canReply,
  onReply,
  children,
}: {
  streamRef: RefObject<HTMLElement | null>;
  messages: Message[];
  msgById: (id: number) => Message | undefined;
  canReply: boolean;
  onReply: (m: Message) => void;
  children?: React.ReactNode;
}) {
  return (
    <main ref={streamRef} className="scroll-smooth overflow-y-auto px-6 pt-4 pb-6">
      {messages.length === 0 && (
        <Empty className="mx-auto my-[60px] max-w-[520px] flex-none">
          <EmptyHeader>
            <EmptyMedia className="text-[40px]">🌿</EmptyMedia>
            <EmptyDescription>Waiting for messages on this channel…</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {messages.map((m, idx) => (
        <MessageRow
          key={m.id ?? idx}
          m={m}
          parent={m.in_reply_to != null ? msgById(m.in_reply_to) : undefined}
          canReply={canReply}
          onReply={onReply}
        />
      ))}
      {children}
    </main>
  );
}
