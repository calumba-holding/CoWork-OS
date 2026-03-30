import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "../../shared/types";
import { UsageInsightsLlmSection } from "./UsageInsightsLlmSection";

interface TaskMetrics {
  totalCreated: number;
  completed: number;
  failed: number;
  cancelled: number;
  avgCompletionTimeMs: number | null;
}

interface CostByModelRow {
  model: string;
  cost: number;
  calls: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  distinctTasks?: number;
}

interface CostMetrics {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  costByModel: CostByModelRow[];
}

interface LlmSummary {
  totalLlmCalls: number;
  totalCost: number;
  chargeableCallRate: number | null;
  avgTokensPerCall: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  cacheReadRate: number | null;
  distinctTaskCount: number;
}

interface RequestDayRow {
  dateKey: string;
  llmCalls: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

interface ProviderSlice {
  provider: string;
  calls: number;
  cost: number;
  percent: number;
}

interface ExecutionMetrics {
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalLlmCalls: number;
  avgTokensPerLlmCall: number | null;
  avgTokensPerTask: number | null;
  outputInputRatio: number | null;
  totalToolCalls: number;
  totalToolResults: number;
  toolErrors: number;
  toolBlocked: number;
  toolWarnings: number;
  toolCompletionRate: number | null;
  uniqueTools: number;
  topTools: Array<{ tool: string; calls: number; errors: number }>;
}

interface ActivityPattern {
  tasksByDayOfWeek: number[];
  tasksByHour: number[];
  mostActiveDay: string;
  mostActiveHour: number;
}

interface AwuMetrics {
  awuCount: number;
  totalTokens: number;
  totalCost: number;
  tokensPerAwu: number | null;
  costPerAwu: number | null;
  awuPerDollar: number | null;
  trend: {
    previousAwuCount: number;
    previousTokensPerAwu: number | null;
    previousCostPerAwu: number | null;
    tokensPerAwuChange: number | null;
    costPerAwuChange: number | null;
  };
}

interface UsageInsightsData {
  periodStart: number;
  periodEnd: number;
  workspaceId: string | null;
  generatedAt: number;
  taskMetrics: TaskMetrics;
  costMetrics: CostMetrics;
  executionMetrics: ExecutionMetrics;
  activityPattern: ActivityPattern;
  topSkills: Array<{ skill: string; count: number }>;
  awuMetrics: AwuMetrics;
  formatted: string;
  llmSuccessRate?: number | null;
  llmSummary?: LlmSummary;
  requestsByDay?: RequestDayRow[];
  providerBreakdown?: ProviderSlice[];
  personaMetrics?: Array<{
    personaId: string;
    personaName: string;
    total: number;
    completed: number;
    failed: number;
    cancelled: number;
    successRate: number;
    avgCompletionTimeMs: number | null;
    avgAttempts: number | null;
    totalCost: number;
  }>;
  feedbackMetrics?: {
    totalFeedback: number;
    accepted: number;
    rejected: number;
    satisfactionRate: number | null;
    topRejectionReasons: Array<{ reason: string; count: number }>;
  };
  retryMetrics?: {
    avgAttempts: number | null;
    retriedTasks: number;
    retriedRate: number | null;
    maxAttempts: number;
  };
}

interface UsageInsightsPanelProps {
  workspaceId?: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDuration(ms: number | null): string {
  if (ms === null) return "\u2014";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function MiniBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="insights-bar-track">
      <div className="insights-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

interface PackSkillMap {
  packName: string;
  packIcon: string;
  skills: Array<{ skill: string; count: number }>;
  totalUsage: number;
}

const ALL_WORKSPACES = "__all__";

type PeriodPreset = 7 | 14 | 30 | 90 | 180 | 365 | "custom";
const PERIOD_PRESETS: { value: PeriodPreset; label: string }[] = [
  { value: 7, label: "7d" },
  { value: 14, label: "14d" },
  { value: 30, label: "30d" },
  { value: 90, label: "90d" },
  { value: 180, label: "6mo" },
  { value: 365, label: "1y" },
  { value: "custom", label: "Custom" },
];

function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysBetween(start: string, end: string): number {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Math.max(1, Math.round(ms / 86_400_000));
}

function isValidWorkspaceId(id: string | undefined): id is string {
  return !!id && (id === ALL_WORKSPACES || !id.startsWith("__temp_workspace__"));
}

export function UsageInsightsPanel({ workspaceId: initialWorkspaceId }: UsageInsightsPanelProps) {
  const [data, setData] = useState<UsageInsightsData | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<PeriodPreset>(7);
  const [customStart, setCustomStart] = useState(() => toISODate(new Date(Date.now() - 30 * 86_400_000)));
  const [customEnd, setCustomEnd] = useState(() => toISODate(new Date()));
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const customPickerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [packAnalytics, setPackAnalytics] = useState<PackSkillMap[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(ALL_WORKSPACES);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);
  const [dataAgeDays, setDataAgeDays] = useState<number | null>(null);

  const periodDays = useMemo(
    () => (selectedPreset === "custom" ? daysBetween(customStart, customEnd) : selectedPreset),
    [selectedPreset, customStart, customEnd],
  );

  const visiblePresets = useMemo(() => {
    if (dataAgeDays === null) return PERIOD_PRESETS;
    return PERIOD_PRESETS.filter(
      ({ value }) => value === "custom" || value <= Math.max(dataAgeDays, 7),
    );
  }, [dataAgeDays]);

  useEffect(() => {
    if (selectedPreset === "custom") return;
    const stillVisible = visiblePresets.some(({ value }) => value === selectedPreset);
    if (!stillVisible) {
      const largest = visiblePresets.filter(({ value }) => value !== "custom").pop();
      if (largest) setSelectedPreset(largest.value as Exclude<PeriodPreset, "custom">);
    }
  }, [visiblePresets, selectedPreset]);

  const workspaceId = selectedWorkspaceId;

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspacesLoading(true);
      const loaded = await window.electronAPI.listWorkspaces();
      const nonTemp = loaded.filter((w) => !w.id.startsWith("__temp_workspace__"));
      setWorkspaces(nonTemp);
      // Keep current selection if valid; default to "All Workspaces"
      setSelectedWorkspaceId((prev) => {
        if (prev === ALL_WORKSPACES) return ALL_WORKSPACES;
        if (prev && nonTemp.some((w) => w.id === prev)) return prev;
        return ALL_WORKSPACES;
      });
    } catch {
      setWorkspaces([]);
    } finally {
      setWorkspacesLoading(false);
    }
  }, [initialWorkspaceId]);

