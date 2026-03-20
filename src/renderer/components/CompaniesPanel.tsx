import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Building2,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  Plus,
  RefreshCw,
  Save,
  Target,
  Workflow,
  X,
} from "lucide-react";
import { resolveTwinIcon } from "../utils/twin-icons";
import type { AgentRoleData } from "../../electron/preload";
import type {
  Company,
  CompanyCreateInput,
  Goal,
  GoalCreateInput,
  Issue,
  IssueCreateInput,
  Project,
  ProjectCreateInput,
  StrategicPlannerConfig,
  StrategicPlannerRun,
} from "../../shared/types";

interface CompaniesPanelProps {
  onOpenMissionControl?: (companyId: string) => void;
  onOpenDigitalTwins?: (companyId: string) => void;
}

interface CompanyFormState {
  name: string;
  slug: string;
  description: string;
  status: Company["status"];
  isDefault: boolean;
  monthlyBudgetCost: string;
  budgetPaused: boolean;
}

interface GoalFormState {
  title: string;
  description: string;
  status: Goal["status"];
  targetDate: string;
}

interface ProjectFormState {
  name: string;
  description: string;
  status: Project["status"];
  goalId: string;
  monthlyBudgetCost: string;
}

interface IssueFormState {
  title: string;
  description: string;
  status: Issue["status"];
  goalId: string;
  projectId: string;
  priority: string;
}

