import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../types";
import {
  inferTimelineStageForLegacyType,
  normalizeTaskEventToTimelineV2,
  projectTimelineEventToLegacy,
} from "../timeline-v2";

describe("timeline v2 helpers", () => {
  it("normalizes legacy step events into timeline step lifecycle events", () => {
    const normalized = normalizeTaskEventToTimelineV2({
      taskId: "task-1",
      type: "step_completed",
      payload: {
        step: { id: "step-1", description: "Run verification" },
      },
      timestamp: 1_700_000_000_000,
      eventId: "event-1",
      seq: 12,
    });

    expect(normalized.type).toBe("timeline_step_finished");
    expect(normalized.schemaVersion).toBe(2);
    expect(normalized.status).toBe("completed");
    expect(normalized.stepId).toBe("step-1");
    expect(normalized.legacyType).toBe("step_completed");
  });

  it("projects timeline events back to legacy shape for compatibility consumers", () => {
    const projected = projectTimelineEventToLegacy({
      id: "event-2",
      taskId: "task-2",
      timestamp: 1_700_000_000_100,
      type: "timeline_step_finished",
      payload: {
        legacyType: "task_completed",
        message: "Task completed successfully",
      },
      schemaVersion: 2,
      eventId: "event-2",
      seq: 22,
      ts: 1_700_000_000_100,
      status: "completed",
      stepId: "step:deliver",
      actor: "system",
    } as TaskEvent);

    expect(projected.type).toBe("task_completed");
    expect(projected.payload.message).toBe("Task completed successfully");
  });

  it("maps key legacy lifecycle events to timeline stages", () => {
    expect(inferTimelineStageForLegacyType("task_created")).toBe("DISCOVER");
    expect(inferTimelineStageForLegacyType("tool_call")).toBe("BUILD");
    expect(inferTimelineStageForLegacyType("verification_passed")).toBe("VERIFY");
    expect(inferTimelineStageForLegacyType("step_failed")).toBe("FIX");
    expect(inferTimelineStageForLegacyType("task_completed")).toBe("DELIVER");
  });

  it("maps workflow_detected to a timeline group start event", () => {
    const normalized = normalizeTaskEventToTimelineV2({
      taskId: "task-wf",
      type: "workflow_detected",
      payload: {
        phaseCount: 3,
        phases: [
          { type: "research" },
          { type: "build" },
          { type: "verify" },
        ],
      },
      timestamp: 1_700_000_000_200,
      eventId: "event-workflow",
      seq: 33,
    });

    expect(normalized.type).toBe("timeline_group_started");
    expect(normalized.status).toBe("in_progress");
    expect(normalized.legacyType).toBe("workflow_detected");
  });
});
