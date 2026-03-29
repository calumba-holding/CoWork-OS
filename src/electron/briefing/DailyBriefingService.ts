/**
 * DailyBriefingService — generates unified morning briefings by composing
 * data from tasks, memory, suggestions, priorities, cron jobs, and daily logs.
 *
 * Can be scheduled via CronService or triggered on-demand.
 */

import { randomUUID } from "crypto";
import {
  Briefing,
  BriefingConfig,
  BriefingSection,
  BriefingItem,
  BriefingSectionType,
  DailyBriefingServiceDeps,
  DEFAULT_BRIEFING_CONFIG,
} from "./types";
import type { MailboxDigestSnapshot } from "../../shared/mailbox";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export class DailyBriefingService {
  private deps: DailyBriefingServiceDeps;
  private configs: Map<string, BriefingConfig> = new Map();
  private latestBriefings: Map<string, Briefing> = new Map();
  private db: Any;

  constructor(deps: DailyBriefingServiceDeps, db?: Any) {
    this.deps = deps;
    this.db = db;
    this.ensureSchema();
  }

  // ── Main generation ─────────────────────────────────────────────

  async generateBriefing(
    workspaceId: string,
    configOverride?: Partial<BriefingConfig>,
  ): Promise<Briefing> {
    const config = { ...this.getConfig(workspaceId), ...configOverride };
    const sections: BriefingSection[] = [];

    try {
      await this.deps.refreshSuggestions?.(workspaceId);
    } catch (err) {
      this.log("[DailyBriefing] refreshSuggestions skipped:", err);
    }

    const sectionGenerators: Record<BriefingSectionType, () => BriefingSection | Promise<BriefingSection>> = {
      task_summary: () => this.buildTaskSummary(workspaceId),
      memory_highlights: () => this.buildMemoryHighlights(workspaceId),
      active_suggestions: () => this.buildSuggestions(workspaceId),
      priority_review: () => this.buildPriorities(workspaceId),
      upcoming_jobs: () => this.buildUpcomingJobs(workspaceId),
      open_loops: () => this.buildOpenLoops(workspaceId),
      mailbox_summary: () => this.buildMailboxSummary(workspaceId),
      awareness_digest: () => this.buildAwarenessDigest(workspaceId),
      evolution_metrics: () => this.buildEvolutionMetrics(workspaceId),
    };

    for (const [sectionType, generator] of Object.entries(sectionGenerators)) {
      const enabled = config.enabledSections[sectionType as BriefingSectionType] ?? true;
      try {
        const section = await generator();
        section.enabled = enabled;
        if (enabled && section.items.length > 0) {
          sections.push(section);
        }
      } catch (err) {
        this.log(`[DailyBriefing] Error generating ${sectionType}:`, err);
      }
    }

    const briefing: Briefing = {
      id: randomUUID(),
      workspaceId,
      generatedAt: Date.now(),
      sections,
      delivered: false,
    };

    this.latestBriefings.set(workspaceId, briefing);
    this.saveBriefingToDB(briefing);

    // Auto-deliver if configured
    if (config.deliveryChannelType && config.deliveryChannelId && this.deps.deliverToChannel) {
      try {
        const text = this.formatBriefingAsText(briefing);
        await this.deps.deliverToChannel({
          channelType: config.deliveryChannelType,
          channelId: config.deliveryChannelId,
          text,
        });
        briefing.delivered = true;
        this.saveBriefingToDB(briefing);
      } catch (err) {
        this.log("[DailyBriefing] Failed to deliver:", err);
      }
    }

    return briefing;
  }

  renderBriefingAsText(briefing: Briefing): string {
    return this.formatBriefingAsText(briefing);
  }

  getLatestBriefing(workspaceId: string): Briefing | undefined {
    return this.latestBriefings.get(workspaceId) || this.loadLatestFromDB(workspaceId);
  }

  // ── Section builders ────────────────────────────────────────────

  private formatWorkspaceLabel(item: Any): string | null {
    if (typeof item?.workspaceName === "string" && item.workspaceName.trim()) {
      return item.workspaceName.trim();
    }
    if (typeof item?.workspaceId === "string" && item.workspaceId.trim()) {
      return item.workspaceId.trim();
    }
    return null;
  }

  private prefixWorkspace(item: Any, text: string): string {
    const label = this.formatWorkspaceLabel(item);
    return label ? `[${label}] ${text}` : text;
  }

  private stripWorkspacePrefix(text: string): string {
    return String(text || "")
      .trim()
      .replace(/^\[[^\]]+\]\s*/, "")
      .replace(/\s+/g, " ");
  }

  private joinWorkspaceLabels(...items: Any[]): string | undefined {
    const labels = new Set<string>();
    for (const item of items) {
      const label = this.formatWorkspaceLabel(item);
      if (label) labels.add(label);
    }
    return labels.size > 0 ? [...labels].join(", ") : undefined;
  }

  private dedupeBriefingItems(
    items: Any[],
    keyFn: (item: Any) => string,
    limit?: number,
  ): Any[] {
    const map = new Map<string, Any>();
    for (const item of items) {
      const key = keyFn(item);
      if (!key) continue;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, { ...item });
        continue;
      }
      const mergedWorkspaceName = this.joinWorkspaceLabels(existing, item);
      if (mergedWorkspaceName) {
        existing.workspaceName = mergedWorkspaceName;
      }
      if (!existing.detail && item.detail) existing.detail = item.detail;
      if (!existing.link && item.link) existing.link = item.link;
      if (!existing.status && item.status) existing.status = item.status;
      if (typeof existing.relevanceScore === "number" && typeof item.relevanceScore === "number") {
        if (item.relevanceScore > existing.relevanceScore) {
          existing.relevanceScore = item.relevanceScore;
        }
      }
      if (typeof existing.confidence === "number" && typeof item.confidence === "number") {
        if (item.confidence > existing.confidence) {
          existing.confidence = item.confidence;
        }
      }
    }
    return [...map.values()].slice(0, limit ?? map.size);
  }

  private buildTaskSummary(workspaceId: string): BriefingSection {
    const since = Date.now() - TWENTY_FOUR_HOURS_MS;
    const tasks = this.deps.getRecentTasks(workspaceId, since);

    const completed = tasks.filter((t: Any) => t.status === "completed");
    const failed = tasks.filter((t: Any) => t.status === "failed");
    const pending = tasks.filter((t: Any) => t.status === "pending" || t.status === "queued");
    const running = tasks.filter((t: Any) => t.status === "running" || t.status === "executing");

    const items: BriefingItem[] = [];
    if (completed.length > 0)
      items.push({ label: `${completed.length} completed`, status: "completed" });
    if (running.length > 0)
      items.push({ label: `${running.length} in progress`, status: "running" });
    if (pending.length > 0) items.push({ label: `${pending.length} pending`, status: "pending" });
    if (failed.length > 0)
      items.push({
        label: `${failed.length} failed`,
        status: "failed",
        detail: failed.map((t: Any) => t.title).join(", "),
      });

    // Top 5 recent completions
    for (const t of this.dedupeBriefingItems(
      completed.slice(0, 20),
      (item) => this.stripWorkspacePrefix(item.title || ""),
      5,
    )) {
      items.push({
        label: this.prefixWorkspace(t, t.title),
        status: "completed",
        link: { taskId: t.id },
      });
    }

    return { type: "task_summary", title: "Task Summary (24h)", items, enabled: true };
  }

  private buildMemoryHighlights(workspaceId: string): BriefingSection {
    const memories = this.dedupeBriefingItems(
      [
        ...this.deps.searchMemory(workspaceId, "recent learning insight", 5),
        ...this.deps.searchMemory(workspaceId, "preference correction workflow timing", 5),
      ],
      (item) =>
        `${item.id || ""}::${this.stripWorkspacePrefix(item.summary || item.content || item.snippet || "")}`,
      6,
    );
    const items: BriefingItem[] = this.dedupeBriefingItems(
      memories.map((m: Any) => ({
        ...m,
        label: this.prefixWorkspace(m, m.summary || m.content?.slice(0, 100) || "Memory item"),
      })),
      (item) => this.stripWorkspacePrefix(item.label || item.summary || item.content || ""),
      5,
    ).map((m: Any) => ({
      label: `${this.describeMemoryType(m.type)} ${m.label}`.trim(),
      detail: [m.workspaceName ? `Workspaces: ${m.workspaceName}` : null, this.memoryTypeDetail(m.type)]
        .filter(Boolean)
        .join(" · ") || undefined,
      status: "info" as const,
    }));
    return { type: "memory_highlights", title: "Memory Highlights", items, enabled: true };
  }

  private buildSuggestions(workspaceId: string): BriefingSection {
    const suggestions = [...this.deps.getActiveSuggestions(workspaceId)].sort((a: Any, b: Any) => {
      const urgencyScore = (value: string | undefined) =>
        value === "high" ? 3 : value === "medium" ? 2 : value === "low" ? 1 : 0;
      const deliveryScore = (value: string | undefined) =>
        value === "nudge" ? 3 : value === "inbox" ? 2 : value === "briefing" ? 1 : 0;
      const combinedA = urgencyScore(a.urgency) * 10 + deliveryScore(a.recommendedDelivery) * 5 + (a.confidence || 0);
      const combinedB = urgencyScore(b.urgency) * 10 + deliveryScore(b.recommendedDelivery) * 5 + (b.confidence || 0);
      return combinedB - combinedA;
    });
    const items: BriefingItem[] = this.dedupeBriefingItems(
      suggestions.slice(0, 20).map((s: Any) => ({
        ...s,
        label: this.prefixWorkspace(s, s.title || s.description),
      })),
      (item) =>
        `${this.stripWorkspacePrefix(item.label || item.title || "")}::${this.stripWorkspacePrefix(
          item.detail || item.description || "",
        )}`,
      5,
    ).map((s: Any) => ({
      label: s.label,
      detail: [
        s.description || "",
        s.recommendedDelivery ? `Delivery: ${s.recommendedDelivery}` : null,
        typeof s.confidence === "number" ? `Confidence: ${Math.round(s.confidence * 100)}%` : null,
        s.workspaceName ? `Workspaces: ${s.workspaceName}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      status: "info" as const,
    }));
    return { type: "active_suggestions", title: "Active Suggestions", items, enabled: true };
  }

  private describeMemoryType(type: string | undefined): string {
    switch (type) {
      case "preference":
        return "Preference:";
      case "constraint":
        return "Constraint:";
      case "timing_preference":
        return "Timing preference:";
      case "workflow_pattern":
        return "Workflow pattern:";
      case "correction_rule":
        return "Correction learned:";
      default:
        return "";
    }
  }

  private memoryTypeDetail(type: string | undefined): string | undefined {
    switch (type) {
      case "preference":
        return "Companion-learned preference";
      case "constraint":
        return "Companion-learned constraint";
      case "timing_preference":
        return "Attention and interruption pattern";
      case "workflow_pattern":
        return "Promoted reusable workflow signal";
      case "correction_rule":
        return "Suppression rule from user correction";
      default:
        return undefined;
    }
  }

  private buildPriorities(workspaceId: string): BriefingSection {
    const raw = this.deps.getPriorities(workspaceId);
    if (!raw) return { type: "priority_review", title: "Priorities", items: [], enabled: true };
    const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    const items: BriefingItem[] = this.dedupeBriefingItems(
      lines.slice(0, 20).map((line: string) => ({
        label: line.replace(/^[-*\d.]+\s*/, "").trim(),
      })),
      (item) => this.stripWorkspacePrefix(item.label || ""),
      10,
    ).map((item: Any) => ({
      label: item.label,
      detail: item.workspaceName ? `Workspaces: ${item.workspaceName}` : undefined,
      status: "info" as const,
    }));
    return { type: "priority_review", title: "Priorities", items, enabled: true };
  }

  private async buildUpcomingJobs(workspaceId: string): Promise<BriefingSection> {
    const jobs = await this.deps.getUpcomingJobs(workspaceId, 5);
    const items: BriefingItem[] = jobs.map((j: Any) => {
      const nextRun = j.state?.nextRunAtMs
        ? new Date(j.state.nextRunAtMs).toLocaleTimeString()
        : "—";
      return {
        label: this.prefixWorkspace(j, j.name || j.taskTitle || "Scheduled job"),
        detail: `${j.workspaceName ? `Workspace: ${j.workspaceName} · ` : ""}Next: ${nextRun}`,
        status: "pending" as const,
      };
    });
    return { type: "upcoming_jobs", title: "Upcoming Scheduled Jobs", items, enabled: true };
  }

  private buildOpenLoops(workspaceId: string): BriefingSection {
    const loops = this.deps.getOpenLoops(workspaceId);
    const items: BriefingItem[] = this.dedupeBriefingItems(
      loops.slice(0, 20).map((line: string) => ({
        label: line.replace(/^[-*]+\s*/, "").trim(),
      })),
      (item) => this.stripWorkspacePrefix(item.label || ""),
      8,
    ).map((item: Any) => ({
      label: item.label,
      detail: item.workspaceName ? `Workspaces: ${item.workspaceName}` : undefined,
      status: "pending" as const,
    }));
    return { type: "open_loops", title: "Open Loops", items, enabled: true };
  }

  private async buildMailboxSummary(workspaceId: string): Promise<BriefingSection> {
    const digest = this.deps.getMailboxDigest ? await this.deps.getMailboxDigest(workspaceId) : null;
    if (!digest) {
      return { type: "mailbox_summary", title: "Inbox Summary", items: [], enabled: true };
    }

    const items: BriefingItem[] = [
      {
        label: `${digest.unreadCount} unread thread${digest.unreadCount === 1 ? "" : "s"}`,
        status: digest.unreadCount > 0 ? "pending" : "completed",
      },
      {
        label: `${digest.needsReplyCount} need${digest.needsReplyCount === 1 ? "s" : ""} reply`,
        status: digest.needsReplyCount > 0 ? "pending" : "completed",
      },
      {
        label: `${digest.overdueCommitmentCount} overdue commitment${digest.overdueCommitmentCount === 1 ? "" : "s"}`,
        status: digest.overdueCommitmentCount > 0 ? "failed" : "completed",
      },
      {
        label: `${digest.draftCount} draft${digest.draftCount === 1 ? "" : "s"} in progress`,
        status: digest.draftCount > 0 ? "info" : "completed",
      },
      {
        label: `${digest.sensitiveThreadCount} sensitive thread${digest.sensitiveThreadCount === 1 ? "" : "s"}`,
        status: digest.sensitiveThreadCount > 0 ? "info" : "completed",
      },
    ];

    if (digest.recentEventTypes.length) {
      items.push({
        label: `${digest.eventCount} mailbox event${digest.eventCount === 1 ? "" : "s"} captured`,
        detail: digest.recentEventTypes
          .map((event: MailboxDigestSnapshot["recentEventTypes"][number]) => `${event.type}: ${event.count}`)
          .join(" · "),
        status: "info",
      });
    }

    return { type: "mailbox_summary", title: "Inbox Summary", items, enabled: true };
  }

  private async buildAwarenessDigest(workspaceId: string): Promise<BriefingSection> {
    try {
      const summary = await this.deps.getAwarenessSummary?.(workspaceId);
      const autonomyState = await this.deps.getAutonomyState?.(workspaceId);
      const autonomyDecisions = (await this.deps.getAutonomyDecisions?.(workspaceId)) || [];
      if (!summary) {
        return { type: "awareness_digest", title: "Awareness Digest", items: [], enabled: true };
      }

      const items: BriefingItem[] = [];
      if (summary.currentFocus) {
        items.push({
          label: `Current focus: ${summary.currentFocus}`,
          status: "running",
        });
      }

      for (const entry of summary.whatMattersNow?.slice(0, 4) || []) {
        items.push({
          label: entry.title,
          detail: entry.detail,
          status: entry.tags?.includes("deadline") ? "pending" : "info",
        });
      }

      for (const entry of summary.dueSoon?.slice(0, 3) || []) {
        items.push({
          label: entry.title,
          detail: entry.detail,
          status: "pending",
        });
      }

      for (const goal of autonomyState?.goals?.slice(0, 3) || []) {
        items.push({
          label: `Goal: ${goal.title}`,
          detail: `Status ${goal.status}, confidence ${Math.round((goal.confidence || 0) * 100)}%`,
          status: goal.status === "blocked" ? "failed" : "info",
        });
      }

      for (const routine of autonomyState?.routines?.slice(0, 2) || []) {
        items.push({
          label: `Routine: ${routine.title}`,
          detail: routine.description,
          status: "info",
        });
      }

      for (const decision of autonomyDecisions.slice(0, 3)) {
        items.push({
          label: `Next action: ${decision.title}`,
          detail: decision.description,
          status: decision.priority === "high" ? "pending" : "info",
        });
      }

      const deduped = this.dedupeBriefingItems(
        items,
        (item) => `${this.stripWorkspacePrefix(item.label || "")}::${this.stripWorkspacePrefix(item.detail || "")}`,
        10,
      ).map((item: Any) => ({
        label: item.label,
        detail:
          item.detail ||
          (item.workspaceName ? `Workspaces: ${item.workspaceName}` : undefined),
        status: item.status,
      }));

      return { type: "awareness_digest", title: "Awareness Digest", items: deduped, enabled: true };
    } catch (error) {
      this.log("[DailyBriefing] buildAwarenessDigest skipped:", error);
      return { type: "awareness_digest", title: "Awareness Digest", items: [], enabled: true };
    }
  }

  /** Max ms to wait for evolution metrics before skipping the section. */
  private static readonly EVOLUTION_METRICS_TIMEOUT_MS = 5_000;

  private async buildEvolutionMetrics(workspaceId: string): Promise<BriefingSection> {
    try {
      const { EvolutionMetricsService } = await import("../memory/EvolutionMetricsService");

      // Guard against a slow computeSnapshot stalling the entire briefing pipeline.
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("EvolutionMetricsService timed out")),
          DailyBriefingService.EVOLUTION_METRICS_TIMEOUT_MS,
        ),
      );
      const snapshot = await Promise.race([
        EvolutionMetricsService.computeSnapshot(workspaceId),
        timeoutPromise,
      ]);

      const items: BriefingItem[] = snapshot.metrics.map((m) => ({
        label: `${m.label}: ${m.value}${m.unit}`,
        detail: m.detail,
        status: m.trend === "improving" ? ("completed" as const) : m.trend === "declining" ? ("failed" as const) : ("info" as const),
      }));
      items.push({
        label: `Overall Evolution Score: ${snapshot.overallScore}/100`,
        status: "info",
      });
      return { type: "evolution_metrics", title: "Agent Evolution", items, enabled: true };
    } catch (err) {
      this.log("[DailyBriefing] buildEvolutionMetrics skipped:", (err as Error)?.message ?? err);
      return { type: "evolution_metrics", title: "Agent Evolution", items: [], enabled: true };
    }
  }

  // ── Config management ───────────────────────────────────────────

  getConfig(workspaceId: string): BriefingConfig {
    const cached = this.configs.get(workspaceId);
    if (cached) return cached;
    const loaded = this.loadConfigFromDB(workspaceId);
    if (loaded) {
      this.configs.set(workspaceId, loaded);
      return loaded;
    }
    return { ...DEFAULT_BRIEFING_CONFIG };
  }

  saveConfig(workspaceId: string, config: BriefingConfig): void {
    this.configs.set(workspaceId, config);
    this.saveConfigToDB(workspaceId, config);
  }

  // ── Text formatting ─────────────────────────────────────────────

  private formatBriefingAsText(briefing: Briefing): string {
    const lines = [
      `Good morning! Here's your daily briefing for ${new Date(briefing.generatedAt).toLocaleDateString()}:\n`,
    ];

    for (const section of briefing.sections) {
      lines.push(`**${section.title}**`);
      for (const item of section.items) {
        const prefix =
          item.status === "completed"
            ? "✅"
            : item.status === "failed"
              ? "❌"
              : item.status === "running"
                ? "🔄"
                : item.status === "pending"
                  ? "⏳"
                  : "ℹ️";
        lines.push(`${prefix} ${item.label}${item.detail ? ` — ${item.detail}` : ""}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  // ── Database persistence ────────────────────────────────────────

  private ensureSchema(): void {
    if (!this.db) return;
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS briefing_config (
          workspace_id TEXT PRIMARY KEY,
          schedule_time TEXT DEFAULT '08:00',
          enabled_sections TEXT DEFAULT '{}',
          delivery_channel_type TEXT,
          delivery_channel_id TEXT,
          enabled INTEGER DEFAULT 0,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS briefings (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          generated_at INTEGER NOT NULL,
          sections TEXT NOT NULL,
          delivered INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_briefings_workspace ON briefings(workspace_id, generated_at DESC);
      `);
    } catch {
      // Tables already exist
    }
  }

  private saveBriefingToDB(briefing: Briefing): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO briefings (id, workspace_id, generated_at, sections, delivered)
         VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          briefing.id,
          briefing.workspaceId,
          briefing.generatedAt,
          JSON.stringify(briefing.sections),
          briefing.delivered ? 1 : 0,
        );
    } catch (err) {
      this.log("[DailyBriefing] DB save error:", err);
    }
  }

  private loadLatestFromDB(workspaceId: string): Briefing | undefined {
    if (!this.db) return undefined;
    try {
      const row = this.db
        .prepare(
          "SELECT * FROM briefings WHERE workspace_id = ? ORDER BY generated_at DESC LIMIT 1",
        )
        .get(workspaceId) as Any;
      if (!row) return undefined;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        generatedAt: row.generated_at,
        sections: JSON.parse(row.sections || "[]"),
        delivered: !!row.delivered,
      };
    } catch {
      return undefined;
    }
  }

  private saveConfigToDB(workspaceId: string, config: BriefingConfig): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO briefing_config
         (workspace_id, schedule_time, enabled_sections, delivery_channel_type, delivery_channel_id, enabled, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          workspaceId,
          config.scheduleTime,
          JSON.stringify(config.enabledSections),
          config.deliveryChannelType || null,
          config.deliveryChannelId || null,
          config.enabled ? 1 : 0,
          Date.now(),
        );
    } catch (err) {
      this.log("[DailyBriefing] Config save error:", err);
    }
  }

  private loadConfigFromDB(workspaceId: string): BriefingConfig | null {
    if (!this.db) return null;
    try {
      const row = this.db
        .prepare("SELECT * FROM briefing_config WHERE workspace_id = ?")
        .get(workspaceId) as Any;
      if (!row) return null;
      return {
        scheduleTime: row.schedule_time || "08:00",
        enabledSections: JSON.parse(row.enabled_sections || "{}"),
        deliveryChannelType: row.delivery_channel_type || undefined,
        deliveryChannelId: row.delivery_channel_id || undefined,
        enabled: !!row.enabled,
      };
    } catch {
      return null;
    }
  }

  private log(...args: unknown[]): void {
    if (this.deps.log) this.deps.log(...args);
    else console.log(...args);
  }
}
