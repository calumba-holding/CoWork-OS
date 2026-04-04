import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LLMProviderConfig, LLMRequest } from "../types";
import { OpenAIProvider } from "../openai-provider";

const completeMock = vi.fn();
const getModelsMock = vi.fn();
const getApiKeyFromTokensMock = vi.fn();
const loadPiAiModuleMock = vi.fn();
const chatCompletionsCreateMock = vi.fn();

vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function OpenAIClientMock() {
    this.chat = {
      completions: {
        create: (...args: Any[]) => chatCompletionsCreateMock(...args),
      },
    };
  }),
}));

vi.mock("../pi-ai-loader", () => ({
  loadPiAiModule: (...args: Any[]) => loadPiAiModuleMock(...args),
}));

vi.mock("../openai-oauth", () => ({
  OpenAIOAuth: {
    getApiKeyFromTokens: (...args: Any[]) => getApiKeyFromTokensMock(...args),
  },
}));

function makeConfig(): LLMProviderConfig {
  return {
    type: "openai",
    model: "gpt-5.3-codex-spark",
    openaiAccessToken: "header.payload.signature",
    openaiRefreshToken: "refresh-token",
    openaiTokenExpiresAt: Date.now() + 60_000,
  };
}

function makeRequest(): LLMRequest {
  return {
    model: "gpt-5.3-codex-spark",
    maxTokens: 512,
    system: "system",
    messages: [{ role: "user", content: "test" }],
  };
}

describe("OpenAIProvider structured errors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getModelsMock.mockReturnValue([{ id: "gpt-5.3-codex-spark" }]);
    getApiKeyFromTokensMock.mockResolvedValue({ apiKey: "test-key", newTokens: null });
    loadPiAiModuleMock.mockResolvedValue({
      getModels: (...args: Any[]) => getModelsMock(...args),
      complete: (...args: Any[]) => completeMock(...args),
    });
  });

  it("sends prompt_cache_key with a split stable/turn system prefix for API-key requests", async () => {
    chatCompletionsCreateMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 25,
        prompt_tokens_details: {
          cached_tokens: 60,
          cache_creation_input_tokens: 40,
        },
      },
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-5.4",
      openaiApiKey: "sk-test",
    });

    const response = await provider.createMessage({
      model: "gpt-5.4",
      maxTokens: 128,
      system: "Stable instructions\n\nCurrent time: 2026-04-04T10:00:00Z",
      systemBlocks: [
        {
          text: "Stable instructions",
          scope: "session",
          cacheable: true,
          stableKey: "identity:1",
        },
        {
          text: "Current time: 2026-04-04T10:00:00Z",
          scope: "turn",
          cacheable: false,
          stableKey: "time:1",
        },
      ],
      promptCache: {
        mode: "openai_key",
        ttl: "1h",
        explicitRecentMessages: 3,
        cacheKey: "stable-prefix-hash",
        retention: "24h",
      },
      messages: [{ role: "user", content: "hello" }],
    });

    expect(chatCompletionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        prompt_cache_key: "stable-prefix-hash",
        prompt_cache_retention: "24h",
        messages: [
          { role: "system", content: "Stable instructions" },
          { role: "system", content: "Current time: 2026-04-04T10:00:00Z" },
          { role: "user", content: "hello" },
        ],
      }),
      undefined,
    );
    expect(response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      cachedTokens: 60,
      cacheWriteTokens: 40,
    });
  });

  it("uses max_completion_tokens for newer OpenAI chat-completions models", async () => {
    chatCompletionsCreateMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
      },
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-5.4",
      openaiApiKey: "sk-test",
    });

    await provider.createMessage({
      model: "gpt-5.4",
      maxTokens: 128,
      system: "system",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(chatCompletionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        max_completion_tokens: 128,
      }),
      undefined,
    );
  });

  it("honors toolChoice=none for API-key requests", async () => {
    chatCompletionsCreateMock.mockResolvedValue({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
      },
    });

    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-5.4",
      openaiApiKey: "sk-test",
    });

    await provider.createMessage({
      model: "gpt-5.4",
      maxTokens: 128,
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      tools: [
        {
          name: "write_file",
          description: "Write a file",
          input_schema: {
            type: "object",
            properties: {
              path: { type: "string" },
              content: { type: "string" },
            },
            required: ["path", "content"],
          },
        },
      ],
      toolChoice: "none",
    });

    expect(chatCompletionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: "none",
        tools: expect.any(Array),
      }),
      undefined,
    );
  });

  it("marks terminated OAuth stopReason errors as retryable", async () => {
    completeMock.mockResolvedValue({
      stopReason: "error",
      errorMessage: "terminated",
      content: [],
    });

    const provider = new OpenAIProvider(makeConfig());
    const request = makeRequest();

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      retryable: true,
      phase: "oauth",
      code: "PI_AI_ERROR",
    });
  });

  it("wraps stream interruption exceptions with retryable metadata", async () => {
    completeMock.mockRejectedValue(new Error("stream disconnected by upstream"));

    const provider = new OpenAIProvider(makeConfig());
    const request = makeRequest();

    await expect(provider.createMessage(request)).rejects.toMatchObject({
      retryable: true,
      phase: "oauth",
    });
  });

  it("does not derive OAuth expiry from the JWT payload", () => {
    const provider = new OpenAIProvider({
      type: "openai",
      model: "gpt-5.3-codex-spark",
      openaiAccessToken: "not-a-real-jwt",
      openaiRefreshToken: "refresh-token",
    });

    expect((provider as Any).oauthTokens?.expires_at).toBe(0);
  });
});
