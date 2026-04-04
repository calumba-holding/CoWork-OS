# Session Runtime

SessionRuntime is the canonical owner of mutable task-session state for execution-oriented work. It sits between `TaskExecutor` and the lower-level turn executor, so the executor keeps task lifecycle responsibilities while the runtime owns the session mirror, permission state, persistence, and recovery behavior.

## What It Owns

SessionRuntime groups all mutable session state into explicit buckets:

- `transcript`: conversation history, latest user and assistant outputs, chat summary blocks, and step outcome summaries
- `tooling`: tool failure tracking, tool usage counters, tool-result memory, web evidence memory, and visible-tool render caching
- `files`: file-read tracking and file-operation tracking
- `loop`: turn counts, continuation counters, compaction counters, loop fingerprints, and soft-deadline flags
- `recovery`: retry and failure-signature state, recovery classification, and tool-disable scopes
- `queues`: pending follow-ups and step-feedback signals
- `worker`: mentioned-agent dispatch state and verification-agent state
- `verification`: verification evidence and failed-step tracking
- `checklist`: session-local execution checklist items, nudge state, and checklist timestamps
- `promptCache`: stable system blocks, stable-prefix hash, tool-schema hash, provider-family mode, and invalidation reason
- `usage`: cumulative token and cost tracking plus usage offsets
- `permissions`: default mode, session-local rules, temporary grants, denial counters, and latest prompt context

This is the state that used to be mirrored across the executor and related helpers. It now lives in one place so task resume, retry, and completion logic read the same source of truth.

## Tool Availability and Rendering

SessionRuntime also owns the runtime-facing available-tools path used by execution and follow-up turns.

The sequence is:

1. start from the tool catalog
2. apply restriction, allowlist, policy, mode, and intent filters
3. render prompt-aware descriptions only for the remaining visible tools
4. cache the rendered result for repeated turns under the same visible-tool and render-context state

This means tool-local guidance is attached only to tools the current task can actually see.

The render-context inputs include:

- execution mode
- task domain
- web-search mode
- shell availability
- agent type
- worker role
- user-input allowance

The provider-facing tool shape remains unchanged after rendering; providers still receive only `name`, rendered `description`, and `input_schema`.

## Prompt Cache State

SessionRuntime persists the stable prompt-cache context needed to reuse provider-side prompt prefixes across turns and restarts.

It tracks:

- stable session-scoped `systemBlocks`
- `stablePrefixHash`
- `toolSchemaHash`
- prompt-cache mode and provider family
- the latest invalidation reason when the stable prefix changes

This lets CoWork reuse the same cacheable prefix after follow-ups, resume from `session_runtime_v2` snapshots without rebuilding it blindly, and explain why a cache epoch changed when model, provider family, tool schema, or stable prompt contracts changed.

## Public Surface

The runtime exposes a narrow API for the executor and task orchestration layers:

- `runStepLoop(...)`
- `runFollowUpLoop(...)`
- `runTextLoop(...)`
- `queueFollowUp(...)`
- `setStepFeedback(...)`
- `drainAllPendingFollowUps(...)`
- `maybeAutoContinueAfterTurnLimit(...)`
- `continueAfterBudgetExhausted(...)`
- `resetForRetry(...)`
- `saveSnapshot(...)`
- `restoreFromEvents(...)`
- `projectTaskState(...)`
- `createTaskList(...)`
- `updateTaskList(...)`
- `listTaskList(...)`
- `getTaskListState(...)`
- `clearTaskListVerificationNudge()`
- `getOutputState(...)`
- `getVerificationState(...)`
- `getRecoveryState(...)`
- `getPermissionState(...)`
- `applyWorkspaceUpdate(...)`

The executor still owns task bootstrap, plan construction, completion policy, UI/daemon updates, and final result projection. It now delegates session state changes instead of duplicating them.

## Session Checklist Primitive

SessionRuntime now owns a lightweight session checklist that is separate from:

- plan steps
- shared team checklists
- any database-backed durable checklist model

The checklist is session-scoped, agent-managed, and persisted only inside `session_runtime_v2` snapshots and checklist events. It exists to keep execution disciplined during multi-step work without creating a second planning system.

### Tool surface

Execution-capable paths expose three runtime tools:

