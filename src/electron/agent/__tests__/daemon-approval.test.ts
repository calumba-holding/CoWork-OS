import { describe, expect, it, vi, afterEach } from "vitest";
import { AgentDaemon } from "../daemon";

describe("AgentDaemon.requestApproval auto-approve controls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps auto-approve behavior by default", async () => {
    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-1" }),
      update: vi.fn(),
    };
    const evaluatePermissionRequest = vi.fn();

    const daemonLike = {
      sessionAutoApproveAll: true,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      taskRepo: {
        findById: vi.fn().mockReturnValue({ agentConfig: { autonomousMode: true } }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approved = await AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-1",
      "external_service",
      "Approve action",
      { tool: "x402_fetch" },
    );

    expect(approved).toBe(true);
    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "approved",
      }),
    );
    expect(evaluatePermissionRequest).not.toHaveBeenCalled();
  });

  it("disables auto-approve when allowAutoApprove=false is passed", async () => {
    vi.useFakeTimers();

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-2" }),
      update: vi.fn(),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
        scopePreview: "tool x402_fetch",
        suggestedActions: [],
      },
      scope: { kind: "tool", toolName: "x402_fetch" },
      trackingKey: "tool x402_fetch",
      runtime: null,
      workspace: undefined,
    });

    const daemonLike = {
      sessionAutoApproveAll: true,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      taskRepo: {
        findById: vi.fn().mockReturnValue({ agentConfig: { autonomousMode: true } }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approvalPromise = AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-2",
      "external_service",
      "Approve payment",
      { tool: "x402_fetch" },
      { allowAutoApprove: false },
    );

    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(1);

    const pending = daemonLike.pendingApprovals.get("approval-2");
    clearTimeout(pending.timeoutHandle);
    pending.resolve(true);

    await expect(approvalPromise).resolves.toBe(true);
  });

  it("scopes task auto-approve to explicitly allowed approval types", async () => {
    vi.useFakeTimers();

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-3" }),
      update: vi.fn(),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
        scopePreview: "tool x402_fetch",
        suggestedActions: [],
      },
      scope: { kind: "tool", toolName: "x402_fetch" },
      trackingKey: "tool x402_fetch",
      runtime: null,
      workspace: undefined,
    });

    const daemonLike = {
      sessionAutoApproveAll: false,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          agentConfig: {
            autonomousMode: true,
            autoApproveTypes: ["run_command"],
          },
        }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approvalPromise = AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-3",
      "external_service",
      "Approve external side effect",
      { tool: "x402_fetch" },
    );

    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        type: "external_service",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(1);

    const pending = daemonLike.pendingApprovals.get("approval-3");
    clearTimeout(pending.timeoutHandle);
    pending.resolve(false);

    await expect(approvalPromise).resolves.toBe(false);
  });

  it("does not session auto-approve computer_use even when session auto-approve is enabled", async () => {
    vi.useFakeTimers();

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-cu" }),
      update: vi.fn(),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
        scopePreview: "tool computer_use",
        suggestedActions: [],
      },
      scope: { kind: "tool", toolName: "computer_use" },
      trackingKey: "tool computer_use",
      runtime: null,
      workspace: undefined,
    });

    const daemonLike = {
      sessionAutoApproveAll: true,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      taskRepo: {
        findById: vi.fn().mockReturnValue({ agentConfig: { autonomousMode: true } }),
      },
      pendingApprovals: new Map(),
    } as Any;

    void AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-cu",
      "computer_use",
      "Allow app for session",
      { kind: "computer_use_app_grant", appName: "Safari" },
      { allowAutoApprove: false },
    );

    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        type: "computer_use",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(1);
  });

  it("does not overwrite terminal task state when an approval times out late", async () => {
    vi.useFakeTimers();

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-timeout" }),
      update: vi.fn(),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
        scopePreview: "tool x402_fetch",
        suggestedActions: [],
      },
      scope: { kind: "tool", toolName: "x402_fetch" },
      trackingKey: "tool x402_fetch",
      runtime: null,
      workspace: undefined,
    });
    const updateTask = vi.fn();
    const logEvent = vi.fn();

    const daemonLike = {
      sessionAutoApproveAll: false,
      approvalRepo,
      logEvent,
      updateTask,
      evaluatePermissionRequest,
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-timeout",
          status: "completed",
          completedAt: Date.now(),
          terminalStatus: "ok",
        }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approvalPromise = AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-timeout",
      "external_service",
      "Approve action",
      { tool: "x402_fetch" },
    );

    expect(updateTask).toHaveBeenCalledWith(
      "task-timeout",
      expect.objectContaining({
        status: "blocked",
        terminalStatus: "awaiting_approval",
      }),
    );

    const rejection = expect(approvalPromise).rejects.toThrow(
      "Approval request timed out after task completion",
    );
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    await rejection;
    expect(approvalRepo.update).toHaveBeenCalledWith("approval-timeout", "denied");
    expect(updateTask).not.toHaveBeenCalledWith(
      "task-timeout",
      expect.objectContaining({
        status: "paused",
        terminalStatus: "needs_user_action",
        error: "Approval request timed out",
      }),
    );
    expect(logEvent).not.toHaveBeenCalledWith(
      "task-timeout",
      "approval_denied",
      expect.objectContaining({
        approvalId: "approval-timeout",
        reason: "timeout",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(0);
  });

  it("persists workspace approval rules and resolves the pending approval", async () => {
    const runtime = {
      recordPermissionSuccess: vi.fn(),
      recordPermissionDenial: vi.fn(),
      addTemporaryPermissionGrant: vi.fn(),
    };
    const pendingApprovals = new Map<string, Any>();
    pendingApprovals.set("approval-4", {
      taskId: "task-4",
      approval: {
        id: "approval-4",
        taskId: "task-4",
        type: "external_service",
        details: {
          permissionPrompt: {
            scope: { kind: "tool", toolName: "open_url" },
            scopePreview: "tool open_url",
            reason: { type: "mode", mode: "default", summary: "Prompt for side effects." },
            suggestedActions: [],
          },
        },
      },
      resolve: vi.fn(),
      reject: vi.fn(),
      resolved: false,
      timeoutHandle: setTimeout(() => undefined, 60_000),
    });

    const daemonLike = {
      pendingApprovals,
      approvalRepo: {
        update: vi.fn(),
      },
      updateTask: vi.fn(),
      logEvent: vi.fn(),
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-4",
          workspaceId: "workspace-4",
        }),
      },
      workspaceRepo: {
        findById: vi.fn().mockReturnValue({
          id: "workspace-4",
          path: "/tmp/workspace-4",
        }),
      },
      workspacePermissionRuleRepo: {
        create: vi.fn(),
      },
      getExecutorForTask: vi.fn().mockReturnValue({ runtime }),
      buildPermissionTrackingKey: vi.fn().mockReturnValue("tool open_url"),
      persistApprovalActionRule: AgentDaemon.prototype["persistApprovalActionRule"],
    } as Any;

    const manifestSpy = vi.spyOn(
      await import("../../security/workspace-permission-manifest"),
      "appendWorkspacePermissionManifestRule",
    ).mockReturnValue({
      success: true,
      manifestPath: "/tmp/workspace-4/.cowork/policy/permissions.json",
    });

    const result = await AgentDaemon.prototype.respondToApproval.call(
      daemonLike,
      "approval-4",
      true,
      "allow_workspace",
    );

    expect(result).toBe("handled");
    expect(daemonLike.workspacePermissionRuleRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-4",
        effect: "allow",
        scope: { kind: "tool", toolName: "open_url" },
      }),
    );
    expect(manifestSpy).toHaveBeenCalled();
    expect(runtime.recordPermissionSuccess).toHaveBeenCalledWith("tool open_url");
    expect(daemonLike.approvalRepo.update).toHaveBeenCalledWith("approval-4", "approved");

    manifestSpy.mockRestore();
  });
});

