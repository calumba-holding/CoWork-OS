import Database from "better-sqlite3";
import { createHash, randomUUID } from "crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentDaemon } from "../agent/daemon";
import { ProactiveSuggestionsService } from "../agent/ProactiveSuggestionsService";
import { WorkspaceRepository } from "../database/repositories";
import { getCronService } from "../cron";
import { getCronStorePath, loadCronStoreSync } from "../cron/store";
import { syncDailyBriefingCronJob } from "../briefing/briefing-scheduler";
import { DEFAULT_BRIEFING_CONFIG } from "../briefing/types";
import { MailboxAutomationRegistry } from "../mailbox/MailboxAutomationRegistry";
import type { EventTriggerService } from "../triggers/EventTriggerService";
import { GitService } from "../git/GitService";
import type {
  ImprovementCampaign,
  ImprovementCandidate,
  ImprovementEligibility,
  ImprovementHistoryResetResult,
  ImprovementLoopSettings,
  NotificationType,
  Workspace,
} from "../../shared/types";
import {
  type SubconsciousBacklogItem,
  type SubconsciousBrainSummary,
  type SubconsciousCritique,
  type SubconsciousDecision,
  type SubconsciousDispatchKind,
  type SubconsciousDispatchRecord,
  type SubconsciousDispatchStatus,
  type SubconsciousEvidence,
  type SubconsciousHealth,
  type SubconsciousHistoryResetResult,
  type SubconsciousHypothesis,
  type SubconsciousRefreshResult,
  type SubconsciousRun,
  type SubconsciousRunOutcome,
  type SubconsciousRunStage,
  type SubconsciousSettings,
  type SubconsciousTargetDetail,
  type SubconsciousTargetKind,
  type SubconsciousTargetRef,
  type SubconsciousTargetSummary,
} from "../../shared/subconscious";
import { SubconsciousArtifactStore } from "./SubconsciousArtifactStore";
import { SubconsciousMigrationService } from "./SubconsciousMigrationService";
import {
  SubconsciousBacklogRepository,
  SubconsciousCritiqueRepository,
  clearSubconsciousHistoryData,
  SubconsciousDecisionRepository,
  SubconsciousDispatchRepository,
  SubconsciousHypothesisRepository,
  SubconsciousRunRepository,
  SubconsciousTargetRepository,
} from "./SubconsciousRepositories";
import { SubconsciousSettingsManager } from "./SubconsciousSettingsManager";

type Any = any;

interface SubconsciousLoopServiceDeps {
  notify?: (params: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    workspaceId?: string;
  }) => Promise<void> | void;
  getTriggerService?: () => EventTriggerService | null;
  getGlobalRoot?: () => string;
}

