import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("ControlPlaneCoreService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let service: import("../ControlPlaneCoreService").ControlPlaneCoreService;
  let agentRoleRepo: import("../../agents/AgentRoleRepository").AgentRoleRepository;
  let taskRepo: import("../../database/repositories").TaskRepository;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;

  const insertWorkspace = (name = "main") => {
    const workspace = {
      id: randomUUID(),
      name,
      path: path.join(tmpDir, name),
      createdAt: Date.now(),
      permissions: JSON.stringify({
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: true,
      }),
    };
    fs.mkdirSync(workspace.path, { recursive: true });
    db.prepare(
      `
        INSERT INTO workspaces (id, name, path, created_at, permissions)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run(workspace.id, workspace.name, workspace.path, workspace.createdAt, workspace.permissions);
    return workspace;
  };

  const insertUsageEvent = (
    taskId: string,
    payload: { delta: { cost: number; inputTokens: number; outputTokens: number } },
  ) => {
    const timestamp = Date.now();
    db.prepare(
      `
        INSERT INTO task_events (id, task_id, timestamp, type, payload, schema_version)
        VALUES (?, ?, ?, 'llm_usage', ?, 2)
      `,
    ).run(randomUUID(), taskId, timestamp, JSON.stringify(payload));
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-control-plane-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const [
      { DatabaseManager },
      { ControlPlaneCoreService },
      { AgentRoleRepository },
      { TaskRepository },
    ] = await Promise.all([
      import("../../database/schema"),
      import("../ControlPlaneCoreService"),
      import("../../agents/AgentRoleRepository"),
      import("../../database/repositories"),
    ]);

    manager = new DatabaseManager();
    db = manager.getDatabase();
    service = new ControlPlaneCoreService(db);
    agentRoleRepo = new AgentRoleRepository(db);
    taskRepo = new TaskRepository(db);
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("seeds a default company and round-trips export/import with collision-safe renaming", () => {
    const workspace = insertWorkspace();
    const company = service.getDefaultCompany();

    expect(company.name).toBe("Local Company");
    expect(company.slug).toBe("local");
    expect(company.isDefault).toBe(true);

    const goal = service.createGoal({
      companyId: company.id,
      title: "Ship the control plane",
      description: "Expose the company/project/issue graph to operators.",
    });
    const project = service.createProject({
      companyId: company.id,
      goalId: goal.id,
      name: "Mission Control",
      description: "Desktop and remote control plane surfaces.",
      monthlyBudgetCost: 75,
    });
    service.linkProjectWorkspace({
      projectId: project.id,
      workspaceId: workspace.id,
      isPrimary: true,
    });
    const issue = service.createIssue({
      companyId: company.id,
      goalId: goal.id,
      projectId: project.id,
      workspaceId: workspace.id,
      title: "Move Mission Control to issues",
      description: "Board state should reflect issue status, not raw task status.",
      priority: 2,
    });
    service.createIssueComment({
      issueId: issue.id,
      authorType: "user",
      body: "Do not backfill historical tasks.",
    });

    const exported = service.exportCompanyTemplate(company.id);
    const imported = service.importCompanyTemplate(exported);

    expect(exported.goals).toHaveLength(1);
    expect(exported.projects).toHaveLength(1);
    expect(exported.issues).toHaveLength(1);
    expect(exported.projectWorkspaceLinks).toHaveLength(1);
    expect(exported.issueComments).toHaveLength(1);

    expect(imported.company.id).not.toBe(company.id);
    expect(imported.company.name).toBe("Local Company (2)");
    expect(imported.company.slug).toBe("local-2");
    expect(imported.goalCount).toBe(1);
    expect(imported.projectCount).toBe(1);
    expect(imported.issueCount).toBe(1);

    const importedProjects = service.listProjects({
      companyId: imported.company.id,
      includeArchived: true,
    });
    const importedIssues = service.listIssues({ companyId: imported.company.id, limit: 20 });

    expect(importedProjects).toHaveLength(1);
    expect(importedProjects[0].name).toBe(project.name);
    expect(importedIssues).toHaveLength(1);
    expect(importedIssues[0].title).toBe(issue.title);
  });

  it("enforces single active issue checkout and syncs task lifecycle into runs", () => {
    const workspace = insertWorkspace();
    const company = service.getDefaultCompany();
    const issue = service.createIssue({
      companyId: company.id,
      workspaceId: workspace.id,
      title: "Claim one operator issue",
      description: "Only one active run should exist for the issue.",
    });

    const checkout = service.checkoutIssue({
      issueId: issue.id,
      workspaceId: workspace.id,
    });

    expect(checkout.issue.status).toBe("in_progress");
    expect(checkout.run.status).toBe("queued");
    expect(() =>
      service.checkoutIssue({
        issueId: issue.id,
        workspaceId: workspace.id,
      }),
    ).toThrow(/already checked out/i);

    const task = taskRepo.create({
      title: "Execute issue",
      prompt: "Complete the control-plane implementation.",
      status: "planning",
      workspaceId: workspace.id,
      source: "manual",
    });

    const attached = service.attachTaskToRun(checkout.run.id, task.id);
    expect(attached.task.issueId).toBe(issue.id);
    expect(attached.task.heartbeatRunId).toBe(checkout.run.id);
    expect(attached.run.status).toBe("running");

    taskRepo.update(task.id, {
      status: "completed",
      terminalStatus: "ok",
      resultSummary: "Completed successfully",
    });
    service.syncTaskLifecycle(task.id, {
      status: "completed",
      resultSummary: "Completed successfully",
    });

    const completedIssue = service.getIssue(issue.id);
    const completedRun = service.getRun(checkout.run.id);
    const runEvents = service.getRunEvents(checkout.run.id);

    expect(completedIssue?.status).toBe("done");
    expect(completedIssue?.activeRunId).toBeUndefined();
    expect(completedRun?.status).toBe("completed");
    expect(completedRun?.summary).toBe("Completed successfully");
    expect(runEvents.some((event) => event.type === "run.task_attached")).toBe(true);
    expect(runEvents.some((event) => event.type === "task.completed")).toBe(true);
  });

  it("rolls up project and agent cost usage and auto-pauses agents over budget", () => {
    const workspace = insertWorkspace();
    const company = service.getDefaultCompany();
    const agent = agentRoleRepo.create({
      name: "ops",
      displayName: "Ops",
      description: "Operator agent",
      capabilities: ["ops"],
      heartbeatEnabled: true,
      monthlyBudgetCost: 0.1,
    });
    const project = service.createProject({
      companyId: company.id,
      name: "Budget Guardrails",
      description: "Cost-based auto-pause coverage.",
    });
    const issue = service.createIssue({
      companyId: company.id,
      projectId: project.id,
      workspaceId: workspace.id,
      assigneeAgentRoleId: agent.id,
      title: "Pause heartbeat agent after budget breach",
    });
    const checkout = service.checkoutIssue({
      issueId: issue.id,
      agentRoleId: agent.id,
      workspaceId: workspace.id,
    });
    const task = taskRepo.create({
      title: "Track spend",
      prompt: "Measure the current run cost.",
      status: "executing",
      workspaceId: workspace.id,
      source: "manual",
      assignedAgentRoleId: agent.id,
    });

    service.attachTaskToRun(checkout.run.id, task.id);
    insertUsageEvent(task.id, {
      delta: {
        cost: 0.25,
        inputTokens: 120,
        outputTokens: 80,
      },
    });

    const projectCost = service.summarizeCostsByProject(project.id);
    const agentCost = service.summarizeCostsByAgent(agent.id);
    const paused = service.enforceAgentBudgets([agent.id]);
    const updatedAgent = agentRoleRepo.findById(agent.id);

    expect(projectCost.totalCost).toBeCloseTo(0.25, 5);
    expect(projectCost.totalTokens).toBe(200);
    expect(projectCost.taskCount).toBe(1);

    expect(agentCost.totalCost).toBeCloseTo(0.25, 5);
    expect(agentCost.totalTokens).toBe(200);
    expect(agentCost.taskCount).toBe(1);

    expect(paused).toHaveLength(1);
    expect(updatedAgent?.heartbeatEnabled).toBe(false);
    expect(updatedAgent?.autoPausedAt).toBeTypeOf("number");
  });
});
