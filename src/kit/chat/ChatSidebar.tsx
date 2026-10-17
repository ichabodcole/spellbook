// The conversation column's body: the log, the waiting badge on the message it is
// about, and the composer. Props only, like the context sidebar: messages in,
// what the human typed out.
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Message, Waiting } from "../workspace/protocol";
import { type Attachable, ChatComposer } from "./ChatComposer.tsx";
import { type AboutPartLabel, ChatMessageView } from "./ChatMessageView.tsx";
import { badgeFor } from "./WaitingBadge.tsx";

type ChatSidebarBase = {
  messages: readonly Message[];
  /** Whether the human is waiting on an answer, and how that should read. */
  waiting: Waiting | null;
  /**
   * Whether an agent is following the session (the daemon's `agentListening`).
   * When not, the composer says so before anything is sent, and the badge on an
   * unanswered message says it is waiting for one. Default true.
   */
  agentListening?: boolean;
  /** A document's display name, from its slug. */
  docName?: (slug: string) => string;
  /** A path's display name, for a message's chip: a bundle by its title. */
  pathName?: (path: string) => string;
  /**
   * The app's words for its own parts of a message's `about` (what its
   * `hooks.messageAbout` added), on the chip after the kit's. Without it the
   * chip shows the kit's parts only.
   */
  aboutPart?: AboutPartLabel;
  onFollowLink?: (target: string) => void;
  /**
   * An app's own actions under a message (a button, a link), or nothing. The
   * kit draws whatever it returns and knows nothing of what it does: Atlas
   * puts "Review N changes" under the agent's message about a board.
   */
  messageActions?: (message: Message) => ReactNode;
};

/** The sidebar draws its own composer, holding its own draft. */
type OwnComposer = {
  composer?: undefined;
  /** The held selection, as the composer's chip shows it, or null. */
  attachable: Attachable | null;
  connected: boolean;
  /** The session was closed on purpose. */
  ended?: boolean;
  onSend: (text: string, withSelection: boolean) => void;
  /** The chip's X: drop the held selection. */
  onDropSelection: () => void;
  /** Whole documents pointed at (their names), as the composer's chip shows them, or null. */
  pointed?: readonly string[] | null;
  /** What that chip says it is about instead of a document count, or null. */
  pointedLabel?: string | null;
  /** That chip's X: drop the pointed-at documents. */
  onDropPointed?: () => void;
};

/**
 * The caller draws the composer (or nothing, with null): the shell holds the one
 * draft and draws the composer here or floating at the foot of the centre.
 */
type GivenComposer = { composer: ReactNode };

export type ChatSidebarProps = ChatSidebarBase & (OwnComposer | GivenComposer);

export function ChatSidebar(props: ChatSidebarProps) {
  const {
    messages,
    waiting,
    agentListening = true,
    docName,
    pathName,
    aboutPart,
    onFollowLink,
    messageActions,
  } = props;
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const last = messages.at(-1)?.id;

  // New lines arrive at the bottom, and the log follows them. Only when the
  // human is already near the bottom, so reading back up the log is not undone
  // by a message arriving.
  const stuck = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the last message's id is the trigger.
  useEffect(() => {
    const el = log.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [last]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={log}
        role="log"
        aria-label="Conversation"
        onScroll={(e) => {
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
        className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto p-2"
      >
        {messages.length === 0 ? (
          <p className="px-1 py-6 text-center text-xs text-ink-faint">
            Nothing said yet. Ask the agent something below, or wait for it to speak.
          </p>
        ) : (
          messages.map((m) => (
            <ChatMessageView
              key={m.id}
              message={m}
              badge={waiting?.messageId === m.id ? badgeFor(waiting, agentListening) : null}
              docName={docName}
              pathName={pathName}
              aboutPart={aboutPart}
              onFollowLink={onFollowLink}
              actions={messageActions?.(m)}
            />
          ))
        )}
      </div>
      {!("onSend" in props) ? (
        props.composer
      ) : (
        <ChatComposer
          attachable={props.attachable}
          connected={props.connected}
          heard={agentListening}
          ended={props.ended}
          draft={draft}
          onDraft={setDraft}
          onDrop={props.onDropSelection}
          pointed={props.pointed ?? null}
          pointedLabel={props.pointedLabel ?? null}
          {...(props.onDropPointed ? { onDropPointed: props.onDropPointed } : {})}
          onSend={props.onSend}
        />
      )}
    </div>
  );
}