- `task_list_create`
- `task_list_update`
- `task_list_list`

They are intentionally unavailable in chat, plan, analyze, and other non-executing paths.

### Runtime semantics

- `task_list_create` creates the first ordered checklist and fails if one already exists
- `task_list_update` replaces the full ordered state
- existing items keep their ids when the caller supplies them
- new items may omit `id` and the runtime generates one
- `kind` defaults to `implementation`
- create and update reject empty lists, duplicate ids, and more than one `in_progress` item

### Verification nudge algorithm

The checklist can raise a non-blocking verification reminder when all of the following are true:

- a session checklist exists
- at least one checklist item has `kind: "implementation"`
- every implementation item is `completed`
- no checklist item has `kind: "verification"`
- the current plan does not already contain a verification step
- the task is not already on a verified path with explicit verification coverage

When that happens:

- `task_list_update` returns `verificationNudgeNeeded: true`
- `task_list_create` and `task_list_update` can append an immediate human-readable reminder in the tool result payload seen by the model
- SessionRuntime persists that flag in checklist state
- the runtime emits `task_list_verification_nudged`
- next-turn preparation injects a short reminder to add or run a verification item before final completion

The reminder is advisory. It does not fail completion by itself, and the post-hoc verification runtime remains the final enforcement layer.

### UI/event model

Checklist state is replayable from events alone. The runtime emits:

- `task_list_created`
- `task_list_updated`
- `task_list_verification_nudged`

Each payload carries the full current checklist snapshot so the renderer can reconstruct the latest read-only checklist state without a separate query path.

## Turn Execution Flow

```
TaskExecutor
  -> SessionRuntime
      -> TurnKernel for the active step / follow-up / text turn
      -> provider-aware output-budget policy
      -> adaptive truncation retry helpers
      -> session state updates
      -> task projection updates
      -> snapshot save / restore
```

The turn kernel is still responsible for a single turn of execution. SessionRuntime is responsible for choosing when to run it, which state to feed into it, and how to persist the results.

## Adaptive Output Budgeting

When `COWORK_LLM_OUTPUT_POLICY=adaptive` is enabled, execution and follow-up turns resolve output limits through one shared provider-aware policy path instead of relying on provider defaults or a single tool-call floor.

### Request kinds

The runtime resolves a budget for three request kinds:

- `agentic_main`: the first execution turn for a step or follow-up
- `tool_followup`: the next turn after tool results are present in the transcript
- `continuation`: explicit continuation-only retries after a visible truncation

### Policy shape

For the current internal rollout, the runtime uses provider-family defaults for the mainstream routes first:

- Anthropic-family routes
- Bedrock Claude routes
- OpenAI routes
- Azure OpenAI routes
- Gemini routes
- OpenRouter routes
- generic fallback for everything else

Default behavior:

- main execution turns start with `8000`
- tool-follow-up turns start with `16000`
- if a main/tool turn is truncated, the runtime retries the same request once with a higher budget before injecting any continuation prompt
- the escalated target is typically `48000`
- Anthropic-family routes can escalate to `64000`
- generic fallback escalation is capped at `16000`

The runtime always sends an explicit output limit for agentic turns in adaptive mode. It does not depend on provider-side defaults because gateways and compatible endpoints vary too much.

### Budget selection

The runtime resolves the outbound limit in this order:

1. task-level `agentConfig.maxTokens`, when present
2. `COWORK_LLM_MAX_OUTPUT_TOKENS`
3. provider-family defaults for the current request kind
4. final clamping by known hard caps and context headroom

Known provider caps remain a safety rail even when task-level or env-level overrides request more.

### Truncation handling

If a turn stops because it hit the output limit, the runtime classifies the result as one of:

- `visible_partial_output`: the model produced usable answer text but was cut off
- `reasoning_exhausted`: the model spent the budget on internal reasoning or otherwise produced no usable answer text

Recovery order:

1. same-request escalation once
2. if still truncated and visible partial output exists, fall back to the normal continuation prompt path
3. if still truncated and the result is reasoning-only, stop burning continuation retries and surface a targeted guidance message instead

This keeps continuation retries focused on recoverable truncation and avoids loops where the model repeatedly spends the entire budget without producing visible output.

### Logging and rollout controls

The runtime logs output-budget decisions on each agentic call, including:

