import type { Task, TaskEvent } from "../../shared/types";

type TaskRepoLike = {
  findById(taskId: string): Task | null | undefined;
  findByParent(taskId: string): Task[];
};

type TaskEventRepoLike = {
  findRecentByTaskId(taskId: string, maxEvents: number): TaskEvent[];
  findByTaskIds(taskIds: string[], types?: string[]): TaskEvent[];
};

const COLLABORATIVE_CHILD_FILE_EVENT_TYPES: Array<TaskEvent["type"]> = [
  "file_created",
  "file_modified",
  "file_deleted",
  "artifact_created",
];

export function buildTaskEventHistoryForTransport(params: {
  taskId: string;
  limit: number;
  taskRepo: TaskRepoLike;
  eventRepo: TaskEventRepoLike;
}): TaskEvent[] {
  const { taskId, limit, taskRepo, eventRepo } = params;
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (!taskId || safeLimit <= 0) return [];

  const events = eventRepo.findRecentByTaskId(taskId, safeLimit);
  const task = taskRepo.findById(taskId);
  if (task?.agentConfig?.collaborativeMode || task?.agentConfig?.multiLlmMode) {
    const childTasks = taskRepo.findByParent(taskId);
    if (childTasks.length > 0) {
      const childFileEvents = eventRepo.findByTaskIds(
        childTasks.map((childTask) => childTask.id),
        COLLABORATIVE_CHILD_FILE_EVENT_TYPES,
      );
      events.push(...childFileEvents);
      events.sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  return events.length > safeLimit ? events.slice(-safeLimit) : events;
}

export function serializeTaskEventForTransport(
  event: TaskEvent,
  sanitizeValue: (value: unknown) => unknown,
): TaskEvent {
  return {
    ...event,
    payload: sanitizeValue(event.payload) as Record<string, unknown>,
  };
}
