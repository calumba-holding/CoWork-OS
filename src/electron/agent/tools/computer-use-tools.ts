import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as crypto from "crypto";
import { Workspace } from "../../../shared/types";
import { AgentDaemon } from "../daemon";
import { LLMTool } from "../llm/types";
import type { AppAccessLevel } from "../../security/app-permission-manager";
import { ComputerUseSessionManager } from "../../computer-use/session-manager";
import {
  getMacScreenCaptureAccessStatus,
  checkAccessibilityTrusted,
} from "../../computer-use/computer-use-permissions";

type Any = any; // oxlint-disable-line typescript-eslint(no-explicit-any)

const execAsync = promisify(exec);

const CUA_ACTION_TIMEOUT_MS = 15_000;
const SCREENSHOT_MAX_DIMENSION = 2560;
const DESKTOP_CAPTURER_TIMEOUT_MS = 12_000;

/**
 * Blocked key combinations that must never be emitted during computer use.
 * These are OS-level shortcuts that could disrupt the session or compromise safety.
 */
const BLOCKED_KEY_COMBOS = new Set([
  "cmd+tab",
  "command+tab",
  "cmd+space",
  "command+space",
  "cmd+q",
  "command+q",
  "cmd+option+esc",
  "command+option+escape",
  "ctrl+alt+delete",
]);

function normalizeKeysForBlocklist(keys: string[]): string {
  return keys.map((k) => k.toLowerCase().trim()).sort().join("+");
}

function getElectronScreen(): Any {
  try {
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    return electron?.screen;
  } catch {
    return undefined;
  }
}

function getElectronDesktopCapturer(): Any {
  try {
    // oxlint-disable-next-line typescript-eslint(no-require-imports)
    const electron = require("electron") as Any;
    return electron?.desktopCapturer;
  } catch {
    return undefined;
  }
}

export type CUAClickButton = "left" | "right" | "middle";
export type CUAClickType = "single" | "double" | "triple";

export interface CUAScreenshotResult {
  base64: string;
  width: number;
  height: number;
  hash: string;
}

async function getDesktopSourcesWithTimeout(
  desktopCapturer: Any,
  opts: { types: string[]; thumbnailSize: { width: number; height: number } },
  timeoutMs: number,
): Promise<Any[]> {
  const promise = desktopCapturer.getSources(opts);
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(
        new Error(
          "Screen capture timed out. Grant Screen Recording for CoWork OS in System Settings > Privacy & Security > Screen Recording, then restart the app if needed.",
        ),
      );
    }, timeoutMs);
  });
  return (await Promise.race([promise, timeout])) as Any[];
}

/**
 * ComputerUseTools provides native OS-level mouse, keyboard, and screenshot
 * control for computer use agent (CUA) workflows.
 *
 * On macOS this uses AppleScript / CoreGraphics via shell commands.
 * A single computer-use session per machine applies: per-app consent for the session,
 * safety overlay, and Esc to stop.
 */
export class ComputerUseTools {
  private lastScreenshotHash: string | null = null;

  constructor(
    private workspace: Workspace,
    private daemon: AgentDaemon,
    private taskId: string,
  ) {}

  setWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  private session(): ComputerUseSessionManager {
    return ComputerUseSessionManager.getInstance();
  }

  private pm() {
    return this.session().acquire(this.taskId, this.daemon);
  }

  // ───────────── Accessibility permission check ─────────────

  /**
   * Check (and optionally prompt) for macOS Accessibility permission.
   * Returns true if granted.
   */
  async checkAccessibilityPermission(): Promise<boolean> {
    if (os.platform() !== "darwin") {
      return false;
    }
    return checkAccessibilityTrusted(true);
  }

  private async ensureAccessibility(): Promise<void> {
    if (os.platform() !== "darwin") {
      throw new Error("Computer use tools are currently only supported on macOS");
    }
    const granted = await this.checkAccessibilityPermission();
    if (!granted) {
      throw new Error(
        "Accessibility permission is required for computer use. " +
          "Please grant access in System Settings > Privacy & Security > Accessibility.",
      );
    }
  }

  private async ensureScreenCaptureAllowed(): Promise<void> {
    if (os.platform() !== "darwin") return;
    const status = getMacScreenCaptureAccessStatus();
    if (status === "denied") {
      throw new Error(
        "Screen Recording is denied for CoWork OS. Enable it in System Settings > Privacy & Security > Screen Recording, then restart the app.",
      );
    }
    // "not-determined" / "unknown" — still attempt capture (may prompt / register app)
  }

