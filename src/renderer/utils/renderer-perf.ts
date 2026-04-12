import type { TaskEvent } from "../../shared/types";
type MetricBucket = {
  samples: number[];
};

type RenderBucket = {
  total: number;
  keys: Map<string, number>;
};

type CounterBucket = {
  value: number;
};

type PendingVisibleEvent = {
  location: string;
  attempts: number;
  firstQueuedAtMs: number;
};

type TaskEventTrace = {
  eventId: string;
  aliasId?: string;
  taskId: string;
  type: string;
  receivedAtMs: number;
  queuedAtMs?: number;
  appendDispatchAtMs?: number;
  appendedAtMs?: number;
  renderable: boolean;
  renderableAtMs?: number;
  visibleRecorded?: boolean;
};

type RendererPerfState = {
  metrics: Map<string, MetricBucket>;
  renders: Map<string, RenderBucket>;
  counters: Map<string, CounterBucket>;
  taskEvents: Map<string, TaskEventTrace>;
  taskEventAliases: Map<string, string>;
  settledVisibleEvents: Map<string, number>;
  pendingVisibleEvents: Map<string, PendingVisibleEvent>;
  reportTimer: number | null;
  visibleFrame1: number | null;
  visibleFrame2: number | null;
};

declare global {
  interface Window {
    __coworkRendererPerfState__?: RendererPerfState;
  }
}

const MAX_METRIC_SAMPLES = 240;
const MAX_RENDER_KEYS = 120;
const MAX_PENDING_VISIBLE_EVENTS = 240;
const MAX_PENDING_VISIBLE_ATTEMPTS = 4;
const PENDING_VISIBLE_TTL_MS = 5_000;
const REPORT_INTERVAL_MS = 10_000;
const TASK_EVENT_TTL_MS = 60_000;

function isRendererPerfEnabled(enabled?: boolean): boolean {
  return Boolean(enabled && typeof window !== "undefined" && typeof performance !== "undefined");
}

function getState(): RendererPerfState | null {
  if (typeof window === "undefined") return null;
  if (!window.__coworkRendererPerfState__) {
    window.__coworkRendererPerfState__ = {
      metrics: new Map(),
      renders: new Map(),
      counters: new Map(),
      taskEvents: new Map(),
      taskEventAliases: new Map(),
      settledVisibleEvents: new Map(),
      pendingVisibleEvents: new Map(),
      reportTimer: null,
      visibleFrame1: null,
      visibleFrame2: null,
    };
  }
  return window.__coworkRendererPerfState__;
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function cleanupTaskEventTraces(state: RendererPerfState, nowMs: number): void {
  for (const [eventId, trace] of state.taskEvents) {
    const ageMs = nowMs - (trace.appendedAtMs ?? trace.receivedAtMs);
    if (ageMs > TASK_EVENT_TTL_MS) {
      if (trace.renderable && !trace.visibleRecorded) {
        const bucket = state.counters.get("task-event.visible_trace_expired_count") ?? { value: 0 };
        bucket.value += 1;
        state.counters.set("task-event.visible_trace_expired_count", bucket);
      }
      state.taskEvents.delete(eventId);
      if (trace.aliasId) {
        state.taskEventAliases.delete(trace.aliasId);
      }
      state.pendingVisibleEvents.delete(eventId);
      if (trace.aliasId) {
        state.pendingVisibleEvents.delete(trace.aliasId);
      }
    }
  }
  for (const [eventId, settledAtMs] of state.settledVisibleEvents) {
    if (nowMs - settledAtMs > TASK_EVENT_TTL_MS) {
      state.settledVisibleEvents.delete(eventId);
    }
  }
}

function getTaskEventAlias(event: Pick<TaskEvent, "id" | "eventId">): string | null {
  if (typeof event.eventId === "string" && event.eventId.trim().length > 0) {
    return event.eventId;
  }
  return null;
}

function resolveTaskEventTrace(
  state: RendererPerfState,
  event: Pick<TaskEvent, "id" | "eventId"> | string,
): TaskEventTrace | null {
  const key = typeof event === "string" ? event : event.id;
  const direct = state.taskEvents.get(key);
  if (direct) return direct;
  if (typeof event === "string") {
    const canonicalId = state.taskEventAliases.get(event);
    return canonicalId ? state.taskEvents.get(canonicalId) ?? null : null;
  }

  const aliasCandidates = [event.id];
  const explicitAlias = getTaskEventAlias(event);
  if (explicitAlias && explicitAlias !== event.id) {
    aliasCandidates.push(explicitAlias);
  }

  for (const alias of aliasCandidates) {
    const canonicalId = state.taskEventAliases.get(alias);
    if (!canonicalId) continue;
    const traced = state.taskEvents.get(canonicalId);
    if (traced) return traced;
  }

  return null;
}

function deleteTaskEventTrace(state: RendererPerfState, trace: TaskEventTrace): void {
  state.taskEvents.delete(trace.eventId);
  if (trace.aliasId) {
    state.taskEventAliases.delete(trace.aliasId);
  }
}

function isTaskEventVisibilitySettled(
  state: RendererPerfState,
  event: Pick<TaskEvent, "id" | "eventId"> | string,
): boolean {
  const eventId = typeof event === "string" ? event : event.id;
  if (state.settledVisibleEvents.has(eventId)) return true;
  if (typeof event !== "string") {
    const alias = getTaskEventAlias(event);
    if (alias && state.settledVisibleEvents.has(alias)) return true;
  }
  const canonicalId = state.taskEventAliases.get(eventId);
  return canonicalId ? state.settledVisibleEvents.has(canonicalId) : false;
}

function emitRendererPerfLog(_message: string): void {}

function flushRendererPerfReport(state: RendererPerfState): void {
  const metricSummaries = [...state.metrics.entries()]
    .filter(([, bucket]) => bucket.samples.length > 0)
    .map(([name, bucket]) => {
      const sorted = [...bucket.samples].sort((a, b) => a - b);
      return `${name} n=${sorted.length} p50=${percentile(sorted, 0.5).toFixed(1)}ms p95=${percentile(sorted, 0.95).toFixed(1)}ms max=${sorted[sorted.length - 1]!.toFixed(1)}ms`;
    });

  const renderSummaries = [...state.renders.entries()]
    .filter(([, bucket]) => bucket.total > 0)
    .map(([name, bucket]) => {
      const topKeys = [...bucket.keys.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key, count]) => `${key}:${count}`)
        .join(", ");
      return `${name} total=${bucket.total} unique=${bucket.keys.size}${topKeys ? ` top=[${topKeys}]` : ""}`;
    });

  const counterSummaries = [...state.counters.entries()]
    .filter(([, bucket]) => bucket.value > 0)
    .map(([name, bucket]) => `${name} count=${bucket.value}`);

  if (metricSummaries.length === 0 && renderSummaries.length === 0 && counterSummaries.length === 0) {
    return;
  }

  emitRendererPerfLog("Summary");
  for (const summary of metricSummaries) {
    emitRendererPerfLog(summary);
  }
  for (const summary of renderSummaries) {
    emitRendererPerfLog(summary);
  }
  for (const summary of counterSummaries) {
    emitRendererPerfLog(summary);
  }
}