function toCurrencyText(value?: number): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function parseOptionalNumber(value: string): number | undefined {
  const normalized = value.trim();
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toDateInputValue(timestamp?: number): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function parseDateInputValue(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.getTime();
}

function formatTimestamp(timestamp?: number): string {
  if (!timestamp) return "Not set";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return date.toLocaleString();
}

function formatRelativeRun(run?: StrategicPlannerRun): string {
  if (!run) return "No planner runs yet";
  const when = new Date(run.createdAt);
  return `${run.status.replace(/_/g, " ")} at ${when.toLocaleString()}`;
}

function companyStatusBadgeClass(status: Company["status"]): string {
  switch (status) {
    case "active":
      return "settings-badge settings-badge--success";
    case "inactive":
      return "settings-badge settings-badge--warning";
    case "suspended":
      return "settings-badge settings-badge--warning";
    default:
      return "settings-badge settings-badge--neutral";
  }
}

function itemStatusBadgeClass(status: string): string {
  if (status === "active" || status === "ready" || status === "completed") {
    return "settings-badge settings-badge--success";
  }
  if (status === "paused" || status === "blocked" || status === "planned" || status === "in_progress") {
    return "settings-badge settings-badge--warning";
  }
  return "settings-badge settings-badge--neutral";
}

function buildCompanyForm(company?: Company | null): CompanyFormState {
  return {
    name: company?.name ?? "",
    slug: company?.slug ?? "",
    description: company?.description ?? "",
    status: company?.status ?? "active",
    isDefault: company?.isDefault ?? false,
    monthlyBudgetCost: toCurrencyText(company?.monthlyBudgetCost),
    budgetPaused: Boolean(company?.budgetPausedAt),
  };
}

function buildGoalForm(goal?: Goal | null): GoalFormState {
  return {
    title: goal?.title ?? "",
    description: goal?.description ?? "",
    status: goal?.status ?? "active",
    targetDate: toDateInputValue(goal?.targetDate),
  };
}

function buildProjectForm(project?: Project | null): ProjectFormState {
  return {
    name: project?.name ?? "",
    description: project?.description ?? "",
    status: project?.status ?? "active",
    goalId: project?.goalId ?? "",
    monthlyBudgetCost: toCurrencyText(project?.monthlyBudgetCost),
  };
}

function buildIssueForm(issue?: Issue | null): IssueFormState {
  return {
    title: issue?.title ?? "",
    description: issue?.description ?? "",
    status: issue?.status ?? "backlog",
    goalId: issue?.goalId ?? "",
    projectId: issue?.projectId ?? "",
    priority: String(issue?.priority ?? 1),
  };
}

type EntityTab = "goals" | "projects" | "issues";

export function CompaniesPanel({
  onOpenMissionControl,
  onOpenDigitalTwins,
}: CompaniesPanelProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [plannerConfig, setPlannerConfig] = useState<StrategicPlannerConfig | null>(null);
  const [plannerRuns, setPlannerRuns] = useState<StrategicPlannerRun[]>([]);
  const [roles, setRoles] = useState<AgentRoleData[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [editingGoalId, setEditingGoalId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingIssueId, setEditingIssueId] = useState<string | null>(null);
  const [companyForm, setCompanyForm] = useState<CompanyFormState>(buildCompanyForm());
  const [newCompanyForm, setNewCompanyForm] = useState<CompanyFormState>(buildCompanyForm());
  const [goalForm, setGoalForm] = useState<GoalFormState>(buildGoalForm());
  const [projectForm, setProjectForm] = useState<ProjectFormState>(buildProjectForm());
  const [issueForm, setIssueForm] = useState<IssueFormState>(buildIssueForm());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [companySaving, setCompanySaving] = useState(false);
  const [goalSaving, setGoalSaving] = useState(false);
  const [projectSaving, setProjectSaving] = useState(false);
  const [issueSaving, setIssueSaving] = useState(false);
  const [creatingCompany, setCreatingCompany] = useState(false);
  const [assigningRoleId, setAssigningRoleId] = useState<string>("");
  const [roleSaving, setRoleSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [entityTab, setEntityTab] = useState<EntityTab>("goals");

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId],
  );
  const editingGoal = useMemo(
    () => goals.find((goal) => goal.id === editingGoalId) ?? null,
    [goals, editingGoalId],
  );
  const editingProject = useMemo(
    () => projects.find((project) => project.id === editingProjectId) ?? null,
    [projects, editingProjectId],
  );
  const editingIssue = useMemo(
    () => issues.find((issue) => issue.id === editingIssueId) ?? null,
    [issues, editingIssueId],
  );
  const companyRoles = useMemo(
    () => roles.filter((role) => role.companyId === selectedCompanyId),
    [roles, selectedCompanyId],
  );
  const availableRoles = useMemo(
    () => roles.filter((role) => role.companyId !== selectedCompanyId),
    [roles, selectedCompanyId],
  );

  const loadCompanies = useCallback(async (preferredCompanyId?: string | null) => {
    const loaded = await window.electronAPI.listCompanies();
    setCompanies(loaded);
    setSelectedCompanyId((previous) => {
      const nextId = preferredCompanyId ?? previous;
      if (nextId && loaded.some((company) => company.id === nextId)) {
        return nextId;
      }
      return loaded[0]?.id ?? null;
    });
    return loaded;
  }, []);

  const loadRoles = useCallback(async () => {
    const loaded = await window.electronAPI.getAgentRoles(true);
    setRoles(loaded);
    return loaded;
  }, []);

  const loadCompanyGraph = useCallback(async (companyId: string) => {
    const [loadedGoals, loadedProjects, loadedIssues, loadedPlannerConfig, loadedPlannerRuns] =
      await Promise.all([
        window.electronAPI.listCompanyGoals(companyId),
        window.electronAPI.listCompanyProjects(companyId),
        window.electronAPI.listCompanyIssues(companyId, 100),
        window.electronAPI.getPlannerConfig(companyId).catch(() => null),
        window.electronAPI.listPlannerRuns(companyId, 6).catch(() => []),
      ]);
    setGoals(loadedGoals);
    setProjects(loadedProjects);
    setIssues(loadedIssues);
    setPlannerConfig(loadedPlannerConfig);
    setPlannerRuns(loadedPlannerRuns);
  }, []);

  const refreshAll = useCallback(
    async (preferredCompanyId?: string | null) => {
      const companyId = preferredCompanyId ?? selectedCompanyId;
      setRefreshing(true);
      try {
        const loadedCompanies = await loadCompanies(companyId);
        await loadRoles();
        const resolvedCompanyId =
          companyId && loadedCompanies.some((company) => company.id === companyId)
            ? companyId
            : loadedCompanies[0]?.id ?? null;
        if (resolvedCompanyId) {
          await loadCompanyGraph(resolvedCompanyId);
        } else {
          setGoals([]);
          setProjects([]);
          setIssues([]);
          setPlannerConfig(null);
          setPlannerRuns([]);
        }
        setError(null);
      } catch (err) {
        console.error("Failed to refresh companies panel:", err);
        setError("Failed to load company data");
      } finally {
        setRefreshing(false);
        setLoading(false);
      }
    },
    [loadCompanies, loadCompanyGraph, loadRoles, selectedCompanyId],
  );

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    setCompanyForm(buildCompanyForm(selectedCompany));
  }, [selectedCompany]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    void loadCompanyGraph(selectedCompanyId).catch((err) => {
      console.error("Failed to load company graph:", err);
      setError("Failed to load company graph");
    });
  }, [loadCompanyGraph, selectedCompanyId]);

  useEffect(() => {
    if (editingGoalId && goals.some((goal) => goal.id === editingGoalId)) {
      setGoalForm(buildGoalForm(goals.find((goal) => goal.id === editingGoalId) ?? null));
      return;
    }
    setEditingGoalId(null);
    setGoalForm(buildGoalForm());
  }, [editingGoalId, goals]);

  useEffect(() => {
    if (editingProjectId && projects.some((project) => project.id === editingProjectId)) {
      setProjectForm(buildProjectForm(projects.find((project) => project.id === editingProjectId) ?? null));
      return;
    }
    setEditingProjectId(null);
    setProjectForm(buildProjectForm());
  }, [editingProjectId, projects]);

  useEffect(() => {
    if (editingIssueId && issues.some((issue) => issue.id === editingIssueId)) {
      setIssueForm(buildIssueForm(issues.find((issue) => issue.id === editingIssueId) ?? null));
      return;
    }
    setEditingIssueId(null);
    setIssueForm(buildIssueForm());
  }, [editingIssueId, issues]);

  const goalCount = goals.length;
  const projectCount = projects.length;
  const issueCount = issues.length;
  const openIssueCount = issues.filter((issue) => !["completed", "cancelled"].includes(issue.status)).length;
  const activeProjectCount = projects.filter((project) => project.status === "active").length;
  const activeGoalCount = goals.filter((goal) => goal.status === "active").length;
  const activeOperatorCount = companyRoles.filter((role) => role.isActive).length;

  const handleCreateCompany = async () => {
    const name = newCompanyForm.name.trim();
    if (!name) {
      setError("Company name is required");
      return;
    }

    const payload: CompanyCreateInput = {
      name,
      slug: newCompanyForm.slug.trim() || undefined,
      description: newCompanyForm.description.trim() || undefined,
      status: newCompanyForm.status,
      isDefault: newCompanyForm.isDefault,
      monthlyBudgetCost: parseOptionalNumber(newCompanyForm.monthlyBudgetCost) ?? null,
      budgetPausedAt: newCompanyForm.budgetPaused ? Date.now() : null,
    };

    try {
      setCreatingCompany(true);
      const created = await window.electronAPI.createCompany(payload);
      setSuccessMessage(`Created ${created.name}`);
      setNewCompanyForm(buildCompanyForm());
      setShowCreateForm(false);
      await refreshAll(created.id);
    } catch (err) {
      console.error("Failed to create company:", err);
      setError("Failed to create company");
    } finally {
      setCreatingCompany(false);
    }
  };

  const handleSaveCompany = async () => {
    if (!selectedCompany) return;
    const name = companyForm.name.trim();
    if (!name) {
      setError("Company name is required");
      return;
    }

    try {
      setCompanySaving(true);
      const updated = await window.electronAPI.updateCompany({
        companyId: selectedCompany.id,
        name,
        slug: companyForm.slug.trim() || undefined,
        description: companyForm.description.trim() || "",
        status: companyForm.status,
        isDefault: companyForm.isDefault,
        monthlyBudgetCost: parseOptionalNumber(companyForm.monthlyBudgetCost) ?? null,
        budgetPausedAt: companyForm.budgetPaused ? selectedCompany.budgetPausedAt ?? Date.now() : null,
      });
      if (updated) {
        setSuccessMessage(`Saved ${updated.name}`);
      }
      await refreshAll(selectedCompany.id);
    } catch (err) {
      console.error("Failed to save company:", err);
      setError("Failed to save company");
    } finally {
      setCompanySaving(false);
    }
  };

  const handleSaveGoal = async () => {
    if (!selectedCompanyId) return;
    const title = goalForm.title.trim();
    if (!title) {
      setError("Goal title is required");
      return;
    }

    try {
      setGoalSaving(true);
      if (editingGoal) {
        await window.electronAPI.updateGoal({
          goalId: editingGoal.id,
          title,
          description: goalForm.description.trim() || "",
          status: goalForm.status,
          targetDate: goalForm.targetDate ? parseDateInputValue(goalForm.targetDate) ?? null : null,
        });
        setSuccessMessage("Goal updated");
      } else {
        const payload: GoalCreateInput = {
          companyId: selectedCompanyId,
          title,
          description: goalForm.description.trim() || undefined,
          status: goalForm.status,
          targetDate: parseDateInputValue(goalForm.targetDate),
        };
        const created = await window.electronAPI.createGoal(payload);
        setEditingGoalId(created.id);
        setSuccessMessage("Goal created");
      }
      await loadCompanyGraph(selectedCompanyId);
    } catch (err) {
      console.error("Failed to save goal:", err);
      setError("Failed to save goal");
    } finally {
      setGoalSaving(false);
    }
  };

  const handleSaveProject = async () => {
    if (!selectedCompanyId) return;
    const name = projectForm.name.trim();
    if (!name) {
      setError("Project name is required");
      return;
    }

    try {
      setProjectSaving(true);
      if (editingProject) {
        await window.electronAPI.updateProject({
          projectId: editingProject.id,
          name,
          description: projectForm.description.trim() || "",
          status: projectForm.status,
          goalId: projectForm.goalId || null,
          monthlyBudgetCost: parseOptionalNumber(projectForm.monthlyBudgetCost) ?? null,
        });
        setSuccessMessage("Project updated");
      } else {
        const payload: ProjectCreateInput = {
          companyId: selectedCompanyId,
          goalId: projectForm.goalId || undefined,
          name,
          description: projectForm.description.trim() || undefined,
          status: projectForm.status,
          monthlyBudgetCost: parseOptionalNumber(projectForm.monthlyBudgetCost) ?? null,
        };
        const created = await window.electronAPI.createProject(payload);
        setEditingProjectId(created.id);
        setSuccessMessage("Project created");
      }
      await loadCompanyGraph(selectedCompanyId);
    } catch (err) {
      console.error("Failed to save project:", err);
      setError("Failed to save project");
    } finally {
      setProjectSaving(false);
    }
  };

  const handleSaveIssue = async () => {
    if (!selectedCompanyId) return;
    const title = issueForm.title.trim();
    if (!title) {
      setError("Issue title is required");
      return;
    }

    const parsedPriority = parseOptionalNumber(issueForm.priority);
    if (parsedPriority === undefined) {
      setError("Issue priority must be a number");
      return;
    }

    try {
      setIssueSaving(true);
      if (editingIssue) {
        await window.electronAPI.updateIssue({
          issueId: editingIssue.id,
          title,
          description: issueForm.description.trim() || "",
          status: issueForm.status,
          goalId: issueForm.goalId || null,
          projectId: issueForm.projectId || null,
          priority: parsedPriority,
        });
        setSuccessMessage("Issue updated");
      } else {
        const payload: IssueCreateInput = {
          companyId: selectedCompanyId,
          goalId: issueForm.goalId || undefined,
          projectId: issueForm.projectId || undefined,
          title,
          description: issueForm.description.trim() || undefined,
          status: issueForm.status,
          priority: parsedPriority,
        };
        const created = await window.electronAPI.createIssue(payload);
        setEditingIssueId(created.id);
        setSuccessMessage("Issue created");
      }
      await loadCompanyGraph(selectedCompanyId);
    } catch (err) {
      console.error("Failed to save issue:", err);
      setError("Failed to save issue");
    } finally {
      setIssueSaving(false);
    }
  };

  const handleAssignRole = async (roleId: string, companyId: string | null) => {
    if (!roleId) return;
    try {
      setRoleSaving(true);
      const updated = await window.electronAPI.updateAgentRole({
        id: roleId,
        companyId,
      });
      if (updated) {
        setSuccessMessage(companyId ? "Operator assigned to company" : "Operator unassigned from company");
      }
      setAssigningRoleId("");
      await loadRoles();
    } catch (err) {
      console.error("Failed to update company operator assignment:", err);
      setError("Failed to update company operator assignment");
    } finally {
      setRoleSaving(false);
    }
  };

  if (loading) {
    return <div className="settings-empty">Loading companies...</div>;
  }

  const renderGoalsTab = () => (
    <div className="co-entity-pane">
      <div className="co-entity-list">
        <div className="co-entity-list-header">
          <span>{goalCount} goal{goalCount !== 1 ? "s" : ""}</span>
          <button
            type="button"
            className="co-icon-button"
            onClick={() => {
              setEditingGoalId(null);
              setGoalForm(buildGoalForm());
            }}
            title="New goal"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="co-entity-items">
          {goals.map((goal) => (
            <button
              key={goal.id}
              type="button"
              className={`co-entity-item ${editingGoalId === goal.id ? "is-selected" : ""}`}
              onClick={() => setEditingGoalId(goal.id)}
            >
              <span className="co-entity-item-name">{goal.title}</span>
              <span className={itemStatusBadgeClass(goal.status)}>{goal.status}</span>
            </button>
          ))}
          {goals.length === 0 && <div className="settings-empty">No goals yet</div>}
        </div>
      </div>
      <div className="co-entity-form">
        <h4>{editingGoal ? "Edit goal" : "New goal"}</h4>
        <div className="co-form-grid">
          <label className="co-field co-field--full">
            <span>Title</span>
            <input
              type="text"
              value={goalForm.title}
              onChange={(e) => setGoalForm((p) => ({ ...p, title: e.target.value }))}
              placeholder="What outcome are you targeting?"
            />
          </label>
          <label className="co-field co-field--full">
            <span>Description</span>
            <textarea
              rows={2}
              value={goalForm.description}
              onChange={(e) => setGoalForm((p) => ({ ...p, description: e.target.value }))}
            />
          </label>
          <label className="co-field">
            <span>Status</span>
            <select
              value={goalForm.status}
              onChange={(e) => setGoalForm((p) => ({ ...p, status: e.target.value as Goal["status"] }))}
            >
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="co-field">
            <span>Target date</span>
            <input
              type="date"
              value={goalForm.targetDate}
              onChange={(e) => setGoalForm((p) => ({ ...p, targetDate: e.target.value }))}
            />
          </label>
        </div>
        <button
          type="button"
          className="provider-save-button"
          onClick={handleSaveGoal}
          disabled={goalSaving}
        >
          <Save size={14} />
          {editingGoal ? "Save goal" : "Create goal"}
        </button>
      </div>
    </div>
  );

  const renderProjectsTab = () => (
    <div className="co-entity-pane">
      <div className="co-entity-list">
        <div className="co-entity-list-header">
          <span>{projectCount} project{projectCount !== 1 ? "s" : ""}</span>
          <button
            type="button"
            className="co-icon-button"
            onClick={() => {
              setEditingProjectId(null);
              setProjectForm(buildProjectForm());
            }}
            title="New project"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="co-entity-items">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={`co-entity-item ${editingProjectId === project.id ? "is-selected" : ""}`}
              onClick={() => setEditingProjectId(project.id)}
            >
              <span className="co-entity-item-name">{project.name}</span>
              <span className={itemStatusBadgeClass(project.status)}>{project.status}</span>
            </button>
          ))}
          {projects.length === 0 && <div className="settings-empty">No projects yet</div>}
        </div>
      </div>
      <div className="co-entity-form">
        <h4>{editingProject ? "Edit project" : "New project"}</h4>
        <div className="co-form-grid">
          <label className="co-field co-field--full">
            <span>Name</span>
            <input
              type="text"
              value={projectForm.name}
              onChange={(e) => setProjectForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="Project name"
            />
          </label>
          <label className="co-field co-field--full">
            <span>Description</span>
            <textarea
              rows={2}
              value={projectForm.description}
              onChange={(e) => setProjectForm((p) => ({ ...p, description: e.target.value }))}
            />
          </label>
          <label className="co-field">
            <span>Status</span>
            <select
              value={projectForm.status}
              onChange={(e) => setProjectForm((p) => ({ ...p, status: e.target.value as Project["status"] }))}
            >
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="completed">Completed</option>
              <option value="archived">Archived</option>
            </select>
          </label>
          <label className="co-field">
            <span>Goal</span>
            <select
              value={projectForm.goalId}
              onChange={(e) => setProjectForm((p) => ({ ...p, goalId: e.target.value }))}
            >
              <option value="">No goal</option>
              {goals.map((goal) => (
                <option key={goal.id} value={goal.id}>{goal.title}</option>
              ))}
            </select>
          </label>
          <label className="co-field co-field--full">
            <span>Monthly budget</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={projectForm.monthlyBudgetCost}
              onChange={(e) => setProjectForm((p) => ({ ...p, monthlyBudgetCost: e.target.value }))}
            />
          </label>
        </div>
        <button
          type="button"
          className="provider-save-button"
          onClick={handleSaveProject}
          disabled={projectSaving}
        >
          <Save size={14} />
          {editingProject ? "Save project" : "Create project"}
        </button>
      </div>
    </div>
  );

  const renderIssuesTab = () => (
    <div className="co-entity-pane">
      <div className="co-entity-list">
        <div className="co-entity-list-header">
          <span>{issueCount} issue{issueCount !== 1 ? "s" : ""}{openIssueCount > 0 ? ` (${openIssueCount} open)` : ""}</span>
          <button
            type="button"
            className="co-icon-button"
            onClick={() => {
              setEditingIssueId(null);
              setIssueForm(buildIssueForm());
            }}
            title="New issue"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="co-entity-items">
          {issues.map((issue) => (
            <button
              key={issue.id}
              type="button"
              className={`co-entity-item ${editingIssueId === issue.id ? "is-selected" : ""}`}
              onClick={() => setEditingIssueId(issue.id)}
            >
              <span className="co-entity-item-name">{issue.title}</span>
              <span className={itemStatusBadgeClass(issue.status)}>{issue.status}</span>
            </button>
          ))}
          {issues.length === 0 && <div className="settings-empty">No issues yet</div>}
        </div>
      </div>
      <div className="co-entity-form">
        <h4>{editingIssue ? "Edit issue" : "New issue"}</h4>
        <div className="co-form-grid">
          <label className="co-field co-field--full">
            <span>Title</span>
            <input
              type="text"
              value={issueForm.title}
              onChange={(e) => setIssueForm((p) => ({ ...p, title: e.target.value }))}
              placeholder="Issue title"
            />
          </label>
          <label className="co-field co-field--full">
            <span>Description</span>
            <textarea
              rows={2}
              value={issueForm.description}
              onChange={(e) => setIssueForm((p) => ({ ...p, description: e.target.value }))}
            />
          </label>
          <label className="co-field">
            <span>Status</span>
            <select
              value={issueForm.status}
              onChange={(e) => setIssueForm((p) => ({ ...p, status: e.target.value as Issue["status"] }))}
            >
              <option value="backlog">Backlog</option>
              <option value="planned">Planned</option>
              <option value="ready">Ready</option>
              <option value="in_progress">In progress</option>
              <option value="blocked">Blocked</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label className="co-field">
            <span>Priority</span>
            <input
              type="number"
              min="0"
              step="1"
              value={issueForm.priority}
              onChange={(e) => setIssueForm((p) => ({ ...p, priority: e.target.value }))}
            />
          </label>
          <label className="co-field">
            <span>Goal</span>
            <select
              value={issueForm.goalId}
              onChange={(e) => setIssueForm((p) => ({ ...p, goalId: e.target.value }))}
            >
              <option value="">No goal</option>
              {goals.map((goal) => (
                <option key={goal.id} value={goal.id}>{goal.title}</option>
              ))}
            </select>
          </label>
          <label className="co-field">
            <span>Project</span>
            <select
              value={issueForm.projectId}
              onChange={(e) => setIssueForm((p) => ({ ...p, projectId: e.target.value }))}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
        </div>
        <button
          type="button"
          className="provider-save-button"
          onClick={handleSaveIssue}
          disabled={issueSaving}
        >
          <Save size={14} />
          {editingIssue ? "Save issue" : "Create issue"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="companies-panel settings-page">
      {/* ── Page header ─────────────────────────────────── */}
      <section className="co-page-header">
        <div>
          <h2>Companies</h2>
          <p className="settings-description">
            Create companies, scaffold their operating graph, and hand them off to Mission Control or Digital Twins.
          </p>
        </div>
        <button
          type="button"
          className="provider-test-button"
          onClick={() => void refreshAll(selectedCompanyId)}
          disabled={refreshing}
        >
          <RefreshCw size={14} className={refreshing ? "spin" : ""} />
          Refresh
        </button>
      </section>

      {error && (
        <div className="settings-alert settings-alert-error">
          <span>{error}</span>
          <button type="button" className="co-icon-button" onClick={() => setError(null)}>
            <X size={14} />
          </button>
        </div>
      )}
      {successMessage && <div className="settings-save-indicator">{successMessage}</div>}

      {/* ── Two-column layout ───────────────────────────── */}
      <div className="co-layout">
        {/* ── Sidebar ─────────────────────────────────── */}
        <aside className="co-sidebar">
          <div className="co-sidebar-section">
            <div className="co-sidebar-heading">
              <span>Companies</span>
              <span className="settings-badge settings-badge--neutral">{companies.length}</span>
            </div>

            {companies.length === 0 ? (
              <div className="settings-empty" style={{ fontSize: 13 }}>
                No companies yet
              </div>
            ) : (
              <div className="co-company-list">
                {companies.map((company) => (
                  <button
                    key={company.id}
                    type="button"
                    className={`co-company-item ${company.id === selectedCompanyId ? "is-selected" : ""}`}
                    onClick={() => setSelectedCompanyId(company.id)}
                  >
                    <div className="co-company-item-row">
                      <strong>{company.name}</strong>
                      <span className={companyStatusBadgeClass(company.status)}>{company.status}</span>
                    </div>
                    {(company.isDefault || company.slug) && (
                      <div className="co-company-item-meta">
                        {company.slug && <span>{company.slug}</span>}
                        {company.isDefault && (
                          <span className="settings-badge settings-badge--outline">Default</span>
                        )}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Collapsible create form ──────────────── */}
          <button
            type="button"
            className="co-create-toggle"
            onClick={() => setShowCreateForm(!showCreateForm)}
          >
            {showCreateForm ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Plus size={14} />
            New company
          </button>

          {showCreateForm && (
            <div className="co-create-form">
              <div className="co-form-grid">
                <label className="co-field">
                  <span>Name</span>
                  <input
                    type="text"
                    value={newCompanyForm.name}
                    onChange={(e) => setNewCompanyForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="Acme Ventures"
                  />
                </label>
                <label className="co-field">
                  <span>Slug</span>
                  <input
                    type="text"
                    value={newCompanyForm.slug}
                    onChange={(e) => setNewCompanyForm((p) => ({ ...p, slug: e.target.value }))}
                    placeholder="acme-ventures"
                  />
                </label>
                <label className="co-field co-field--full">
                  <span>Description</span>
                  <textarea
                    value={newCompanyForm.description}
                    onChange={(e) => setNewCompanyForm((p) => ({ ...p, description: e.target.value }))}
                    rows={2}
                    placeholder="What this company exists to do"
                  />
                </label>
                <label className="co-field">
                  <span>Status</span>
                  <select
                    value={newCompanyForm.status}
                    onChange={(e) =>
                      setNewCompanyForm((p) => ({ ...p, status: e.target.value as Company["status"] }))
                    }
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </label>
                <label className="co-field">
                  <span>Budget</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={newCompanyForm.monthlyBudgetCost}
                    onChange={(e) =>
                      setNewCompanyForm((p) => ({ ...p, monthlyBudgetCost: e.target.value }))
                    }
                    placeholder="0"
                  />
                </label>
                <label className="co-checkbox co-field--full">
                  <input
                    type="checkbox"
                    checked={newCompanyForm.isDefault}
                    onChange={(e) =>
                      setNewCompanyForm((p) => ({ ...p, isDefault: e.target.checked }))
                    }
                  />
                  <span>Make this the default company</span>
                </label>
              </div>
              <button
                type="button"
                className="provider-save-button co-create-btn"
                onClick={handleCreateCompany}
                disabled={creatingCompany}
              >
                <Plus size={14} />
                Create company
              </button>
            </div>
          )}
        </aside>

        {/* ── Main content ────────────────────────────── */}
        <main className="co-main">
          {!selectedCompany ? (
            <div className="settings-empty">Select or create a company to manage its operating graph.</div>
          ) : (
            <>
              {/* ── Stat bar ───────────────────────────── */}
              <div className="co-stat-bar">
                <div className="co-stat">
                  <Target size={15} />
                  <strong>{activeGoalCount}</strong>
                  <span>Goals</span>
                </div>
                <div className="co-stat">
                  <FolderKanban size={15} />
                  <strong>{activeProjectCount}</strong>
                  <span>Projects</span>
                </div>
                <div className="co-stat">
                  <Workflow size={15} />
                  <strong>{openIssueCount}</strong>
                  <span>Open issues</span>
                </div>
                <div className="co-stat">
                  <Building2 size={15} />
                  <strong>{activeOperatorCount}</strong>
                  <span>Operators</span>
                </div>
                <div className="co-stat">
                  <Workflow size={15} />
                  <strong>{plannerConfig?.enabled ? "On" : "Off"}</strong>
                  <span>Planner</span>
                </div>
                {plannerRuns[0] && (
                  <div className="co-stat co-stat--wide">
                    <span className="co-stat-run">{formatRelativeRun(plannerRuns[0])}</span>
                  </div>
                )}
              </div>

              {/* ── Company detail card ─────────────────── */}
              <section className="settings-card co-detail-card">
                <div className="co-detail-header">
                  <div className="co-detail-title">
                    <h3>{selectedCompany.name}</h3>
                    <span className={companyStatusBadgeClass(selectedCompany.status)}>
                      {selectedCompany.status}
                    </span>
                    {selectedCompany.isDefault && (
                      <span className="settings-badge settings-badge--outline">Default</span>
                    )}
                  </div>
                  <div className="co-detail-actions">
                    <button
                      type="button"
                      className="provider-test-button"
                      onClick={() => onOpenMissionControl?.(selectedCompany.id)}
                    >
                      Mission Control <ArrowRight size={13} />
                    </button>
                    <button
                      type="button"
                      className="provider-test-button"
                      onClick={() => onOpenDigitalTwins?.(selectedCompany.id)}
                    >
                      Digital Twins <ArrowRight size={13} />
                    </button>
                  </div>
                </div>

                <div className="co-detail-grid">
                  <label className="co-field">
                    <span>Name</span>
                    <input
                      type="text"
                      value={companyForm.name}
                      onChange={(e) => setCompanyForm((p) => ({ ...p, name: e.target.value }))}
                    />
                  </label>
                  <label className="co-field">
                    <span>Slug</span>
                    <input
                      type="text"
                      value={companyForm.slug}
                      onChange={(e) => setCompanyForm((p) => ({ ...p, slug: e.target.value }))}
                    />
                  </label>
                  <label className="co-field co-field--full">
                    <span>Description</span>
                    <textarea
                      rows={2}
                      value={companyForm.description}
                      onChange={(e) => setCompanyForm((p) => ({ ...p, description: e.target.value }))}
                    />
                  </label>
                  <label className="co-field">
                    <span>Status</span>
                    <select
                      value={companyForm.status}
                      onChange={(e) =>
                        setCompanyForm((p) => ({ ...p, status: e.target.value as Company["status"] }))
                      }
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                      <option value="suspended">Suspended</option>
                    </select>
                  </label>
                  <label className="co-field">
                    <span>Monthly budget</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={companyForm.monthlyBudgetCost}
                      onChange={(e) =>
                        setCompanyForm((p) => ({ ...p, monthlyBudgetCost: e.target.value }))
                      }
                    />
                  </label>
                  <label className="co-checkbox">
                    <input
                      type="checkbox"
                      checked={companyForm.isDefault}
                      onChange={(e) =>
                        setCompanyForm((p) => ({ ...p, isDefault: e.target.checked }))
                      }
                    />
                    <span>Default company</span>
                  </label>
                  <label className="co-checkbox">
                    <input
                      type="checkbox"
                      checked={companyForm.budgetPaused}
                      onChange={(e) =>
                        setCompanyForm((p) => ({ ...p, budgetPaused: e.target.checked }))
                      }
                    />
                    <span>Budget paused</span>
                  </label>
                </div>

                <div className="co-detail-footer">
                  <div className="co-meta-strip">
                    <span>Created {formatTimestamp(selectedCompany.createdAt)}</span>
                    <span>Updated {formatTimestamp(selectedCompany.updatedAt)}</span>
                    {selectedCompany.budgetPausedAt && (
                      <span>Paused {formatTimestamp(selectedCompany.budgetPausedAt)}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="provider-save-button"
                    onClick={handleSaveCompany}
                    disabled={companySaving}
                  >
                    <Save size={14} />
                    Save
                  </button>
                </div>
              </section>

              {/* ── Operators ───────────────────────────── */}
              <section className="settings-card co-operators-card">
                <div className="co-section-header">
                  <h3>Operators</h3>
                  <span className="settings-badge settings-badge--outline">
                    {companyRoles.length} linked
                  </span>
                </div>

                <div className="co-operator-assign">
                  <select
                    value={assigningRoleId}
                    onChange={(e) => setAssigningRoleId(e.target.value)}
                    disabled={roleSaving}
                  >
                    <option value="">Assign existing twin...</option>
                    {availableRoles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.displayName || role.name}
                        {role.companyId ? " (reassign)" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="provider-save-button"
                    disabled={!assigningRoleId || roleSaving || !selectedCompanyId}
                    onClick={() => void handleAssignRole(assigningRoleId, selectedCompanyId)}
                  >
                    <Plus size={14} />
                    Link
                  </button>
                </div>

                {companyRoles.length === 0 ? (
                  <div className="settings-empty" style={{ fontSize: 13 }}>
                    No operators linked. Assign a twin or open Digital Twins to create one.
                  </div>
                ) : (
                  <div className="co-operator-list">
                    {companyRoles.map((role) => (
                      <div key={role.id} className="co-operator-row">
                        <div className="co-operator-info">
                          {role.icon && (
                            <span className="co-operator-icon">
                              {(() => {
                                const Icon = resolveTwinIcon(role.icon);
                                return <Icon size={16} strokeWidth={2} />;
                              })()}
                            </span>
                          )}
                          <strong>{role.displayName || role.name}</strong>
                          {role.autonomyLevel && (
                            <span className="settings-badge settings-badge--outline">
                              {role.autonomyLevel}
                            </span>
                          )}
                          {!role.isActive && (
                            <span className="settings-badge settings-badge--neutral">inactive</span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="co-text-button"
                          disabled={roleSaving}
                          onClick={() => void handleAssignRole(role.id, null)}
                        >
                          Unassign
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* ── Entity tabs ─────────────────────────── */}
              <section className="settings-card co-entities-card">
                <div className="co-tab-bar">
                  <button
                    type="button"
                    className={`co-tab ${entityTab === "goals" ? "is-active" : ""}`}
                    onClick={() => setEntityTab("goals")}
                  >
                    <Target size={14} />
                    Goals
                    <span className="co-tab-count">{goalCount}</span>
                  </button>
                  <button
                    type="button"
                    className={`co-tab ${entityTab === "projects" ? "is-active" : ""}`}
                    onClick={() => setEntityTab("projects")}
                  >
                    <FolderKanban size={14} />
                    Projects
                    <span className="co-tab-count">{projectCount}</span>
                  </button>
                  <button
                    type="button"
                    className={`co-tab ${entityTab === "issues" ? "is-active" : ""}`}
                    onClick={() => setEntityTab("issues")}
                  >
                    <Workflow size={14} />
                    Issues
                    <span className="co-tab-count">{issueCount}</span>
                  </button>
                </div>
                {entityTab === "goals" && renderGoalsTab()}
                {entityTab === "projects" && renderProjectsTab()}
                {entityTab === "issues" && renderIssuesTab()}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
