# Trust Boundaries

Understanding the security boundaries in CoWork OS helps you configure appropriate access controls.

## Workspace Boundary

```
+------------------------------------------+
|              Workspace                    |
|  +------------------------------------+  |
|  |     Files & Directories            |  |
|  |  - Source code                     |  |
|  |  - Configuration                   |  |
|  |  - Generated artifacts             |  |
|  +------------------------------------+  |
|                                          |
|  Permissions:                            |
|  - read, write, delete                   |
|  - shell (command execution)             |
|  - network (browser/web access)          |
+------------------------------------------+
         |
         | Allowed Paths (optional)
         v
+------------------------------------------+
|           External Paths                  |
|  - ~/Documents (if configured)           |
|  - /shared/projects (if configured)      |
+------------------------------------------+
```

### Workspace Isolation

Each workspace operates in isolation:
- Tools can only access files within the workspace by default
- External paths require explicit configuration
- Different workspaces cannot access each other's files

### Unrestricted Mode

When `unrestrictedFileAccess` is enabled:
- Tools can read/write files anywhere the user has permission
- Protected system paths are still blocked
- Use only for development workflows requiring broad access

## Channel Boundary

```
+------------------------------------------+
|           External Channel                |
|  (Telegram, Discord, Slack, etc.)        |
+------------------------------------------+
         |
         | Security Mode
         v
+------------------------------------------+
|         Security Layer                    |
|  - Pairing code verification             |
|  - Allowlist checking                    |
|  - User authentication                   |
+------------------------------------------+
         |
         | Context Policy
         v
+------------------------------------------+
|         Context Restrictions              |
|  DM: Full access                          |
|  Group: Memory tools blocked              |
+------------------------------------------+
         |
         v
+------------------------------------------+
|         CoWork OS Processing              |
+------------------------------------------+
```

### Channel Trust Levels

| Level | How Users Get It | Capabilities |
|-------|------------------|--------------|
| Untrusted | Default for unknown users | Access denied |
| Paired | Entered valid pairing code | Full context access |
| Allowlisted | Pre-configured in settings | Full context access |
| Open Mode | Any user | Full context access |

### Context-Based Restrictions

Even after authentication, capabilities vary by context:

**DM Context:**
- Full tool access
- No memory restrictions
- Clipboard read/write allowed

**Group Context:**
- Memory tools blocked (clipboard)
- Prevents data leakage to other group members
- Other tools function normally

## Network Boundary

```
+------------------------------------------+
|           CoWork OS                       |
+------------------------------------------+
         |
         | Network Permission
         v
+------------------------------------------+
|         Browser / Web Tools               |
|  - browser_navigate                       |
|  - browser_get_content                    |
|  - web_search                             |
+------------------------------------------+
         |
         | Domain Allowlist (optional)
         v
+------------------------------------------+
|           External Networks               |
|  - Internet (if network=true)            |
|  - Localhost only (if network=false)     |
+------------------------------------------+
```

### Network Controls

**Workspace Level:**
- `network: true` enables browser/web tools
- `network: false` blocks all external network access

**Guardrail Level:**
- `enforceAllowedDomains: true` limits to specific domains
- Domain allowlist restricts which sites can be accessed

**Sandbox Level:**
- Docker: `--network none` by default
- macOS: localhost only unless explicitly allowed

## Tool Boundary

```
+------------------------------------------+
|           Tool Execution                  |
+------------------------------------------+
         |
         | Permission Engine
         v
+------------------------------------------+
|         Policy Manager                    |
|  - Hard restrictions / denylist           |
|  - Guardrails / dangerous commands        |
|  - Workspace capability gates             |
|  - Workspace policy script                |
|  - Explicit permission rules              |
|  - Mode defaults and fallback escalation  |
+------------------------------------------+
         |
         | Allow / Deny / Ask
         v
+------------------------------------------+
|         User Approval / Rule Persistence   |
|  - Review exact reason and scope           |
|  - Approve or deny                         |
|  - Persist session/workspace/profile rules |
+------------------------------------------+
         |
         v
+------------------------------------------+
|         Sandboxed Execution               |
+------------------------------------------+
```

### Tool Risk Levels

| Risk Level | Examples | Behavior |
|------------|----------|----------|
| Read | read_file, list_directory | Auto-allowed if read permission |
| Write | write_file, create_directory | Auto-allowed if write permission and no rule blocks it |
| Destructive | delete_file, run_command | Usually prompts unless a rule or mode changes the outcome |
| System | screenshot, clipboard | Context-dependent |
| Network | browser_navigate | Requires network permission and may still prompt under default mode |

### Approval Gates

Some operations usually require user approval:
- Shell command execution
- File deletion
- Destructive operations
- External side effects without matching allow rules

The approval shows:
- Tool name and description
- Parameters being used
- Exact reason and matched rule when available
- Allows user to approve or deny

Workspace-local rules can also be browsed and removed from Settings so the current policy is
visible without waiting for the next prompt.

## Trust Hierarchy

```
Most Trusted
    |
    +-- Local Desktop UI
    |     - Direct user interaction
    |     - Full approval capability
    |
    +-- Private DM (Paired)
    |     - Authenticated user
    |     - Full tool access
    |
    +-- Group Chat (Paired)
    |     - Authenticated user
    |     - Memory tools restricted
    |
    +-- Open Mode
    |     - Any user
    |     - Same as paired access
    |
    +-- Unknown User
          - No access
          - Must pair first
Least Trusted
```
