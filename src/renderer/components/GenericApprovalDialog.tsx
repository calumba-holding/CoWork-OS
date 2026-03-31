import { Fragment, type ReactNode } from "react";
import type { ApprovalRequest, ApprovalType } from "../../shared/types";

function titleForType(type: ApprovalType): string {
  switch (type) {
    case "run_command":
      return "Shell command";
    case "delete_file":
      return "Delete file";
    case "delete_multiple":
      return "Delete multiple items";
    case "bulk_rename":
      return "Bulk rename";
    case "network_access":
      return "Network access";
    case "external_service":
      return "External service";
    case "risk_gate":
      return "Risk review";
    case "computer_use":
    case "computer_move_mouse":
    case "computer_click":
    case "computer_type":
    case "computer_key":
      return "Computer use";
    default:
      return "Action approval";
  }
}

function iconForType(type: ApprovalType): string {
  switch (type) {
    case "delete_file":
    case "delete_multiple":
      return "🗑️";
    case "bulk_rename":
      return "📝";
    case "network_access":
      return "🌐";
    case "external_service":
      return "🔗";
    case "run_command":
      return "⌨️";
    default:
      return "⚠️";
  }
}

function formatApprovalTypeLabel(type: ApprovalType): string {
  return type.replace(/_/g, " ");
}

interface GenericApprovalDialogProps {
  approval: ApprovalRequest;
  onApprove: () => void;
  onDeny: () => void;
  onApproveAllSession?: () => void;
}

export function GenericApprovalDialog({
  approval,
  onApprove,
  onDeny,
  onApproveAllSession,
}: GenericApprovalDialogProps) {
  const details =
    approval.details && typeof approval.details === "object" && !Array.isArray(approval.details)
      ? (approval.details as Record<string, unknown>)
      : {};
  const command = typeof details.command === "string" ? details.command : null;
  const cwd = typeof details.cwd === "string" ? details.cwd : null;
  const timeoutMs = typeof details.timeout === "number" && Number.isFinite(details.timeout) ? details.timeout : null;
  const bundleScope = typeof details.bundleScope === "string" ? details.bundleScope : null;
  const path = typeof details.path === "string" ? details.path : null;
  const url = typeof details.url === "string" ? details.url : null;

  const rows: { label: string; value: ReactNode }[] = [];

  rows.push({ label: "Category", value: formatApprovalTypeLabel(approval.type) });

  if (command) {
    rows.push({
      label: "Command",
      value: (
        <div className="session-approval-code-scroll" role="region" aria-label="Command to approve">
          <code className="session-approval-code session-approval-code--multiline">{command}</code>
        </div>
      ),
    });
  }
  if (cwd) {
    rows.push({
      label: "Working directory",
      value: <code className="session-approval-code">{cwd}</code>,
    });
  }
  if (timeoutMs !== null) {
    rows.push({
      label: "Timeout",
      value: `${Math.max(1, Math.round(timeoutMs / 1000))}s`,
    });
  }
  if (bundleScope) {
    rows.push({
      label: "Bundle",
      value: bundleScope.replace(/_/g, " "),
    });
  }
  if (path) {
    rows.push({
      label: "Path",
      value: <code className="session-approval-code">{path}</code>,
    });
  }
  if (url) {
    rows.push({
      label: "URL",
      value: <code className="session-approval-code">{url}</code>,
    });
  }

  return (
    <div className="session-approval-overlay" role="dialog" aria-modal="true">
      <div className="session-approval-card">
        <div className="session-approval-icon" aria-hidden="true">
          {iconForType(approval.type)}
        </div>
        <h3 className="session-approval-title">{titleForType(approval.type)}</h3>
        <p className="session-approval-prompt">{approval.description}</p>

        <dl className="session-approval-details">
          {rows.map((row) => (
            <Fragment key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </Fragment>
          ))}
        </dl>

        <p className="session-approval-footer-hint">
          This decision applies only to this request. You can enable session auto-approve from the
          link below if you trust this run.
        </p>

        <div className="session-approval-actions">
          <button type="button" className="session-approval-btn-deny" onClick={onDeny}>
            Deny
          </button>
          <button type="button" className="session-approval-btn-allow" onClick={onApprove}>
            Approve
          </button>
        </div>

        {onApproveAllSession ? (
          <button
            type="button"
            className="session-approval-approve-all-link"
            onClick={onApproveAllSession}
          >
            Approve all for this session
          </button>
        ) : null}
      </div>
    </div>
  );
}
