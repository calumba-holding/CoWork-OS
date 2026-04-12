import { describe, expect, it } from "vitest";
import type { Task, TaskEvent } from "../../../shared/types";
import {
  buildTaskEventHistoryForTransport,
  serializeTaskEventForTransport,
} from "../task-event-transport";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Remote task",
    prompt: "Prompt",
    status: "executing",
    workspaceId: "workspace-1",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Task;
}

function makeEvent(
  id: string,
  type: TaskEvent["type"],
  timestamp: number,
  overrides: Partial<TaskEvent> = {},
): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp,
    type,
    payload: {},
    ...overrides,
  } as TaskEvent;
}

describe("task-event transport", () => {
  it("preserves verbose timeline metadata when serializing remote history", () => {
    const event = makeEvent("evt-1", "timeline_step_updated", 10, {
      legacyType: "tool_call",
      stepId: "step-1",
      groupId: "tools:web",
      status: "running",
      seq: 7,
      eventId: "event-1",
      actor: "tool",
      payload: {
        tool: "web_search",
        nested: {
          fn: () => "drop me",
          keep: "ok",
        },
      } as unknown as Record<string, unknown>,
    });

    const serialized = serializeTaskEventForTransport(event, (value) =>
      JSON.parse(
        JSON.stringify(value, (_key, innerValue) =>
          typeof innerValue === "function" ? undefined : innerValue,
        ),
      ),
    );

    expect(serialized.legacyType).toBe("tool_call");
    expect(serialized.stepId).toBe("step-1");
    expect(serialized.groupId).toBe("tools:web");
    expect(serialized.status).toBe("running");
    expect(serialized.seq).toBe(7);
    expect(serialized.eventId).toBe("event-1");
    expect(serialized.actor).toBe("tool");
    expect(serialized.payload).toEqual({
      tool: "web_search",
      nested: {
        keep: "ok",
      },
    });
  });

  it("matches local task history behavior for collaborative roots", () => {
    const parentEvents = [
      makeEvent("evt-1", "timeline_step_started", 10),
      makeEvent("evt-2", "timeline_step_finished", 20),
    ];
    const childFileEvent = {
      ...makeEvent("evt-3", "artifact_created", 15),
      taskId: "child-1",
    };
    const taskRepo = {
      findById: () =>
        makeTask({
          agentConfig: { collaborativeMode: true } as Task["agentConfig"],
        }),
      findByParent: () => [makeTask({ id: "child-1", parentTaskId: "task-1" })],
    };
    const eventRepo = {
      findRecentByTaskId: () => parentEvents,
      findByTaskIds: () => [childFileEvent],
    };

    const events = buildTaskEventHistoryForTransport({
      taskId: "task-1",
      limit: 10,
      taskRepo,
      eventRepo,
    });

    expect(events.map((event) => event.id)).toEqual(["evt-1", "evt-3", "evt-2"]);
  });
});
