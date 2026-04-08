import { describe, expect, it } from "vitest";
import { buildScope, scopeToLabel } from "../PermissionSettingsPanel";

describe("PermissionSettingsPanel helpers", () => {
  it("renders domain-scoped rules without returning an object", () => {
    expect(
      scopeToLabel({
        kind: "domain",
        domain: "api.example.com",
        toolName: "http_request",
      }),
    ).toBe("Domain: api.example.com (http_request)");
  });

  it("builds a domain scope from the rule draft", () => {
    expect(
      buildScope({
        effect: "allow",
        scopeKind: "domain",
        toolName: "web_fetch",
        domain: "docs.example.com",
        path: "",
        prefix: "",
        serverName: "",
      }),
    ).toEqual({
      kind: "domain",
      toolName: "web_fetch",
      domain: "docs.example.com",
    });
  });
});
