import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Building2,
  FolderGit2,
  GitBranch,
  Link2,
  Network,
  Plus,
  RefreshCw,
  Upload,
  Workflow,
  Wrench,
} from "lucide-react";
import type { AgentRoleData } from "../../electron/preload";
import type {
  Company,
  CompanyCommandCenterSummary,
  CompanyGraphEdge,
  CompanyGraphNode,
  CompanyImportPreview,
  CompanyPackageImportRequest,
  CompanyPackageSource,
  CompanySyncState,
  ResolvedCompanyGraph,
} from "../../shared/types";

interface CompaniesPanelProps {
  onOpenMissionControl?: (companyId: string) => void;
  onOpenDigitalTwins?: (companyId: string) => void;
}

type CompaniesMode = "library" | "org" | "ops";
type ImportTargetMode = "selected" | "new";

interface CompanyDraft {
  name: string;
  slug: string;
  description: string;
}

function emptyDraft(): CompanyDraft {
  return {
    name: "",
    slug: "",
    description: "",
  };
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

function formatWhen(timestamp?: number): string {
  if (!timestamp) return "Never";
  return new Date(timestamp).toLocaleString();
}

function actionBadgeClass(action: string): string {
  if (action === "create") return "settings-badge settings-badge--success";
  if (action === "update" || action === "link") return "settings-badge settings-badge--warning";
  if (action === "conflict" || action === "warning") return "settings-badge settings-badge--warning";
  return "settings-badge settings-badge--neutral";
}

function syncBadgeClass(status: string): string {
  if (status === "in_sync") return "settings-badge settings-badge--success";
  if (status === "diverged" || status === "local_override") return "settings-badge settings-badge--warning";
  return "settings-badge settings-badge--neutral";
}

function nodeIcon(kind: string) {
  switch (kind) {
    case "company":
      return <Building2 size={14} />;
    case "team":
      return <Network size={14} />;
    case "agent":
      return <Workflow size={14} />;
    case "project":
      return <FolderGit2 size={14} />;
    case "task":
      return <Wrench size={14} />;
    case "skill":
      return <GitBranch size={14} />;
    default:
      return <Building2 size={14} />;
  }
}

function sortNodes(nodes: CompanyGraphNode[]): CompanyGraphNode[] {
  const weight = (kind: CompanyGraphNode["kind"]) => {
    switch (kind) {
      case "company":
        return 0;
      case "team":
        return 1;
      case "agent":
        return 2;
      case "project":
        return 3;
      case "task":
        return 4;
      case "skill":
        return 5;
      default:
        return 99;
    }
  };
  return [...nodes].sort((left, right) => weight(left.kind) - weight(right.kind) || left.name.localeCompare(right.name));
}

function buildTree(nodes: CompanyGraphNode[]) {
  const children = new Map<string, CompanyGraphNode[]>();
  const roots: CompanyGraphNode[] = [];

  for (const node of sortNodes(nodes)) {
    if (!node.parentNodeId) {
      roots.push(node);
      continue;
    }
    const bucket = children.get(node.parentNodeId) || [];
    bucket.push(node);
    children.set(node.parentNodeId, bucket);
  }

  return { roots, children };
}

function buildAgentHierarchy(nodes: CompanyGraphNode[], edges: CompanyGraphEdge[]) {
  const agents = nodes.filter((node) => node.kind === "agent");
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const children = new Map<string, CompanyGraphNode[]>();
  const hasManager = new Set<string>();

  for (const edge of edges) {
    if (edge.kind !== "reports_to") continue;
    const child = byId.get(edge.fromNodeId);
    const manager = byId.get(edge.toNodeId);
    if (!child || !manager) continue;
    hasManager.add(child.id);
    const bucket = children.get(manager.id) || [];
    bucket.push(child);
    children.set(manager.id, bucket);
  }

  const roots = agents.filter((agent) => !hasManager.has(agent.id));
  return {
    roots,
    children,
  };
}

function renderAgentChartNode(
  node: CompanyGraphNode,
  children: Map<string, CompanyGraphNode[]>,
  selectedNodeId: string | null,
  setSelectedNodeId: (value: string) => void,
) {
  const directReports = children.get(node.id) || [];
  return (
    <div key={node.id} className="co-org-branch">
      <button
        type="button"
        className={`co-org-card ${selectedNodeId === node.id ? "is-selected" : ""}`}
        onClick={() => setSelectedNodeId(node.id)}
      >
        <span className="co-org-card-kind">{node.kind}</span>
        <strong>{node.name}</strong>
        {node.description && <span>{node.description}</span>}
      </button>
      {directReports.length > 0 && (
        <div className="co-org-branch-children">
          {directReports.map((child) => renderAgentChartNode(child, children, selectedNodeId, setSelectedNodeId))}
        </div>
      )}
    </div>
  );
}

export function CompaniesPanel({
  onOpenMissionControl,
  onOpenDigitalTwins,
}: CompaniesPanelProps) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [roles, setRoles] = useState<AgentRoleData[]>([]);
  const [sources, setSources] = useState<CompanyPackageSource[]>([]);
  const [graph, setGraph] = useState<ResolvedCompanyGraph | null>(null);
  const [syncStates, setSyncStates] = useState<CompanySyncState[]>([]);
  const [summary, setSummary] = useState<CompanyCommandCenterSummary | null>(null);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [mode, setMode] = useState<CompaniesMode>("library");
  const [companyDraft, setCompanyDraft] = useState<CompanyDraft>(emptyDraft());
  const [preview, setPreview] = useState<CompanyImportPreview | null>(null);
  const [previewRequest, setPreviewRequest] = useState<CompanyPackageImportRequest | null>(null);
  const [importTargetMode, setImportTargetMode] = useState<ImportTargetMode>("selected");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [linkingNodeId, setLinkingNodeId] = useState<string | null>(null);
  const [pendingRoleLinks, setPendingRoleLinks] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId],
  );
  const graphNodes = graph?.nodes || [];
  const graphEdges = graph?.edges || [];
  const syncByOrgNode = useMemo(
    () => new Map(syncStates.filter((state) => state.orgNodeId).map((state) => [state.orgNodeId as string, state])),
    [syncStates],
  );
  const selectedNode = useMemo(
    () => graphNodes.find((node) => node.id === selectedNodeId) ?? null,
    [graphNodes, selectedNodeId],
  );
  const relatedEdges = useMemo(
    () =>
      selectedNode
        ? graphEdges.filter((edge) => edge.fromNodeId === selectedNode.id || edge.toNodeId === selectedNode.id)
        : [],
    [graphEdges, selectedNode],
  );
  const tree = useMemo(() => buildTree(graphNodes), [graphNodes]);
  const agentHierarchy = useMemo(() => buildAgentHierarchy(graphNodes, graphEdges), [graphNodes, graphEdges]);
  const projects = useMemo(() => graphNodes.filter((node) => node.kind === "project"), [graphNodes]);
  const tasks = useMemo(() => graphNodes.filter((node) => node.kind === "task"), [graphNodes]);
  const linkedRoleIds = useMemo(
    () => new Set(syncStates.filter((state) => state.runtimeEntityKind === "agent_role").map((state) => state.runtimeEntityId)),
    [syncStates],
  );

  const loadCompanies = useCallback(async (preferredCompanyId?: string | null) => {
    const loaded = await window.electronAPI.listCompanies();
    setCompanies(loaded);
    setSelectedCompanyId((current) => {
      const next = preferredCompanyId ?? current;
      if (next && loaded.some((company) => company.id === next)) return next;
      return loaded[0]?.id || null;
    });
    return loaded;
  }, []);

  const loadRoles = useCallback(async () => {
    const loaded = await window.electronAPI.getAgentRoles(true);
    setRoles(loaded);
    return loaded;
  }, []);

  const loadCompanyData = useCallback(async (companyId: string | null, includeOps = false) => {
    if (!companyId) {
      setSources([]);
      setGraph(null);
      setSyncStates([]);
      if (!includeOps) setSummary(null);
      return;
    }

    const [loadedSources, loadedGraph, loadedSyncStates] = await Promise.all([
      window.electronAPI.listCompanyPackageSources(companyId),
      window.electronAPI.getCompanyGraph(companyId).catch(() => null),
      window.electronAPI.listCompanySyncStates(companyId).catch(() => []),
    ]);

    setSources(loadedSources);
    setGraph(loadedGraph);
    setSyncStates(loadedSyncStates);

    if (includeOps) {
      const loadedSummary = await window.electronAPI.getCommandCenterSummary(companyId).catch(() => null);
      setSummary(loadedSummary);
    }
  }, []);

  const refreshAll = useCallback(
    async (preferredCompanyId?: string | null) => {
      setRefreshing(true);
      setError(null);
      try {
        const loadedCompanies = await loadCompanies(preferredCompanyId);
        await loadRoles();
        const resolvedCompanyId =
          preferredCompanyId && loadedCompanies.some((company) => company.id === preferredCompanyId)
            ? preferredCompanyId
            : loadedCompanies[0]?.id || null;
        await loadCompanyData(resolvedCompanyId, mode === "ops");
      } catch (err) {
        console.error("Failed to refresh companies panel:", err);
        setError("Failed to refresh Companies");
      } finally {
        setRefreshing(false);
        setLoading(false);
      }
    },
    [loadCompanies, loadRoles, loadCompanyData, mode],
  );

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!selectedCompanyId) return;
    void loadCompanyData(selectedCompanyId, mode === "ops");
  }, [selectedCompanyId, mode, loadCompanyData]);

  useEffect(() => {
    if (!graphNodes.length) {
      setSelectedNodeId(null);
      return;
    }
    if (selectedNodeId && graphNodes.some((node) => node.id === selectedNodeId)) {
      return;
    }
    const companyNode = graphNodes.find((node) => node.kind === "company");
    setSelectedNodeId(companyNode?.id || graphNodes[0]?.id || null);
  }, [graphNodes, selectedNodeId]);

  const handleCreateCompany = async () => {
    if (!companyDraft.name.trim()) {
      setError("Company name is required");
      return;
    }

    setCreating(true);
    setError(null);
    try {
      const created = await window.electronAPI.createCompany({
        name: companyDraft.name.trim(),
        slug: companyDraft.slug.trim() || undefined,
        description: companyDraft.description.trim() || undefined,
      });
      setCompanyDraft(emptyDraft());
      setSuccess("Company created");
      await refreshAll(created.id);
    } catch (err) {
      console.error("Failed to create company:", err);
      setError("Failed to create company");
    } finally {
      setCreating(false);
    }
  };

  const handlePreviewImport = async () => {
    const folderPath = await window.electronAPI.selectFolder();
    if (!folderPath) return;

    if (importTargetMode === "selected" && !selectedCompanyId) {
      setError("Select a company or switch import target to Create New Company");
      return;
    }

    const request: CompanyPackageImportRequest = {
      companyId: importTargetMode === "selected" ? selectedCompanyId : null,
      source: {
        sourceKind: "local",
        rootUri: folderPath,
        localPath: folderPath,
      },
    };

    setError(null);
    try {
      const nextPreview = await window.electronAPI.previewCompanyPackageImport(request);
      setPreview(nextPreview);
      setPreviewRequest(request);
      setSuccess("Package preview ready");
    } catch (err) {
      console.error("Failed to preview package import:", err);
      setError(err instanceof Error ? err.message : "Failed to preview package import");
    }
  };

  const handleImportPackage = async () => {
    if (!previewRequest) return;
    setImporting(true);
    setError(null);
    try {
      const result = await window.electronAPI.importCompanyPackage(previewRequest);
      setPreview(null);
      setPreviewRequest(null);
      setSuccess(`Imported ${result.graph.nodes.length} org nodes into ${result.company.name}`);
      setMode("org");
      await refreshAll(result.company.id);
    } catch (err) {
      console.error("Failed to import company package:", err);
      setError(err instanceof Error ? err.message : "Failed to import package");
    } finally {
      setImporting(false);
    }
  };

  const handleLinkRole = async (nodeId: string) => {
    if (!selectedCompanyId) return;
    const roleId = pendingRoleLinks[nodeId] || null;
    setLinkingNodeId(nodeId);
    setError(null);
    try {
      await window.electronAPI.linkCompanyOrgNodeToRole({
        companyId: selectedCompanyId,
        orgNodeId: nodeId,
        agentRoleId: roleId,
      });
      setSuccess(roleId ? "Linked agent node to operator" : "Cleared operator link");
      await loadCompanyData(selectedCompanyId, mode === "ops");
    } catch (err) {
      console.error("Failed to link org node to role:", err);
      setError("Failed to link org node to role");
    } finally {
      setLinkingNodeId(null);
    }
  };

  const activeCompanySummary = summary?.overview;
  const selectedNodeSync = selectedNode ? syncByOrgNode.get(selectedNode.id) : undefined;
  const selectedLinkedRole =
    selectedNodeSync?.runtimeEntityKind === "agent_role"
      ? roles.find((role) => role.id === selectedNodeSync.runtimeEntityId)
      : null;

  if (loading) {
    return <div className="settings-empty">Loading companies…</div>;
  }

  return (
    <div className="companies-v2 settings-page">
      <section className="co-v2-header">
        <div>
          <h2>Companies</h2>
          <p className="settings-description">
            Manage company packages, design the org graph, and hand runtime operations to Mission Control.
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

      {error && <div className="settings-alert settings-alert-error">{error}</div>}
      {success && <div className="settings-save-indicator">{success}</div>}

      <div className="co-v2-layout">
        <aside className="co-v2-sidebar">
          <div className="co-v2-card">
            <div className="co-v2-card-header">
              <h3>Companies</h3>
              <span className="settings-badge settings-badge--outline">{companies.length}</span>
            </div>
            <div className="co-v2-company-list">
              {companies.map((company) => (
                <button
                  key={company.id}
                  type="button"
                  className={`co-v2-company-item ${company.id === selectedCompanyId ? "is-selected" : ""}`}
                  onClick={() => setSelectedCompanyId(company.id)}
                >
                  <div className="co-v2-company-item-row">
                    <strong>{company.name}</strong>
                    <span className={companyStatusBadgeClass(company.status)}>{company.status}</span>
                  </div>
                  <div className="co-v2-company-item-meta">
                    {company.slug && <span>{company.slug}</span>}
                    {company.isDefault && <span className="settings-badge settings-badge--outline">Default</span>}
                  </div>
                </button>
              ))}
              {companies.length === 0 && (
                <div className="settings-empty" style={{ fontSize: 13 }}>
                  No companies yet. Create one or import a package.
                </div>
              )}
            </div>
          </div>

          <div className="co-v2-card">
            <div className="co-v2-card-header">
              <h3>New Company</h3>
            </div>
            <div className="co-v2-form">
              <label className="co-v2-field">
                <span>Name</span>
                <input
                  type="text"
                  value={companyDraft.name}
                  onChange={(event) =>
                    setCompanyDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="Acme Ventures"
                />
              </label>
              <label className="co-v2-field">
                <span>Slug</span>
                <input
                  type="text"
                  value={companyDraft.slug}
                  onChange={(event) =>
                    setCompanyDraft((current) => ({ ...current, slug: event.target.value }))
                  }
                  placeholder="acme-ventures"
                />
              </label>
              <label className="co-v2-field">
                <span>Description</span>
                <textarea
                  rows={3}
                  value={companyDraft.description}
                  onChange={(event) =>
                    setCompanyDraft((current) => ({ ...current, description: event.target.value }))
                  }
                  placeholder="What this company exists to do"
                />
              </label>
              <button
                type="button"
                className="provider-save-button"
                onClick={() => void handleCreateCompany()}
                disabled={creating}
              >
                <Plus size={14} />
                Create company
              </button>
            </div>
          </div>
        </aside>

        <main className="co-v2-main">
          <section className="co-v2-topbar">
            <div className="co-v2-summary-strip">
              <div className="co-v2-summary-card">
                <span>Package sources</span>
                <strong>{sources.length}</strong>
              </div>
              <div className="co-v2-summary-card">
                <span>Org nodes</span>
                <strong>{graphNodes.length}</strong>
              </div>
              <div className="co-v2-summary-card">
                <span>Linked runtime entities</span>
                <strong>{syncStates.length}</strong>
              </div>
              <div className="co-v2-summary-card">
                <span>Operators</span>
                <strong>{selectedCompany ? roles.filter((role) => role.companyId === selectedCompany.id).length : 0}</strong>
              </div>
            </div>
            <div className="co-v2-tabs">
              {([
                { id: "library", label: "Library" },
                { id: "org", label: "Org Builder" },
                { id: "ops", label: "Ops" },
              ] as const).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`co-v2-tab ${mode === tab.id ? "is-active" : ""}`}
                  onClick={() => setMode(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </section>

          {mode === "library" && (
            <div className="co-v2-panel-grid">
              <section className="co-v2-card">
                <div className="co-v2-card-header">
                  <div>
                    <h3>Package Library</h3>
                    <p className="co-v2-subtle">
                      Import local Agent Companies packages into a Cowork company graph.
                    </p>
                  </div>
                  <button type="button" className="provider-save-button" onClick={() => void handlePreviewImport()}>
                    <Upload size={14} />
                    Preview Import
                  </button>
                </div>

                <div className="co-v2-chip-row">
                  <button
                    type="button"
                    className={`co-v2-chip ${importTargetMode === "selected" ? "is-selected" : ""}`}
                    onClick={() => setImportTargetMode("selected")}
                    disabled={!selectedCompanyId}
                  >
                    {selectedCompany ? `Import into ${selectedCompany.name}` : "Import into selected company"}
                  </button>
                  <button
                    type="button"
                    className={`co-v2-chip ${importTargetMode === "new" ? "is-selected" : ""}`}
                    onClick={() => setImportTargetMode("new")}
                  >
                    Create new company
                  </button>
                </div>

                <div className="co-v2-source-list">
                  {sources.length === 0 ? (
                    <div className="settings-empty">No package sources imported yet.</div>
                  ) : (
                    sources.map((source) => (
                      <div key={source.id} className="co-v2-source-item">
                        <div>
                          <strong>{source.name}</strong>
                          <div className="co-v2-source-meta">
                            <span>{source.sourceKind}</span>
                            <span>{source.rootUri}</span>
                            <span>{source.trustLevel}</span>
                          </div>
                        </div>
                        <span className="settings-badge settings-badge--outline">{source.status}</span>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="co-v2-card">
                <div className="co-v2-card-header">
                  <div>
                    <h3>Import Preview</h3>
                    <p className="co-v2-subtle">
                      Desired state is previewed before Cowork runtime entities are seeded.
                    </p>
                  </div>
                  {preview && (
                    <button
                      type="button"
                      className="provider-save-button"
                      onClick={() => void handleImportPackage()}
                      disabled={importing}
                    >
                      <Upload size={14} />
                      Import Package
                    </button>
                  )}
                </div>

                {!preview ? (
                  <div className="settings-empty">
                    Choose a local package folder to preview the company graph, runtime diff, and warnings.
                  </div>
                ) : (
                  <div className="co-v2-preview">
                    <div className="co-v2-preview-summary">
                      <div className="co-v2-summary-card">
                        <span>Manifests</span>
                        <strong>{preview.graph.manifests.length}</strong>
                      </div>
                      <div className="co-v2-summary-card">
                        <span>Nodes</span>
                        <strong>{preview.graph.nodes.length}</strong>
                      </div>
                      <div className="co-v2-summary-card">
                        <span>Edges</span>
                        <strong>{preview.graph.edges.length}</strong>
                      </div>
                      <div className="co-v2-summary-card">
                        <span>Warnings</span>
                        <strong>{preview.warnings.length}</strong>
                      </div>
                    </div>

                    <div className="co-v2-preview-meta">
                      <strong>{preview.graph.packageName}</strong>
                      <span>{preview.source.rootUri}</span>
                      {preview.targetCompany && (
                        <span className="settings-badge settings-badge--outline">
                          Syncing into {preview.targetCompany.name}
                        </span>
                      )}
                      {!preview.targetCompany && (
                        <span className="settings-badge settings-badge--success">
                          Creates a new company
                        </span>
                      )}
                    </div>

                    {preview.warnings.length > 0 && (
                      <div className="settings-alert settings-alert-error">
                        {preview.warnings.join(" ")}
                      </div>
                    )}

                    <div className="co-v2-preview-items">
                      {preview.items.map((item) => (
                        <div key={item.id} className="co-v2-preview-item">
                          <div>
                            <strong>{item.label}</strong>
                            <div className="co-v2-subtle">{item.details || item.manifestKind}</div>
                          </div>
                          <span className={actionBadgeClass(item.action)}>{item.action}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}

          {mode === "org" && (
            <div className="co-v2-panel-grid co-v2-panel-grid--org">
              <section className="co-v2-card">
                <div className="co-v2-card-header">
                  <div>
                    <h3>Structure</h3>
                    <p className="co-v2-subtle">Desired-state company graph from imported packages.</p>
                  </div>
                </div>
                {graphNodes.length === 0 ? (
                  <div className="settings-empty">
                    No desired-state graph yet. Import a package from the Library tab to populate the org builder.
                  </div>
                ) : (
                  <div className="co-v2-tree">
                    {tree.roots.map((node) => (
                      <OrgTreeNode
                        key={node.id}
                        node={node}
                        childrenMap={tree.children}
                        selectedNodeId={selectedNodeId}
                        setSelectedNodeId={setSelectedNodeId}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section className="co-v2-card">
                <div className="co-v2-card-header">
                  <div>
                    <h3>Org Chart</h3>
                    <p className="co-v2-subtle">Reporting lines for imported agent roles.</p>
                  </div>
                  {selectedCompany && (
                    <button
                      type="button"
                      className="provider-test-button"
                      onClick={() => onOpenMissionControl?.(selectedCompany.id)}
                    >
                      Open Ops <ArrowRight size={13} />
                    </button>
                  )}
                </div>
                {agentHierarchy.roots.length === 0 ? (
                  <div className="settings-empty">No agent hierarchy found in the imported graph yet.</div>
                ) : (
                  <div className="co-v2-org-chart">
                    {agentHierarchy.roots.map((root) =>
                      renderAgentChartNode(root, agentHierarchy.children, selectedNodeId, setSelectedNodeId),
                    )}
                  </div>
                )}

                {(projects.length > 0 || tasks.length > 0) && (
                  <div className="co-v2-runtime-lanes">
                    {projects.length > 0 && (
                      <div>
                        <h4>Projects</h4>
                        <div className="co-v2-chip-row">
                          {projects.map((project) => (
                            <button
                              key={project.id}
                              type="button"
                              className={`co-v2-chip ${selectedNodeId === project.id ? "is-selected" : ""}`}
                              onClick={() => setSelectedNodeId(project.id)}
                            >
                              {project.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {tasks.length > 0 && (
                      <div>
                        <h4>Starter Tasks</h4>
                        <div className="co-v2-chip-row">
                          {tasks.map((task) => (
                            <button
                              key={task.id}
                              type="button"
                              className={`co-v2-chip ${selectedNodeId === task.id ? "is-selected" : ""}`}
                              onClick={() => setSelectedNodeId(task.id)}
                            >
                              {task.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="co-v2-card">
                <div className="co-v2-card-header">
                  <div>
                    <h3>Node Detail</h3>
                    <p className="co-v2-subtle">Desired state, provenance, and runtime linkage.</p>
                  </div>
                  {selectedCompany && (
                    <button
                      type="button"
                      className="provider-test-button"
                      onClick={() => onOpenDigitalTwins?.(selectedCompany.id)}
                    >
                      Digital Twins <ArrowRight size={13} />
                    </button>
                  )}
                </div>
                {!selectedNode ? (
                  <div className="settings-empty">Select a node to inspect its desired state and runtime linkage.</div>
                ) : (
                  <div className="co-v2-detail">
                    <div className="co-v2-detail-title">
                      <div className="co-v2-detail-kind">
                        {nodeIcon(selectedNode.kind)}
                        <span>{selectedNode.kind}</span>
                      </div>
                      <h3>{selectedNode.name}</h3>
                    </div>

                    <div className="co-v2-detail-grid">
                      <div>
                        <span className="co-v2-subtle">Slug</span>
                        <strong>{selectedNode.slug}</strong>
                      </div>
                      <div>
                        <span className="co-v2-subtle">Path</span>
                        <strong>{selectedNode.relativePath || "n/a"}</strong>
                      </div>
                      <div>
                        <span className="co-v2-subtle">Runtime sync</span>
                        <span className={selectedNodeSync ? syncBadgeClass(selectedNodeSync.syncStatus) : "settings-badge settings-badge--neutral"}>
                          {selectedNodeSync?.syncStatus || "unlinked"}
                        </span>
                      </div>
                    </div>

                    {selectedNode.description && <p>{selectedNode.description}</p>}

                    <div className="co-v2-detail-section">
                      <h4>Relationships</h4>
                      {relatedEdges.length === 0 ? (
                        <div className="co-v2-subtle">No graph relationships recorded for this node.</div>
                      ) : (
                        <div className="co-v2-rel-list">
                          {relatedEdges.map((edge) => {
                            const target =
                              graphNodes.find((node) =>
                                edge.fromNodeId === selectedNode.id ? node.id === edge.toNodeId : node.id === edge.fromNodeId,
                              ) || null;
                            return (
                              <div key={edge.id} className="co-v2-rel-item">
                                <span className="settings-badge settings-badge--outline">{edge.kind}</span>
                                <span>{target?.name || "Unknown node"}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {selectedNode.kind === "agent" && (
                      <div className="co-v2-detail-section">
                        <h4>Linked Runtime Operator</h4>
                        <div className="co-v2-linker">
                          <select
                            value={pendingRoleLinks[selectedNode.id] ?? selectedLinkedRole?.id ?? ""}
                            onChange={(event) =>
                              setPendingRoleLinks((current) => ({
                                ...current,
                                [selectedNode.id]: event.target.value,
                              }))
                            }
                          >
                            <option value="">No linked operator</option>
                            {roles
                              .filter((role) => !linkedRoleIds.has(role.id) || role.id === selectedLinkedRole?.id)
                              .map((role) => (
                                <option key={role.id} value={role.id}>
                                  {role.displayName || role.name}
                                </option>
                              ))}
                          </select>
                          <button
                            type="button"
                            className="provider-save-button"
                            disabled={linkingNodeId === selectedNode.id}
                            onClick={() => void handleLinkRole(selectedNode.id)}
                          >
                            <Link2 size={14} />
                            Save Link
                          </button>
                        </div>
                        {selectedLinkedRole && (
                          <div className="co-v2-subtle">
                            Linked to {selectedLinkedRole.displayName || selectedLinkedRole.name} · company-scoped operator
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>
          )}

          {mode === "ops" && (
            <div className="co-v2-panel-grid">
              <section className="co-v2-card">
                <div className="co-v2-card-header">
                  <div>
                    <h3>Runtime Overview</h3>
                    <p className="co-v2-subtle">Actual company operations in Cowork runtime.</p>
                  </div>
                  {selectedCompany && (
                    <button
                      type="button"
                      className="provider-test-button"
                      onClick={() => onOpenMissionControl?.(selectedCompany.id)}
                    >
                      Full Mission Control <ArrowRight size={13} />
                    </button>
                  )}
                </div>

                {!selectedCompany ? (
                  <div className="settings-empty">Select a company to inspect runtime operations.</div>
                ) : !activeCompanySummary ? (
                  <div className="settings-empty">Loading runtime operations…</div>
                ) : (
                  <div className="co-v2-ops-overview">
                    <div className="co-v2-summary-card">
                      <span>Active goals</span>
                      <strong>{activeCompanySummary.activeGoalCount}</strong>
                    </div>
                    <div className="co-v2-summary-card">
                      <span>Active projects</span>
                      <strong>{activeCompanySummary.activeProjectCount}</strong>
                    </div>
                    <div className="co-v2-summary-card">
                      <span>Open issues</span>
                      <strong>{activeCompanySummary.openIssueCount}</strong>
                    </div>
                    <div className="co-v2-summary-card">
                      <span>Pending review</span>
                      <strong>{activeCompanySummary.pendingReviewCount}</strong>
                    </div>
                    <div className="co-v2-summary-card">
                      <span>Valuable outputs</span>
                      <strong>{activeCompanySummary.valuableOutputCount}</strong>
                    </div>
                  </div>
                )}
              </section>

              <section className="co-v2-card">
                <div className="co-v2-card-header">
                  <h3>Desired vs Actual</h3>
                </div>
                <div className="co-v2-runtime-comparison">
                  <div className="co-v2-summary-card">
                    <span>Desired agents</span>
                    <strong>{graphNodes.filter((node) => node.kind === "agent").length}</strong>
                  </div>
                  <div className="co-v2-summary-card">
                    <span>Linked operators</span>
                    <strong>{syncStates.filter((state) => state.runtimeEntityKind === "agent_role").length}</strong>
                  </div>
                  <div className="co-v2-summary-card">
                    <span>Desired projects</span>
                    <strong>{graphNodes.filter((node) => node.kind === "project").length}</strong>
                  </div>
                  <div className="co-v2-summary-card">
                    <span>Seeded runtime issues</span>
                    <strong>{syncStates.filter((state) => state.runtimeEntityKind === "issue").length}</strong>
                  </div>
                </div>
              </section>

              <section className="co-v2-card">
                <div className="co-v2-card-header">
                  <h3>Outputs & Review</h3>
                </div>
                {!summary ? (
                  <div className="settings-empty">No runtime summary loaded yet.</div>
                ) : (
                  <div className="co-v2-output-columns">
                    <div>
                      <h4>Recent Outputs</h4>
                      <div className="co-v2-list">
                        {summary.outputs.slice(0, 6).map((output) => (
                          <div key={output.id} className="co-v2-list-row">
                            <div>
                              <strong>{output.title}</strong>
                              <div className="co-v2-subtle">{output.outputType} · {output.valueReason}</div>
                            </div>
                            <span className="settings-badge settings-badge--outline">
                              {output.reviewRequired ? "review" : output.status || output.outputType}
                            </span>
                          </div>
                        ))}
                        {summary.outputs.length === 0 && <div className="settings-empty">No outputs yet.</div>}
                      </div>
                    </div>
                    <div>
                      <h4>Review Queue</h4>
                      <div className="co-v2-list">
                        {summary.reviewQueue.slice(0, 6).map((item) => (
                          <div key={item.id} className="co-v2-list-row">
                            <div>
                              <strong>{item.title}</strong>
                              <div className="co-v2-subtle">{item.reviewReason}</div>
                            </div>
                            <span className="settings-badge settings-badge--warning">
                              {formatWhen(item.createdAt)}
                            </span>
                          </div>
                        ))}
                        {summary.reviewQueue.length === 0 && <div className="settings-empty">No queued reviews.</div>}
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </main>
      </div>

      <style>{`
        .companies-v2 {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .co-v2-header,
        .co-v2-topbar,
        .co-v2-card-header,
        .co-v2-company-item-row,
        .co-v2-company-item-meta,
        .co-v2-source-item,
        .co-v2-preview-item,
        .co-v2-list-row,
        .co-v2-rel-item,
        .co-v2-linker,
        .co-v2-detail-title,
        .co-v2-detail-kind,
        .co-v2-company-list {
          display: flex;
        }
        .co-v2-header,
        .co-v2-topbar,
        .co-v2-card-header,
        .co-v2-source-item,
        .co-v2-preview-item,
        .co-v2-list-row,
        .co-v2-linker {
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .co-v2-layout {
          display: grid;
          grid-template-columns: 280px minmax(0, 1fr);
          gap: 16px;
          min-height: 0;
        }
        .co-v2-sidebar,
        .co-v2-main,
        .co-v2-panel-grid,
        .co-v2-card,
        .co-v2-preview,
        .co-v2-detail,
        .co-v2-source-list,
        .co-v2-preview-items,
        .co-v2-list,
        .co-v2-tree,
        .co-v2-form,
        .co-v2-runtime-lanes,
        .co-v2-output-columns {
          display: flex;
          flex-direction: column;
        }
        .co-v2-sidebar,
        .co-v2-main,
        .co-v2-panel-grid,
        .co-v2-card,
        .co-v2-source-list,
        .co-v2-preview-items,
        .co-v2-list,
        .co-v2-tree,
        .co-v2-form,
        .co-v2-runtime-lanes {
          gap: 12px;
        }
        .co-v2-main {
          gap: 16px;
        }
        .co-v2-card {
          padding: 16px;
          border: 1px solid var(--color-border, rgba(0,0,0,0.1));
          border-radius: 16px;
          background: var(--color-surface, rgba(255,255,255,0.72));
          box-shadow: 0 8px 28px rgba(15, 23, 42, 0.06);
        }
        .co-v2-panel-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
        }
        .co-v2-panel-grid--org {
          grid-template-columns: 280px minmax(0, 1.4fr) minmax(300px, 0.8fr);
        }
        .co-v2-company-list {
          flex-direction: column;
          gap: 8px;
        }
        .co-v2-company-item,
        .co-v2-chip,
        .co-v2-tab,
        .co-org-card,
        .co-v2-tree-node {
          border: 1px solid var(--color-border, rgba(0,0,0,0.1));
          border-radius: 12px;
          background: rgba(255,255,255,0.8);
          transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
        }
        .co-v2-company-item,
        .co-v2-tree-node {
          width: 100%;
          text-align: left;
          padding: 10px 12px;
        }
        .co-v2-company-item.is-selected,
        .co-v2-tab.is-active,
        .co-v2-chip.is-selected,
        .co-org-card.is-selected,
        .co-v2-tree-node.is-selected {
          border-color: #2563eb;
          box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.2);
        }
        .co-v2-company-item-meta,
        .co-v2-source-meta,
        .co-v2-subtle {
          color: var(--color-text-secondary, rgba(15, 23, 42, 0.68));
          font-size: 12px;
          gap: 8px;
        }
        .co-v2-summary-strip,
        .co-v2-preview-summary,
        .co-v2-ops-overview,
        .co-v2-runtime-comparison {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 10px;
        }
        .co-v2-summary-card {
          padding: 12px;
          border-radius: 12px;
          background: linear-gradient(180deg, rgba(248, 250, 252, 0.96), rgba(241, 245, 249, 0.9));
          border: 1px solid rgba(148, 163, 184, 0.18);
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .co-v2-summary-card span {
          font-size: 12px;
          color: var(--color-text-secondary, rgba(15, 23, 42, 0.68));
        }
        .co-v2-summary-card strong {
          font-size: 20px;
        }
        .co-v2-tabs {
          display: inline-flex;
          gap: 8px;
          padding: 4px;
          border-radius: 14px;
          background: rgba(148, 163, 184, 0.12);
        }
        .co-v2-tab {
          padding: 8px 12px;
        }
        .co-v2-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .co-v2-field input,
        .co-v2-field textarea,
        .co-v2-linker select {
          width: 100%;
          border-radius: 10px;
          border: 1px solid var(--color-border, rgba(0,0,0,0.12));
          background: rgba(255,255,255,0.86);
          padding: 10px 12px;
        }
        .co-v2-preview-meta,
        .co-v2-detail-grid,
        .co-v2-rel-list,
        .co-v2-chip-row {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .co-v2-source-item,
        .co-v2-preview-item,
        .co-v2-list-row,
        .co-v2-rel-item {
          padding: 12px;
          border-radius: 12px;
          border: 1px solid rgba(148, 163, 184, 0.18);
          background: rgba(248, 250, 252, 0.88);
        }
        .co-v2-tree {
          overflow: auto;
          max-height: 720px;
        }
        .co-v2-tree-children {
          margin-left: 18px;
          padding-left: 12px;
          border-left: 1px solid rgba(148, 163, 184, 0.22);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .co-v2-tree-node {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .co-v2-tree-node strong {
          display: block;
        }
        .co-v2-tree-node span {
          font-size: 12px;
          color: var(--color-text-secondary, rgba(15, 23, 42, 0.68));
        }
        .co-v2-org-chart {
          overflow: auto;
          padding: 8px;
        }
        .co-org-branch {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 16px;
          position: relative;
        }
        .co-org-branch-children {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 18px;
          position: relative;
        }
        .co-org-card {
          min-width: 180px;
          max-width: 220px;
          padding: 14px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          text-align: center;
        }
        .co-org-card-kind {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--color-text-secondary, rgba(15, 23, 42, 0.68));
        }
        .co-v2-runtime-lanes h4,
        .co-v2-detail-section h4,
        .co-v2-output-columns h4 {
          margin: 0 0 8px;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: var(--color-text-secondary, rgba(15, 23, 42, 0.68));
        }
        .co-v2-chip {
          padding: 8px 10px;
          font-size: 12px;
        }
        .co-v2-detail-title h3 {
          margin: 0;
        }
        .co-v2-detail-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px;
        }
        .co-v2-detail-grid strong {
          display: block;
          margin-top: 4px;
        }
        .co-v2-linker {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto;
        }
        .co-v2-output-columns {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
        }
        @media (max-width: 1200px) {
          .co-v2-layout,
          .co-v2-panel-grid,
          .co-v2-panel-grid--org,
          .co-v2-output-columns {
            grid-template-columns: 1fr;
          }
          .co-v2-sidebar {
            order: 2;
          }
          .co-v2-main {
            order: 1;
          }
        }
      `}</style>
    </div>
  );
}

function OrgTreeNode({
  node,
  childrenMap,
  selectedNodeId,
  setSelectedNodeId,
}: {
  node: CompanyGraphNode;
  childrenMap: Map<string, CompanyGraphNode[]>;
  selectedNodeId: string | null;
  setSelectedNodeId: (value: string) => void;
}) {
  const children = childrenMap.get(node.id) || [];
  return (
    <div>
      <button
        type="button"
        className={`co-v2-tree-node ${selectedNodeId === node.id ? "is-selected" : ""}`}
        onClick={() => setSelectedNodeId(node.id)}
      >
        {nodeIcon(node.kind)}
        <div>
          <strong>{node.name}</strong>
          <span>{node.kind}</span>
        </div>
      </button>
      {children.length > 0 && (
        <div className="co-v2-tree-children">
          {children.map((child) => (
            <OrgTreeNode
              key={child.id}
              node={child}
              childrenMap={childrenMap}
              selectedNodeId={selectedNodeId}
              setSelectedNodeId={setSelectedNodeId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
