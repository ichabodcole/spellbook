// The watch surface: header · (rail | feed | roster+you) · status. Every
// visible state in the behaviour inventory has a home in exactly one child.

import { TooltipProvider } from "@/ui/tooltip";
import { ChannelRail } from "./components/ChannelRail";
import { ArchivedNote, Composer } from "./components/Composer";
import { Header } from "./components/Header";
import { IdentityBox } from "./components/IdentityBox";
import { MessageFeed } from "./components/MessageFeed";
import { Roster } from "./components/Roster";
import { StatusBar } from "./components/StatusBar";
import { hiddenArchivedCount, topicEditState, visibleChannels } from "./state/lifecycle";
import { useGrapevine } from "./state/useGrapevine";

export function App() {
  const g = useGrapevine();
  const joined = g.mode === "join";
  return (
    <TooltipProvider>
      <Header
        channel={g.channel}
        topic={g.topic}
        editState={topicEditState(g.channelArchived, g.topicFrom)}
        editRequest={g.topicEditRequest}
        signer={g.topicFrom}
        onCommit={g.putTopic}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr_220px]">
        <ChannelRail
          channels={visibleChannels(g.channels, g.channel, g.showArchived)}
          hiddenCount={hiddenArchivedCount(g.channels, g.channel, g.showArchived)}
          showArchived={g.showArchived}
          onShowArchived={g.setShowArchived}
          current={g.channel}
          onClose={g.closeChannel}
          onArchive={g.archiveChannel}
          onUnarchive={g.unarchiveChannel}
          onEditTopic={g.editTopicFor}
          onCreate={g.createChannel}
          onUnarchiveAndGo={g.unarchiveAndGo}
          signer={g.topicFrom}
        />
        <MessageFeed
          streamRef={g.streamRef}
          messages={g.messages}
          msgById={g.msgById}
          canReply={joined && !g.channelArchived}
          onReply={g.replyTo}
        >
          {g.channelArchived && <ArchivedNote />}
          {joined && !g.channelArchived && (
            <Composer
              alias={g.alias}
              replyingTo={g.replyingTo}
              onCancelReply={g.cancelReply}
              onSend={g.send}
            />
          )}
        </MessageFeed>
        <aside className="overflow-y-auto border-l border-edge bg-surface px-[18px] py-4">
          <Roster subscribers={g.subscribers} humans={g.humans} alias={g.alias} />
          <IdentityBox
            alias={g.alias}
            mode={g.mode}
            onAliasChange={g.setAlias}
            onToggle={g.toggleMode}
          />
        </aside>
      </div>
      <StatusBar status={g.status} disconnected={g.disconnected} />
    </TooltipProvider>
  );
}
