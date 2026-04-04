# CoWork OS Architecture

CoWork OS is a local-first desktop runtime for AI-assisted task execution, background operator loops, and multi-surface automation.

## Core Architecture

- **Electron main process**: task orchestration, agent runtime, heartbeat orchestration, IPC, and tool execution
- **React renderer**: desktop UI, Mission Control, task timeline, settings, and monitoring surfaces
- **Tool and connector layer**: file, shell, browser, web, native integrations, MCP connectors, remote execution, and **macOS computer use** (`computer_*`) as a governed desktop-GUI lane (session overlay, per-app consent, policy-gated routing). See [Computer use (macOS)](computer-use.md).
- **Automation/event layer**: scheduled tasks, webhooks, channel events, and MCP connector/resource notifications all flow through the same trigger engine
- **Turn and tool orchestration**: a session-scoped `SessionRuntime` owns task-session state, session checklists, permission state, turn coordination, resume/snapshot persistence, and task projection, while a lower-level `TurnKernel` handles the active step, follow-up, or text turn; a metadata-driven `ToolScheduler` batches concurrency-safe reads, serializes conflicting writes, and keeps tool-result ordering stable
- **Prompt stack and tool guidance**: execution prompts are assembled from named session- and turn-scoped sections with explicit budgets; stable session sections form a provider-cacheable prefix, volatile turn sections stay uncached, and visible tools receive prompt-aware descriptions rendered only after policy and mode filtering
- **Additive skill runtime**: canonical task text remains immutable for skill routing purposes, while `use_skill` attaches structured `SkillApplication` context plus scoped runtime directives instead of rewriting the task prompt
- **Delegation graph**: delegated work now runs through a normalized orchestration graph engine so spawned agents, team work, workflow phases, and ACP tasks share one run/node/event model
- **Worker roles and verification**: built-in worker roles (`researcher`, `implementer`, `verifier`, `synthesizer`) carry hard tool scopes, delegated work receives a structured brief instead of raw prompt passthrough, and verification runs use both early nudges and a dedicated verdict/report contract
- **Adaptive model routing**: the executor can switch into a workflow-pipeline path where decomposed phases run as child tasks with per-phase model overrides or capability-based auto-selection
- **Federated agent orchestration**: ACP registry + remote invocation let orchestrators target local roles or remote A2A-compatible agents under shared approval and policy controls
- **Local persistence**: SQLite, local files, knowledge graph state, run records, orchestration graph nodes/events, ACP agent registrations and ACP task state, usage telemetry, feedback events, `session_runtime_v2` task snapshots, and workspace-kit contracts in `.cowork/`
- **Permission engine**: layered tool approval decisions combine workspace capabilities, explicit rules, hard guardrails, session grants, and workspace-local policy files, with workspace rule browsing/removal in Settings
- **Runtime visibility surfaces**: the task runtime emits learning progression, unified recall, persistent shell, live routing events, semantic tool-batch summaries, session-checklist events, and follow-up completion events into Mission Control and the renderer so operator state stays visible instead of hidden in services
- **Lifecycle reconciliation**: completion persists terminal task state before emitting terminal events, and resume paths re-derive canonical persisted status before writing `executing`, so late approval or follow-up resumes cannot reopen completed tasks
- **Completion hardening**: verified-mode evidence bundles, step-intent alignment/decomposition heuristics, read-only entropy sweeps, and verifier verdict/report projection make completion checks more explicit without mutating the task's final result

## Profiles and Isolation

CoWork supports multiple app profiles so one install can keep separate operating environments for different users, clients, or trust zones.

- each profile has its own user-data root, SQLite database, encrypted settings, channel configs, managed skills, and session history
- profile export/import moves a complete app profile bundle without merging it into another profile implicitly
- workspaces still live outside the app profile, but the profile controls the credentials, automations, channels, and runtime state that operate on those workspaces
- profile switching is an app-level concern, separate from personality export/import or workspace-kit files

## Heartbeat V3

Heartbeat v3 is the default background automation architecture.

- **Signal ledger**: ambient changes, mentions, manual wakes, and awareness events emit normalized heartbeat signals instead of accumulating raw wake requests
- **Pulse**: cheap, deterministic, non-LLM state reduction that evaluates merged signals, due proactive work, checklist cadence, foreground contention, and dispatch guardrails
- **Dispatch**: escalation lane invoked only when Pulse decides the situation warrants user-visible or task-visible work
- **Run records**: every Pulse and Dispatch execution is tracked, and any heartbeat-created task is linked back to its originating heartbeat run
- **Defer and compress**: foreground manual work suppresses churn by compressing pending signals into resumable deferred state instead of growing a queue

See [Heartbeat v3](heartbeat-v3.md) for the detailed runtime contract.

## Workspace Kit

The `.cowork/` workspace kit holds durable human-edited operating context.

- `BOOTSTRAP.md` is a one-time onboarding checklist
- `HEARTBEAT.md` is reserved for recurring heartbeat checklist work
- project-scoped context lives under `.cowork/projects/<projectId>/`

## Skills Runtime Model

The skill system now follows an additive contract:

- the canonical user request is resolved as `rawPrompt -> userPrompt -> prompt`
- task creation normalizes prompt fields centrally so new tasks always persist canonical prompt data
- skill routing works as shortlist-and-hint guidance, not prompt takeover
- slash commands can still invoke skills deterministically, but the result is applied additively
- `use_skill` returns structured context plus scoped directives, not a replacement task definition
- the executor builds runtime context from canonical prompt + task notes + applied skill content
- the renderer always shows canonical task text and renders applied skills separately

This prevents skills from hijacking the task while preserving proactive skill selection.

See [Skills Runtime Model](skills-runtime-model.md) for the detailed contract.

## Repo Landmarks

- `src/electron/`: main-process runtime, services, database, scheduling, monitoring
- `src/electron/agent/runtime/SessionRuntime.ts`: canonical task-session owner for execution, recovery, snapshotting, and task projection
- `src/renderer/components/RightPanel.tsx`: renderer-side read-only projection of the latest session checklist state
- `src/electron/agent/runtime/PermissionEngine.ts`: layered tool-approval evaluation, rule matching, and fallback escalation
- `src/renderer/`: React UI and settings surfaces
- `src/shared/`: shared contracts and types
- `docs/`: product and architecture documentation
- `.cowork/`: local workspace operating context

## Computer use (macOS)

Native GUI control is implemented in the main process (`src/electron/computer-use/`, `src/electron/agent/tools/computer-use-tools.ts`) with renderer onboarding and approval dialogs. A **singleton session** coordinates overlay, isolation, and teardown; **AppPermissionManager** enforces per-app tiers during that session. Tool policy and the executor only expose `computer_*` when **native desktop GUI intent** is detected so routine web and repo work stays on browser and shell paths. Product-level behavior, permissions, and troubleshooting are documented in [Computer use (macOS)](computer-use.md).

## Update Rule

If defaults, behavior, or architecture change, update this file in the same PR.
