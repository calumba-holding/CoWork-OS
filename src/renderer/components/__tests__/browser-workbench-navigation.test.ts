import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentPath = fileURLToPath(new URL("../BrowserWorkbenchView.tsx", import.meta.url));

describe("Browser workbench navigation controls", () => {
  it("attaches webview listeners after the measured webview is rendered", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toMatch(/hasVisibleWebview,[\s\S]*webviewKey,/);
  });

  it("does not require the dom-ready flag before invoking toolbar navigation commands", () => {
    const source = readFileSync(componentPath, "utf8");
    const commandMatch = source.match(
      /const runWebviewCommand = useCallback\([\s\S]*?\n  \}, \[\]\);/,
    );

    expect(commandMatch?.[0]).not.toContain("!webviewDomReadyRef.current");
  });

  it("hides the browser profile pill when there is no active URL", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toMatch(/\{activeUrl && \(\s*<span className="browser-workbench-profile"/);
    expect(source).not.toContain('"workspace"');
    expect(source).not.toContain("Workspace browser");
  });

  it("listens for agent-driven viewport changes and exposes viewport presets", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("onBrowserWorkbenchViewport");
    expect(source).toContain("VIEWPORT_PRESETS");
    expect(source).toContain("browser-workbench-device-toolbar");
    expect(source).toContain("has-controlled-viewport");
  });

  it("exposes a toolbar action for opening the current page externally", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("openCurrentPageExternal");
    expect(source).toContain("window.electronAPI.openExternal(externalUrl)");
    expect(source).toContain('aria-label="Open current page in external browser"');
    expect(source).toContain("getExternalBrowserUrl");
  });
});