  const load = useCallback(async () => {
    if (!isValidWorkspaceId(workspaceId)) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.getUsageInsights(workspaceId, periodDays);
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load usage insights");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, periodDays]);

  useEffect(() => {
    if (!showCustomPicker) return;
    function handleClickOutside(e: MouseEvent) {
      if (customPickerRef.current && !customPickerRef.current.contains(e.target as Node)) {
        setShowCustomPicker(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showCustomPicker]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    setData(null);
    setPackAnalytics([]);
    if (!isValidWorkspaceId(workspaceId)) return;
    let cancelled = false;
    (async () => {
      try {
        const earliest = await window.electronAPI.getUsageInsightsEarliest(workspaceId);
        if (cancelled) return;
        if (earliest !== null) {
          const age = Math.ceil((Date.now() - earliest) / 86_400_000);
          setDataAgeDays(age);
        } else {
          setDataAgeDays(null);
        }
      } catch {
        setDataAgeDays(null);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  // Cross-reference skill usage with pack data
  useEffect(() => {
    if (!data || data.topSkills.length === 0) {
      setPackAnalytics([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const packs = await window.electronAPI.listPluginPacks();
        if (cancelled) return;

        // Build skill-to-pack mapping
        const skillToPack = new Map<string, { packName: string; packIcon: string }>();
        for (const p of packs) {
          for (const s of p.skills) {
            skillToPack.set(s.id, { packName: p.displayName, packIcon: p.icon || "\uD83D\uDCE6" });
            skillToPack.set(s.name, {
              packName: p.displayName,
              packIcon: p.icon || "\uD83D\uDCE6",
            });
          }
        }

        // Group skills by pack
        const packMap = new Map<string, PackSkillMap>();
        for (const s of data.topSkills) {
          const packInfo = skillToPack.get(s.skill);
          const key = packInfo?.packName || "Other";
          if (!packMap.has(key)) {
            packMap.set(key, {
              packName: key,
              packIcon: packInfo?.packIcon || "\u26A1",
              skills: [],
              totalUsage: 0,
            });
          }
          const entry = packMap.get(key)!;
          entry.skills.push(s);
          entry.totalUsage += s.count;
        }

        // Sort by total usage descending
        const sorted = Array.from(packMap.values()).sort((a, b) => b.totalUsage - a.totalUsage);
        setPackAnalytics(sorted);
      } catch {
        // Pack analytics not available
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (workspacesLoading) {
    return (
      <div className="settings-panel insights-panel">
        <h2>Usage Insights</h2>
        <p className="settings-description">Loading workspaces\u2026</p>
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <div className="settings-panel insights-panel">
        <h2>Usage Insights</h2>
        <p className="settings-description">No workspaces found. Create a workspace first.</p>
      </div>
    );
  }

  if (!isValidWorkspaceId(workspaceId)) {
    return (
      <div className="settings-panel insights-panel">
        <h2>Usage Insights</h2>
        <p className="settings-description">Select a workspace to view usage insights.</p>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="settings-panel insights-panel">
        <h2>Usage Insights</h2>
        <p className="settings-description">Loading\u2026</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="settings-panel insights-panel">
        <h2>Usage Insights</h2>
        <p className="settings-description" style={{ color: "var(--color-error, #ef4444)" }}>
          {error}
        </p>
        <button type="button" className="button-secondary" onClick={load}>
          Retry
        </button>
      </div>
    );
  }

  const tm = data?.taskMetrics;
  const cm = data?.costMetrics;
  const em = data?.executionMetrics;
  const ap = data?.activityPattern;
  const awu = data?.awuMetrics;
  const personaMetrics = data?.personaMetrics ?? [];
  const feedbackMetrics = data?.feedbackMetrics;
  const retryMetrics = data?.retryMetrics;
  const modelRows = cm?.costByModel ?? [];
  const hasModelCost = modelRows.some((m) => m.cost > 0);
  const modelBarMax =
    modelRows.length === 0
      ? 1
      : hasModelCost
        ? Math.max(...modelRows.map((m) => m.cost))
        : Math.max(...modelRows.map((m) => m.calls), 1);
  const hasAwuCard = !!(awu && awu.awuCount > 0);
  const maxDayTasks = ap ? Math.max(...ap.tasksByDayOfWeek, 1) : 1;
  const maxHourTasks = ap ? Math.max(...ap.tasksByHour, 1) : 1;
  const successRate =
    tm && tm.totalCreated > 0 ? Math.round((tm.completed / tm.totalCreated) * 100) : 0;

  return (
    <div className="settings-panel insights-panel">
      {/* Header with workspace and period inline */}
      <div className="insights-header">
        <div className="insights-header-left">
          <h2>Usage Insights</h2>
          <div className="insights-header-controls">
            <select
              value={selectedWorkspaceId}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
              className="insights-workspace-select"
            >
              <option value={ALL_WORKSPACES}>All Workspaces</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <div className="insights-period-filter">
              {visiblePresets.map(({ value, label }) =>
                value === "custom" ? (
                  <div key="custom" className="insights-period-custom-wrap" ref={customPickerRef}>
                    <button
                      type="button"
                      className={`insights-period-btn${selectedPreset === "custom" ? " active" : ""}`}
                      onClick={() => {
                        if (selectedPreset === "custom") {
                          setShowCustomPicker((v) => !v);
                        } else {
                          setSelectedPreset("custom");
                          setShowCustomPicker(true);
                        }
                      }}
                    >
                      {selectedPreset === "custom"
                        ? `${customStart} – ${customEnd}`
                        : label}
                    </button>
                    {showCustomPicker && (
                      <div className="insights-custom-picker">
                        <label className="insights-custom-picker-label">
                          From
                          <input
                            type="date"
                            className="insights-custom-picker-input"
                            value={customStart}
                            max={customEnd}
                            onChange={(e) => setCustomStart(e.target.value)}
                          />
                        </label>
                        <label className="insights-custom-picker-label">
                          To
                          <input
                            type="date"
                            className="insights-custom-picker-input"
                            value={customEnd}
                            min={customStart}
                            max={toISODate(new Date())}
                            onChange={(e) => setCustomEnd(e.target.value)}
                          />
                        </label>
                        <button
                          type="button"
                          className="insights-period-btn active insights-custom-picker-apply"
                          onClick={() => setShowCustomPicker(false)}
                        >
                          Apply
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    key={value}
                    type="button"
                    className={`insights-period-btn${selectedPreset === value ? " active" : ""}`}
                    onClick={() => {
                      setSelectedPreset(value);
                      setShowCustomPicker(false);
                    }}
                  >
                    {label}
                  </button>
                ),
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Hero stats row */}
      {tm && (
        <div className="insights-hero">
          <div className="insights-hero-card">
            <div className="insights-hero-value">{tm.completed}</div>
            <div className="insights-hero-label">Completed</div>
            <div className="insights-hero-sub">of {tm.totalCreated} created</div>
          </div>
          <div className="insights-hero-card">
            <div
              className="insights-hero-value"
              style={{
                color:
                  successRate >= 70
                    ? "var(--color-success, #22c55e)"
                    : successRate >= 40
                      ? "var(--color-warning, #f59e0b)"
                      : "var(--color-error, #ef4444)",
              }}
            >
              {successRate}%
            </div>
            <div className="insights-hero-label">Success Rate</div>
            <div className="insights-hero-rate-bar">
              <div
                className="insights-hero-rate-fill"
                style={{
                  width: `${successRate}%`,
                  background:
                    successRate >= 70
                      ? "var(--color-success, #22c55e)"
                      : successRate >= 40
                        ? "var(--color-warning, #f59e0b)"
                        : "var(--color-error, #ef4444)",
                }}
              />
            </div>
          </div>
          <div className="insights-hero-card">
            <div className="insights-hero-value">{tm.failed}</div>
            <div className="insights-hero-label">Failed</div>
            <div className="insights-hero-sub">
              {tm.cancelled > 0 ? `${tm.cancelled} cancelled` : "\u00A0"}
            </div>
          </div>
          <div className="insights-hero-card">
            <div className="insights-hero-value">{formatDuration(tm.avgCompletionTimeMs)}</div>
            <div className="insights-hero-label">Avg Time</div>
            <div className="insights-hero-sub">per task</div>
          </div>
        </div>
      )}

      {data && (personaMetrics.length > 0 || feedbackMetrics || retryMetrics) && (
        <div className="insights-two-col">
          {personaMetrics.length > 0 && (
            <div className="insights-card">
              <div className="insights-card-header">Persona Performance</div>
              <div>
                {personaMetrics.slice(0, 5).map((persona) => (
                  <div key={persona.personaId} className="insights-bar-row">
                    <span className="insights-bar-label" style={{ minWidth: 140 }}>
                      {persona.personaName}
                    </span>
                    <MiniBar value={persona.successRate} max={100} />
                    <span className="insights-bar-value" style={{ minWidth: 54 }}>
                      {persona.successRate.toFixed(0)}%
                    </span>
                    <span className="insights-model-calls" style={{ minWidth: 92 }}>
                      ${persona.totalCost.toFixed(4)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="insights-runtime-note">
                {personaMetrics[0]?.total ?? 0} tasks for top persona
              </div>
            </div>
          )}

          {(feedbackMetrics || retryMetrics) && (
            <div className="insights-card">
              <div className="insights-card-header">Feedback & Quality</div>
              <div className="insights-runtime-grid">
                <div className="insights-runtime-metric">
                  <span className="insights-runtime-value">
                    {feedbackMetrics?.satisfactionRate !== null &&
                    feedbackMetrics?.satisfactionRate !== undefined
                      ? `${feedbackMetrics.satisfactionRate.toFixed(0)}%`
                      : "\u2014"}
                  </span>
                  <span className="insights-runtime-label">Satisfaction</span>
                </div>
                <div className="insights-runtime-metric">
                  <span className="insights-runtime-value">{feedbackMetrics?.totalFeedback ?? 0}</span>
                  <span className="insights-runtime-label">Feedback events</span>
                </div>
                <div className="insights-runtime-metric">
                  <span className="insights-runtime-value">{retryMetrics?.retriedTasks ?? 0}</span>
                  <span className="insights-runtime-label">Retried tasks</span>
                </div>
                <div className="insights-runtime-metric">
                  <span className="insights-runtime-value">
                    {retryMetrics?.avgAttempts !== null && retryMetrics?.avgAttempts !== undefined
                      ? retryMetrics.avgAttempts.toFixed(1)
                      : "\u2014"}
                  </span>
                  <span className="insights-runtime-label">Avg attempts</span>
                </div>
              </div>
              {feedbackMetrics && feedbackMetrics.topRejectionReasons.length > 0 && (
                <>
                  <div className="insights-runtime-section-label">Top rejection reasons</div>
                  <div>
                    {feedbackMetrics.topRejectionReasons.map((item) => (
                      <div key={item.reason} className="insights-bar-row">
                        <span className="insights-bar-label" style={{ minWidth: 140 }}>
                          {item.reason}
                        </span>
                        <MiniBar
                          value={item.count}
                          max={feedbackMetrics.topRejectionReasons[0]?.count || 1}
                        />
                        <span className="insights-bar-value">{item.count}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {data && (
        <UsageInsightsLlmSection
          llmSummary={
            data.llmSummary ?? {
              totalLlmCalls: 0,
              totalCost: 0,
              chargeableCallRate: null,
              avgTokensPerCall: null,
              totalInputTokens: 0,
              totalOutputTokens: 0,
              totalCachedTokens: 0,
              cacheReadRate: null,
              distinctTaskCount: 0,
            }
          }
          llmSuccessRate={data.llmSuccessRate ?? null}
          requestsByDay={data.requestsByDay ?? []}
          providerBreakdown={data.providerBreakdown ?? []}
          costByModel={(data.costMetrics?.costByModel ?? []).map((m) => ({
            model: m.model,
            cost: m.cost,
            calls: m.calls,
            inputTokens: m.inputTokens ?? 0,
            outputTokens: m.outputTokens ?? 0,
            cachedTokens: m.cachedTokens ?? 0,
            distinctTasks: m.distinctTasks ?? 0,
          }))}
        />
      )}

      {/* Token/Runtime + AWU row */}
      {((em && (em.totalTokens > 0 || em.totalToolCalls > 0 || em.totalLlmCalls > 0)) ||
        (awu && awu.awuCount > 0)) && (
        <div className={`insights-two-col${hasAwuCard ? "" : " single"}`}>
          {em && cm && (em.totalTokens > 0 || em.totalToolCalls > 0 || em.totalLlmCalls > 0) && (
            <div className="insights-card">
              <div className="insights-card-header">Token & Runtime</div>
              <div className="insights-cost-hero">
                <span className="insights-cost-amount">{formatTokens(em.totalTokens)}</span>
                <span className="insights-cost-tokens">
                  total tokens (prompt + completion)
                </span>
              </div>
              <div className="insights-cost-split">
                <div className="insights-cost-split-item">
                  <span className="insights-cost-split-label">Prompt</span>
                  <span className="insights-cost-split-value">{formatTokens(em.totalPromptTokens)}</span>
                </div>
                <div className="insights-cost-split-item">
                  <span className="insights-cost-split-label">Completion</span>
                  <span className="insights-cost-split-value">
                    {formatTokens(em.totalCompletionTokens)}
                  </span>
                </div>
                <div className="insights-cost-split-item">
                  <span className="insights-cost-split-label">Cost</span>
                  <span className="insights-cost-split-value">${cm.totalCost.toFixed(4)}</span>
                </div>
              </div>

              <div className="insights-runtime-grid">
                <div className="insights-runtime-metric">
                  <span className="insights-runtime-value">{em.totalLlmCalls}</span>
                  <span className="insights-runtime-label">LLM calls</span>
                </div>
                <div className="insights-runtime-metric">
                  <span className="insights-runtime-value">
                    {em.avgTokensPerLlmCall !== null ? formatTokens(em.avgTokensPerLlmCall) : "\u2014"}
                  </span>
                  <span className="insights-runtime-label">Tok / call</span>
                </div>
                <div className="insights-runtime-metric">
                  <span className="insights-runtime-value">
                    {em.avgTokensPerTask !== null ? formatTokens(em.avgTokensPerTask) : "\u2014"}
                  </span>
                  <span className="insights-runtime-label">Tok / task</span>
                </div>
                <div className="insights-runtime-metric">
                  <span className="insights-runtime-value">
                    {em.outputInputRatio !== null ? `${em.outputInputRatio.toFixed(2)}x` : "\u2014"}
                  </span>
                  <span className="insights-runtime-label">Out / In</span>
                </div>
              </div>

              {(em.totalToolCalls > 0 || em.toolErrors > 0 || em.toolBlocked > 0) && (
                <>
                  <div className="insights-runtime-grid">
                    <div className="insights-runtime-metric">
                      <span className="insights-runtime-value">{em.totalToolCalls}</span>
                      <span className="insights-runtime-label">Tool calls</span>
                    </div>
                    <div className="insights-runtime-metric">
                      <span className="insights-runtime-value">{em.totalToolResults}</span>
                      <span className="insights-runtime-label">Tool results</span>
                    </div>
                    <div className="insights-runtime-metric">
                      <span className="insights-runtime-value">{em.toolErrors}</span>
                      <span className="insights-runtime-label">Tool errors</span>
                    </div>
                    <div className="insights-runtime-metric">
                      <span className="insights-runtime-value">{em.uniqueTools}</span>
                      <span className="insights-runtime-label">Unique tools</span>
                    </div>
                  </div>

                  <div className="insights-runtime-note">
                    {em.toolCompletionRate !== null
                      ? `${em.toolCompletionRate.toFixed(0)}% completion`
                      : "\u2014"}
                    {" \u00B7 "}
                    {em.toolBlocked} blocked
                    {" \u00B7 "}
                    {em.toolWarnings} warnings
                  </div>

                  {em.topTools.length > 0 && (
                    <>
                      <div className="insights-runtime-section-label">Top tools</div>
                      <div className="insights-model-list">
                        {em.topTools.slice(0, 4).map((tool) => (
                          <div key={tool.tool} className="insights-model-row">
                            <span className="insights-model-name">{tool.tool}</span>
                            <MiniBar value={tool.calls} max={em.topTools[0].calls} />
                            <span className="insights-model-cost">{tool.calls}\u00D7</span>
                            <span className="insights-model-calls">
                              {tool.errors > 0 ? `${tool.errors} err` : "\u00A0"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}

              {cm.costByModel.length > 0 && (
                <>
                  <div className="insights-runtime-section-label">
                    Top models by {hasModelCost ? "cost" : "calls"}
                  </div>
                  <div className="insights-model-list">
                    {cm.costByModel.slice(0, 4).map((m) => (
                      <div key={m.model} className="insights-model-row">
                        <span className="insights-model-name">{m.model}</span>
                        <MiniBar value={hasModelCost ? m.cost : m.calls} max={modelBarMax} />
                        <span className="insights-model-cost">
                          {hasModelCost ? `$${m.cost.toFixed(4)}` : `${m.calls}\u00D7`}
                        </span>
                        <span className="insights-model-calls">
                          {hasModelCost ? `${m.calls}\u00D7` : "\u00A0"}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {awu && awu.awuCount > 0 && (
            <div className="insights-card">
              <div className="insights-card-header">Agent Efficiency (AWU)</div>
              <div className="insights-awu-hero">
                <span className="insights-awu-count">{awu.awuCount}</span>
                <span className="insights-awu-label">work units</span>
              </div>
              <div className="insights-awu-grid">
                <div className="insights-awu-metric">
                  <div className="insights-awu-metric-value">
                    {awu.tokensPerAwu !== null ? formatTokens(awu.tokensPerAwu) : "\u2014"}
                  </div>
                  <div className="insights-awu-metric-label">Tokens / AWU</div>
                  <TrendIndicator change={awu.trend.tokensPerAwuChange} invertColor />
                </div>
                <div className="insights-awu-metric">
                  <div className="insights-awu-metric-value">
                    {awu.costPerAwu !== null ? `$${awu.costPerAwu.toFixed(4)}` : "\u2014"}
                  </div>
                  <div className="insights-awu-metric-label">Cost / AWU</div>
                  <TrendIndicator change={awu.trend.costPerAwuChange} invertColor />
                </div>
                <div className="insights-awu-metric">
                  <div
                    className="insights-awu-metric-value"
                    style={{ color: "var(--color-success, #22c55e)" }}
                  >
                    {awu.awuPerDollar !== null ? awu.awuPerDollar.toFixed(1) : "\u2014"}
                  </div>
                  <div className="insights-awu-metric-label">AWUs / $1</div>
                </div>
              </div>
              {awu.trend.previousAwuCount > 0 && (
                <div className="insights-awu-comparison">
                  vs prev {periodDays}d: {awu.trend.previousAwuCount} AWU
                  {awu.trend.previousTokensPerAwu !== null && (
                    <> at {formatTokens(awu.trend.previousTokensPerAwu)} tok/AWU</>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Activity charts side by side */}
      {ap && (
        <div className="insights-two-col">
          <div className="insights-card">
            <div className="insights-card-header">
              Activity by Day
              <span className="insights-card-header-sub">Peak: {ap.mostActiveDay}</span>
            </div>
            <div className="insights-day-chart">
              {DAY_NAMES.map((day, i) => (
                <div key={day} className="insights-bar-row">
                  <span className="insights-bar-label">{day}</span>
                  <MiniBar value={ap.tasksByDayOfWeek[i]} max={maxDayTasks} />
                  <span className="insights-bar-value">{ap.tasksByDayOfWeek[i]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="insights-card">
            <div className="insights-card-header">
              Activity by Hour
              <span className="insights-card-header-sub">Peak: {ap.mostActiveHour}:00</span>
            </div>
            <div className="insights-hour-chart">
              {ap.tasksByHour.map((count, h) => (
                <div
                  key={h}
                  className={`insights-hour-bar ${count > 0 ? "has-data" : "no-data"}`}
                  title={`${h}:00 \u2014 ${count} task${count !== 1 ? "s" : ""}`}
                  style={{
                    height: `${maxHourTasks > 0 ? Math.max((count / maxHourTasks) * 100, count > 0 ? 10 : 3) : 3}%`,
                  }}
                />
              ))}
            </div>
            <div className="insights-hour-labels">
              <span>12am</span>
              <span>6am</span>
              <span>12pm</span>
              <span>6pm</span>
              <span>12am</span>
            </div>
          </div>
        </div>
      )}

      {/* Skills section */}
      {data && data.topSkills.length > 0 && (
        <div className={packAnalytics.length > 0 ? "insights-two-col" : ""}>
          <div className="insights-card">
            <div className="insights-card-header">Top Skills</div>
            <div>
              {data.topSkills.slice(0, 5).map((s) => (
                <div key={s.skill} className="insights-bar-row">
                  <span className="insights-bar-label" style={{ minWidth: 120 }}>
                    {s.skill}
                  </span>
                  <MiniBar value={s.count} max={data.topSkills[0].count} />
                  <span className="insights-bar-value" style={{ minWidth: 30 }}>
                    {s.count}\u00D7
                  </span>
                </div>
              ))}
            </div>
          </div>

          {packAnalytics.length > 0 && (
            <div className="insights-card">
              <div className="insights-card-header">By Pack</div>
              <div>
                {packAnalytics.map((pa) => (
                  <div key={pa.packName} style={{ marginBottom: 10 }}>
                    <div className="insights-bar-row" style={{ fontWeight: 500 }}>
                      <span className="insights-bar-label" style={{ minWidth: 120 }}>
                        {pa.packIcon} {pa.packName}
                      </span>
                      <MiniBar value={pa.totalUsage} max={packAnalytics[0].totalUsage} />
                      <span className="insights-bar-value" style={{ minWidth: 30 }}>
                        {pa.totalUsage}\u00D7
                      </span>
                    </div>
                    {pa.skills.length > 1 &&
                      pa.skills.slice(0, 3).map((s) => (
                        <div
                          key={s.skill}
                          className="insights-bar-row"
                          style={{ paddingLeft: 16, opacity: 0.7 }}
                        >
                          <span
                            className="insights-bar-label"
                            style={{ minWidth: 104, fontSize: 12 }}
                          >
                            {s.skill}
                          </span>
                          <MiniBar value={s.count} max={pa.skills[0].count} />
                          <span
                            className="insights-bar-value"
                            style={{ minWidth: 30, fontSize: 12 }}
                          >
                            {s.count}\u00D7
                          </span>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrendIndicator({ change, invertColor }: { change: number | null; invertColor?: boolean }) {
  if (change === null) return null;
  const abs = Math.abs(change);
  if (abs < 0.5) return <span className="insights-trend neutral">\u2014</span>;
  // For per-AWU metrics, negative change = improvement (invertColor=true)
  const isGood = invertColor ? change < 0 : change > 0;
  const arrow = change < 0 ? "\u2193" : "\u2191";
  const colorClass = isGood ? "good" : "bad";
  return (
    <span className={`insights-trend ${colorClass}`}>
      {arrow} {abs.toFixed(0)}%
    </span>
  );
}
