import { describe, expect, it } from "vitest";

import { MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES } from "../../../shared/microsoft-email";
import { buildMicrosoftEmailAuthorizeUrl } from "../microsoft-email-oauth";

describe("buildMicrosoftEmailAuthorizeUrl", () => {
  it("uses a single supported prompt value for Microsoft auth", () => {
    const authUrl = buildMicrosoftEmailAuthorizeUrl({
      tenant: "consumers",
      clientId: "client-id",
      redirectUri: "http://localhost:18767",
      scopes: MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES,
      state: "state-123",
      codeChallenge: "challenge-123",
      loginHint: "person@example.com",
    });

    expect(authUrl.origin).toBe("https://login.microsoftonline.com");
    expect(authUrl.pathname).toBe("/consumers/oauth2/v2.0/authorize");
    expect(authUrl.searchParams.get("prompt")).toBe("select_account");
    expect(authUrl.searchParams.get("scope")).toBe(MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES.join(" "));
    expect(authUrl.searchParams.get("login_hint")).toBe("person@example.com");
  });

  it("respects custom scopes without adding unsupported prompt combinations", () => {
    const authUrl = buildMicrosoftEmailAuthorizeUrl({
      tenant: "common",
      clientId: "client-id",
      redirectUri: "http://localhost:18767",
      scopes: ["offline_access", "https://outlook.office.com/IMAP.AccessAsUser.All"],
      state: "state-123",
      codeChallenge: "challenge-123",
    });

    expect(authUrl.searchParams.get("scope")).toBe(
      "offline_access https://outlook.office.com/IMAP.AccessAsUser.All",
    );
    expect(authUrl.searchParams.get("prompt")).toBe("select_account");
    expect(authUrl.searchParams.get("login_hint")).toBeNull();
  });
});
