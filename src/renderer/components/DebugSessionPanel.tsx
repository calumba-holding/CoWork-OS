import { useMemo } from "react";
import { Bug } from "lucide-react";
import type { TaskEvent } from "../../shared/types";
import { DEBUG_PHASE_ORDER, type DebugPhase } from "../../shared/debug-mode";

function isDebugPhase(value: unknown): value is DebugPhase {
  return typeof value === "string" && (DEBUG_PHASE_ORDER as readonly string[]).includes(value);
}

export interface DebugSessionPanelProps {
  events: TaskEvent[];
}

/**
 * Summary strip for tasks created in Debug execution mode: phase, ingest URL, loop stages.
 */
export function DebugSessionPanel({ events }: DebugSessionPanelProps) {
  const { ingestUrl, activePhase } = useMemo(() => {
    let ingest: string | null = null;
    let phase: DebugPhase = "hypothesize";
    let phaseFound = false;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const payload = e.payload as Record<string, unknown> | undefined;
      if (!ingest && e.type === "timeline_evidence_attached" && payload?.debugIngestUrl) {
        const refs = payload.evidenceRefs;
        if (Array.isArray(refs) && refs[0] && typeof (refs[0] as { sourceUrlOrPath?: string }).sourceUrlOrPath === "string") {
          ingest = (refs[0] as { sourceUrlOrPath: string }).sourceUrlOrPath;
        }
      }
      if (!phaseFound && e.type === "timeline_step_started" && payload?.debugPhase && isDebugPhase(payload.debugPhase)) {
        phase = payload.debugPhase;
        phaseFound = true;
      }
      if (ingest && phaseFound) {
        break;
      }
    }
    return { ingestUrl: ingest, activePhase: phase };
  }, [events]);

  return (
    <div
      className="debug-session-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        marginBottom: 12,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1px solid var(--color-border-subtle, rgba(0,0,0,0.08))",
        background: "var(--color-bg-elevated, rgba(99, 102, 241, 0.06))",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600, fontSize: "0.8rem" }}>
        <Bug size={16} strokeWidth={2} aria-hidden />
        <span>Debug mode</span>
        <span
          style={{
            marginLeft: "auto",
            fontSize: "0.72rem",
            fontWeight: 500,
            color: "var(--color-text-muted, #6b7280)",
          }}
        >
          Phase: {activePhase}
        </span>
      </div>
      <div style={{ fontSize: "0.75rem", color: "var(--color-text-muted, #6b7280)", lineHeight: 1.45 }}>
        Hypothesize → instrument → reproduce → analyze logs → targeted fix → verify → remove{" "}
        <code style={{ fontSize: "0.7rem" }}>cowork-debug</code> markers. Use structured prompts when the agent asks
        you to reproduce or confirm.
      </div>
      {ingestUrl ? (
        <div style={{ fontSize: "0.72rem" }}>
          <span style={{ fontWeight: 600 }}>Runtime ingest: </span>
          <code
            style={{
              wordBreak: "break-all",
              fontSize: "0.68rem",
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--color-bg-muted, rgba(0,0,0,0.04))",
            }}
          >
            {ingestUrl}
          </code>
        </div>
      ) : (
        <div style={{ fontSize: "0.72rem", color: "var(--color-text-muted, #6b7280)" }}>
          Starting debug runtime collector…
        </div>
      )}
      <div style={{ fontSize: "0.68rem", color: "var(--color-text-muted, #8b8fa3)" }}>
        Stages: {DEBUG_PHASE_ORDER.join(" → ")}
      </div>
    </div>
  );
}