- provider family
- request kind
- chosen budget
- transport token field
- cap source
- escalation attempted
- truncation classification
- whether continuation fallback was allowed or skipped

Internal rollout is controlled by environment flags:

- `COWORK_LLM_OUTPUT_POLICY=legacy|adaptive`
- `COWORK_LLM_MAX_OUTPUT_TOKENS`
- `COWORK_LLM_AGENTIC_INITIAL_MAX_TOKENS`
- `COWORK_LLM_AGENTIC_ESCALATED_MAX_TOKENS`

`COWORK_LLM_OUTPUT_POLICY` defaults to `legacy` unless explicitly enabled. `COWORK_LLM_TOOL_RESPONSE_MAX_TOKENS` remains a legacy compatibility input and is no longer the primary path in adaptive mode.

## Snapshot And Restore Algorithm

Persisted task state uses the legacy `conversation_snapshot` event name for compatibility, but the payload is now versioned as `session_runtime_v2`.

### Write path

1. SessionRuntime captures the full runtime snapshot.
2. It writes a `conversation_snapshot` event with:
   - `schema: "session_runtime_v2"`
   - `version: 2`
   - transcript, tooling, files, loop, recovery, queues, worker, verification, checklist, prompt-cache, usage, and permissions state
3. `TaskExecutor` no longer writes the payload directly.

### Restore path

`restoreFromEvents()` follows a strict precedence order:

1. Load a V2 checkpoint payload, if present.
2. Otherwise load the latest V2 `conversation_snapshot` event payload.
3. Otherwise restore from a legacy checkpoint payload that still contains `conversationHistory`.
4. Otherwise restore from a legacy `conversation_snapshot` event payload with `conversationHistory`.
5. Otherwise rebuild a readable fallback conversation from task events.

If a legacy payload is restored, the runtime writes back a V2 snapshot on the next checkpoint so future resumes use the canonical schema.

### Why the order matters

- Checkpoints are the most recent durable session state.
- Event payloads provide a replayable source of truth when a checkpoint is absent or stale.
- Legacy payloads remain readable so older tasks can still resume.
- Event-derived fallback keeps very old or partially migrated tasks usable even when no snapshot payload is available.

## Task Projection

`projectTaskState()` exposes the runtime-owned task fields that still need to be reflected on the task row:

- budget usage
- continuation count and window
- lifetime turns used
- compaction count and last compaction markers
- no-progress streak
- last loop fingerprint

This keeps the task row synchronized with the runtime without copying the rest of the session state into the database row itself.

## Terminal Status Synchronization

The runtime boundary is also responsible for keeping the task row and the event stream in the same terminal state.

### Completion algorithm

1. The executor computes the final outcome and terminal metadata.
2. The daemon persists the task row first, including `status`, `completedAt`, `terminalStatus`, `failureClass`, and completion summaries.
3. Only after the row update succeeds does the daemon emit `task_completed` or the final `task_status` event.

This ordering ensures the event stream never advertises completion ahead of the durable task row update.

### Resume safety algorithm

Late resume calls can happen after approvals, structured-input responses, or renderer-side event handling. To prevent a finished task from being reopened accidentally:

1. resume callers ask the daemon to resume instead of writing `executing` themselves
2. the daemon re-reads the persisted task row and derives the canonical lifecycle state
3. if the task is already terminal, resume is rejected and no state is rewritten
4. if the task is already `executing`, the daemon skips duplicate `executing` writes
5. only a genuinely resumable non-terminal task is moved back to `executing`

This protects terminal fields from stale post-resume writes and keeps task rows aligned with `task_completed` events even when approval or follow-up flows resolve very quickly.

## Workspace Refresh

When the active workspace changes, SessionRuntime swaps to the new tool registry, invalidates tool availability caches, and preserves the live transcript and loop state. This lets the task continue without resetting the session mirror.

It also clears workspace-derived permission cache entries so the next evaluation uses the refreshed
workspace rule set.

## Related Docs

- [Architecture](architecture.md)
- [Execution Runtime Model](execution-runtime-model.md)
- [Features](features.md)
- [Context Compaction](context-compaction.md)
- [Project Status](project-status.md)
- [Session Note: 2026-04-02](session-notes/2026-04-02-session-runtime-owner.md)
