import { beforeEach, describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  markTaskEventRenderable,
  markTaskEventVisible,
  noteRendererTaskEventReceived,
  noteRendererTaskEventsAppendDispatched,
  noteRendererTaskEventsAppended,
} from "../renderer-perf";

function makeEvent(
  overrides: Partial<TaskEvent> & Pick<TaskEvent, "id" | "taskId" | "type">,
): TaskEvent {
  return {
    id: overrides.id,
    taskId: overrides.taskId,
    type: overrides.type,
    timestamp: overrides.timestamp ?? Date.now(),
    payload: overrides.payload ?? {},
    schemaVersion: 2,
    ...(overrides.eventId ? { eventId: overrides.eventId } : {}),
  };
}

describe("renderer-perf visibility tracing", () => {
  beforeEach(() => {
    const testWindow = globalThis as any;
    if (!testWindow.window) {
      testWindow.window = testWindow;
    }
    if (!("requestAnimationFrame" in testWindow.window)) {
      testWindow.window.requestAnimationFrame = (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      };
      testWindow.window.cancelAnimationFrame = () => {};
    }
    testWindow.window.__coworkRendererPerfState__ = undefined;
  });

  it("records visible timing immediately when the row reports a normalized event id alias", () => {
    const receivedEvent = makeEvent({
      id: "raw-event-id",
      eventId: "timeline-event-id",
      taskId: "task-1",
      type: "step_started",
    });
    const visibleEvent = makeEvent({
      id: "timeline-event-id",
      taskId: "task-1",
      type: "step_started",
    });

    noteRendererTaskEventReceived(receivedEvent, true);
    noteRendererTaskEventsAppendDispatched([receivedEvent], true);
    noteRendererTaskEventsAppended([{ event: receivedEvent }], true);
    markTaskEventRenderable(visibleEvent, true);
    markTaskEventVisible(visibleEvent, "measured-row", true);

    const state = (globalThis.window as Window & {
      __coworkRendererPerfState__?: {
        metrics: Map<string, { samples: number[] }>;
        counters: Map<string, { value: number }>;
      };
    }).__coworkRendererPerfState__;
    expect(state).toBeDefined();

    const receivedToVisible = state?.metrics.get("task-event.received_to_visible_ms")?.samples ?? [];
    const appendedToVisible = state?.metrics.get("task-event.appended_to_visible_ms")?.samples ?? [];

    expect(receivedToVisible.length).toBe(1);
    expect(appendedToVisible.length).toBe(1);
    expect(state?.counters.get("task-event.visible_signal_count")?.value).toBe(1);
    expect(state?.counters.get("task-event.visible_recorded_count")?.value).toBe(1);
  });

  it("drops unresolved visible signals after bounded retries", () => {
    const visibleEvent = makeEvent({
      id: "untracked-event",
      taskId: "task-1",
      type: "step_started",
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      markTaskEventVisible(visibleEvent, "measured-row", true);
    }

    const state = (globalThis.window as Window & {
      __coworkRendererPerfState__?: {
        counters: Map<string, { value: number }>;
      };
    }).__coworkRendererPerfState__;

    expect(state?.counters.get("task-event.visible_drop_no_trace_count")?.value).toBeGreaterThan(0);
  });

  it("ignores repeated renderable and visible notifications after a trace is already settled", () => {
    const event = makeEvent({
      id: "step-1",
      taskId: "task-1",
      type: "step_started",
    });

    noteRendererTaskEventReceived(event, true);
    noteRendererTaskEventsAppendDispatched([event], true);
    noteRendererTaskEventsAppended([{ event }], true);
    markTaskEventRenderable(event, true);
    markTaskEventVisible(event, "measured-row", true);

    markTaskEventRenderable(event, true);
    markTaskEventVisible(event, "measured-row", true);

    const state = (globalThis.window as Window & {
      __coworkRendererPerfState__?: {
        counters: Map<string, { value: number }>;
      };
    }).__coworkRendererPerfState__;

    expect(state?.counters.get("task-event.visible_recorded_count")?.value).toBe(1);
    expect(state?.counters.get("task-event.visible_signal_count")?.value).toBe(1);
    expect(state?.counters.get("task-event.renderable_without_trace_count")?.value ?? 0).toBe(0);
    expect(state?.counters.get("task-event.visible_drop_no_trace_count")?.value ?? 0).toBe(0);
  });
});