describe("AgentDaemon.buildPermissionRules", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not create legacy guardrail allow rules when trusted commands are disabled", async () => {
    const { GuardrailManager } = await import("../../guardrails/guardrail-manager");
    const { PermissionSettingsManager } = await import("../../security/permission-settings-manager");
    const { BuiltinToolsSettingsManager } = await import("../tools/builtin-settings");

    vi.spyOn(GuardrailManager, "loadSettings").mockReturnValue({
      autoApproveTrustedCommands: false,
      trustedCommandPatterns: ["git status*"],
    } as Any);
    vi.spyOn(PermissionSettingsManager, "loadSettings").mockReturnValue({
      defaultMode: "default",
      rules: [],
    } as Any);
    vi.spyOn(BuiltinToolsSettingsManager, "getToolAutoApprove").mockReturnValue(false);

    const daemonLike = {
      getExecutorForTask: vi.fn().mockReturnValue(null),
      workspacePermissionRuleRepo: {
        listByWorkspaceId: vi.fn().mockReturnValue([]),
      },
    } as Any;

    const rules = AgentDaemon.prototype["buildPermissionRules"].call(
      daemonLike,
      "task-1",
      undefined,
      undefined,
    );

    expect(rules.filter((rule: Any) => rule.source === "legacy_guardrails")).toEqual([]);
  });
});
