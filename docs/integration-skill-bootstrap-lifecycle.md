# Integration Setup, Skill Proposals, and Bootstrap Lifecycle

This document records the implementation shipped for three platform capabilities:

1. Chat-native setup for Tier-1 integrations (`integration_setup`)
2. Approval-gated skill expansion (`skill_proposal`)
3. Workspace bootstrap lifecycle + heartbeat frequency alignment

It is written as an implementation and operations reference for product, support, and engineering.

---

## 1) Chat-Native Tier-1 Integration Setup

### Scope

Tier-1 providers currently supported by `integration_setup`:

- `resend`
- `slack`
- `gmail`
- `google-calendar`
- `google-drive`
- `jira`
- `linear`
- `hubspot`

A shared capability catalog now drives both:

- Chat orchestration behavior (`integration_setup`)
- MCP auto-connect readiness checks

Source: `src/electron/mcp/connectors/capabilities.ts`

### Tool actions

`integration_setup` now supports:

- `list`
- `inspect`
- `configure`

#### `list`

Returns all Tier-1 providers with:

- install status
- config readiness
- connection status
- auth methods
- setup docs links

#### `inspect`

Returns deterministic planning info for a single provider:

- `missing_inputs`
- selected auth method
- current install/connect/config readiness
- `plan_hash` for safe apply

#### `configure`

Applies configuration and can perform install/connect/health/OAuth.

Core behavior:

1. Optional install from MCP registry
2. Env merge and readiness evaluation
3. Optional OAuth flow and token materialization
4. Optional connect (`connect_now` defaults to true)
5. Optional health check (`<provider>.health`)
6. Return updated `plan_hash`

### Input contract

`integration_setup` accepts:

- `action`: `list | inspect | configure`
- `provider`: Tier-1 provider id
- `auth_method`: `auto | api_key | oauth`
- `env`: key/value env overrides
- `oauth`: optional OAuth bootstrap object
  - `client_id`
  - `client_secret`
  - `scopes[]`
  - `login_url`
  - `subdomain`
  - `team_domain`
- `expected_plan_hash`: stale-plan guard token from `inspect`
- `dry_run`: compute-only, no writes or OAuth launch

Backward-compatible Resend shortcuts are still supported:

- `api_key`
- `base_url`
- `enable_inbound`
- `webhook_secret`
- `allow_unsafe_external_content`

### Plan-hash safety contract

`inspect` emits a deterministic `plan_hash` computed from provider state:

- provider id
- auth selection
- installed/connected status
- missing input fields
- env fingerprint
- (Resend only) inbound state snapshot

If `configure.expected_plan_hash` is provided and differs from current state, configure fails safely with:

- `success: false`
- `stale_plan: true`
- no mutation

### OAuth mapping behavior

When OAuth succeeds, provider tokens are written into connector env:

- Jira -> `JIRA_ACCESS_TOKEN`, optional `JIRA_REFRESH_TOKEN`, auto-fill `JIRA_BASE_URL` from OAuth resources when available
- HubSpot -> `HUBSPOT_ACCESS_TOKEN`, optional `HUBSPOT_REFRESH_TOKEN`
- Slack -> `SLACK_ACCESS_TOKEN`, optional `SLACK_REFRESH_TOKEN`
- Gmail / Google Calendar / Google Drive -> `GOOGLE_ACCESS_TOKEN`, optional `GOOGLE_REFRESH_TOKEN`

Client credentials are also persisted where applicable:

- Jira: `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`
- HubSpot: `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`
- Slack: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`
- Google family: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`

### Resend inbound specialization

Inbound setup remains explicitly provider-scoped to `resend`.

If `enable_inbound=true` during configure:

- hooks are enabled if disabled
- Resend preset is added
- optional signing secret is persisted
- endpoint state is returned (`/hooks/resend` path based on hooks base path)

---

## 2) Approval-Gated Skill Expansion

### New tool

`skill_proposal` is now available with actions:

- `create`
- `list`
- `approve`
- `reject`

Source: `src/electron/agent/tools/registry.ts`

### Persistence

Proposals are persisted per workspace at:

- `.cowork/skills/proposals/<proposal-id>.json`

Source: `src/electron/agent/skills/SkillProposalService.ts`

### Proposal record model

Each proposal stores:

