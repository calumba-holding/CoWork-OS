import { describe, expect, it, vi } from "vitest";

vi.mock("../../security/policy-manager", () => ({
  isToolAllowedQuick: vi.fn(() => true),
}));

vi.mock("../../security/monty-tool-policy", () => ({
  evaluateMontyToolPolicy: vi.fn(async () => ({ decision: "pass", reason: null })),
}));

import { evaluateToolPolicyPipeline } from "../runtime/ToolPolicyPipeline";

describe("ToolPolicyPipeline", () => {
  const workspace = {
    id: "workspace-1",
    name: "Workspace",
    path: "/tmp/workspace",
    permissions: {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: true,
    },
    createdAt: Date.now(),
  } as Any;

  it("produces an allow trace for a permitted tool", async () => {
    const result = await evaluateToolPolicyPipeline({
      workspace,
      toolName: "read_file",
      toolInput: { path: "foo.ts" },
      policyContext: {
        executionMode: "execute",
        taskDomain: "code",
        shellEnabled: true,
      },
      availabilityContext: {
        executionMode: "execute",
        taskDomain: "code",
        shellEnabled: true,
        taskText: "read file",
      },
    });

    expect(result.decision).toBe("allow");
    expect(result.trace.entries.length).toBeGreaterThan(0);
    expect(result.trace.finalDecision).toBe("allow");
  });
});
