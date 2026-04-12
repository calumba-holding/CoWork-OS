import { useEffect, useId, useMemo, useState } from "react";

import { buildPauseBannerPreview } from "../utils/pause-banner-summary";

type TaskPauseBannerProps = {
  message?: string | null;
  reasonCode?: string | null;
  onStopTask?: (() => void) | undefined;
};

export function TaskPauseBanner({ message, reasonCode, onStopTask }: TaskPauseBannerProps) {
  const [showDetails, setShowDetails] = useState(false);
  const detailsTitleId = useId();
  const normalizedMessage = typeof message === "string" ? message.trim() : "";
  const preview = useMemo(() => buildPauseBannerPreview(normalizedMessage), [normalizedMessage]);
  const waitingForSkillParameter = reasonCode === "skill_parameters";

  useEffect(() => {
    setShowDetails(false);
  }, [normalizedMessage]);

  useEffect(() => {
    if (!showDetails) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowDetails(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showDetails]);

  return (
    <>
      <div className="task-status-banner task-status-banner-paused">
        <div className="task-status-banner-content">
          <strong>
            {waitingForSkillParameter
              ? "Skill needs one more detail."
              : "Quick check-in - I'm at a decision point."}
          </strong>
          {normalizedMessage && (
            <span className="task-status-banner-detail task-status-banner-summary">
              {preview.summary}
            </span>
          )}
          <span className="task-status-banner-detail">
            {waitingForSkillParameter
              ? "Reply below with the requested value, or stop this task here."
              : "Type anything below to continue, or stop this task here."}
          </span>
        </div>
        {(preview.showDetails || onStopTask) && (
          <div className="task-status-banner-actions">
            {preview.showDetails && (
              <button
                type="button"
                className="task-status-banner-secondary-btn"
                onClick={() => setShowDetails(true)}
              >
                View details
              </button>
            )}
            {onStopTask && (
              <button
                type="button"
                className="task-status-banner-stop-btn"
                onClick={onStopTask}
                title="Stop task"
              >
                Stop task
              </button>
            )}
          </div>
        )}
      </div>

      {showDetails && preview.showDetails && (
        <div className="modal-overlay" onClick={() => setShowDetails(false)}>
          <div
            className="modal task-pause-details-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby={detailsTitleId}
          >
            <div className="modal-header">
              <h2 id={detailsTitleId}>Quick check-in details</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setShowDetails(false)}
                aria-label="Close details"
              >
                ×
              </button>
            </div>
            <div className="modal-body">
              <div className="task-pause-details-text">{preview.fullText}</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
