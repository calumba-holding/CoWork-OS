import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Sidebar } from "../Sidebar";

describe("Sidebar top-level destinations", () => {
  it("renders the Agents destination alongside Mission Control", () => {
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
    expect(markup).toContain("Mission Control");
    expect(markup).toContain("aria-pressed=\"true\"");
  });
});
