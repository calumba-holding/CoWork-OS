import { getEmojiIcon } from "../../utils/emoji-icon-map";
import type { MissionControlData } from "./useMissionControlData";
import type { UiCopyKey } from "../../utils/agentMessages";

interface MCFeedTabProps {
  data: MissionControlData;
}

const FILTER_LABELS: Record<string, UiCopyKey> = {
  all: "mcFilterAll",
  tasks: "mcFilterTasks",
  comments: "mcFilterComments",
  status: "mcFilterStatus",
};

export function MCFeedTab({ data }: MCFeedTabProps) {
  const {
    agents, feedItems, feedFilter, setFeedFilter,
    selectedAgent, setSelectedAgent, getAgent,
    setDetailPanel, formatRelativeTime, agentContext, isAllWorkspacesSelected,
  } = data;

  const activeAgents = agents.filter((a) => a.isActive);

  return (
    <div className="mc-v2-feed">
      <div className="mc-v2-feed-toolbar">
        <div className="mc-v2-feed-filters">
          {(["all", "tasks", "comments", "status"] as const).map((filter) => (
            <button
              key={filter}
              className={`mc-v2-filter-btn ${feedFilter === filter ? "active" : ""}`}
              onClick={() => setFeedFilter(filter)}
            >
              {agentContext.getUiCopy(FILTER_LABELS[filter])}
            </button>
          ))}
        </div>
        <div className="mc-v2-feed-agent-chips">
          {activeAgents.map((agent) => (
            <button
              key={agent.id}
              className={`mc-v2-agent-chip ${selectedAgent === agent.id ? "active" : ""}`}
              style={{ borderColor: agent.color }}
              onClick={() => setSelectedAgent(selectedAgent === agent.id ? null : agent.id)}
            >
              {(() => { const Icon = getEmojiIcon(agent.icon || "🤖"); return <Icon size={12} strokeWidth={2} />; })()}
              {agent.displayName.split(" ")[0]}
            </button>
          ))}
        </div>
      </div>
      <div className="mc-v2-feed-list">
        {feedItems.length === 0 ? (
          <div className="mc-v2-empty">{agentContext.getUiCopy("mcFeedEmpty")}</div>
        ) : (
          feedItems.map((item) => {
            const agent = getAgent(item.agentId);
            return (
              <div
                key={item.id}
                className="mc-v2-feed-item"
                onClick={() => { if (item.taskId) setDetailPanel({ kind: "task", taskId: item.taskId }); }}
                style={item.taskId ? { cursor: "pointer" } : undefined}
              >
                <div className="mc-v2-feed-item-header">
                  <div className="mc-v2-feed-item-meta">
                    {agent ? (
                      <span className="mc-v2-feed-agent" style={{ color: agent.color }}>
                        {(() => { const Icon = getEmojiIcon(agent.icon || "🤖"); return <Icon size={14} strokeWidth={2} style={{ display: "inline", verticalAlign: "middle", marginRight: 4 }} />; })()}
                        {agent.displayName}
                      </span>
                    ) : item.agentName ? (
                      <span className="mc-v2-feed-agent system">{item.agentName}</span>
                    ) : null}
                    {isAllWorkspacesSelected && item.workspaceName ? (
                      <span className="mc-v2-workspace-tag">{item.workspaceName}</span>
                    ) : null}
                  </div>
                  <span className="mc-v2-feed-time">{formatRelativeTime(item.timestamp)}</span>
                </div>
                <div className="mc-v2-feed-content">{item.content}</div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
