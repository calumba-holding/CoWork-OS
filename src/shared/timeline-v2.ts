import type {
  EventType,
  EvidenceRef,
  TaskEvent,
  TaskTimelineEventV2,
  TimelineEventActor,
  TimelineEventStatus,
  TimelineEventType,
  TimelineStage,
} from "./types";

export const TIMELINE_SCHEMA_VERSION = 2 as const;

export const TIMELINE_EVENT_TYPES: readonly TimelineEventType[] = [
  "timeline_group_started",
  "timeline_group_finished",
  "timeline_step_started",
  "timeline_step_updated",
  "timeline_step_finished",
  "timeline_evidence_attached",
  "timeline_artifact_emitted",
  "timeline_command_output",
  "timeline_error",
] as const;

const TIMELINE_EVENT_SET = new Set<string>(TIMELINE_EVENT_TYPES);

export function isTimelineEventType(value: unknown): value is TimelineEventType {
  return typeof value === "string" && TIMELINE_EVENT_SET.has(value);
}

function coerceEventStatus(value: unknown): TimelineEventStatus | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "pending":
    case "in_progress":
    case "completed":
    case "failed":
    case "blocked":
    case "skipped":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

function coerceEventActor(value: unknown): TimelineEventActor | undefined {
  if (typeof value !== "string") return undefined;
  switch (value) {
    case "system":
    case "agent":
    case "user":
    case "tool":
    case "subagent":
      return value;
    default:
      return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function deriveStepId(
  taskId: string,
  payload: Record<string, unknown>,
  fallback: string,
  defaultStepId?: string,
): string {
  if (typeof payload.stepId === "string" && payload.stepId.trim().length > 0) {
    return payload.stepId.trim();
  }
  const step = asObject(payload.step);
  if (typeof step.id === "string" && step.id.trim().length > 0) {
    return step.id.trim();
  }
  if (typeof payload.commandId === "string" && payload.commandId.trim().length > 0) {
    return `command:${payload.commandId.trim()}`;
  }
  if (typeof payload.tool === "string" && payload.tool.trim().length > 0) {
    return `tool:${payload.tool.trim()}`;
  }
  if (typeof defaultStepId === "string" && defaultStepId.trim().length > 0) {
    return defaultStepId.trim();
  }
  return `${fallback}:${taskId}`;
}

function inferLegacyTimelineType(
  legacyType: EventType,
  payload: Record<string, unknown>,
): TimelineEventType {
  if (
    legacyType === "file_created" ||
    legacyType === "file_modified" ||
    legacyType === "file_deleted" ||
    legacyType === "artifact_created"
  ) {
    return "timeline_artifact_emitted";
  }

  if (legacyType === "command_output") {
    return "timeline_command_output";
  }

  if (legacyType === "citations_collected") {
    return "timeline_evidence_attached";
  }

  if (legacyType === "step_started") {
    return "timeline_step_started";
  }

  if (
    legacyType === "step_completed" ||
    legacyType === "step_skipped" ||
    legacyType === "task_completed" ||
    legacyType === "task_cancelled"
  ) {
    return "timeline_step_finished";
  }

  if (
    legacyType === "error" ||
    legacyType === "step_failed" ||
    legacyType === "verification_failed" ||
    legacyType === "tool_error" ||
    legacyType === "llm_error" ||
    legacyType === "step_timeout" ||
    legacyType === "follow_up_failed"
  ) {
    return "timeline_error";
  }

  if (legacyType === "verification_pending_user_action") {
    return "timeline_step_updated";
  }

  if (legacyType === "workflow_phase_started" || legacyType === "workflow_detected") {
    return "timeline_group_started";
  }

  if (
    legacyType === "workflow_phase_completed" ||
    legacyType === "pipeline_completed" ||
    legacyType === "workflow_phase_failed"
  ) {
    return "timeline_group_finished";
  }

  return "timeline_step_updated";
}

function inferLegacyStatus(
  legacyType: EventType,
  payload: Record<string, unknown>,
): TimelineEventStatus {
  const explicit = coerceEventStatus(payload.status);
  if (explicit) return explicit;

  switch (legacyType) {
    case "task_queued":
      return "pending";
    case "task_paused":
    case "approval_requested":
      return "blocked";
    case "step_started":
    case "task_created":
    case "task_resumed":
    case "task_dequeued":
    case "executing":
      return "in_progress";
    case "step_completed":
    case "verification_passed":
    case "task_completed":
      return "completed";
    case "verification_pending_user_action":
      return "blocked";
    case "step_skipped":
      return "skipped";
    case "task_cancelled":
      return "cancelled";
    case "auto_continuation_blocked":
    case "no_progress_circuit_breaker":
      return "failed";
    case "error":
    case "step_failed":
    case "verification_failed":
    case "tool_error":
    case "llm_error":
    case "step_timeout":
    case "approval_denied":
      return "failed";
    default:
      return "in_progress";
  }
}

function inferLegacyActor(legacyType: EventType): TimelineEventActor {
  if (legacyType === "user_message" || legacyType === "user_feedback") {
    return "user";
  }
  if (legacyType === "assistant_message" || legacyType === "agent_thought") {
    return "agent";
  }
  if (
    legacyType === "tool_call" ||
    legacyType === "tool_result" ||
    legacyType === "tool_error" ||
    legacyType === "command_output"
  ) {
    return "tool";
  }
  if (
    legacyType === "agent_spawned" ||
    legacyType === "agent_completed" ||
    legacyType === "agent_failed" ||
    legacyType === "sub_agent_result"
  ) {
    return "subagent";
  }
  return "system";
}

function toEvidenceRefs(payload: Record<string, unknown>, timestamp: number): EvidenceRef[] {
  const raw = payload.evidenceRefs;
  if (Array.isArray(raw)) {
    const refs: EvidenceRef[] = [];
    raw.forEach((entry, index) => {
        const obj = asObject(entry);
        const evidenceId =
          typeof obj.evidenceId === "string" && obj.evidenceId.trim().length > 0
            ? obj.evidenceId.trim()
            : `evidence-${index + 1}`;
        const sourceType =
          obj.sourceType === "url" ||
          obj.sourceType === "file" ||
          obj.sourceType === "tool_output" ||
          obj.sourceType === "user_input" ||
          obj.sourceType === "other"
            ? obj.sourceType
            : "other";
        const sourceUrlOrPath =
          typeof obj.sourceUrlOrPath === "string" && obj.sourceUrlOrPath.trim().length > 0
            ? obj.sourceUrlOrPath.trim()
            : "";
        if (!sourceUrlOrPath) return;
        refs.push({
          evidenceId,
          sourceType,
          sourceUrlOrPath,
          snippet: typeof obj.snippet === "string" ? obj.snippet : undefined,
          capturedAt:
            typeof obj.capturedAt === "number" && Number.isFinite(obj.capturedAt)
              ? obj.capturedAt
              : timestamp,
        });
      });
    return refs;
  }

  const citations = payload.citations;
  if (!Array.isArray(citations) || citations.length === 0) return [];

  const refs: EvidenceRef[] = [];
  citations.forEach((citation, index) => {
    const obj = asObject(citation);
    const url =
      typeof obj.url === "string" && obj.url.trim().length > 0
        ? obj.url.trim()
        : typeof obj.source === "string" && obj.source.trim().length > 0
          ? obj.source.trim()
          : "";
    if (!url) return;
    const snippet =
      typeof obj.snippet === "string"
        ? obj.snippet
        : typeof obj.title === "string"
          ? obj.title
          : undefined;
    refs.push({
      evidenceId: `citation-${index + 1}`,
      sourceType: "url",
      sourceUrlOrPath: url,
      snippet,
      capturedAt: timestamp,
    });
  });

  return refs;
}

export function inferTimelineStageForLegacyType(type: EventType): TimelineStage | undefined {
  switch (type) {
    case "task_created":
    case "plan_created":
    case "plan_revised":
      return "DISCOVER";
    case "step_started":
    case "step_completed":
    case "tool_call":
    case "tool_result":
    case "file_created":
    case "file_modified":
    case "file_deleted":
    case "artifact_created":
    case "command_output":
      return "BUILD";
    case "verification_started":
    case "verification_passed":
    case "verification_pending_user_action":
      return "VERIFY";
    case "verification_failed":
    case "retry_started":
    case "continuation_decision":
    case "auto_continuation_started":
    case "auto_continuation_blocked":
    case "context_compaction_started":
    case "context_compaction_completed":
    case "context_compaction_failed":
    case "step_contract_escalated":
    case "no_progress_circuit_breaker":
    case "step_failed":
    case "tool_error":
      return "FIX";
    case "task_completed":
      return "DELIVER";
    default:
      return undefined;
  }
}

export function stageToGroupId(stage: TimelineStage): string {
  return `stage:${stage.toLowerCase()}`;
}

export function normalizeTaskEventToTimelineV2(params: {
  taskId: string;
  type: string;
  payload: unknown;
  timestamp: number;
  eventId: string;
  seq: number;
  defaultStepId?: string;
  explicitGroupId?: string;
}): TaskTimelineEventV2 {
  const payload = asObject(params.payload);
  const rawType = params.type;

  if (isTimelineEventType(rawType)) {
    const status =
      coerceEventStatus(payload.status) ||
      (rawType === "timeline_group_finished" || rawType === "timeline_step_finished"
        ? "completed"
        : rawType === "timeline_error"
          ? "failed"
          : "in_progress");
    const actor = coerceEventActor(payload.actor) || "system";
    const stepId = deriveStepId(params.taskId, payload, "timeline", params.defaultStepId);
    const groupId =
      (typeof payload.groupId === "string" && payload.groupId.trim().length > 0
        ? payload.groupId.trim()
        : params.explicitGroupId) || undefined;
    const eventId =
      typeof payload.eventId === "string" && payload.eventId.trim().length > 0
        ? payload.eventId.trim()
        : params.eventId;
    const ts =
      typeof payload.ts === "number" && Number.isFinite(payload.ts) ? payload.ts : params.timestamp;

    const maybeEvidenceRefs =
      rawType === "timeline_evidence_attached" ? toEvidenceRefs(payload, params.timestamp) : [];
    const nextPayload =
      maybeEvidenceRefs.length > 0 ? { ...payload, evidenceRefs: maybeEvidenceRefs } : payload;

    return {
      id: eventId,
      taskId: params.taskId,
      timestamp: params.timestamp,
      type: rawType,
      payload: nextPayload,
      schemaVersion: TIMELINE_SCHEMA_VERSION,
      eventId,
      seq: params.seq,
      ts,
      status,
      stepId,
      ...(groupId ? { groupId } : {}),
      actor,
      legacyType:
        typeof payload.legacyType === "string" ? (payload.legacyType as EventType) : undefined,
    };
  }

  const legacyType = rawType as EventType;
  const timelineType = inferLegacyTimelineType(legacyType, payload);
  const status = inferLegacyStatus(legacyType, payload);
  const actor = inferLegacyActor(legacyType);
  const stepId = deriveStepId(params.taskId, payload, "task", params.defaultStepId);
  const stage = inferTimelineStageForLegacyType(legacyType);
  const groupId =
    (typeof payload.groupId === "string" && payload.groupId.trim().length > 0
      ? payload.groupId.trim()
      : params.explicitGroupId) ||
    (stage ? stageToGroupId(stage) : undefined);

  const nextPayload: Record<string, unknown> = {
    ...payload,
    legacyType,
  };
  if (timelineType === "timeline_evidence_attached") {
    nextPayload.evidenceRefs = toEvidenceRefs(payload, params.timestamp);
  }

  return {
    id: params.eventId,
    taskId: params.taskId,
    timestamp: params.timestamp,
    type: timelineType,
    payload: nextPayload,
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    eventId: params.eventId,
    seq: params.seq,
    ts: params.timestamp,
    status,
    stepId,
    ...(groupId ? { groupId } : {}),
    actor,
    legacyType,
  };
}

function defaultLegacyTypeForTimeline(
  type: TimelineEventType,
  status: TimelineEventStatus,
): EventType {
  switch (type) {
    case "timeline_group_started":
      return "step_started";
    case "timeline_group_finished":
      return "step_completed";
    case "timeline_step_started":
      return "step_started";
    case "timeline_step_updated":
      return "progress_update";
    case "timeline_step_finished":
      if (status === "failed") return "step_failed";
      if (status === "skipped") return "step_skipped";
      if (status === "cancelled") return "task_cancelled";
      return "step_completed";
    case "timeline_evidence_attached":
      return "citations_collected";
    case "timeline_artifact_emitted":
      return "artifact_created";
    case "timeline_command_output":
      return "command_output";
    case "timeline_error":
      return "error";
    default:
      return "progress_update";
  }
}

export function projectTimelineEventToLegacy(event: TaskEvent): TaskEvent {
  if (!isTimelineEventType(event.type)) return event;
  const payload = asObject(event.payload);
  const status = coerceEventStatus(event.status ?? payload.status) || "in_progress";
  const legacyTypeRaw = typeof payload.legacyType === "string" ? payload.legacyType : undefined;
  const legacyType =
    legacyTypeRaw && !isTimelineEventType(legacyTypeRaw)
      ? (legacyTypeRaw as EventType)
      : defaultLegacyTypeForTimeline(event.type, status);

  const legacyPayload = { ...payload };
  delete legacyPayload.legacyType;

  if (
    (legacyType === "step_started" || legacyType === "step_completed" || legacyType === "step_failed") &&
    !legacyPayload.step
  ) {
    legacyPayload.step = {
      id: event.stepId || `step:${event.taskId}`,
      description:
        (typeof payload.message === "string" && payload.message) ||
        (typeof payload.groupLabel === "string" && payload.groupLabel) ||
        "Timeline step",
    };
  }

  return {
    id: event.id,
    taskId: event.taskId,
    timestamp: event.timestamp,
    type: legacyType,
    payload: legacyPayload,
    schemaVersion: event.schemaVersion,
    eventId: event.eventId,
    seq: event.seq,
    ts: event.ts,
    status: event.status,
    stepId: event.stepId,
    groupId: event.groupId,
    actor: event.actor,
    legacyType: event.legacyType,
  };
}

export function extractTimelineEvidenceRefs(event: TaskEvent): EvidenceRef[] {
  const payload = asObject(event.payload);
  const now = typeof event.timestamp === "number" ? event.timestamp : Date.now();
  return toEvidenceRefs(payload, now);
}
