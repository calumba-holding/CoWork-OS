import { describe, expect, it, vi } from "vitest";
import { AgentDaemon } from "../daemon";

describe("AgentDaemon.forkTaskSession", () => {
  it("creates a forked task with session lineage metadata", async () => {
    const forkedTask = {
      id: "forked-task",
      title: "Original task (investigate)",
    };
    const createTaskRecord = vi.fn().mockReturnValue({
      task: forkedTask,
      derived: {
        route: { intent: "debug", domain: "code", confidence: 0.9, signals: [] },
        strategy: { conversationMode: "task", executionMode: "execute" },
      },
    });
    const logEvent = vi.fn();
    const startTask = vi.fn().mockResolvedValue(undefined);
    const cloneForkHistoryEvents = vi.fn();
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-1",
          title: "Original task",
          prompt: "Fix the bug",
          rawPrompt: "Fix the bug",
          userPrompt: "Fix the bug",
          workspaceId: "workspace-1",
          agentConfig: { executionMode: "execute" },
          source: "manual",
        }),
      },
      getTaskEventsForReplay: vi.fn().mockReturnValue([
        {
          id: "event-7",
          eventId: "event-7",
          taskId: "task-1",
          timestamp: 1,
          type: "assistant_message",
          payload: { message: "Prior answer" },
        },
      ]),
      createTaskRecord,
      cloneForkHistoryEvents,
      logEvent,
      logTaskIntentRouted: vi.fn(),
      startTask,
    } as Any);

    const result = await AgentDaemon.prototype.forkTaskSession.call(daemonLike, {
      taskId: "task-1",
      branchLabel: "investigate",
      fromEventId: "event-7",
    });

    expect(createTaskRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        taskOverrides: expect.objectContaining({
          branchFromTaskId: "task-1",
          branchFromEventId: "event-7",
          branchLabel: "investigate",
        }),
      }),
    );
    expect(cloneForkHistoryEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTaskId: "task-1",
        targetTaskId: "forked-task",
        events: expect.arrayContaining([
          expect.objectContaining({
            id: "event-7",
          }),
        ]),
      }),
    );
    expect(logEvent).toHaveBeenCalledWith(
      "forked-task",
      "log",
      expect.objectContaining({
        message: "Session fork created",
        sourceTaskId: "task-1",
      }),
    );
    expect(startTask).not.toHaveBeenCalled();
    expect(result.id).toBe("forked-task");
  });

  it("backtracks before a selected user message and uses it as the branch prompt", async () => {
    const createTaskRecord = vi.fn().mockReturnValue({
      task: { id: "forked-task", title: "Original task (side-chat)" },
      derived: {
        route: { intent: "debug", domain: "code", confidence: 0.9, signals: [] },
        strategy: { conversationMode: "task", executionMode: "execute" },
      },
    });
    const cloneForkHistoryEvents = vi.fn();
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-1",
          title: "Original task",
          prompt: "Original prompt",
          rawPrompt: "Original prompt",
          userPrompt: "Original prompt",
          workspaceId: "workspace-1",
          source: "manual",
        }),
      },
      getTaskEventsForReplay: vi.fn().mockReturnValue([
        {
          id: "event-1",
          eventId: "event-1",
          taskId: "task-1",
          timestamp: 1,
          type: "user_message",
          payload: { message: "Start here" },
        },
        {
          id: "event-2",
          eventId: "event-2",
          taskId: "task-1",
          timestamp: 2,
          type: "assistant_message",
          payload: { message: "Prior answer" },
        },
        {
          id: "event-step",
          eventId: "event-step",
          taskId: "task-1",
          timestamp: 2.5,
          type: "timeline_step_finished",
          payload: { legacyType: "step_completed", message: "Finished a step" },
          legacyType: "step_completed",
        },
        {
          id: "event-3",
          eventId: "event-3",
          taskId: "task-1",
          timestamp: 3,
          type: "user_message",
          payload: { message: "Try the other approach" },
        },
      ]),
      createTaskRecord,
      cloneForkHistoryEvents,
      logEvent: vi.fn(),
      logTaskIntentRouted: vi.fn(),
      startTask: vi.fn().mockResolvedValue(undefined),
    } as Any);

    await AgentDaemon.prototype.forkTaskSession.call(daemonLike, {
      taskId: "task-1",
      branchLabel: "side-chat",
      fromEventId: "event-3",
    });

    expect(createTaskRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Try the other approach",
      }),
    );
    expect(cloneForkHistoryEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        events: [
          expect.objectContaining({ id: "event-1" }),
          expect.objectContaining({ id: "event-2" }),
          expect.objectContaining({ id: "event-step" }),
        ],
      }),
    );
  });
});