function scheduleRendererPerfReport(state: RendererPerfState): void {
  if (state.reportTimer != null) return;
  state.reportTimer = window.setTimeout(() => {
    state.reportTimer = null;
    cleanupTaskEventTraces(state, performance.now());
    flushRendererPerfReport(state);
  }, REPORT_INTERVAL_MS);
}

export function measureRendererPerf<T>(name: string, enabled: boolean | undefined, fn: () => T): T {
  if (!isRendererPerfEnabled(enabled)) {
    return fn();
  }
  const startedAtMs = performance.now();
  try {
    return fn();
  } finally {
    recordRendererPerfSample(name, performance.now() - startedAtMs, enabled);
  }
}

export function recordRendererPerfSample(
  name: string,
  valueMs: number,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled) || !Number.isFinite(valueMs) || valueMs < 0) {
    return;
  }
  const state = getState();
  if (!state) return;
  const bucket = state.metrics.get(name) ?? { samples: [] };
  bucket.samples.push(valueMs);
  if (bucket.samples.length > MAX_METRIC_SAMPLES) {
    bucket.samples.splice(0, bucket.samples.length - MAX_METRIC_SAMPLES);
  }
  state.metrics.set(name, bucket);
  scheduleRendererPerfReport(state);
}

export function recordRendererRender(
  name: string,
  key: string,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  if (!state) return;
  const bucket = state.renders.get(name) ?? { total: 0, keys: new Map<string, number>() };
  bucket.total += 1;
  bucket.keys.set(key, (bucket.keys.get(key) ?? 0) + 1);
  if (bucket.keys.size > MAX_RENDER_KEYS) {
    const sorted = [...bucket.keys.entries()].sort((a, b) => a[1] - b[1]);
    const toDelete = sorted.slice(0, bucket.keys.size - MAX_RENDER_KEYS);
    for (const [renderKey] of toDelete) {
      bucket.keys.delete(renderKey);
    }
  }
  state.renders.set(name, bucket);
  scheduleRendererPerfReport(state);
}

