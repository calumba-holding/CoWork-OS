import { describe, expect, it } from "vitest";

import type { Task, TaskEvent } from "../../../shared/types";
import {
  collectInlineRunCommandSessionIds,
  deriveTaskHeaderPresentation,
  estimateTaskFeedRowHeight,
  getAutoScrollTargetTop,
  getDefaultTranscriptMode,
  hasInactiveStringSetEntries,
  isTaskActivelyWorking,
  pruneStringSetToActiveIds,
  selectVisibleTaskFeedRows,
  shouldScheduleAutoScrollWrite,
} from "../MainContent";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Test task",
    prompt: "Test prompt",
    status: "executing",
    createdAt: 0,
    updatedAt: 0,
    executionMode: "execute",
    ...overrides,
  } as Task;
}

function makeEvent(
  id: string,
  timestamp: number,
  type: TaskEvent["type"],
  payload: Record<string, unknown> = {},
): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp,
    type,
    payload,
  } as TaskEvent;
}

describe("isTaskActivelyWorking", () => {
  it("hides the header title when it only repeats the initial prompt", () => {
    const presentation = deriveTaskHeaderPresentation({
      title: "run command 'echo hello world'",
      prompt: "run command 'echo hello world'",
    });

    expect(presentation.showHeaderTitle).toBe(false);
    expect(presentation.trimmedPrompt).toBe("run command 'echo hello world'");
  });

  it("keeps the header title when it adds distinct context beyond the prompt", () => {
    const presentation = deriveTaskHeaderPresentation({
      title: "Shell reproduction",
      prompt: "run command 'echo hello world'",
    });

    expect(presentation.showHeaderTitle).toBe(true);
    expect(presentation.headerTitle).toBe("Shell reproduction");
  });

  it("keeps executing tasks active when newer progress follows an older completed follow-up", () => {
    const task = makeTask();
    const events = [
      makeEvent("follow-up-done", 1_000, "follow_up_completed"),
      makeEvent("step-progress", 2_000, "timeline_step_updated", {
        legacyType: "progress_update",
        message: "Working on your request",
      }),
    ];

    expect(isTaskActivelyWorking(task, events, false, 2_500)).toBe(true);
  });

  it("marks executing tasks idle when the latest relevant event is a completed follow-up", () => {
    const task = makeTask();
    const events = [makeEvent("follow-up-done", 2_000, "follow_up_completed")];

    expect(isTaskActivelyWorking(task, events, false, 2_500)).toBe(false);
  });

  it("does not treat generic error events as terminal while the task is still executing", () => {
    const task = makeTask();
    const events = [makeEvent("tool-side-error", 2_000, "error", { error: "Image generation failed" })];

    expect(isTaskActivelyWorking(task, events, false, 2_500)).toBe(true);
  });

  it("computes the correct bottom-scroll target", () => {
    expect(getAutoScrollTargetTop(1200, 400)).toBe(800);
    expect(getAutoScrollTargetTop(300, 400)).toBe(0);
  });

  it("skips auto-scroll writes when already pinned to the same bottom target", () => {
    expect(
      shouldScheduleAutoScrollWrite({
        scrollTop: 800,
        scrollHeight: 1200,
        clientHeight: 400,
        lastTargetTop: 800,
      }),
    ).toBe(false);
  });

  it("schedules auto-scroll writes when the bottom target materially changes", () => {
    expect(
      shouldScheduleAutoScrollWrite({
        scrollTop: 800,
        scrollHeight: 1400,
        clientHeight: 400,
        lastTargetTop: 800,
      }),
    ).toBe(true);
  });

  it("defaults transcript mode to live only while a non-chat task is actively working", () => {
    expect(
      getDefaultTranscriptMode({
        isTaskWorking: true,
        isReplayMode: false,
        verboseSteps: false,
        isChatTask: false,
      }),
    ).toBe("live");
    expect(
      getDefaultTranscriptMode({
        isTaskWorking: false,
        isReplayMode: false,
        verboseSteps: false,
        isChatTask: false,
      }),
    ).toBe("inspect");
  });

  it("detects when action block state contains stale ids", () => {
    expect(
      hasInactiveStringSetEntries(new Set(["block-1", "block-2"]), new Set(["block-2", "block-3"])),
    ).toBe(true);
    expect(hasInactiveStringSetEntries(new Set(["block-2"]), new Set(["block-2", "block-3"]))).toBe(
      false,
    );
  });

  it("prunes action block state down to active ids", () => {
    expect(
      [...pruneStringSetToActiveIds(new Set(["block-1", "block-2"]), new Set(["block-2", "block-3"]))],
    ).toEqual(["block-2"]);
  });

  it("projects a bounded live transcript row set while preserving hidden count", () => {
    const rows = [
      {
        kind: "timeline",
        key: "user-1",
        estimatedHeight: 100,
        timelineIndex: 0,
        visiblePerfEventId: "user-1",
        revision: "user-1",
        item: { kind: "event", event: makeEvent("user-1", 100, "user_message", { message: "User" }) },
      },
      {
        kind: "timeline",
        key: "assistant-1",
        estimatedHeight: 100,
        timelineIndex: 1,
        visiblePerfEventId: "assistant-1",
        revision: "assistant-1",
        item: {
          kind: "event",
          event: makeEvent("assistant-1", 200, "assistant_message", { message: "First answer" }),
        },
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        kind: "timeline",
        key: `progress-${index}`,
        estimatedHeight: 100,
        timelineIndex: index + 2,
        visiblePerfEventId: `progress-${index}`,
        revision: `progress-${index}`,
        item: {
          kind: "event",
          event: makeEvent(`progress-${index}`, 300 + index, "timeline_step_updated", {
            legacyType: "progress_update",
            message: `Progress ${index}`,
          }),
        },
      })),
      {
        kind: "timeline",
        key: "action-block-1",
        estimatedHeight: 180,
        timelineIndex: 20,
        visiblePerfEventId: "step-2",
        revision: "action-block-1",
        item: {
          kind: "action_block",
          blockId: "action-block-1",
          events: [
            makeEvent("step-1", 500, "timeline_step_started", {
              legacyType: "step_started",
            }),
            makeEvent("step-2", 600, "timeline_step_updated", {
              legacyType: "progress_update",
              message: "Final meaningful step",
            }),
          ],
        },
      },
    ] as Any[];

    const result = selectVisibleTaskFeedRows(rows, "live");

    expect(result.visibleFeedRows.length).toBeLessThan(rows.length);
    expect(result.hiddenLiveFeedRowCount).toBe(rows.length - result.visibleFeedRows.length);
    expect(result.visibleFeedRows.some((row) => row.key === "action-block-1")).toBe(true);
    expect(result.visibleFeedRows.some((row) => row.key === "assistant-1")).toBe(true);
  });

  it("keeps the full transcript visible in inspect mode", () => {
    const rows = [
      {
        kind: "timeline",
        key: "budget-1",
        estimatedHeight: 100,
        timelineIndex: 0,
        visiblePerfEventId: "budget-1",
        revision: "budget-1",
        item: {
          kind: "event",
          event: makeEvent("budget-1", 100, "timeline_step_updated", {
            legacyType: "llm_output_budget",
            message: "Budget remaining: 82%",
          }),
        },
      },
      {
        kind: "timeline",
        key: "assistant-1",
        estimatedHeight: 100,
        timelineIndex: 1,
        visiblePerfEventId: "assistant-1",
        revision: "assistant-1",
        item: {
          kind: "event",
          event: makeEvent("assistant-1", 200, "assistant_message", { message: "Answer" }),
        },
      },
    ] as Any[];

    const result = selectVisibleTaskFeedRows(rows, "inspect");

    expect(result.visibleFeedRows).toHaveLength(rows.length);
    expect(result.hiddenLiveFeedRowCount).toBe(0);
    expect(result.visibleFeedRows[0]?.key).toBe("budget-1");
  });

  it("keeps collapsed action block estimates compact for virtualized history views", () => {
    const height = estimateTaskFeedRowHeight(
      {
        kind: "action_block",
        blockId: "action-block-1",
        events: Array.from({ length: 40 }, (_, index) =>
          makeEvent(`step-${index}`, index, "timeline_step_updated", {
            legacyType: "progress_update",
            message: `Step ${index}`,
          }),
        ),
      },
      { expanded: false, visibleEventCount: 0, hasVisibilityToggle: false },
    );

    expect(height).toBe(56);
  });

  it("bases expanded action block estimates on visible rows instead of raw hidden events", () => {
    const height = estimateTaskFeedRowHeight(
      {
        kind: "action_block",
        blockId: "action-block-1",
        events: Array.from({ length: 40 }, (_, index) =>
          makeEvent(`step-${index}`, index, "timeline_step_updated", {
            legacyType: "progress_update",
            message: `Step ${index}`,
          }),
        ),
      },
      { expanded: true, visibleEventCount: 7, hasVisibilityToggle: true },
    );

    expect(height).toBeLessThan(520);
    expect(height).toBe(488);
  });

  it("only suppresses run_command terminals for visible expanded rows", () => {
    const hiddenRunCommand = makeEvent("tool-call-hidden", 100, "timeline_step_updated", {
      legacyType: "tool_call",
      tool: "run_command",
    });
    const visibleRead = makeEvent("tool-call-visible", 200, "timeline_step_updated", {
      legacyType: "tool_call",
      tool: "read_file",
    });

    const sessionsByIndex = new Map([
      [0, [{ id: "cmd-hidden", command: "npm test", output: "ok", isRunning: false, exitCode: 0, startTimestamp: 100 }]],
      [1, [{ id: "cmd-visible", command: "cat file", output: "ok", isRunning: false, exitCode: 0, startTimestamp: 200 }]],
    ]);

    const hiddenIds = collectInlineRunCommandSessionIds({
      events: [visibleRead],
      eventIndices: [1],
      commandOutputSessionsByInsertIndex: sessionsByIndex as Any,
      isEventExpanded: (event) => event.id === "tool-call-hidden",
    });

    expect(hiddenIds.has("cmd-hidden")).toBe(false);
    expect(hiddenIds.has("cmd-visible")).toBe(false);

    const visibleIds = collectInlineRunCommandSessionIds({
      events: [hiddenRunCommand],
      eventIndices: [0],
      commandOutputSessionsByInsertIndex: sessionsByIndex as Any,
      isEventExpanded: (event) => event.id === "tool-call-hidden",
    });

    expect(visibleIds.has("cmd-hidden")).toBe(true);
  });
});
