# Managed Agents

Managed Agents adds a first-class managed resource model to CoWork without replacing the existing task runtime.

V1 introduces three control-plane resources:

- `ManagedAgent`: reusable, versioned execution definition
- `ManagedEnvironment`: reusable local execution template
- `ManagedSession`: durable run resource that owns lifecycle, event history, and resume semantics

The implementation is local-first and additive. Managed resources are exposed through the control plane, while existing `Task`, `AgentTeamRun`, `task_events`, and `session_runtime_v2` remain the execution primitives underneath.

## Why This Exists

CoWork already had the low-level pieces for durable execution, team runs, worktree isolation, MCP integration, and resumable task runtime state. Managed Agents packages those pieces into reusable definitions and a stable run identity so UI and backend surfaces can reason about durable agent runs directly instead of reconstructing them from ad hoc task metadata.

The model is:

- define reusable behavior in `ManagedAgent`
- define reusable local policy in `ManagedEnvironment`
- execute and observe durable runs through `ManagedSession`

## V1 Scope

Managed Agents V1 is intentionally narrow:

- local execution only through `ManagedEnvironment.kind = "cowork_local"`
- control-plane and backend first
- no dedicated renderer screen yet
- existing task APIs remain supported
- Mission Control and task surfaces observe the backing task or team run created by the managed session

This means Managed Agents is ready for backend integration and operator testing before a polished end-user creation UI exists.

## Control-Plane Surface

Managed Agents is available through the existing dot-style control-plane namespace.

Agent methods:

- `managedAgent.list`
- `managedAgent.get`
- `managedAgent.create`
- `managedAgent.update`
- `managedAgent.archive`
- `managedAgent.version.list`
- `managedAgent.version.get`

Environment methods:

- `managedEnvironment.list`
- `managedEnvironment.get`
- `managedEnvironment.create`
- `managedEnvironment.update`
- `managedEnvironment.archive`

Session methods:

- `managedSession.list`
- `managedSession.get`
- `managedSession.create`
- `managedSession.cancel`
- `managedSession.resume`
- `managedSession.sendEvent`
- `managedSession.events.list`

Managed-session broadcasts:

- `managedSession.created`
- `managedSession.updated`
- `managedSession.event`
- `managedSession.completed`
- `managedSession.failed`

## Runtime Mapping

Managed Agents is not a second executor. It maps onto the existing runtime:

- `ManagedAgentVersion` becomes the source of truth for model, prompt, execution mode, and runtime defaults
- `ManagedEnvironment` becomes the source of truth for workspace binding, tool policy, MCP scope, and execution affordances
- `ManagedSession` creates exactly one backing `Task`
- team-mode `ManagedSession` also creates a backing `AgentTeamRun`
- `task_events` and daemon notifications are mirrored into `managed_session_events`
- `session_runtime_v2` remains task-scoped runtime state owned by `SessionRuntime`

The important contract is that `ManagedSession` is the API-facing durable run, while `Task` remains the execution worker.

## Managed Turn Budgets

Managed Agents keep explicit turn caps because managed runs are often unattended or intentionally bounded.

- `ManagedAgentVersion.runtimeDefaults.maxTurns` is passed through as an explicit cap on the backing task when configured
- if a managed agent does not set `runtimeDefaults.maxTurns`, the backing task inherits the same default-unbounded main-task behavior as ordinary interactive sessions
- this differs from older strategy behavior: the runtime no longer invents a low implicit window such as `30` turns just because the task routed as `advice` or `planning`

In practice:

- use `runtimeDefaults.maxTurns` when you want a managed session to stop after a defined number of turns
- leave it unset when you want the run to rely on lifetime caps, emergency fuses, and the normal recovery/safety model instead

## Security And Policy Boundaries

Managed Agents follows the same security posture as the rest of CoWork, with a few managed-specific rules:

- renderer-facing managed environment reads redact `credentialRefs` and `managedAccountRefs`
- managed session events are sanitized before persistence and sanitized again on read
- MCP allowlists fail closed if the referenced server or its cached tool metadata is unavailable
- managed account refs are validated server-side at environment creation/update time
- legacy tasks, runs, and team APIs are unchanged for non-managed flows

These rules keep the managed control-plane surface suitable for UI/backend consumption without exposing sensitive linkage or silently broadening tool access.

## Current UI State

There is not yet a dedicated Managed Agents screen in the renderer.

Today’s operator workflow is:

1. enable and start the Control Plane in app settings
2. open the built-in Control Plane page
3. use its `request(method, params)` helper to create a managed environment, managed agent, and managed session
4. observe the resulting backing task or team run in the normal task UI and Mission Control

This is the current practical test path from the desktop app.

## Manual App Test Flow

Use a solo session first:

```js
const workspaces = await request("workspace.list", {});
const workspaceId = workspaces.workspaces[0]?.id;

const environment = await request("managedEnvironment.create", {
  name: "Local Test Env",
  config: {
    workspaceId,
    enableShell: true,
    enableBrowser: true,
  },
});

const agent = await request("managedAgent.create", {
  name: "Managed Test Agent",
  systemPrompt: "You are a precise coding assistant.",
  executionMode: "solo",
  runtimeDefaults: {
    autonomousMode: true,
    allowUserInput: true,
  },
});

const session = await request("managedSession.create", {
  agentId: agent.agent.id,
  environmentId: environment.environment.id,
  title: "Managed Session Smoke Test",
  initialEvent: {
    type: "user.message",
    content: [{ type: "text", text: "Inspect the repo and summarize it." }],
  },
});
```

Then verify:

- a normal task appears in the desktop UI
- the task starts through the normal daemon lifecycle
- `managedSession.get` shows the backing task link and current status
- `managedSession.events.list` returns sanitized event payloads

For team mode:

- create a `ManagedAgent` with `executionMode: "team"`
- create a managed session
- observe the backing team run from Mission Control and task surfaces
- expect `managedSession.sendEvent` with `user.message` to reject for team-mode sessions in V1

That rejection is intentional until follow-up routing is wired cleanly into the team orchestration path.

## Compatibility Contract

Managed Agents must not break existing flows.

The additive contract is:

- legacy `task.*` methods still create and run ordinary tasks
- legacy task timelines and approvals still work
- Agent Teams still work outside managed sessions
- managed sessions reuse the daemon and runtime instead of bypassing them
- managed resources add a new control-plane namespace; they do not replace existing APIs

When changing this system, preserve that boundary and update the tests that prove it.