export function incrementRendererPerfCounter(
  name: string,
  enabled?: boolean,
  delta: number = 1,
): void {
  if (!isRendererPerfEnabled(enabled) || !Number.isFinite(delta) || delta <= 0) return;
  const state = getState();
  if (!state) return;
  const bucket = state.counters.get(name) ?? { value: 0 };
  bucket.value += delta;
  state.counters.set(name, bucket);
  scheduleRendererPerfReport(state);
}

export function noteRendererTaskEventReceived(
  event: Pick<TaskEvent, "id" | "eventId" | "taskId" | "type">,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  if (!state) return;
  cleanupTaskEventTraces(state, performance.now());
  const trace: TaskEventTrace = {
    eventId: event.id,
    taskId: event.taskId,
    type: event.type,
    receivedAtMs: performance.now(),
    renderable: false,
  };
  state.taskEvents.set(event.id, trace);
  const alias = getTaskEventAlias(event);
  if (alias && alias !== event.id) {
    trace.aliasId = alias;
    state.taskEventAliases.set(alias, event.id);
  }
}

export function noteRendererTaskEventQueued(
  event: Pick<TaskEvent, "id" | "eventId">,
  queuedAtMs: number,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  const trace = state ? resolveTaskEventTrace(state, event) : null;
  if (!trace) return;
  trace.queuedAtMs = queuedAtMs;
}

export function noteRendererTaskEventsAppended(
  entries: Array<{ event: Pick<TaskEvent, "id" | "type">; queuedAtMs?: number }>,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled) || entries.length === 0) return;
  const state = getState();
  if (!state) return;
  const nowMs = performance.now();
  for (const entry of entries) {
    const trace = resolveTaskEventTrace(state, entry.event);
    if (!trace) continue;
    const queuedAtMs = entry.queuedAtMs ?? trace.queuedAtMs;
    trace.appendedAtMs = nowMs;
    if (queuedAtMs != null) {
      recordRendererPerfSample("task-event.batch_wait_ms", nowMs - queuedAtMs, enabled);
      recordRendererPerfSample(
        `task-event.${entry.event.type}.batch_wait_ms`,
        nowMs - queuedAtMs,
        enabled,
      );
    }
    recordRendererPerfSample("task-event.received_to_append_ms", nowMs - trace.receivedAtMs, enabled);
    recordRendererPerfSample(
      `task-event.${entry.event.type}.received_to_append_ms`,
      nowMs - trace.receivedAtMs,
      enabled,
    );
    if (trace.appendDispatchAtMs != null) {
      recordRendererPerfSample(
        "task-event.append_dispatch_to_append_ms",
        nowMs - trace.appendDispatchAtMs,
        enabled,
      );
      recordRendererPerfSample(
        `task-event.${entry.event.type}.append_dispatch_to_append_ms`,
        nowMs - trace.appendDispatchAtMs,
        enabled,
      );
    }
  }
}

export function noteRendererTaskEventsAppendDispatched(
  entries: Array<Pick<TaskEvent, "id" | "eventId" | "type">>,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled) || entries.length === 0) return;
  const state = getState();
  if (!state) return;
  const nowMs = performance.now();
  for (const entry of entries) {
    const trace = resolveTaskEventTrace(state, entry);
    if (!trace) continue;
    trace.appendDispatchAtMs = nowMs;
    recordRendererPerfSample(
      "task-event.received_to_append_dispatch_ms",
      nowMs - trace.receivedAtMs,
      enabled,
    );
    recordRendererPerfSample(
      `task-event.${entry.type}.received_to_append_dispatch_ms`,
      nowMs - trace.receivedAtMs,
      enabled,
    );
  }
}

function flushPendingVisibleEvents(state: RendererPerfState, enabled?: boolean): void {
  state.visibleFrame1 = null;
  state.visibleFrame2 = null;
  if (state.pendingVisibleEvents.size === 0) return;
  const pending = [...state.pendingVisibleEvents.entries()];
  state.pendingVisibleEvents.clear();
  const nowMs = performance.now();
  for (const [eventId, pendingVisible] of pending) {
    const recorded = recordTaskEventVisibleFromTrace(eventId, pendingVisible.location, enabled);
    if (!recorded) {
      const trace = resolveTaskEventTrace(state, eventId);
      const nextAttempts = pendingVisible.attempts + 1;
      const ageMs = nowMs - pendingVisible.firstQueuedAtMs;
      if (!trace && (nextAttempts >= MAX_PENDING_VISIBLE_ATTEMPTS || ageMs >= PENDING_VISIBLE_TTL_MS)) {
        incrementRendererPerfCounter("task-event.visible_drop_no_trace_count", enabled);
        continue;
      }
      if (trace && !trace.renderable && (nextAttempts >= MAX_PENDING_VISIBLE_ATTEMPTS || ageMs >= PENDING_VISIBLE_TTL_MS)) {
        incrementRendererPerfCounter("task-event.visible_drop_not_renderable_count", enabled);
        continue;
      }
      state.pendingVisibleEvents.set(eventId, {
        ...pendingVisible,
        attempts: nextAttempts,
      });
    }
  }
  if (state.pendingVisibleEvents.size > 0) {
    schedulePendingVisibleEvents(state, enabled);
  }
}

