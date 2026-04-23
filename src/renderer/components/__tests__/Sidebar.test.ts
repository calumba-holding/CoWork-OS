import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Sidebar } from "../Sidebar";

describe("Sidebar top-level destinations", () => {
  it("renders Agents as a primary destination and keeps More collapsed by default", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [] as Any,
        selectedTaskId: null,
        isAgentsActive: true,
        onSelectTask: () => {},
        onOpenHome: () => {},
        onOpenIdeas: () => {},
        onOpenInboxAgent: () => {},
        onOpenAgents: () => {},
        onOpenHealth: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onOpenMissionControl: () => {},
        onOpenDevices: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("Agents");
    expect(markup).toContain("More");
    expect(markup).not.toContain("Mission Control");
    expect(markup).toContain("aria-pressed=\"true\"");
  });

  it("expands More when a nested destination is active", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Sidebar, {
        workspace: { id: "ws-1", name: "Workspace", path: "/workspace" } as Any,
        tasks: [] as Any,
        selectedTaskId: null,
        isMissionControlActive: true,
        onSelectTask: () => {},
        onOpenHome: () => {},
        onOpenIdeas: () => {},
        onOpenInboxAgent: () => {},
        onOpenAgents: () => {},
        onOpenHealth: () => {},
        onNewSession: () => {},
        onOpenSettings: () => {},
        onOpenMissionControl: () => {},
        onOpenDevices: () => {},
        onTasksChanged: () => {},
      }),
    );

    expect(markup).toContain("aria-expanded=\"true\"");
    expect(markup).toContain("Mission Control");
  });
});
