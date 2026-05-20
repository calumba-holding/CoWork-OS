import { describe, expect, it } from "vitest";
import { buildIntegrationMentionOptionsFromState } from "../integration-mention-options";
import { GMAIL_DEFAULT_SCOPES, GOOGLE_WORKSPACE_DEFAULT_SCOPES } from "../../../shared/google-workspace";

describe("buildIntegrationMentionOptionsFromState", () => {
  it("always exposes Browser Use as an @mention option", () => {
    const options = buildIntegrationMentionOptionsFromState({});

    expect(options).toEqual([
      expect.objectContaining({
        id: "builtin:browser-use",
        label: "Browser",
        iconKey: "browser",
        tools: expect.arrayContaining(["browser_navigate", "browser_snapshot"]),
      }),
    ]);
  });

  it("splits configured Google Workspace into Gmail, Drive, and Calendar", () => {
    const options = buildIntegrationMentionOptionsFromState({
      builtins: {
        googleWorkspace: {
          enabled: true,
          connectionMode: "workspace",
          clientId: "",
          clientSecret: "",
          refreshToken: "refresh",
          scopes: GOOGLE_WORKSPACE_DEFAULT_SCOPES,
          timeoutMs: 20000,
        },
      },
    });

    expect(options.map((option) => option.label)).toEqual([
      "Browser",
      "Gmail",
      "Google Drive",
      "Google Calendar",
      "Inbox",
    ]);
    expect(options.some((option) => option.label === "Google Workspace")).toBe(false);
    expect(options.find((option) => option.label === "Gmail")?.tools).toEqual(
      expect.arrayContaining([
        "gmail_search_emails",
        "gmail_batch_read_email",
        "gmail_read_email_thread",
        "gmail_create_draft",
        "gmail_send_email",
        "gmail_action",
      ]),
    );
  });

  it("shows only Gmail and Inbox for Gmail-only Google connections", () => {
    const options = buildIntegrationMentionOptionsFromState({
      builtins: {
        googleWorkspace: {
          enabled: true,
          connectionMode: "gmail",
          refreshToken: "refresh",
          scopes: GMAIL_DEFAULT_SCOPES,
          timeoutMs: 20000,
        },
      },
    });

    expect(options.map((option) => option.label)).toEqual(["Browser", "Gmail", "Inbox"]);
    expect(options.some((option) => option.label === "Google Drive")).toBe(false);
    expect(options.some((option) => option.label === "Google Calendar")).toBe(false);
  });

  it("shows Inbox Agent when a mailbox backend is configured", () => {
    const googleBacked = buildIntegrationMentionOptionsFromState({
      builtins: {
        googleWorkspace: {
          enabled: true,
          refreshToken: "refresh",
          timeoutMs: 20000,
        },
      },
    });
    const channelBacked = buildIntegrationMentionOptionsFromState({
      channels: [
        {
          id: "email_1",
          type: "email",
          name: "Ops email",
          enabled: true,
          status: "connected",
          securityMode: "pairing",
          createdAt: 1,
        },
      ],
    });

    expect(googleBacked.some((option) => option.id === "builtin:inbox-agent")).toBe(true);
    expect(channelBacked.some((option) => option.id === "builtin:inbox-agent")).toBe(true);
  });

  it("hides enabled built-ins that do not have required credentials", () => {
    const options = buildIntegrationMentionOptionsFromState({
      builtins: {
        notion: { enabled: true, notionVersion: "2022-06-28", timeoutMs: 20000 },
        dropbox: { enabled: true, timeoutMs: 20000 },
      },
    });

    expect(options.map((option) => option.id)).toEqual(["builtin:browser-use"]);
    expect(options.some((option) => option.id === "builtin:notion")).toBe(false);
    expect(options.some((option) => option.id === "builtin:dropbox")).toBe(false);
  });

  it("returns connected Slack gateway channels", () => {
    const options = buildIntegrationMentionOptionsFromState({
      channels: [
        {
          id: "ch_1",
          type: "slack",
          name: "Workspace",
          enabled: true,
          status: "connected",
          securityMode: "pairing",
          createdAt: 1,
        },
      ],
    });

    expect(options).toHaveLength(2);
    expect(options[1]).toMatchObject({
      id: "gateway:slack:ch_1",
      label: "Slack",
      iconKey: "slack",
      tools: ["channel_list_chats", "channel_history"],
    });
  });

  it("splits multi-service MCP Google Workspace tools by service including Tasks and Slides", () => {
    const options = buildIntegrationMentionOptionsFromState({
      mcp: {
        settings: {
          toolNamePrefix: "mcp_",
          servers: [
            {
              id: "google-workspace",
              name: "Google Workspace",
              enabled: true,
              transport: "stdio",
              env: { GOOGLE_REFRESH_TOKEN: "refresh" },
            },
          ],
        },
        statuses: [
          {
            id: "google-workspace",
            name: "Google Workspace",
            status: "connected",
            tools: [
              { name: "drive_files_list", inputSchema: { type: "object" } },
              { name: "docs_create", inputSchema: { type: "object" } },
              { name: "sheets_create", inputSchema: { type: "object" } },
              { name: "tasks_create", inputSchema: { type: "object" } },
              { name: "slides_batch_update", inputSchema: { type: "object" } },
            ],
          },
        ],
      },
    });

    expect(options.map((option) => option.label)).toEqual([
      "Browser",
      "Google Drive",
      "Google Docs",
      "Google Sheets",
      "Google Tasks",
      "Google Slides",
    ]);
    expect(options.flatMap((option) => option.tools)).toContain("mcp_drive_files_list");
    expect(options.find((option) => option.label === "Google Tasks")?.tools).toEqual([
      "mcp_tasks_create",
    ]);
    expect(options.find((option) => option.label === "Google Slides")?.tools).toEqual([
      "mcp_slides_batch_update",
    ]);
  });

  it("shows unknown MCP servers only when connected", () => {
    const disconnected = buildIntegrationMentionOptionsFromState({
      mcp: {
        settings: {
          toolNamePrefix: "mcp_",
          servers: [{ id: "custom", name: "Custom MCP", enabled: true, transport: "stdio" }],
        },
        statuses: [{ id: "custom", name: "Custom MCP", status: "disconnected", tools: [] }],
      },
    });
    const connected = buildIntegrationMentionOptionsFromState({
      mcp: {
        settings: {
          toolNamePrefix: "mcp_",
          servers: [{ id: "custom", name: "Custom MCP", enabled: true, transport: "stdio" }],
        },
        statuses: [
          {
            id: "custom",
            name: "Custom MCP",
            status: "connected",
            tools: [{ name: "custom_search", inputSchema: { type: "object" } }],
          },
        ],
      },
    });

    expect(disconnected.map((option) => option.id)).toEqual(["builtin:browser-use"]);
    expect(connected).toHaveLength(2);
    expect(connected[1].tools).toEqual(["mcp_custom_search"]);
  });
});