function schedulePendingVisibleEvents(state: RendererPerfState, enabled?: boolean): void {
  if (state.visibleFrame1 != null || state.visibleFrame2 != null) return;
  state.visibleFrame1 = window.requestAnimationFrame(() => {
    state.visibleFrame1 = null;
    state.visibleFrame2 = window.requestAnimationFrame(() => {
      flushPendingVisibleEvents(state, enabled);
    });
  });
}

function recordTaskEventVisibleFromTrace(
  event: Pick<TaskEvent, "id" | "eventId"> | string,
  location: string,
  enabled?: boolean,
): boolean {
  if (!isRendererPerfEnabled(enabled)) return false;
  const state = getState();
  if (!state) return false;
  const trace = resolveTaskEventTrace(state, event);
  if (!trace || trace.visibleRecorded || !trace.renderable) return false;
  const nowMs = performance.now();
  trace.visibleRecorded = true;
  incrementRendererPerfCounter("task-event.visible_recorded_count", enabled);
  recordRendererPerfSample("task-event.received_to_visible_ms", nowMs - trace.receivedAtMs, enabled);
  recordRendererPerfSample(
    `task-event.${trace.type}.received_to_visible_ms`,
    nowMs - trace.receivedAtMs,
    enabled,
  );
  if (trace.appendedAtMs != null) {
    recordRendererPerfSample(
      "task-event.appended_to_visible_ms",
      nowMs - trace.appendedAtMs,
      enabled,
    );
    recordRendererPerfSample(
      `task-event.${trace.type}.appended_to_visible_ms`,
      nowMs - trace.appendedAtMs,
      enabled,
    );
    recordRendererPerfSample(
      `task-event.visible.${location}.ms`,
      nowMs - trace.appendedAtMs,
      enabled,
    );
  }
  state.settledVisibleEvents.set(trace.eventId, nowMs);
  if (trace.aliasId) {
    state.settledVisibleEvents.set(trace.aliasId, nowMs);
  }
  deleteTaskEventTrace(state, trace);
  state.pendingVisibleEvents.delete(trace.eventId);
  if (trace.aliasId) {
    state.pendingVisibleEvents.delete(trace.aliasId);
  }
  return true;
}

export function markTaskEventRenderable(
  event: Pick<TaskEvent, "id" | "eventId">,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  if (!state) return;
  if (isTaskEventVisibilitySettled(state, event)) {
    return;
  }
  const trace = resolveTaskEventTrace(state, event);
  if (!trace) {
    incrementRendererPerfCounter("task-event.renderable_without_trace_count", enabled);
    return;
  }
  trace.renderable = true;
  trace.renderableAtMs = performance.now();
  if (state.pendingVisibleEvents.size > 0) {
    schedulePendingVisibleEvents(state, enabled);
  }
}

export function markTaskEventVisible(
  event: Pick<TaskEvent, "id" | "eventId">,
  location: string,
  enabled?: boolean,
): void {
  if (!isRendererPerfEnabled(enabled)) return;
  const state = getState();
  if (!state) return;
  if (isTaskEventVisibilitySettled(state, event)) {
    return;
  }
  incrementRendererPerfCounter("task-event.visible_signal_count", enabled);
  if (recordTaskEventVisibleFromTrace(event, location, enabled)) {
    return;
  }
  if (state.pendingVisibleEvents.size >= MAX_PENDING_VISIBLE_EVENTS) {
    incrementRendererPerfCounter("task-event.visible_queue_overflow_count", enabled);
    return;
  }
  const pendingVisible = {
    location,
    attempts: 0,
    firstQueuedAtMs: performance.now(),
  };
  state.pendingVisibleEvents.set(event.id, pendingVisible);
  const alias = getTaskEventAlias(event);
  if (alias && alias !== event.id && state.pendingVisibleEvents.size < MAX_PENDING_VISIBLE_EVENTS) {
    state.pendingVisibleEvents.set(alias, pendingVisible);
  }
  schedulePendingVisibleEvents(state, enabled);
}

export function noteRendererTaskEventVisible(
  event: Pick<TaskEvent, "id" | "eventId">,
  location: string,
  enabled?: boolean,
): void {
  markTaskEventVisible(event, location, enabled);
}
