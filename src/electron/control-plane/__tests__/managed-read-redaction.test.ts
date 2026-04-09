import { describe, expect, it } from "vitest";
import { redactManagedEnvironmentForRead } from "../handlers";

describe("redactManagedEnvironmentForRead", () => {
  it("removes sensitive linkage metadata from renderer-facing config", () => {
    const environment = {
      id: "env-1",
      name: "Test env",
      config: {
        workspaceId: "workspace-1",
        enableShell: true,
        credentialRefs: ["cred-1"],
        managedAccountRefs: ["acct-1"],
      },
    };

    const redacted = redactManagedEnvironmentForRead(environment);

    expect(redacted.config.workspaceId).toBe("workspace-1");
    expect(redacted.config.enableShell).toBe(true);
    expect(redacted.config.credentialRefs).toBeUndefined();
    expect(redacted.config.managedAccountRefs).toBeUndefined();
  });

  it("does not mutate the stored environment object", () => {
    const environment = {
      id: "env-1",
      name: "Test env",
      config: {
        workspaceId: "workspace-1",
        credentialRefs: ["cred-1"],
        managedAccountRefs: ["acct-1"],
      },
    };

    const redacted = redactManagedEnvironmentForRead(environment);

    expect(redacted).not.toBe(environment);
    expect(redacted.config).not.toBe(environment.config);
    expect(environment.config.credentialRefs).toEqual(["cred-1"]);
    expect(environment.config.managedAccountRefs).toEqual(["acct-1"]);
  });
});
