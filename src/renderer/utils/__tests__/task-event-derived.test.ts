import { describe, expect, it } from "vitest";

import { deriveSharedTaskEventUiState } from "../task-event-derived";

function makeEvent(
  id: string,
  timestamp: number,
  type: string,
  payload: Record<string, unknown> = {},
): Any {
  return {
    id,
    taskId: "task-1",
    timestamp,
    type,
    payload,
  };
}

describe("deriveSharedTaskEventUiState action blocks", () => {
  it("keeps a stable action-block id while the same block grows", () => {
    const baseEvents = [
      makeEvent("user-1", 100, "user_message", { message: "check steps" }),
      makeEvent("step-1", 200, "timeline_step_started", {
        legacyType: "step_started",
        message: "first",
      }),
      makeEvent("step-2", 300, "timeline_step_updated", {
        legacyType: "progress_update",
        message: "second",
      }),
    ];

    const initial = deriveSharedTaskEventUiState({
      rawEvents: baseEvents,
      task: null,
      workspace: null,
      verboseSteps: false,
    });
    const initialBlock = initial.baseTimelineItems.find((item) => item.kind === "action_block");

    const grown = deriveSharedTaskEventUiState({
      rawEvents: [
        ...baseEvents,
        makeEvent("step-3", 400, "timeline_step_updated", {
          legacyType: "progress_update",
          message: "third",
        }),
      ],
      task: null,
      workspace: null,
      verboseSteps: false,
    });
    const grownBlock = grown.baseTimelineItems.find((item) => item.kind === "action_block");

    expect(initialBlock?.kind).toBe("action_block");
    expect(grownBlock?.kind).toBe("action_block");
    expect(initialBlock?.blockId).toBe("action-block:step-1");
    expect(grownBlock?.blockId).toBe(initialBlock?.blockId);
  });
});