  private async ensureAppPermission(
    toolName: string,
    minimumLevel: AppAccessLevel,
    reason: string,
  ): Promise<{ name: string; bundleId: string }> {
    this.session().checkNotAborted();
    const pm = this.pm();
    const app = await this.getFrontmostApp();
    const existing = pm.getPermission(app.name, app.bundleId);
    if (!existing || !pm.isToolAllowed(app.name, toolName, app.bundleId)) {
      const granted = await pm.requestPermission(app.name, app.bundleId, minimumLevel, reason);
      if (granted === "denied" || !pm.isToolAllowed(app.name, toolName, app.bundleId)) {
        throw new Error(
          `Computer use access for ${app.name} is not approved for this session (${minimumLevel}).`,
        );
      }
      await this.session().onAppPermissionGranted();
    }

    return app;
  }

  // ───────────── Mouse control ─────────────

  async moveMouse(x: number, y: number): Promise<{ success: boolean; x: number; y: number }> {
    await this.ensureAccessibility();
    this.session().updateActionStatus("Moving pointer…");
    const app = await this.ensureAppPermission(
      "computer_move_mouse",
      "view_only",
      "Move the cursor in the frontmost application.",
    );

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "computer_move_mouse",
      appName: app.name,
      bundleId: app.bundleId,
      x,
      y,
    });

    try {
      const script = `
do shell script "python3 -c '
import Quartz
Quartz.CGEventPost(Quartz.kCGHIDEventTap, Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${x}, ${y}), Quartz.kCGMouseButtonLeft))
'"`;
      await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        timeout: CUA_ACTION_TIMEOUT_MS,
      });

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "computer_move_mouse",
        success: true,
      });

      return { success: true, x, y };
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "computer_move_mouse",
        error: error.message,
      });
      throw new Error(`Failed to move mouse: ${error.message}`);
    }
  }

  async click(
    x: number,
    y: number,
    button: CUAClickButton = "left",
    clickType: CUAClickType = "single",
  ): Promise<{ success: boolean; x: number; y: number }> {
    await this.ensureAccessibility();
    this.session().updateActionStatus("Clicking…");
    const app = await this.ensureAppPermission(
      "computer_click",
      "click_only",
      "Send a click to the frontmost application.",
    );

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "computer_click",
      appName: app.name,
      bundleId: app.bundleId,
      x,
      y,
      button,
      clickType,
    });

    try {
      const clickCount = clickType === "double" ? 2 : clickType === "triple" ? 3 : 1;
      const mouseButton =
        button === "right"
          ? "Quartz.kCGMouseButtonRight"
          : button === "middle"
            ? "Quartz.kCGMouseButtonCenter"
            : "Quartz.kCGMouseButtonLeft";
      const downEvent =
        button === "right" ? "Quartz.kCGEventRightMouseDown" : "Quartz.kCGEventLeftMouseDown";
      const upEvent =
        button === "right" ? "Quartz.kCGEventRightMouseUp" : "Quartz.kCGEventLeftMouseUp";

      const pyScript = `
import Quartz, time
pos = (${x}, ${y})
for i in range(${clickCount}):
    down = Quartz.CGEventCreateMouseEvent(None, ${downEvent}, pos, ${mouseButton})
    Quartz.CGEventSetIntegerValueField(down, Quartz.kCGMouseEventClickState, i + 1)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
    up = Quartz.CGEventCreateMouseEvent(None, ${upEvent}, pos, ${mouseButton})
    Quartz.CGEventSetIntegerValueField(up, Quartz.kCGMouseEventClickState, i + 1)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
    if i < ${clickCount} - 1:
        time.sleep(0.05)
`;
      await execAsync(`python3 -c ${JSON.stringify(pyScript)}`, {
        timeout: CUA_ACTION_TIMEOUT_MS,
      });

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "computer_click",
        success: true,
      });

      return { success: true, x, y };
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "computer_click",
        error: error.message,
      });
      throw new Error(`Failed to click: ${error.message}`);
    }
  }

  async drag(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): Promise<{ success: boolean }> {
    await this.ensureAccessibility();
    this.session().updateActionStatus("Dragging…");
    const app = await this.ensureAppPermission(
      "computer_click",
      "click_only",
      "Drag inside the frontmost application.",
    );

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "computer_click",
      appName: app.name,
      bundleId: app.bundleId,
      action: "drag",
      fromX,
      fromY,
      toX,
      toY,
    });

    try {
      const pyScript = `
import Quartz, time
start = (${fromX}, ${fromY})
end = (${toX}, ${toY})
down = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, start, Quartz.kCGMouseButtonLeft)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, down)
time.sleep(0.1)
steps = 20
for i in range(1, steps + 1):
    t = i / steps
    cx = start[0] + (end[0] - start[0]) * t
    cy = start[1] + (end[1] - start[1]) * t
    drag = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDragged, (cx, cy), Quartz.kCGMouseButtonLeft)
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, drag)
    time.sleep(0.01)
up = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, end, Quartz.kCGMouseButtonLeft)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, up)
`;
      await execAsync(`python3 -c ${JSON.stringify(pyScript)}`, {
        timeout: CUA_ACTION_TIMEOUT_MS,
      });

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "computer_click",
        action: "drag",
        success: true,
      });

      return { success: true };
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "computer_click",
        action: "drag",
        error: error.message,
      });
      throw new Error(`Failed to drag: ${error.message}`);
    }
  }

  async typeText(text: string): Promise<{ success: boolean; length: number }> {
    if (!text || typeof text !== "string") {
      throw new Error("Invalid text: must be a non-empty string");
    }

    await this.ensureAccessibility();
    this.session().updateActionStatus("Typing…");
    const app = await this.ensureAppPermission(
      "computer_type",
      "full_control",
      "Type text into the frontmost application.",
    );

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "computer_type",
      appName: app.name,
      bundleId: app.bundleId,
      textLength: text.length,
    });

    try {
      const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const script = `tell application "System Events" to keystroke "${escaped}"`;
      await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        timeout: CUA_ACTION_TIMEOUT_MS,
      });

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "computer_type",
        success: true,
      });

      return { success: true, length: text.length };
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "computer_type",
        error: error.message,
      });
      throw new Error(`Failed to type text: ${error.message}`);
    }
  }

  async pressKeys(keys: string[]): Promise<{ success: boolean; keys: string[] }> {
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error("Invalid keys: must be a non-empty array of key names");
    }

    const normalized = normalizeKeysForBlocklist(keys);
    if (BLOCKED_KEY_COMBOS.has(normalized)) {
      throw new Error(
        `Blocked key combination: ${keys.join("+")}. ` +
          "This system shortcut is not allowed during computer use sessions.",
      );
    }

    await this.ensureAccessibility();
    this.session().updateActionStatus("Key input…");
    const app = await this.ensureAppPermission(
      "computer_key",
      "full_control",
      "Send keyboard input to the frontmost application.",
    );

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "computer_key",
      appName: app.name,
      bundleId: app.bundleId,
      keys,
    });

    try {
      const modifiers: string[] = [];
      let keyChar: string | null = null;
      let keyCode: number | null = null;

      for (const k of keys) {
        const lower = k.toLowerCase().trim();
        if (lower === "cmd" || lower === "command") {
          modifiers.push("command down");
        } else if (lower === "ctrl" || lower === "control") {
          modifiers.push("control down");
        } else if (lower === "alt" || lower === "option") {
          modifiers.push("option down");
        } else if (lower === "shift") {
          modifiers.push("shift down");
        } else if (lower === "return" || lower === "enter") {
          keyCode = 36;
        } else if (lower === "escape" || lower === "esc") {
          keyCode = 53;
        } else if (lower === "tab") {
          keyCode = 48;
        } else if (lower === "space") {
          keyCode = 49;
        } else if (lower === "delete" || lower === "backspace") {
          keyCode = 51;
        } else if (lower === "up") {
          keyCode = 126;
        } else if (lower === "down") {
          keyCode = 125;
        } else if (lower === "left") {
          keyCode = 123;
        } else if (lower === "right") {
          keyCode = 124;
        } else if (lower.startsWith("f") && /^f\d{1,2}$/.test(lower)) {
          const fkeyMap: Record<string, number> = {
            f1: 122,
            f2: 120,
            f3: 99,
            f4: 118,
            f5: 96,
            f6: 97,
            f7: 98,
            f8: 100,
            f9: 101,
            f10: 109,
            f11: 103,
            f12: 111,
          };
          keyCode = fkeyMap[lower] ?? null;
        } else if (lower.length === 1) {
          keyChar = lower;
        } else {
          keyChar = k;
        }
      }

      const modString = modifiers.length > 0 ? ` using {${modifiers.join(", ")}}` : "";
      let script: string;
      if (keyCode !== null) {
        script = `tell application "System Events" to key code ${keyCode}${modString}`;
      } else if (keyChar !== null) {
        const escaped = keyChar.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        script = `tell application "System Events" to keystroke "${escaped}"${modString}`;
      } else {
        throw new Error(`Could not resolve key combination: ${keys.join("+")}`);
      }

      await execAsync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, {
        timeout: CUA_ACTION_TIMEOUT_MS,
      });

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "computer_key",
        success: true,
      });

      return { success: true, keys };
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "computer_key",
        error: error.message,
      });
      throw new Error(`Failed to press keys: ${error.message}`);
    }
  }

  async takeScreenshot(): Promise<CUAScreenshotResult> {
    await this.ensureScreenCaptureAllowed();
    this.session().updateActionStatus("Capturing screen…");
    const app = await this.ensureAppPermission(
      "computer_screenshot",
      "view_only",
      "Capture a screenshot of the screen for the frontmost application context.",
    );
    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "computer_screenshot",
      appName: app.name,
      bundleId: app.bundleId,
    });

    try {
      const desktopCapturer = getElectronDesktopCapturer();
      if (!desktopCapturer) {
        throw new Error("Screenshot capture is only available in the desktop (Electron) runtime");
      }

      const electronScreen = getElectronScreen();
      const display = electronScreen?.getPrimaryDisplay();
      const scaleFactor = display?.scaleFactor ?? 2;
      const workArea = display?.workAreaSize ?? { width: 1920, height: 1080 };

      const captureWidth = Math.min(workArea.width * scaleFactor, SCREENSHOT_MAX_DIMENSION);
      const captureHeight = Math.min(workArea.height * scaleFactor, SCREENSHOT_MAX_DIMENSION);

      const sources = await getDesktopSourcesWithTimeout(
        desktopCapturer,
        {
          types: ["screen"],
          thumbnailSize: { width: captureWidth, height: captureHeight },
        },
        DESKTOP_CAPTURER_TIMEOUT_MS,
      );

      if (sources.length === 0) {
        throw new Error("No screen sources available for capture");
      }

      const primaryId = display?.id;
      let primaryScreen = sources[0];
      if (primaryId !== undefined) {
        const match = sources.find((s: Any) => String(s.display_id) === String(primaryId));
        if (match) primaryScreen = match;
      }

      const image = primaryScreen.thumbnail;

      if (image.isEmpty()) {
        throw new Error(
          "Failed to capture screenshot — image is empty. Check Screen Recording permission and restart CoWork OS after granting.",
        );
      }

      const pngData = image.toPNG();
      const base64 = pngData.toString("base64");
      const hash = crypto.createHash("sha256").update(pngData).digest("hex").slice(0, 16);
      const size = image.getSize();

      this.lastScreenshotHash = hash;

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "computer_screenshot",
        success: true,
        width: size.width,
        height: size.height,
      });

      return {
        base64,
        width: size.width,
        height: size.height,
        hash,
      };
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "computer_screenshot",
        error: error.message,
      });
      throw new Error(`Failed to take screenshot: ${error.message}`);
    }
  }

  async detectScreenChange(): Promise<{ changed: boolean; previousHash: string | null; currentHash: string }> {
    const previousHash = this.lastScreenshotHash;
    const fresh = await this.takeScreenshot();
    return {
      changed: previousHash !== null && fresh.hash !== previousHash,
      previousHash,
      currentHash: fresh.hash,
    };
  }

  async getFrontmostApp(): Promise<{ name: string; bundleId: string }> {
    if (os.platform() !== "darwin") {
      throw new Error("Frontmost app detection is only supported on macOS");
    }

    try {
      const { stdout: appName } = await execAsync(
        `osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`,
        { timeout: 5000 },
      );
      const { stdout: bundleId } = await execAsync(
        `osascript -e 'tell application "System Events" to get bundle identifier of first process whose frontmost is true'`,
        { timeout: 5000 },
      );
      return {
        name: appName.trim(),
        bundleId: bundleId.trim(),
      };
    } catch (error: Any) {
      throw new Error(`Failed to detect frontmost app: ${error.message}`);
    }
  }

  async scroll(
    x: number,
    y: number,
    direction: "up" | "down" | "left" | "right",
    amount: number = 3,
  ): Promise<{ success: boolean }> {
    await this.ensureAccessibility();
    this.session().updateActionStatus("Scrolling…");
    const app = await this.ensureAppPermission(
      "computer_click",
      "click_only",
      "Scroll inside the frontmost application.",
    );

    this.daemon.logEvent(this.taskId, "tool_call", {
      tool: "computer_click",
      appName: app.name,
      bundleId: app.bundleId,
      action: "scroll",
      x,
      y,
      direction,
      amount,
    });

    try {
      const scrollY = direction === "up" ? amount : direction === "down" ? -amount : 0;
      const scrollX = direction === "left" ? amount : direction === "right" ? -amount : 0;

      const pyScript = `
import Quartz
move = Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, (${x}, ${y}), Quartz.kCGMouseButtonLeft)
Quartz.CGEventPost(Quartz.kCGHIDEventTap, move)
scroll = Quartz.CGEventCreateScrollWheelEvent(None, Quartz.kCGScrollEventUnitLine, 2, ${scrollY}, ${scrollX})
Quartz.CGEventPost(Quartz.kCGHIDEventTap, scroll)
`;
      await execAsync(`python3 -c ${JSON.stringify(pyScript)}`, {
        timeout: CUA_ACTION_TIMEOUT_MS,
      });

      this.daemon.logEvent(this.taskId, "tool_result", {
        tool: "computer_click",
        action: "scroll",
        success: true,
      });

      return { success: true };
    } catch (error: Any) {
      this.daemon.logEvent(this.taskId, "tool_error", {
        tool: "computer_click",
        action: "scroll",
        error: error.message,
      });
      throw new Error(`Failed to scroll: ${error.message}`);
    }
  }

  static getToolDefinitions(options?: { headless?: boolean }): LLMTool[] {
    if (options?.headless) {
      return [];
    }

    if (os.platform() !== "darwin") {
      return [];
    }

    return [
      {
        name: "computer_screenshot",
        description:
          "Take a screenshot of the current screen for visual analysis in native macOS apps. " +
          "Preferred for desktop GUI tasks after open_application launches the app. " +
          "Use this before computer_click / computer_type / computer_key so you can act on what is visible. Returns a base64-encoded PNG image.",
        input_schema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        name: "computer_click",
        description:
          "Click at specific screen coordinates in native macOS apps. Preferred for normal GUI interaction in apps like Calculator, Notes, Finder, System Settings, Xcode, and Simulator. " +
          "Use after taking a screenshot to interact with visible UI elements. Supports left/right/middle click, double-click, triple-click, drag, and scroll.",
        input_schema: {
          type: "object",
          properties: {
            x: {
              type: "number",
              description: "X coordinate on screen (pixels from left edge)",
            },
            y: {
              type: "number",
              description: "Y coordinate on screen (pixels from top edge)",
            },
            button: {
              type: "string",
              enum: ["left", "right", "middle"],
              description: "Mouse button to click (default: left)",
            },
            clickType: {
              type: "string",
              enum: ["single", "double", "triple"],
              description: "Click type (default: single)",
            },
            action: {
              type: "string",
              enum: ["click", "drag", "scroll"],
              description: "Action type (default: click). For drag, provide toX/toY. For scroll, provide direction.",
            },
            toX: {
              type: "number",
              description: "Destination X for drag action",
            },
            toY: {
              type: "number",
              description: "Destination Y for drag action",
            },
            direction: {
              type: "string",
              enum: ["up", "down", "left", "right"],
              description: "Scroll direction (for scroll action)",
            },
            amount: {
              type: "number",
              description: "Scroll amount in lines (default: 3, for scroll action)",
            },
          },
          required: ["x", "y"],
        },
      },
      {
        name: "computer_type",
        description:
          "Type text at the current cursor position using OS-level keyboard input in native macOS apps. " +
          "Preferred over run_applescript for entering text into focused GUI fields. " +
          "The text is typed character by character as real keyboard input.",
        input_schema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The text to type",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "computer_key",
        description:
          "Press a key combination using OS-level keyboard input in native macOS apps. " +
          "Preferred over run_applescript for shortcuts and non-text keys during GUI automation. " +
          "Use this for keyboard shortcuts like Cmd+C, Cmd+V, Return, Escape, etc. Provide an array of key names to press simultaneously. " +
          "Modifier keys: cmd/command, ctrl/control, alt/option, shift. " +
          "Special keys: return, escape, tab, space, delete, up, down, left, right, f1-f12.",
        input_schema: {
          type: "object",
          properties: {
            keys: {
              type: "array",
              items: { type: "string" },
              description:
                'Array of key names to press together, e.g. ["cmd", "c"] for Cmd+C, ' +
                '["return"] for Enter, ["cmd", "shift", "s"] for Cmd+Shift+S',
            },
          },
          required: ["keys"],
        },
      },
      {
        name: "computer_move_mouse",
        description:
          "Move the mouse cursor to specific screen coordinates without clicking in native macOS apps. " +
          "Use this to hover over elements or position the cursor before other computer_* actions.",
        input_schema: {
          type: "object",
          properties: {
            x: {
              type: "number",
              description: "X coordinate on screen (pixels from left edge)",
            },
            y: {
              type: "number",
              description: "Y coordinate on screen (pixels from top edge)",
            },
          },
          required: ["x", "y"],
        },
      },
    ];
  }
}
