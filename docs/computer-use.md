# Computer use (macOS)

Computer use lets the agent drive **native macOS applications** through real mouse, keyboard, and screen capture—when integrations, browser automation, and shell are not the right tool for the job.

This page is the **authoritative product guide** for the feature. For a short summary, see [Features → Computer use](features.md#computer-use-macos).

## What it is for

Use computer use when the task clearly requires **a desktop GUI** that is not exposed through a stable API or through the in-app browser tools—for example:

- Operating a native app’s windows, menus, or dialogs
- Filling fields or clicking controls that only exist in a desktop UI
- Short, bounded flows where scripting the UI is impractical

**Prefer instead** when possible:

- **MCP connectors and APIs** for SaaS and internal systems
- **`browser_*` tools** for web surfaces (even if the user says “browser” in passing)
- **`run_command` / scripts** for file, git, and CLI workflows
- **`open_application`** to launch an app; pair with `computer_*` only when the agent must then interact with that app’s UI

The planner and tool policy treat `computer_*` as a **controlled, last-resort lane**: tools stay deferred unless the task signals **native desktop GUI intent** (for example Calculator, System Settings, or “click the OK button in the native dialog”). That keeps routine coding and web work from accidentally taking the desktop-control path.

## Platform requirements

- **macOS only** today. The `computer_*` family is not available on Windows or Linux builds in the same form.
- **CoWork OS must be the app receiving OS permissions** (see below). Permissions are per-app; granting them to Terminal or another helper does not substitute.

## macOS permissions

Two system permissions gate computer use:

| Permission | Why it matters |
|------------|----------------|
| **Accessibility** | Synthetic mouse and keyboard events and many automation paths require the app to be trusted for accessibility control. |
| **Screen Recording** | Capturing the desktop for `computer_screenshot` and related flows uses Electron’s screen capture APIs, which macOS treats as screen recording. |

**Where to enable in the product**

1. Open **Settings → Tools** (or the dedicated **Computer use** panel when present).
2. Use the shortcuts into **System Settings** to enable **Accessibility** and **Screen Recording** for CoWork OS.
3. After changing **Screen Recording**, **quit and restart CoWork OS** if capture still fails—macOS sometimes caches the old state until restart.

If a tool returns an error mentioning screen capture timeout or permission, re-check Screen Recording for this app and restart.

## Session model (one active session)

Computer use runs under a **single global session** on the machine:

- Only **one** computer-use session is active at a time; starting control for a new task coordinates with the session manager.
- When a session is active, a **translucent safety overlay** makes it obvious the agent is controlling the desktop.
- **Esc** aborts the active computer-use session so you can interrupt quickly without hunting in the UI.
- **Window isolation** and **shortcut guard** reduce the chance of stray clicks affecting the wrong surface or global hotkeys firing at the wrong time during automation.

The session is torn down when the task finishes or the session ends cleanly after abort.

## Per-app consent (not per click)

High-risk desktop automation uses **per-app session consent** instead of approving every single pointer or key event:

- The first time the agent needs to affect a given **application** in a session, you may see a **consent dialog** with the app name and a suggested access tier.
- **Consent is scoped to the current computer-use session** (and the app in question), not stored as unlimited forever-access without context.
- You can choose a tier that matches risk:

| Tier | Typical use |
|------|-------------|
| **`view_only`** | Screenshots and mouse movement only—no clicks or typing into that app. |
| **`click_only`** | `computer_screenshot`, `computer_move_mouse`, and `computer_click` only—no `computer_type` or `computer_key`. |
| **`full_control`** | Clicks, keys, and screenshots as needed for the flow—use only when you trust the task and the app. |
| **`denied`** | Block automation for that app for the session. |

The product may show **classifier-driven warnings** for sensitive surfaces (for example browsers, terminals/IDEs, Finder, or System Settings). Treat those as intentional friction: those apps amplify blast radius if mis-automated.

## Built-in tools (`computer_*`)

All of these are part of the **`computer_use` built-in tool family**. They are registered together and can be enabled or prioritized alongside other built-in categories in **Settings → Tools → Built-in tools**.

| Tool | Role |
|------|------|
| `computer_screenshot` | Capture the current desktop (or relevant surface) for vision-backed planning and verification. |
| `computer_move_mouse` | Move the cursor without clicking—useful for hover states and safe positioning. |
| `computer_click` | Click (including multi-click variants where supported). |
| `computer_type` | Type text into the focused element. |
| `computer_key` | Emit key chords or special keys; dangerous combinations are blocklisted at the tool layer. |

Timeouts and error messages are designed to surface permission or capture issues clearly rather than failing silently.

## Related tools: `open_application`

`open_application` can launch macOS apps by name or bundle id. For **native GUI workflows**, policy may allow `open_application` in the same steps as `computer_*` so the agent can start the target app before driving it. That is separate from **shell**-based AppleScript or one-off scripts: when the goal is **GUI interaction**, the product steers toward **`computer_*`** (and `open_application` when needed) rather than `run_applescript` as a first choice.

## Routing and planner behavior (operator mental model)

Rough order the stack encourages:

1. **Structured integrations** (MCP, APIs, mail, channels).
2. **Browser tools** for web UIs.
3. **Shell and file tools** for repo and CLI work.
4. **`open_application`** when the missing piece is “the app is not running.”
5. **`computer_*`** when the task still requires **native GUI** interaction.

**Native desktop GUI intent** is detected from the **user goal and step text** (not only from generic words like “browser” in strategy headers). Explicit mentions of native apps, windows, dialogs, or on-screen UI tend to unlock the computer-use lane; purely web or repo tasks should not.

## Settings checklist

1. **Built-in tools**: Confirm the `computer_use` category is enabled if you want the agent to use this lane at all.
2. **Permissions**: Accessibility + Screen Recording granted for CoWork OS; restart after Screen Recording changes if needed.
3. **Risk tolerance**: Prefer **`view_only`** or **`click_only`** when full keyboard control is unnecessary.

## Security and abuse considerations

Computer use is **high trust**: a mistaken or malicious task could operate any UI your user can reach. Mitigations include:

- Session-wide overlay, Esc abort, and isolation/guard layers
- Per-app tiers and warnings on sensitive app classes
- Policy that keeps `computer_*` off the default path unless GUI intent is clear
- Blocklisted key combinations that could disrupt the session or OS

For how this fits the wider tool-risk model, see [Security guide → Computer use](security-guide.md#computer-use-macos-security).

## Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| Screenshot or capture errors / timeouts | Screen Recording for CoWork OS; restart app after granting. |
| Clicks or keys do nothing | Accessibility trust for CoWork OS; no other app stealing focus unexpectedly. |
| Agent uses shell or browser instead of desktop | Task may not read as native GUI; rephrase with explicit app/window/dialog language, or ensure built-in `computer_use` is enabled. |
| Constant consent prompts | Expected when crossing **app** boundaries or escalating tier; not every click should prompt—that is by design. |
| Session feels “stuck” | Use **Esc** to abort the computer-use session, then cancel or adjust the task. |

## Implementation map (for contributors)

| Area | Location |
|------|----------|
| Tool definitions and execution | `src/electron/agent/tools/computer-use-tools.ts` |
| Session lifecycle, overlay integration | `src/electron/computer-use/session-manager.ts`, `safety-overlay.ts`, `window-isolation.ts`, `shortcut-guard.ts` |
| macOS permission helpers | `src/electron/computer-use/computer-use-permissions.ts` |
| Per-app consent | `src/electron/security/app-permission-manager.ts`, renderer approval UI |
| Policy / routing | `src/electron/agent/tool-policy-engine.ts`, `src/electron/agent/executor.ts` |
| Settings / IPC | `src/renderer/components/ComputerUseSettings.tsx`, `ComputerUseApprovalDialog.tsx`, IPC handlers |

---

**See also:** [Architecture](architecture.md), [Features](features.md), [Security guide](security-guide.md), [Operator runtime visibility](operator-runtime-visibility.md).
