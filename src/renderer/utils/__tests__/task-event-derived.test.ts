import { describe, expect, it } from "vitest";

import {
  taskSurfaceFailureStormEvents,
  taskSurfaceFailureStormTask,
} from "../../perf-fixtures/task-surface-failure-storm.fixture";
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

  it("keeps internal assistant media directives visible and exposes them as files", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("assistant-preview", 200, "timeline_step_updated", {
          legacyType: "assistant_message",
          internal: true,
          message:
            'Rendered.\n\n::video{path="artifacts/hyperframes-demo.mp4" title="HyperFrames Demo" muted=true loop=true}',
        }),
        makeEvent("task-complete", 300, "task_completed", {
          resultSummary: "Completed without output summary metadata.",
        }),
      ],
      task: {
        id: "task-1",
        status: "completed",
      } as Any,
      workspace: {
        id: "workspace-1",
        path: "/workspace",
      } as Any,
      verboseSteps: false,
    });

    expect(shared.filteredEvents.map((event) => event.id)).toContain("assistant-preview");
    expect(shared.outputSummary?.primaryOutputPath).toBe("artifacts/hyperframes-demo.mp4");
    expect(shared.files.map((file) => file.path)).toContain("artifacts/hyperframes-demo.mp4");
  });

  it("bounds live projection while retaining required anchors", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: taskSurfaceFailureStormEvents,
      task: taskSurfaceFailureStormTask,
      workspace: null,
      verboseSteps: false,
      projectionMode: "live",
      liveWindowSize: 160,
    });

    const ids = new Set(shared.normalizedEvents.map((event) => event.id));
    expect(shared.projectionMode).toBe("live");
    expect(shared.rawEventCount).toBeGreaterThan(600);
    expect(shared.normalizedEvents.length).toBeLessThanOrEqual(167);
    expect(ids.has("user-1")).toBe(true);
    expect(ids.has("assistant-2")).toBe(true);
    expect(ids.has("artifact-1")).toBe(true);
    expect(ids.has("terminal-1")).toBe(true);
  });

  it("coalesces identical provider failures in live projection", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: [
        makeEvent("user-1", 100, "user_message", { message: "search" }),
        makeEvent("error-1", 1_000, "error", {
          provider: "search",
          code: "FETCH_FAILED",
          message: "fetch failed: network timeout",
        }),
        makeEvent("error-2", 5_000, "error", {
          provider: "search",
          code: "FETCH_FAILED",
          message: "fetch failed: network timeout",
        }),
        makeEvent("error-3", 13_000, "error", {
          provider: "search",
          code: "FETCH_FAILED",
          message: "fetch failed: network timeout",
        }),
      ],
      task: { id: "task-1", status: "executing" } as Any,
      workspace: null,
      verboseSteps: false,
      projectionMode: "live",
    });

    expect(shared.filteredEvents.map((event) => event.id)).toEqual([
      "user-1",
      "error-1",
      "error-3",
    ]);
  });

  it("limits command output sessions when more sessions are running than the UI budget", () => {
    const shared = deriveSharedTaskEventUiState({
      rawEvents: Array.from({ length: 20 }, (_, index) =>
        makeEvent(`command-${index}`, 1_000 + index, "command_output", {
          type: "start",
          command: `node script-${index}.js`,
          output: `$ node script-${index}.js\n`,
        }),
      ),
      task: { id: "task-1", status: "executing" } as Any,
      workspace: null,
      verboseSteps: false,
    });

    expect(shared.commandOutputSessions).toHaveLength(12);
    expect(shared.commandOutputSessions.every((session) => session.isRunning)).toBe(true);
    expect(shared.commandOutputSessions[0].command).toBe("node script-8.js");
  });
});