- problem statement
- evidence snippets
- required tools
- risk note
- draft skill payload
- lifecycle metadata (`pending | approved | rejected` + timestamps)
- signature hash used for duplicate/cooldown checks

### Lifecycle and safeguards

#### `create`

- Creates proposal record only
- Does not write or mutate any skill
- Emits structured task log event for traceability

#### `approve`

Approval materializes a skill into workspace scope only:

- target directory: `<workspace>/skills`
- uses existing create/update skill path
- blocks mutation if required tools are unavailable
- validates placeholder integrity (`{{placeholder}}` must match declared parameter names)
- blocks writes into bundled skills

#### `reject`

- Marks proposal rejected
- Stores optional rejection reason

### Duplicate and cooldown policy

Signature dedupe logic:

- duplicate pending/approved proposals are rejected immediately
- rejected duplicates are blocked for 24 hours (`cooldown_until` returned)

### Capability-gap detection hook

Executor now watches repeated tool/integration-unavailable patterns in a run.
When repeated failures are detected, it injects a hint to create `skill_proposal` instead of looping.

This is advisory only; no automatic skill mutation occurs.

---

## 3) Workspace Bootstrap Lifecycle

### Required kit files expanded

Workspace kit required set now includes:

- `.cowork/BOOTSTRAP.md`
- `.cowork/VIBES.md`
- `.cowork/LORE.md`

Source: `src/electron/ipc/handlers.ts`

### New lifecycle state file

State is persisted at:

- `.cowork/workspace-state.json`

Current schema:

```json
{
  "version": 1,
  "bootstrapSeededAt": 0,
  "onboardingCompletedAt": 0
}
```

### Lifecycle rules

1. If `BOOTSTRAP.md` exists and `bootstrapSeededAt` is empty, seed `bootstrapSeededAt`.
2. If `BOOTSTRAP.md` is later removed and `bootstrapSeededAt` exists, set `onboardingCompletedAt`.
3. During `KIT_INIT` in `missing` mode, `BOOTSTRAP.md` is not recreated if onboarding is already completed.

### Status payload extension

`WorkspaceKitStatus` now includes onboarding metadata:

- `bootstrapSeededAt`
- `onboardingCompletedAt`
- `bootstrapPresent`

Source: `src/shared/types.ts`

---

## 4) Heartbeat Proactive Frequency Contract

Heartbeat now enforces per-task cadence using `frequencyMinutes` in each proactive task.

Behavior:

- Tasks run only when due, not every heartbeat cycle
- Last-run timestamp tracked in memory by key: `<agentId>:<taskId>`
- `frequencyMinutes` is normalized to a minimum of `1`
- If missing/invalid, default frequency is `15` minutes
- Task run-state is cleared when heartbeat service stops or agent heartbeat is canceled

Important execution detail:

- Due proactive tasks are now evaluated before work/no-work decision, so proactive tasks can independently trigger heartbeat work

Source: `src/electron/agents/HeartbeatService.ts`

---

## 5) Manual Validation Matrix

Use this matrix for release and support verification.

### Integration setup

1. `integration_setup(action="list")` returns exactly 8 Tier-1 providers.
2. `inspect` returns `missing_inputs` and a stable `plan_hash`.
3. `configure` with stale `expected_plan_hash` fails with `stale_plan=true` and no mutation.
4. OAuth success persists access/refresh env and reports configured state.
5. OAuth denial/error returns actionable failure.
6. Resend inbound setup remains functional and provider-scoped.

### Skill proposals

1. `skill_proposal.create` creates proposal JSON only.
2. `skill_proposal.approve` materializes workspace skill and updates proposal state.
3. `skill_proposal.reject` records rejection.
4. Re-submitting rejected duplicate within 24h returns cooldown block.

### Kit + heartbeat

1. Kit init creates `BOOTSTRAP.md`, `VIBES.md`, `LORE.md`.
2. Kit status includes onboarding state fields.
3. Deleting `BOOTSTRAP.md` marks onboarding completed in workspace state.
4. Proactive tasks respect `frequencyMinutes` and do not run each heartbeat.

---

## 6) Compatibility Notes

- Existing Resend setup payloads remain supported.
- Existing Settings/UI OAuth flows are unchanged and remain available.
- New chat integration flow layers on top of current MCP settings and connector registry.
- Skill auto-mutation remains disabled by default; approval is mandatory through `skill_proposal.approve`.