function now(): number {
  return Date.now();
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pick<T>(values: T[]): T | undefined {
  return values[0];
}

function limit<T>(values: T[], max: number): T[] {
  return values.slice(0, max);
}

function toDispatchPolicyKey(kind: SubconsciousDispatchKind):
  | keyof SubconsciousSettings["perExecutorPolicy"]
  | "codeChangeTask"
  | "eventTriggerUpdate"
  | "scheduledTask"
  | "mailboxAutomation" {
  switch (kind) {
    case "scheduled_task":
      return "scheduledTask";
    case "event_trigger_update":
      return "eventTriggerUpdate";
    case "mailbox_automation":
      return "mailboxAutomation";
    case "code_change_task":
      return "codeChangeTask";
    default:
      return kind;
  }
}

function humanizeDispatchKind(kind?: SubconsciousDispatchKind): string {
  switch (kind) {
    case "code_change_task":
      return "code change task";
    case "scheduled_task":
      return "scheduled task";
    case "event_trigger_update":
      return "event trigger update";
    case "mailbox_automation":
      return "mailbox automation";
    default:
      return kind ? kind.replace(/_/g, " ") : "recommendation";
  }
}

function isSelfGeneratedSubconsciousTask(row: Any): boolean {
  return row?.source === "subconscious" && typeof row?.title === "string";
}

const COWORK_OS_REPO_IDENTITY = "CoWork-OS/CoWork-OS";

interface CodeWorkspaceTargetCandidate {
  workspace: Workspace;
  repoRoot: string;
  remoteName?: string;
  remoteUrl?: string;
  repoIdentity?: string;
}

function normalizeRepoIdentity(value?: string | null): string | undefined {
  if (!value) return undefined;
  return value.toLowerCase() === COWORK_OS_REPO_IDENTITY.toLowerCase()
    ? COWORK_OS_REPO_IDENTITY
    : value;
}

function isCoworkRepoIdentity(value?: string | null): boolean {
  return value?.toLowerCase() === COWORK_OS_REPO_IDENTITY.toLowerCase();
}

function buildCodeTargetKey(candidate: Pick<CodeWorkspaceTargetCandidate, "repoRoot" | "repoIdentity">): string {
  if (candidate.repoIdentity) {
    return `code_workspace:github:${candidate.repoIdentity}`;
  }
  return `code_workspace:repo:${stableHash(candidate.repoRoot).slice(0, 16)}`;
}

export class SubconsciousLoopService {
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly targetRepo: SubconsciousTargetRepository;
  private readonly runRepo: SubconsciousRunRepository;
  private readonly hypothesisRepo: SubconsciousHypothesisRepository;
  private readonly critiqueRepo: SubconsciousCritiqueRepository;
  private readonly decisionRepo: SubconsciousDecisionRepository;
  private readonly backlogRepo: SubconsciousBacklogRepository;
  private readonly dispatchRepo: SubconsciousDispatchRepository;
  private readonly artifactStore: SubconsciousArtifactStore;
  private readonly migrationService: SubconsciousMigrationService;
  private readonly latestEvidenceByTarget = new Map<string, SubconsciousEvidence[]>();
  private agentDaemon: AgentDaemon | null = null;
  private intervalHandle?: ReturnType<typeof setInterval>;
  private brainStatus: SubconsciousBrainSummary["status"] = "idle";
  private started = false;

  constructor(
    private readonly db: Database.Database,
    private readonly deps: SubconsciousLoopServiceDeps = {},
  ) {
    this.workspaceRepo = new WorkspaceRepository(db);
    this.targetRepo = new SubconsciousTargetRepository(db);
    this.runRepo = new SubconsciousRunRepository(db);
    this.hypothesisRepo = new SubconsciousHypothesisRepository(db);
    this.critiqueRepo = new SubconsciousCritiqueRepository(db);
    this.decisionRepo = new SubconsciousDecisionRepository(db);
    this.backlogRepo = new SubconsciousBacklogRepository(db);
    this.dispatchRepo = new SubconsciousDispatchRepository(db);
    this.artifactStore = new SubconsciousArtifactStore(
      (workspaceId?: string) => this.resolveWorkspacePath(workspaceId),
      () => this.resolveGlobalRoot(),
    );
    this.migrationService = new SubconsciousMigrationService(db);
  }

  async start(agentDaemon: AgentDaemon): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.agentDaemon = agentDaemon;
    this.migrationService.runOnce();
    await this.refreshTargets();
    this.resetInterval();
    const settings = this.getSettings();
    if (settings.enabled && settings.autoRun) {
      await this.runNow();
    }
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    this.started = false;
    this.agentDaemon = null;
    this.brainStatus = "idle";
  }

  getSettings(): SubconsciousSettings {
    return SubconsciousSettingsManager.loadSettings();
  }

  saveSettings(settings: SubconsciousSettings): SubconsciousSettings {
    SubconsciousSettingsManager.saveSettings(settings);
    this.resetInterval();
    return this.getSettings();
  }

  getBrainSummary(): SubconsciousBrainSummary {
    const settings = this.getSettings();
    const targets = this.targetRepo.list();
    const activeRunCount = this.runRepo.list({ activeOnly: true }).length;
    const lastRunAt = pick(
      this.runRepo
        .list({ limit: 1 })
        .map((run) => run.completedAt || run.startedAt)
        .filter((value): value is number => typeof value === "number"),
    );
    return {
      status: settings.enabled ? this.brainStatus : "paused",
      enabled: settings.enabled,
      cadenceMinutes: settings.cadenceMinutes,
      targetCount: targets.length,
      activeRunCount,
      lastRunAt,
      updatedAt: now(),
    };
  }

  listTargets(workspaceId?: string): SubconsciousTargetSummary[] {
    return this.targetRepo.list({ workspaceId });
  }

  listRuns(targetKey?: string): SubconsciousRun[] {
    return this.runRepo.list({ targetKey });
  }

  async getTargetDetail(targetKey: string): Promise<SubconsciousTargetDetail | null> {
    const target = this.targetRepo.findByKey(targetKey);
    if (!target) return null;
    const recentRuns = this.runRepo.list({ targetKey, limit: 12 });
    const latestRun = pick(recentRuns);
    return {
      target,
      latestEvidence: this.latestEvidenceByTarget.get(targetKey) || [],
      recentRuns,
      latestHypotheses: latestRun ? this.hypothesisRepo.listByRun(latestRun.id) : [],
      latestCritiques: latestRun ? this.critiqueRepo.listByRun(latestRun.id) : [],
      latestDecision: latestRun ? this.decisionRepo.findByRun(latestRun.id) : undefined,
      backlog: this.backlogRepo.listByTarget(targetKey, 50),
      dispatchHistory: this.dispatchRepo.listByTarget(targetKey, 30),
    };
  }

  async refreshTargets(): Promise<SubconsciousRefreshResult> {
    const settings = this.getSettings();
    const collected = await this.collectTargets(settings.enabledTargetKinds);
    let evidenceCount = 0;
    for (const [targetKey, data] of collected.entries()) {
      if (data.target.kind === "code_workspace") {
        this.backlogRepo.deleteLegacyNoiseByTarget(targetKey);
      }
      const evidence = data.evidence
        .sort((a, b) => b.createdAt - a.createdAt)
        .filter((item, index, items) => items.findIndex((other) => other.fingerprint === item.fingerprint) === index);
      evidenceCount += evidence.length;
      this.latestEvidenceByTarget.set(targetKey, evidence);
      const backlogCount = this.backlogRepo.countOpenByTarget(targetKey);
      const summary = this.buildTargetSummary(data.target, evidence, backlogCount);
      this.targetRepo.upsert(summary);
      await this.artifactStore.writeTargetState(summary, evidence, this.backlogRepo.listByTarget(targetKey, 50));
    }
    const targets = this.targetRepo.list();
    await this.artifactStore.writeBrainState(this.getBrainSummary(), targets);
    return { targetCount: targets.length, evidenceCount };
  }

  async runNow(targetKey?: string): Promise<SubconsciousRun | null> {
    const settings = this.getSettings();
    if (!settings.enabled) return null;
    await this.refreshTargets();
    const target = targetKey ? this.targetRepo.findByKey(targetKey) : this.pickTargetForRun();
    if (!target) return null;

    const evidence = this.latestEvidenceByTarget.get(target.key) || [];
    const evidenceFingerprint = stableHash(
      evidence.map((item) => ({
        fingerprint: item.fingerprint,
        createdAt: item.createdAt,
      })),
    );
    const deduped = this.runRepo.findLatestByFingerprint(target.key, evidenceFingerprint);
    if (deduped && (deduped.outcome === "completed" || deduped.outcome === "completed_no_dispatch")) {
      return deduped;
    }

    this.brainStatus = "running";
    let run = this.runRepo.create({
      targetKey: target.key,
      workspaceId: target.target.workspaceId,
      stage: "collecting_evidence",
      evidenceFingerprint,
      evidenceSummary: evidence.map((item) => item.summary).slice(0, 3).join(" | "),
      artifactRoot: this.artifactStore.getRunRoot(target.target, randomUUID()),
      rejectedHypothesisIds: [],
      startedAt: now(),
    });

    try {
      this.targetRepo.update(target.key, {
        state: "active",
        evidenceFingerprint,
      });

      run = await this.advanceRun(run.id, { stage: "ideating" });
      const hypotheses = this.generateHypotheses(target.target, evidence, settings.maxHypothesesPerRun).map(
        (item) => ({ ...item, runId: run.id }),
      );
      this.hypothesisRepo.replaceForRun(run.id, hypotheses);

      run = await this.advanceRun(run.id, { stage: "critiquing" });
      const critiques = this.generateCritiques(target.target, evidence, hypotheses).map((item) => ({
        ...item,
        runId: run.id,
      }));
      this.critiqueRepo.replaceForRun(run.id, critiques);

      run = await this.advanceRun(run.id, { stage: "synthesizing" });
      const decision = {
        ...this.synthesizeDecision(target.target, evidence, hypotheses, critiques),
        runId: run.id,
      };
      this.decisionRepo.upsert(decision);
      const backlog = this.materializeBacklog(target.key, decision, this.resolveDispatchKind(target.target));
      const placeholderDispatch =
        settings.dispatchDefaults.autoDispatch && this.resolveDispatchKind(target.target)
          ? ({
              id: randomUUID(),
              runId: run.id,
              targetKey: target.key,
              kind: this.resolveDispatchKind(target.target)!,
              status: "queued",
              summary: "Dispatch queued after synthesis.",
              createdAt: now(),
            } satisfies SubconsciousDispatchRecord)
          : null;
      const artifactRoot = await this.artifactStore.writeRunArtifacts({
        target: target.target,
        run: { ...run, artifactRoot: this.artifactStore.getRunRoot(target.target, run.id) },
        evidence,
        hypotheses,
        critiques,
        decision,
        backlog,
        dispatch: placeholderDispatch,
      });
      this.runRepo.update(run.id, {
        artifactRoot,
      });

      let dispatchRecord: SubconsciousDispatchRecord | null = null;
      let outcome: SubconsciousRunOutcome = "completed_no_dispatch";
      let finalStage: SubconsciousRunStage = "completed";
      if (settings.dispatchDefaults.autoDispatch) {
        run = await this.advanceRun(run.id, { stage: "dispatching" });
        dispatchRecord = await this.dispatchDecision(target.target, decision, evidence);
        if (dispatchRecord) {
          this.dispatchRepo.create(dispatchRecord);
          outcome =
            dispatchRecord.status === "failed"
              ? "failed"
              : dispatchRecord.status === "skipped"
                ? "completed_no_dispatch"
                : "completed";
          if (dispatchRecord.status === "failed") {
            finalStage = "failed";
          }
        }
      }

      this.runRepo.update(run.id, {
        stage: finalStage,
        outcome,
        dispatchKind: dispatchRecord?.kind,
        dispatchStatus: dispatchRecord?.status,
        completedAt: now(),
        rejectedHypothesisIds: decision.rejectedHypothesisIds,
      });
      const finalRun = this.runRepo.findById(run.id) || run;
      await this.artifactStore.writeRunArtifacts({
        target: target.target,
        run: finalRun,
        evidence,
        hypotheses,
        critiques,
        decision: { ...decision, outcome },
        backlog: this.backlogRepo.listByTarget(target.key, 50),
        dispatch: dispatchRecord,
      });
      this.targetRepo.update(target.key, {
        state: "idle",
        health: finalStage === "failed" ? "blocked" : target.health,
        lastWinner: decision.winnerSummary,
        lastRunAt: finalRun.completedAt,
        lastEvidenceAt: pick(evidence)?.createdAt,
        backlogCount: this.backlogRepo.countOpenByTarget(target.key),
        lastDispatchKind: dispatchRecord?.kind,
        lastDispatchStatus: dispatchRecord?.status,
      });
      await this.artifactStore.writeTargetState(
        this.targetRepo.findByKey(target.key) || target,
        evidence,
        this.backlogRepo.listByTarget(target.key, 50),
      );
      await this.artifactStore.writeBrainState(this.getBrainSummary(), this.targetRepo.list());
      await this.deps.notify?.({
        type: finalStage === "failed" ? "warning" : "info",
        title: `Subconscious ${finalStage === "failed" ? "failed" : "completed"}`,
        message: `${target.target.label}: ${decision.winnerSummary}`,
        workspaceId: target.target.workspaceId,
        taskId: dispatchRecord?.taskId,
      });
      this.brainStatus = "idle";
      return this.runRepo.findById(run.id) || finalRun;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.runRepo.update(run.id, {
        stage: "failed",
        outcome: "failed",
        error: message,
        completedAt: now(),
      });
      this.targetRepo.update(target.key, {
        state: "idle",
        health: "blocked",
      });
      this.brainStatus = "idle";
      return this.runRepo.findById(run.id) || null;
    }
  }

  async retryRun(runId: string): Promise<SubconsciousRun | null> {
    const prior = this.runRepo.findById(runId);
    if (!prior) return null;
    return this.runNow(prior.targetKey);
  }

  async reviewRun(
    runId: string,
    reviewStatus: "accepted" | "dismissed",
  ): Promise<SubconsciousRun | undefined> {
    const run = this.runRepo.findById(runId);
    if (!run) return undefined;
    if (reviewStatus === "dismissed") {
      this.runRepo.update(runId, {
        stage: "blocked",
        outcome: "blocked",
        blockedReason: "Dismissed during compatibility review.",
        completedAt: now(),
      });
      return this.runRepo.findById(runId);
    }
    if (run.dispatchStatus === "completed" || run.dispatchStatus === "dispatched") {
      return run;
    }
    return await this.retryRun(runId) || run;
  }

  dismissTarget(targetKey: string): SubconsciousTargetSummary | undefined {
    const target = this.targetRepo.findByKey(targetKey);
    if (!target) return undefined;
    this.targetRepo.update(targetKey, {
      state: "stale",
      health: "watch",
      lastDispatchStatus: "skipped",
    });
    return this.targetRepo.findByKey(targetKey);
  }

  async resetHistory(): Promise<SubconsciousHistoryResetResult> {
    const deleted = clearSubconsciousHistoryData(this.db);
    this.latestEvidenceByTarget.clear();
    for (const workspace of this.workspaceRepo.findAll()) {
      if (!workspace.path) continue;
      await fs.rm(path.join(workspace.path, ".cowork", "subconscious"), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
    await fs.rm(path.join(this.resolveGlobalRoot(), ".cowork", "subconscious"), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    return {
      resetAt: now(),
      deleted,
    };
  }

  getImprovementCompatibilitySettings(): ImprovementLoopSettings {
    const settings = this.getSettings();
    return {
      enabled: settings.enabled,
      autoRun: settings.autoRun,
      includeDevLogs: true,
      intervalMinutes: settings.cadenceMinutes,
      variantsPerCampaign: 1,
      maxConcurrentCampaigns: 1,
      maxConcurrentImprovementExecutors: 1,
      maxQueuedImprovementCampaigns: 1,
      maxOpenCandidatesPerWorkspace: 25,
      requireWorktree: settings.perExecutorPolicy.codeChangeTask.requireWorktree,
      requireRepoChecks: true,
      enforcePatchScope: true,
      maxPatchFiles: 8,
      reviewRequired: settings.perExecutorPolicy.codeChangeTask.strictReview,
      judgeRequired: false,
      promotionMode: "github_pr",
      evalWindowDays: 14,
      replaySetSize: 3,
      campaignTimeoutMinutes: 30,
      campaignTokenBudget: 60000,
      campaignCostBudget: 15,
    };
  }

  getImprovementEligibility(): ImprovementEligibility {
    return {
      eligible: true,
      reason: "Subconscious is generally available.",
      enrolled: true,
      checks: {
        unpackagedApp: true,
        canonicalRepo: true,
        ownerEnrollment: true,
        ownerProofPresent: true,
      },
    };
  }

  listImprovementCandidates(workspaceId?: string): ImprovementCandidate[] {
    return this.listTargets(workspaceId).map((target) => ({
      id: target.key,
      workspaceId: target.target.workspaceId || workspaceId || "global",
      fingerprint: target.evidenceFingerprint || target.key,
      source: "user_feedback",
      status: target.state === "active" ? "running" : target.health === "blocked" ? "parked" : "open",
      readiness: "ready",
      readinessReason: target.lastWinner || undefined,
      title: target.target.label,
      summary: target.lastWinner || "Subconscious target awaiting review.",
      severity: target.health === "blocked" ? 0.9 : target.health === "watch" ? 0.6 : 0.3,
      recurrenceCount: this.latestEvidenceByTarget.get(target.key)?.length || 0,
      fixabilityScore: 0.8,
      priorityScore: target.backlogCount + (target.health === "blocked" ? 2 : target.health === "watch" ? 1 : 0),
      evidence: (this.latestEvidenceByTarget.get(target.key) || []).map((item) => ({
        type: "user_feedback",
        summary: item.summary,
        details: item.details,
        createdAt: item.createdAt,
        metadata: item.metadata,
      })),
      firstSeenAt: target.lastEvidenceAt || now(),
      lastSeenAt: target.lastEvidenceAt || now(),
      lastExperimentAt: target.lastRunAt,
      failureStreak: target.health === "blocked" ? 1 : 0,
      parkReason: target.health === "blocked" ? "Target is blocked." : undefined,
      parkedAt: target.health === "blocked" ? target.lastRunAt : undefined,
    }));
  }

  listImprovementCampaigns(workspaceId?: string): ImprovementCampaign[] {
    const targets = new Map(this.listTargets(workspaceId).map((item) => [item.key, item]));
    return this.runRepo.list({ workspaceId }).map((run) => {
      const target = targets.get(run.targetKey);
      const decision = this.decisionRepo.findByRun(run.id);
      return {
        id: run.id,
        candidateId: run.targetKey,
        workspaceId: run.workspaceId || target?.target.workspaceId || "global",
        status:
          run.stage === "dispatching"
            ? "ready_for_review"
            : run.outcome === "failed"
              ? "failed"
              : "promoted",
        stage:
          run.stage === "collecting_evidence" || run.stage === "ideating"
            ? "preflight"
            : run.stage === "critiquing"
              ? "reproducing"
              : run.stage === "synthesizing"
                ? "verifying"
                : "completed",
        reviewStatus: "accepted",
        promotionStatus:
          run.dispatchStatus === "failed"
            ? "promotion_failed"
            : run.dispatchStatus === "completed" || run.dispatchStatus === "dispatched"
              ? "pr_opened"
              : "idle",
        stopReason: run.blockedReason,
        verdictSummary: decision?.winnerSummary || run.evidenceSummary,
        evaluationNotes: decision?.recommendation,
        trainingEvidence: [],
        holdoutEvidence: [],
        replayCases: [],
        variants: [],
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      };
    });
  }

  async resetImprovementCompatibilityHistory(): Promise<ImprovementHistoryResetResult> {
    const result = await this.resetHistory();
    return {
      resetAt: result.resetAt,
      deleted: {
        candidates: result.deleted.targets,
        campaigns: result.deleted.runs,
        variantRuns: result.deleted.hypotheses + result.deleted.critiques,
        judgeVerdicts: result.deleted.decisions,
        legacyRuns: result.deleted.dispatchRecords,
      },
      cancelledTaskIds: [],
    };
  }

  private resetInterval(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    const settings = this.getSettings();
    if (!settings.enabled || !settings.autoRun) return;
    this.intervalHandle = setInterval(() => {
      void this.runNow();
    }, settings.cadenceMinutes * 60 * 1000);
  }

  private resolveGlobalRoot(): string {
    const preferred = this.deps.getGlobalRoot?.();
    if (preferred) return preferred;
    const workspace = this.resolveDefaultWorkspace();
    return workspace?.path || process.cwd();
  }

  private resolveDefaultWorkspace() {
    return this.workspaceRepo
      .findAll()
      .find((workspace) => !workspace.isTemp && Boolean(workspace.path));
  }

  private resolveWorkspacePath(workspaceId?: string): string | undefined {
    if (workspaceId) {
      return this.workspaceRepo.findById(workspaceId)?.path;
    }
    return this.resolveDefaultWorkspace()?.path;
  }

  private choosePrimaryCodeWorkspace(
    candidates: CodeWorkspaceTargetCandidate[],
  ): CodeWorkspaceTargetCandidate {
    return [...candidates].sort((a, b) => {
      if (isCoworkRepoIdentity(a.repoIdentity) !== isCoworkRepoIdentity(b.repoIdentity)) {
        return isCoworkRepoIdentity(a.repoIdentity) ? -1 : 1;
      }
      const aAtRoot = a.workspace.path === a.repoRoot;
      const bAtRoot = b.workspace.path === b.repoRoot;
      if (aAtRoot !== bAtRoot) {
        return aAtRoot ? -1 : 1;
      }
      const lastUsedDiff = (b.workspace.lastUsedAt || 0) - (a.workspace.lastUsedAt || 0);
      if (lastUsedDiff !== 0) return lastUsedDiff;
      return a.workspace.path.length - b.workspace.path.length;
    })[0];
  }

  private async collectCodeWorkspaceTargets(
    workspaces: Workspace[],
  ): Promise<Map<string, SubconsciousTargetRef>> {
    const inspectedResults = await Promise.all(
      workspaces.map(async (workspace): Promise<CodeWorkspaceTargetCandidate | null> => {
        if (!workspace.path) return null;
        const isGitRepo = await GitService.isGitRepo(workspace.path).catch(() => false);
        if (!isGitRepo) return null;
        const repoRoot = await GitService.getRepoRoot(workspace.path).catch(() => workspace.path);
        const remotes = await GitService.getRemotes(repoRoot);
        const preferredRemote = remotes.find((remote) => remote.name === "origin") || remotes[0];
        return {
          workspace,
          repoRoot,
          remoteName: preferredRemote?.name,
          remoteUrl: preferredRemote?.url,
          repoIdentity: normalizeRepoIdentity(
            GitService.normalizeGithubRepoIdentity(preferredRemote?.url || ""),
          ),
        };
      }),
    );
    const inspected = inspectedResults.filter(
      (entry): entry is CodeWorkspaceTargetCandidate => entry !== null,
    );

    const grouped = new Map<string, CodeWorkspaceTargetCandidate[]>();
    for (const candidate of inspected) {
      const groupKey = candidate.repoIdentity
        ? `github:${candidate.repoIdentity.toLowerCase()}`
        : `repo:${candidate.repoRoot}`;
      const existing = grouped.get(groupKey) || [];
      existing.push(candidate);
      grouped.set(groupKey, existing);
    }

    const targetsByWorkspaceId = new Map<string, SubconsciousTargetRef>();
    for (const candidates of grouped.values()) {
      const primary = this.choosePrimaryCodeWorkspace(candidates);
      const targetKey = buildCodeTargetKey(primary);
      const label = isCoworkRepoIdentity(primary.repoIdentity)
        ? "CoWork OS source code"
        : primary.repoIdentity
          ? `${primary.repoIdentity} source code`
          : `${primary.workspace.name} source code`;
      const target: SubconsciousTargetRef = {
        key: targetKey,
        kind: "code_workspace",
        workspaceId: primary.workspace.id,
        codeWorkspacePath: primary.repoRoot,
        label,
        metadata: {
          repoRoot: primary.repoRoot,
          repoIdentity: primary.repoIdentity,
          remoteName: primary.remoteName,
          remoteUrl: primary.remoteUrl,
          workspaceIds: candidates.map((candidate) => candidate.workspace.id),
        },
      };
      for (const candidate of candidates) {
        targetsByWorkspaceId.set(candidate.workspace.id, target);
      }
    }

    return targetsByWorkspaceId;
  }

  private mergeTargetSummaries(
    target: SubconsciousTargetRef,
    current: SubconsciousTargetSummary | undefined,
    legacy: SubconsciousTargetSummary | undefined,
  ): SubconsciousTargetSummary {
    if (!current && !legacy) {
      return this.buildTargetSummary(target, [], 0);
    }
    return {
      key: target.key,
      target,
      health:
        current?.health === "blocked" || legacy?.health === "blocked"
          ? "blocked"
          : current?.health === "watch" || legacy?.health === "watch"
            ? "watch"
            : current?.health || legacy?.health || "healthy",
      state: current?.state === "active" || legacy?.state === "active" ? "active" : current?.state || legacy?.state || "idle",
      lastWinner: current?.lastWinner || legacy?.lastWinner,
      lastRunAt: Math.max(current?.lastRunAt || 0, legacy?.lastRunAt || 0) || undefined,
      lastEvidenceAt: Math.max(current?.lastEvidenceAt || 0, legacy?.lastEvidenceAt || 0) || undefined,
      backlogCount: Math.max(current?.backlogCount || 0, legacy?.backlogCount || 0),
      evidenceFingerprint: current?.evidenceFingerprint || legacy?.evidenceFingerprint,
      lastDispatchKind: current?.lastDispatchKind || legacy?.lastDispatchKind,
      lastDispatchStatus: current?.lastDispatchStatus || legacy?.lastDispatchStatus,
    };
  }

  private rekeyTargetRecords(oldKey: string, nextTarget: SubconsciousTargetRef): void {
    if (oldKey === nextTarget.key) return;
    const legacySummary = this.targetRepo.findByKey(oldKey);
    if (!legacySummary) return;
    const currentSummary = this.targetRepo.findByKey(nextTarget.key);
    const merged = this.mergeTargetSummaries(nextTarget, currentSummary, legacySummary);

    const rekeyTx = this.db.transaction(() => {
      this.targetRepo.upsert({
        ...merged,
        backlogCount: Math.max(currentSummary?.backlogCount || 0, legacySummary.backlogCount || 0),
      });

      const updates = [
        "UPDATE subconscious_runs SET target_key = ? WHERE target_key = ?",
        "UPDATE subconscious_hypotheses SET target_key = ? WHERE target_key = ?",
        "UPDATE subconscious_critiques SET target_key = ? WHERE target_key = ?",
        "UPDATE subconscious_decisions SET target_key = ? WHERE target_key = ?",
        "UPDATE subconscious_backlog_items SET target_key = ? WHERE target_key = ?",
        "UPDATE subconscious_dispatch_records SET target_key = ? WHERE target_key = ?",
      ];
      for (const sql of updates) {
        this.db.prepare(sql).run(nextTarget.key, oldKey);
      }

      this.db.prepare("DELETE FROM subconscious_targets WHERE target_key = ?").run(oldKey);

      this.targetRepo.upsert({
        ...merged,
        backlogCount: this.backlogRepo.countOpenByTarget(nextTarget.key),
      });
    });

    rekeyTx();
  }

  private async collectTargets(enabledKinds: SubconsciousTargetKind[]) {
    const collected = new Map<string, { target: SubconsciousTargetRef; evidence: SubconsciousEvidence[] }>();
    const ensure = (target: SubconsciousTargetRef) => {
      if (!enabledKinds.includes(target.kind)) return null;
      if (!collected.has(target.key)) {
        collected.set(target.key, { target, evidence: [] });
      }
      return collected.get(target.key)!;
    };
    const pushEvidence = (target: SubconsciousTargetRef, evidence: Omit<SubconsciousEvidence, "id" | "targetKey">) => {
      const entry = ensure(target);
      if (!entry) return;
      entry.evidence.push({
        id: randomUUID(),
        targetKey: target.key,
        ...evidence,
      });
    };

    const globalTarget: SubconsciousTargetRef = {
      key: "global:brain",
      kind: "global",
      label: "Global brain",
    };
    ensure(globalTarget);

    const workspaces = this.workspaceRepo.findAll().filter((item) => !item.isTemp && item.path);
    const codeTargetsByWorkspaceId = await this.collectCodeWorkspaceTargets(workspaces);

    for (const workspace of workspaces) {
      const workspaceTarget: SubconsciousTargetRef = {
        key: `workspace:${workspace.id}`,
        kind: "workspace",
        workspaceId: workspace.id,
        label: workspace.name,
      };
      ensure(workspaceTarget);
      const codeTarget = codeTargetsByWorkspaceId.get(workspace.id);
      if (codeTarget) {
        ensure(codeTarget);
        this.rekeyTargetRecords(`code_workspace:${workspace.id}`, codeTarget);
      }
    }

    if (this.hasTable("tasks")) {
      const taskRows = this.db
        .prepare(
          `SELECT id, workspace_id, title, status, failure_class, result_summary, updated_at, source
           FROM tasks
           ORDER BY updated_at DESC
           LIMIT 200`,
        )
        .all() as Any[];
      for (const row of taskRows) {
        if (isSelfGeneratedSubconsciousTask(row)) {
          continue;
        }
        const workspaceId = typeof row.workspace_id === "string" ? row.workspace_id : undefined;
        if (!workspaceId) continue;
        const workspace = this.workspaceRepo.findById(workspaceId);
        if (!workspace || workspace.isTemp) continue;
        pushEvidence(
          {
            key: `workspace:${workspaceId}`,
            kind: "workspace",
            workspaceId,
            label: workspace.name,
          },
          {
            type: "task_signal",
            summary: `${row.status}: ${row.title}`,
            details: row.result_summary || row.failure_class || undefined,
            fingerprint: stableHash(["task", row.id, row.status, row.failure_class]),
            createdAt: Number(row.updated_at || now()),
            metadata: {
              taskId: row.id,
              source: row.source,
            },
          },
        );
        if (row.failure_class || row.status === "failed") {
          const codeTarget = codeTargetsByWorkspaceId.get(workspaceId);
          if (codeTarget) {
            pushEvidence(codeTarget, {
              type: "code_failure",
              summary: `${row.title} failed`,
              details: row.failure_class || row.result_summary || undefined,
              fingerprint: stableHash(["code", row.id, row.failure_class, row.status]),
              createdAt: Number(row.updated_at || now()),
              metadata: { taskId: row.id },
            });
          }
        }
      }
    }

    if (this.hasTable("memory_markdown_files")) {
      const rows = this.db
        .prepare(
          `SELECT workspace_id, path, updated_at
           FROM memory_markdown_files
           WHERE path LIKE '%.cowork/%' OR path LIKE '%playbook%'
           ORDER BY updated_at DESC
           LIMIT 100`,
        )
        .all() as Any[];
      for (const row of rows) {
        const workspace = this.workspaceRepo.findById(String(row.workspace_id));
        if (!workspace || workspace.isTemp) continue;
        pushEvidence(
          {
            key: `workspace:${workspace.id}`,
            kind: "workspace",
            workspaceId: workspace.id,
            label: workspace.name,
          },
          {
            type: "memory_playbook",
            summary: `Updated durable context: ${row.path}`,
            fingerprint: stableHash(["memory", row.workspace_id, row.path, row.updated_at]),
            createdAt: Number(row.updated_at || now()),
          },
        );
      }
    }

    if (this.hasTable("mailbox_events")) {
      const rows = this.db
        .prepare(
          `SELECT thread_id, workspace_id, subject, summary_text, created_at, last_seen_at
           FROM mailbox_events
           WHERE thread_id IS NOT NULL
           ORDER BY last_seen_at DESC
           LIMIT 50`,
        )
        .all() as Any[];
      for (const row of rows) {
        const workspace = this.workspaceRepo.findById(String(row.workspace_id));
        const target: SubconsciousTargetRef = {
          key: `mailbox_thread:${row.thread_id}`,
          kind: "mailbox_thread",
          workspaceId: workspace?.id,
          mailboxThreadId: String(row.thread_id),
          label: String(row.subject || row.thread_id),
        };
        pushEvidence(target, {
          type: "mailbox_event",
          summary: String(row.summary_text || row.subject || "Mailbox signal"),
          fingerprint: stableHash(["mailbox", row.thread_id, row.last_seen_at, row.summary_text]),
          createdAt: Number(row.last_seen_at || row.created_at || now()),
        });
      }
    }

    if (this.hasTable("agent_roles")) {
      const rows = this.db
        .prepare(
          `SELECT id, name, heartbeat_enabled, last_heartbeat_at, heartbeat_status, heartbeat_last_pulse_result
           FROM agent_roles
           WHERE COALESCE(heartbeat_enabled, 0) = 1`,
        )
        .all() as Any[];
      for (const row of rows) {
        const target: SubconsciousTargetRef = {
          key: `agent_role:${row.id}`,
          kind: "agent_role",
          agentRoleId: String(row.id),
          label: String(row.name || row.id),
        };
        pushEvidence(target, {
          type: "heartbeat_signal",
          summary: `Heartbeat ${row.heartbeat_status || "idle"} for ${row.name || row.id}`,
          details: row.heartbeat_last_pulse_result || undefined,
          fingerprint: stableHash(["heartbeat", row.id, row.last_heartbeat_at, row.heartbeat_status]),
          createdAt: Number(row.last_heartbeat_at || now()),
        });
      }
    }

    if (this.hasTable("heartbeat_runs")) {
      const rows = this.db
        .prepare(
          `SELECT id, workspace_id, agent_role_id, status, updated_at
           FROM heartbeat_runs
           ORDER BY updated_at DESC
           LIMIT 50`,
        )
        .all() as Any[];
      for (const row of rows) {
        const key = row.agent_role_id ? `agent_role:${row.agent_role_id}` : `workspace:${row.workspace_id}`;
        const target = collected.get(key)?.target;
        if (!target) continue;
        pushEvidence(target, {
          type: "heartbeat_run",
          summary: `Heartbeat run ${row.status || "unknown"}`,
          fingerprint: stableHash(["heartbeat_run", row.id, row.status, row.updated_at]),
          createdAt: Number(row.updated_at || now()),
        });
      }
    }

    if (this.hasTable("event_triggers")) {
      const rows = this.db
        .prepare(
          `SELECT id, name, workspace_id, enabled, source, updated_at
           FROM event_triggers
           ORDER BY updated_at DESC`,
        )
        .all() as Any[];
      for (const row of rows) {
        const target: SubconsciousTargetRef = {
          key: `event_trigger:${row.id}`,
          kind: "event_trigger",
          workspaceId: row.workspace_id || undefined,
          eventTriggerId: String(row.id),
          label: String(row.name || row.id),
          metadata: { source: row.source },
        };
        pushEvidence(target, {
          type: "event_trigger",
          summary: `${row.enabled ? "Enabled" : "Paused"} trigger: ${row.name}`,
          fingerprint: stableHash(["trigger", row.id, row.updated_at, row.enabled]),
          createdAt: Number(row.updated_at || now()),
        });
      }
    }

    const cronStore = loadCronStoreSync(getCronStorePath());
    for (const job of cronStore.jobs) {
      const target: SubconsciousTargetRef = {
        key: `scheduled_task:${job.id}`,
        kind: "scheduled_task",
        workspaceId: job.workspaceId,
        scheduledTaskId: job.id,
        label: job.name,
      };
      pushEvidence(target, {
        type: "scheduled_task",
        summary: `${job.enabled ? "Enabled" : "Paused"} scheduled task: ${job.name}`,
        details: job.taskTitle || job.taskPrompt,
        fingerprint: stableHash(["scheduled", job.id, job.updatedAtMs, job.enabled]),
        createdAt: Number(job.updatedAtMs || job.createdAtMs || now()),
      });
    }

    if (this.hasTable("briefing_config")) {
      const rows = this.db
        .prepare(
          `SELECT workspace_id, enabled, schedule_time, updated_at
           FROM briefing_config`,
        )
        .all() as Any[];
      for (const row of rows) {
        const workspace = this.workspaceRepo.findById(String(row.workspace_id));
        const target: SubconsciousTargetRef = {
          key: `briefing:${row.workspace_id}`,
          kind: "briefing",
          workspaceId: String(row.workspace_id),
          briefingId: String(row.workspace_id),
          label: workspace ? `${workspace.name} briefing` : `Briefing ${row.workspace_id}`,
        };
        pushEvidence(target, {
          type: "briefing",
          summary: `${row.enabled ? "Enabled" : "Paused"} briefing at ${row.schedule_time || "08:00"}`,
          fingerprint: stableHash(["briefing", row.workspace_id, row.schedule_time, row.updated_at, row.enabled]),
          createdAt: Number(row.updated_at || now()),
        });
      }
    }

    for (const [key, value] of collected.entries()) {
      if (key === globalTarget.key) continue;
      const newest = value.evidence.sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!newest) continue;
      pushEvidence(globalTarget, {
        type: value.target.kind,
        summary: `${value.target.label}: ${newest.summary}`,
        details: newest.details,
        fingerprint: stableHash(["global", key, newest.fingerprint]),
        createdAt: newest.createdAt,
      });
    }

    return collected;
  }

  private buildTargetSummary(
    target: SubconsciousTargetRef,
    evidence: SubconsciousEvidence[],
    backlogCount: number,
  ): SubconsciousTargetSummary {
    const lastDecision = this.decisionRepo.findLatestByTarget(target.key);
    const lastDispatch = pick(this.dispatchRepo.listByTarget(target.key, 1));
    const lastEvidenceAt = pick(evidence)?.createdAt;
    let health: SubconsciousHealth = "healthy";
    if (evidence.some((item) => item.type === "code_failure")) {
      health = "blocked";
    } else if (evidence.length >= 3) {
      health = "watch";
    }
    return {
      key: target.key,
      target,
      health,
      state: "idle",
      lastWinner: lastDecision?.winnerSummary,
      lastRunAt: this.runRepo.list({ targetKey: target.key, limit: 1 })[0]?.completedAt,
      lastEvidenceAt,
      backlogCount,
      evidenceFingerprint: evidence.length
        ? stableHash(evidence.map((item) => item.fingerprint))
        : undefined,
      lastDispatchKind: lastDispatch?.kind,
      lastDispatchStatus: lastDispatch?.status,
    };
  }

  private pickTargetForRun(): SubconsciousTargetSummary | undefined {
    const targets = this.targetRepo.list().filter((target) => target.key !== "global:brain");
    return targets.sort((a, b) => {
      const priorityA =
        a.backlogCount +
        (a.health === "blocked" ? 3 : a.health === "watch" ? 1 : 0) +
        (isCoworkRepoIdentity(String(a.target.metadata?.repoIdentity || "")) ? 1 : 0);
      const priorityB =
        b.backlogCount +
        (b.health === "blocked" ? 3 : b.health === "watch" ? 1 : 0) +
        (isCoworkRepoIdentity(String(b.target.metadata?.repoIdentity || "")) ? 1 : 0);
      if (priorityB !== priorityA) return priorityB - priorityA;
      return (b.lastEvidenceAt || 0) - (a.lastEvidenceAt || 0);
    })[0];
  }

  private generateHypotheses(
    target: SubconsciousTargetRef,
    evidence: SubconsciousEvidence[],
    maxHypotheses: number,
  ): SubconsciousHypothesis[] {
    const seed = evidence.map((item) => item.summary).slice(0, 3).join("; ");
    const base: Array<Pick<SubconsciousHypothesis, "title" | "summary" | "rationale" | "confidence">> = [
      {
        title: `Respond directly to ${target.label}`,
        summary: `Turn the dominant signal into a concrete ${humanizeDispatchKind(this.resolveDispatchKind(target))}.`,
        rationale: `The latest evidence points to a specific recurring need: ${seed || "fresh evidence is limited but actionable."}`,
        confidence: 0.84,
      },
      {
        title: `Add a durable guardrail for ${target.label}`,
        summary: "Prevent the same failure or drift from resurfacing on the next run.",
        rationale: "A broader fix is justified when signals repeat or the blast radius spans multiple tasks.",
        confidence: 0.73,
      },
      {
        title: `Refine the operator backlog for ${target.label}`,
        summary: "Capture the lesson in backlog form even if direct dispatch is not the best immediate move.",
        rationale: "A namespaced backlog makes the next run start with explicit context instead of rediscovering the same lesson.",
        confidence: 0.67,
      },
      {
        title: `Tune workflow routing around ${target.label}`,
        summary: "Adjust cadence, executor choice, or automation shape so the workflow stops wasting turns.",
        rationale: "Some failures are orchestration mismatches rather than missing work.",
        confidence: 0.62,
      },
    ];
    return limit(base, maxHypotheses).map((item, index) => ({
      id: randomUUID(),
      runId: "",
      targetKey: target.key,
      title: item.title,
      summary: item.summary,
      rationale: item.rationale,
      confidence: item.confidence - index * 0.04,
      evidenceRefs: evidence.slice(0, 3).map((entry) => entry.id),
      status: "proposed",
      createdAt: now() + index,
    }));
  }

  private generateCritiques(
    target: SubconsciousTargetRef,
    evidence: SubconsciousEvidence[],
    hypotheses: SubconsciousHypothesis[],
  ): SubconsciousCritique[] {
    const executor = this.resolveDispatchKind(target);
    return hypotheses.map((hypothesis, index) => {
      const weakEvidence = evidence.length < 2 && index > 0;
      const noExecutor = !executor && /dispatch|task|workflow|automation/i.test(hypothesis.summary);
      const verdict = weakEvidence || noExecutor ? "reject" : index === 0 ? "support" : "mixed";
      return {
        id: randomUUID(),
        runId: "",
        targetKey: target.key,
        hypothesisId: hypothesis.id,
        verdict,
        objection: noExecutor
          ? "The target has no valid executor mapping, so a dispatch-shaped recommendation would not compound yet."
          : weakEvidence
            ? "Evidence is still thin, so this should stay narrower until another confirming signal lands."
            : "The idea is viable, but it must stay concrete and tied to the current evidence cluster.",
        response:
          verdict === "support"
            ? "The hypothesis matches both the evidence density and the target's executor boundary."
            : verdict === "mixed"
              ? "Keep the hypothesis, but cut the scope to the smallest durable move."
              : "Reject this path for now and keep it in the backlog instead of dispatching it.",
        evidenceRefs: hypothesis.evidenceRefs,
        createdAt: now() + index,
      };
    });
  }

  private synthesizeDecision(
    target: SubconsciousTargetRef,
    evidence: SubconsciousEvidence[],
    hypotheses: SubconsciousHypothesis[],
    critiques: SubconsciousCritique[],
  ): SubconsciousDecision {
    const scored = hypotheses.map((hypothesis) => {
      const critique = critiques.find((item) => item.hypothesisId === hypothesis.id);
      const verdictBoost =
        critique?.verdict === "support" ? 0.12 : critique?.verdict === "mixed" ? 0.03 : -0.2;
      return {
        hypothesis,
        score: hypothesis.confidence + verdictBoost + Math.min(evidence.length, 4) * 0.02,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    const winner = scored[0]?.hypothesis || hypotheses[0];
    const rejected = scored.slice(1).map((item) => item.hypothesis.id);
    const executor = this.resolveDispatchKind(target);
    const nextBacklog = [
      `Preserve the winner for ${target.label} and measure whether the next evidence cluster gets narrower.`,
      `Reject overly broad paths unless they earn more evidence or a clearer executor mapping.`,
      executor
        ? `Track dispatch results for ${executor} and fold the outcome back into the next run.`
        : `No executor exists yet; keep the recommendation durable and wait for a valid mapping.`,
    ];
    return {
      id: randomUUID(),
      runId: "",
      targetKey: target.key,
      winningHypothesisId: winner.id,
      winnerSummary: winner.summary,
      recommendation: `${winner.title}. ${winner.summary} Evidence: ${evidence
        .slice(0, 3)
        .map((item) => item.summary)
        .join(" | ")}`,
      rejectedHypothesisIds: rejected,
      rationale: critiques.find((item) => item.hypothesisId === winner.id)?.response || winner.rationale,
      nextBacklog,
      outcome: executor ? "completed" : "completed_no_dispatch",
      createdAt: now(),
    };
  }

  private materializeBacklog(
    targetKey: string,
    decision: SubconsciousDecision,
    executorKind?: SubconsciousDispatchKind,
  ): SubconsciousBacklogItem[] {
    const items = decision.nextBacklog.map((entry, index) =>
      this.backlogRepo.create({
        targetKey,
        title: index === 0 ? "Keep the winner durable" : `Backlog step ${index + 1}`,
        summary: entry,
        status: "open",
        priority: Math.max(1, 100 - index * 10),
        executorKind,
        sourceRunId: decision.runId,
      }),
    );
    return items;
  }

  private resolveDispatchKind(target: SubconsciousTargetRef): SubconsciousDispatchKind | undefined {
    return this.getSettings().dispatchDefaults.defaultKinds[target.kind];
  }

  private async resolveDispatchWorkspace(target: SubconsciousTargetRef): Promise<Workspace | undefined> {
    if (target.kind !== "code_workspace") {
      return target.workspaceId
        ? this.workspaceRepo.findById(target.workspaceId)
        : this.resolveDefaultWorkspace();
    }

    const repoRoot =
      typeof target.metadata?.repoRoot === "string"
        ? target.metadata.repoRoot
        : target.codeWorkspacePath;
    const workspaceIds = Array.isArray(target.metadata?.workspaceIds)
      ? target.metadata.workspaceIds.filter((value): value is string => typeof value === "string")
      : [];
    const candidates = [
      ...(target.workspaceId ? [target.workspaceId] : []),
      ...workspaceIds,
    ];
    for (const workspaceId of candidates) {
      const workspace = this.workspaceRepo.findById(workspaceId);
      if (!workspace || workspace.isTemp || !workspace.path) continue;
      if (!repoRoot) return workspace;
      const resolvedRepoRoot = await GitService.getRepoRoot(workspace.path).catch(() => null);
      if (resolvedRepoRoot === repoRoot) {
        return workspace;
      }
    }

    if (repoRoot) {
      for (const workspace of this.workspaceRepo.findAll()) {
        if (workspace.isTemp || !workspace.path) continue;
        const resolvedRepoRoot = await GitService.getRepoRoot(workspace.path).catch(() => null);
        if (resolvedRepoRoot === repoRoot) {
          return workspace;
        }
      }
    }

    return undefined;
  }

  private async dispatchDecision(
    target: SubconsciousTargetRef,
    decision: SubconsciousDecision,
    evidence: SubconsciousEvidence[],
  ): Promise<SubconsciousDispatchRecord | null> {
    const dispatchKind = this.resolveDispatchKind(target);
    if (!dispatchKind) {
      return null;
    }
    const policyKey = toDispatchPolicyKey(dispatchKind);
    const policy = this.getSettings().perExecutorPolicy[policyKey as keyof SubconsciousSettings["perExecutorPolicy"]];
    if (policy && "enabled" in policy && policy.enabled === false) {
      return {
        id: randomUUID(),
        runId: decision.runId,
        targetKey: target.key,
        kind: dispatchKind,
        status: "skipped",
        summary: "Dispatch policy disabled this executor.",
        createdAt: now(),
      };
    }

    const workspace = await this.resolveDispatchWorkspace(target);
    const workspaceId = workspace?.id || target.workspaceId || this.resolveDefaultWorkspace()?.id;
    const prompt = `${decision.recommendation}\n\nEvidence:\n${evidence
      .slice(0, 5)
      .map((item) => `- ${item.summary}`)
      .join("\n")}`;
    try {
      switch (dispatchKind) {
        case "task": {
          if (!this.agentDaemon || !workspaceId) {
            return this.skippedDispatch(decision, target, dispatchKind, "Task dispatch is unavailable.");
          }
          const task = await this.agentDaemon.createTask({
            title: `Subconscious: ${target.label}`,
            prompt,
            workspaceId,
            source: "subconscious",
          });
          return this.completedDispatch(decision, target, dispatchKind, {
            taskId: task.id,
            summary: `Created task ${task.id}.`,
          });
        }
        case "suggestion": {
          if (!workspaceId) {
            return this.skippedDispatch(decision, target, dispatchKind, "Suggestion dispatch needs a workspace.");
          }
          const suggestion = await ProactiveSuggestionsService.createCompanionSuggestion(workspaceId, {
            title: `Subconscious: ${target.label}`,
            description: decision.winnerSummary,
            actionPrompt: decision.recommendation,
            confidence: 0.78,
          });
          if (!suggestion) {
            return this.skippedDispatch(decision, target, dispatchKind, "Suggestion deduplicated or unavailable.");
          }
          return this.completedDispatch(decision, target, dispatchKind, {
            externalRefId: suggestion.id,
            summary: `Created suggestion ${suggestion.id}.`,
          });
        }
        case "scheduled_task": {
          const cron = getCronService();
          if (!cron || !workspaceId) {
            return this.skippedDispatch(decision, target, dispatchKind, "Scheduled-task dispatch is unavailable.");
          }
          const result = await cron.add({
            name: `Subconscious: ${target.label}`,
            description: "Managed by the subconscious loop.",
            enabled: true,
            allowUserInput: false,
            shellAccess: false,
            schedule: { kind: "every", everyMs: Math.max(this.getSettings().cadenceMinutes, 60) * 60 * 1000 },
            workspaceId,
            taskTitle: `Subconscious follow-up: ${target.label}`,
            taskPrompt: decision.recommendation,
          });
          if (!result.ok) {
            throw new Error(result.error);
          }
          return this.completedDispatch(decision, target, dispatchKind, {
            externalRefId: result.job.id,
            summary: `Created scheduled task ${result.job.id}.`,
          });
        }
        case "briefing": {
          const cron = getCronService();
          if (!cron || !workspaceId) {
            return this.skippedDispatch(decision, target, dispatchKind, "Briefing dispatch is unavailable.");
          }
          await syncDailyBriefingCronJob(cron, workspaceId, {
            ...DEFAULT_BRIEFING_CONFIG,
            enabled: true,
          });
          return this.completedDispatch(decision, target, dispatchKind, {
            externalRefId: workspaceId,
            summary: `Enabled briefing automation for ${workspaceId}.`,
          });
        }
        case "event_trigger_update": {
          const triggerService = this.deps.getTriggerService?.();
          if (!triggerService || !target.eventTriggerId) {
            return this.skippedDispatch(decision, target, dispatchKind, "Event trigger update is unavailable.");
          }
          const existing = triggerService.getTrigger(target.eventTriggerId);
          if (!existing) {
            return this.skippedDispatch(decision, target, dispatchKind, "Trigger no longer exists.");
          }
          triggerService.updateTrigger(existing.id, {
            description: `${existing.description || ""}\n[Subconscious] ${decision.winnerSummary}`.trim(),
            enabled: true,
          });
          return this.completedDispatch(decision, target, dispatchKind, {
            externalRefId: existing.id,
            summary: `Updated trigger ${existing.id}.`,
          });
        }
        case "mailbox_automation": {
          if (!workspaceId || !target.mailboxThreadId) {
            return this.skippedDispatch(decision, target, dispatchKind, "Mailbox automation needs a thread target.");
          }
          const record = MailboxAutomationRegistry.createRule({
            name: `Subconscious: ${target.label}`,
            description: "Managed by the subconscious loop.",
            workspaceId,
            threadId: target.mailboxThreadId,
            conditions: [
              { field: "threadId", operator: "equals", value: target.mailboxThreadId },
            ],
            actionType: "create_task",
            actionTitle: `Mailbox follow-up: ${target.label}`,
            actionPrompt: decision.recommendation,
            enabled: true,
          });
          return this.completedDispatch(decision, target, dispatchKind, {
            externalRefId: record.id,
            summary: `Created mailbox automation ${record.id}.`,
          });
        }
        case "code_change_task": {
          if (!this.agentDaemon || !workspaceId) {
            return this.skippedDispatch(decision, target, dispatchKind, "Code dispatch is unavailable.");
          }
          const requireWorktree = this.getSettings().perExecutorPolicy.codeChangeTask.requireWorktree;
          if (!workspace) {
            return this.skippedDispatch(decision, target, dispatchKind, "Code workspace is unavailable.");
          }
          if (requireWorktree) {
            const canUseWorktree = await this.agentDaemon
              .getWorktreeManager()
              .shouldUseWorktree(workspace.path, workspace.isTemp, true);
            if (!canUseWorktree) {
              return this.skippedDispatch(
                decision,
                target,
                dispatchKind,
                "Worktree isolation is unavailable for this workspace, so the run stays recommendation-only.",
              );
            }
          }
          const task = await this.agentDaemon.createTask({
            title: `Subconscious code change: ${target.label}`,
            prompt: `${prompt}\n\nOperate with worktree isolation, strict review, and verification.`,
            workspaceId,
            source: "subconscious",
            taskOverrides: {
              workerRole: "implementer",
            },
            agentConfig: {
              llmProfile: "strong",
              requireWorktree: this.getSettings().perExecutorPolicy.codeChangeTask.requireWorktree,
              verificationAgent: this.getSettings().perExecutorPolicy.codeChangeTask.verificationRequired,
              reviewPolicy: this.getSettings().perExecutorPolicy.codeChangeTask.strictReview
                ? "strict"
                : "balanced",
            },
          });
          return this.completedDispatch(decision, target, dispatchKind, {
            taskId: task.id,
            summary: `Created code change task ${task.id}.`,
          });
        }
      }
    } catch (error) {
      return {
        id: randomUUID(),
        runId: decision.runId,
        targetKey: target.key,
        kind: dispatchKind,
        status: "failed",
        summary: "Dispatch failed.",
        error: error instanceof Error ? error.message : String(error),
        createdAt: now(),
        completedAt: now(),
      };
    }
  }

  private completedDispatch(
    decision: SubconsciousDecision,
    target: SubconsciousTargetRef,
    kind: SubconsciousDispatchKind,
    input: { taskId?: string; externalRefId?: string; summary: string },
  ): SubconsciousDispatchRecord {
    return {
      id: randomUUID(),
      runId: decision.runId,
      targetKey: target.key,
      kind,
      status: input.taskId ? "dispatched" : "completed",
      taskId: input.taskId,
      externalRefId: input.externalRefId,
      summary: input.summary,
      createdAt: now(),
      completedAt: now(),
    };
  }

  private skippedDispatch(
    decision: SubconsciousDecision,
    target: SubconsciousTargetRef,
    kind: SubconsciousDispatchKind,
    summary: string,
  ): SubconsciousDispatchRecord {
    return {
      id: randomUUID(),
      runId: decision.runId,
      targetKey: target.key,
      kind,
      status: "skipped",
      summary,
      createdAt: now(),
      completedAt: now(),
    };
  }

  private async advanceRun(id: string, updates: Partial<SubconsciousRun>): Promise<SubconsciousRun> {
    this.runRepo.update(id, updates);
    return this.runRepo.findById(id)!;
  }

  private hasTable(name: string): boolean {
    const row = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return Boolean(row);
  }
}
