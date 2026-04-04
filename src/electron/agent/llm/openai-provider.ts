import OpenAI from "openai";
import type {
  Model,
  Message as PiAiMessage,
  Context as PiAiContext,
  Tool as PiAiTool,
} from "@mariozechner/pi-ai";
import {
  LLMProvider,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMContent,
  LLMMessage,
  LLMSystemBlock,
  LLMTool,
  LLMToolResult,
} from "./types";
import { OpenAIOAuth, OpenAIOAuthTokens } from "./openai-oauth";
import { imageToTextFallback } from "./image-utils";
import { loadPiAiModule } from "./pi-ai-loader";
import { toOpenAICompatibleMessages } from "./openai-compatible";
import { resolveOutputTokenParamName } from "./output-token-policy";
import { buildOpenAIPromptCacheFields, extractOpenAICompatibleCacheUsage } from "./prompt-cache";
import { createLogger } from "../../utils/logger";

// Default model for openai-codex (ChatGPT backend)
const DEFAULT_CODEX_MODEL = "gpt-5.1-codex-mini";
const logger = createLogger("OpenAI");

type OpenAIProviderErrorPhase = "api_key" | "oauth";

class OpenAIProviderError extends Error {
  code?: string;
  retryable?: boolean;
  phase?: OpenAIProviderErrorPhase;
}

/**
 * OpenAI API provider implementation
 * Supports both API key and OAuth token authentication
 * - API Key: Uses OpenAI SDK directly with api.openai.com
 * - OAuth: Uses pi-ai SDK with ChatGPT backend (chatgpt.com/backend-api/)
 */
export class OpenAIProvider implements LLMProvider {
  readonly type = "openai" as const;
  private client: OpenAI | null = null;
  private authMethod: "api_key" | "oauth";
  private oauthTokens?: OpenAIOAuthTokens;
  private model: string;

  constructor(config: LLMProviderConfig) {
    const apiKey = config.openaiApiKey;
    const accessToken = config.openaiAccessToken;
    const refreshToken = config.openaiRefreshToken;
    const tokenExpiresAt = config.openaiTokenExpiresAt;
    this.model = config.model;

    if (accessToken && refreshToken) {
      // Use OAuth - will use pi-ai SDK for API calls
      this.oauthTokens = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at:
          typeof tokenExpiresAt === "number" &&
          Number.isFinite(tokenExpiresAt) &&
          tokenExpiresAt > 0
            ? tokenExpiresAt
            : 0,
      };
      this.authMethod = "oauth";
      logger.info(
        `Using OAuth authentication with pi-ai SDK (token expires: ${
          this.oauthTokens.expires_at
            ? new Date(this.oauthTokens.expires_at).toISOString()
            : "unknown"
        })`,
      );
    } else if (apiKey) {
      // Use API key - standard OpenAI SDK
      this.client = new OpenAI({ apiKey });
      this.authMethod = "api_key";
      logger.info("Using API key authentication");
    } else {
      throw new Error("OpenAI authentication required. Use API key or sign in with ChatGPT.");
    }
  }

  async createMessage(request: LLMRequest): Promise<LLMResponse> {
    if (this.authMethod === "oauth") {
      return this.createMessageWithOAuth(request);
    } else {
      return this.createMessageWithApiKey(request);
    }
  }

  private isTransientInterruptionMessage(message: string): boolean {
    const normalized = String(message || "").toLowerCase();
    if (!normalized) return false;
    return (
      normalized.includes("terminated") ||
      normalized.includes("stream disconnected") ||
      normalized.includes("connection reset") ||
      normalized.includes("unexpected eof") ||
      normalized.includes("socket hang up")
    );
  }

  private toStructuredProviderError(error: Any, phase: OpenAIProviderErrorPhase): Error {
    const message = String(error?.message || "OpenAI request failed");
    const wrapped = new OpenAIProviderError(message);
    wrapped.name = error?.name || "OpenAIProviderError";
    wrapped.phase = phase;
    wrapped.code = String(error?.code || error?.cause?.code || "").trim() || undefined;
    wrapped.retryable =
      this.isTransientInterruptionMessage(message) ||
      wrapped.code === "ECONNRESET" ||
      wrapped.code === "ETIMEDOUT" ||
      wrapped.code === "ENOTFOUND" ||
      wrapped.code === "EAI_AGAIN" ||
      wrapped.code === "ECONNREFUSED";
    if (error?.status !== undefined) {
      (wrapped as Any).status = error.status;
    }
    (wrapped as Any).cause = error;
    return wrapped;
  }

  /**
   * Create message using API key (standard OpenAI SDK)
   */
  private async createMessageWithApiKey(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error("OpenAI client not initialized");
    }

    const messages = this.convertMessages(request.messages, request.system, request.systemBlocks);
    const tools = request.tools ? this.convertTools(request.tools) : undefined;

    try {
      logger.debug(`Calling API with model: ${request.model}`);
      const tokenField = resolveOutputTokenParamName({
        providerType: this.type,
        modelId: request.model || this.model || "gpt-4o",
        apiMode: "chat_completions",
      });

      const body: Any = {
        model: request.model,
        [tokenField]: request.maxTokens,
        messages,
        ...(tools && tools.length > 0
          ? {
              tools,
              tool_choice: request.toolChoice || "auto",
            }
          : {}),
        ...buildOpenAIPromptCacheFields(request.promptCache),
      };
      const response = await this.client.chat.completions.create(
        body,
        request.signal ? { signal: request.signal } : undefined,
      );

      return this.convertResponse(response);
    } catch (error: Any) {
      // Handle abort errors gracefully
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        logger.info("Request aborted");
        throw new Error("Request cancelled");
      }

      logger.error("API error:", {
        status: error.status,
        message: error.message,
        type: error.type || error.name,
      });
      throw this.toStructuredProviderError(error, "api_key");
    }
  }

  /**
   * Map public model names to openai-codex model IDs
   */
  private mapToCodexModel(modelId: string): string {
    // Map common public model names to ChatGPT internal models
    const modelMap: Record<string, string> = {
      // Map gpt-4o models to gpt-5.1
      "gpt-4o": "gpt-5.1",
      "gpt-4o-mini": "gpt-5.1-codex-mini",
      // Map o1/reasoning models to gpt-5.2
      o1: "gpt-5.2",
      "o1-mini": "gpt-5.2-codex",
      "o1-preview": "gpt-5.2",
      // Default mappings
      "gpt-4-turbo": "gpt-5.1",
      "gpt-4": "gpt-5.1",
      "gpt-3.5-turbo": "gpt-5.1-codex-mini",
    };

    return modelMap[modelId] || modelId;
  }

  /**
   * Create message using OAuth (pi-ai SDK with ChatGPT backend)
   */
  private async createMessageWithOAuth(request: LLMRequest): Promise<LLMResponse> {
    if (!this.oauthTokens) {
      throw new Error("OAuth tokens not available");
    }

    try {
      const { getModels, complete: piAiComplete } = await loadPiAiModule();
      // Map model ID to ChatGPT internal model
      const codexModelId = this.mapToCodexModel(request.model);
      logger.debug(
        `Calling ChatGPT backend with model: ${codexModelId} (requested: ${request.model})`,
      );

      // Get the model object from pi-ai SDK
      let model: Model<Any>;
      try {
        // Get available models and find one that matches
        const availableModels = getModels("openai-codex");
        const found = availableModels.find((m) => m.id === codexModelId);
        if (found) {
          model = found;
        } else {
          // Use default if not found
          logger.info(
            `Model ${codexModelId} not found, using default: ${DEFAULT_CODEX_MODEL}`,
          );
          model = availableModels.find((m) => m.id === DEFAULT_CODEX_MODEL) || availableModels[0];
        }
      } catch (e) {
        logger.error("Failed to get model from pi-ai SDK:", e);
        throw new Error(`Model not available: ${codexModelId}`);
      }

      // Convert messages to pi-ai format
      const piAiMessages = this.convertMessagesToPiAi(request.messages);

      // Convert tools to pi-ai format
      const piAiTools = request.tools ? this.convertToolsToPiAi(request.tools) : undefined;

      // Get API key from OAuth tokens (with auto-refresh)
      const { apiKey, newTokens } = await OpenAIOAuth.getApiKeyFromTokens(this.oauthTokens);

      // Update tokens if they were refreshed
      if (newTokens) {
        this.oauthTokens = newTokens;
      }

      // Build context
      const context: PiAiContext = {
        systemPrompt: request.system,
        messages: piAiMessages,
        tools: piAiTools,
      };

      // Make the API call using pi-ai SDK
      const response = await piAiComplete(model, context, {
        apiKey,
        maxTokens: request.maxTokens,
        signal: request.signal,
      });

      // pi-ai returns an AssistantMessage even on errors (stopReason: "error"/"aborted").
      // Our executor expects provider errors to be thrown so it can retry/fail loudly.
      if (response?.stopReason === "aborted") {
        throw new Error("Request cancelled");
      }
      if (response?.stopReason === "error") {
        throw this.toStructuredProviderError(
          { message: response?.errorMessage || "OpenAI request failed", code: "PI_AI_ERROR" },
          "oauth",
        );
      }

      // Convert pi-ai response to our format
      return this.convertPiAiResponse(response);
    } catch (error: Any) {
      // Handle abort errors gracefully
      if (error.name === "AbortError" || error.message?.includes("aborted")) {
        logger.info("Request aborted");
        throw new Error("Request cancelled");
      }

      logger.error("ChatGPT API error:", {
        message: error.message,
        type: error.type || error.name,
      });
      throw this.toStructuredProviderError(error, "oauth");
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.authMethod === "oauth") {
        const { getModels, complete: piAiComplete } = await loadPiAiModule();
        // For OAuth, try to get the API key and make a simple request
        if (!this.oauthTokens) {
          return { success: false, error: "OAuth tokens not available" };
        }

        const { apiKey } = await OpenAIOAuth.getApiKeyFromTokens(this.oauthTokens);

        // Get a model from the available models
        const availableModels = getModels("openai-codex");
        const model =
          availableModels.find((m) => m.id === DEFAULT_CODEX_MODEL) || availableModels[0];

        await piAiComplete(
          model,
          {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "Hi" }],
                timestamp: Date.now(),
              },
            ],
          },
          { apiKey, maxTokens: 10 },
        );

        return { success: true };
      } else {
        // For API key, use standard OpenAI SDK
        if (!this.client) {
          return { success: false, error: "OpenAI client not initialized" };
        }

        await this.client.chat.completions.create({
          model: "gpt-4o-mini",
          max_tokens: 10,
          messages: [{ role: "user", content: "Hi" }],
        });
        return { success: true };
      }
    } catch (error: Any) {
      return {
        success: false,
        error: error.message || "Failed to connect to OpenAI API",
      };
    }
  }

  /**
   * Get available models
   * For API key: uses the models.list API
   * For OAuth: uses pi-ai SDK's model list for openai-codex provider
   */
  async getAvailableModels(): Promise<Array<{ id: string; name: string; description: string }>> {
    // For OAuth authentication, use pi-ai SDK's model list
    if (this.authMethod === "oauth") {
      logger.info("Using OAuth - fetching models from pi-ai SDK...");

      try {
        const { getModels } = await loadPiAiModule();
        // Get models from pi-ai SDK for openai-codex provider
        const piAiModels = getModels("openai-codex");

        const models = piAiModels.map((m) => ({
          id: m.id,
          name: m.name || this.formatModelName(m.id),
          description: this.getModelDescription(m.id),
        }));

        // Sort by priority
        models.sort((a, b) => {
          const priority = (id: string) => {
            if (id.includes("5.1-codex-mini")) return 0;
            if (id.includes("5.1-codex-max")) return 1;
            if (id === "gpt-5.1") return 2;
            if (id.includes("5.3-codex")) return 3;
            if (id.includes("5.2-codex")) return 3;
            if (id === "gpt-5.2") return 4;
            return 5;
          };
          return priority(a.id) - priority(b.id);
        });

        logger.info(`Found ${models.length} models via pi-ai SDK`);
        return models;
      } catch (error) {
        logger.error("Failed to get models from pi-ai SDK:", error);
        // Return defaults on error
        return this.getDefaultCodexModels();
      }
    }

    // For API key authentication, use the standard models list API
    if (this.client) {
      try {
        const response = await this.client.models.list();
        const models = response.data
          .filter((m) => m.id.startsWith("gpt-") || m.id.startsWith("o1") || m.id.startsWith("o3"))
          .map((m) => ({
            id: m.id,
            name: this.formatModelName(m.id),
            description: this.getModelDescription(m.id),
          }))
          .sort((a, b) => {
            const priority = (id: string) => {
              if (id.includes("gpt-4o")) return 0;
              if (id.includes("gpt-4")) return 1;
              if (id.includes("gpt-3.5")) return 2;
              if (id.includes("o1")) return 3;
              if (id.includes("o3")) return 4;
              return 5;
            };
            return priority(a.id) - priority(b.id);
          });
        return models;
      } catch (error: Any) {
        logger.error("Failed to fetch OpenAI models:", error);
      }
    }

    // Return defaults if nothing else works
    return this.getDefaultModels();
  }

  private getDefaultModels(): Array<{ id: string; name: string; description: string }> {
    return [
      { id: "gpt-4o", name: "GPT-4o", description: "Most capable model for complex tasks" },
      { id: "gpt-4o-mini", name: "GPT-4o Mini", description: "Fast and affordable for most tasks" },
      { id: "o1", name: "o1", description: "Advanced reasoning model" },
      { id: "o1-mini", name: "o1 Mini", description: "Fast reasoning model" },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo", description: "Previous generation flagship" },
      { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", description: "Fast and cost-effective" },
    ];
  }

  private getDefaultCodexModels(): Array<{ id: string; name: string; description: string }> {
    return [
      {
        id: "gpt-5.1-codex-mini",
        name: "GPT-5.1 Codex Mini",
        description: "Fast and efficient for most tasks",
      },
      {
        id: "gpt-5.1-codex-max",
        name: "GPT-5.1 Codex Max",
        description: "Maximum capability for complex tasks",
      },
      { id: "gpt-5.1", name: "GPT-5.1", description: "Balanced performance and capability" },
      { id: "gpt-5.2-codex", name: "GPT-5.2 Codex", description: "Advanced reasoning model" },
      { id: "gpt-5.3-codex", name: "GPT-5.3 Codex", description: "Advanced reasoning model" },
      { id: "gpt-5.2", name: "GPT-5.2", description: "Most advanced reasoning" },
    ];
  }

  private formatModelName(modelId: string): string {
    // Format model ID to display name
    if (modelId === "gpt-4o") return "GPT-4o";
    if (modelId === "gpt-4o-mini") return "GPT-4o Mini";
    if (modelId.includes("gpt-4o-")) return `GPT-4o (${modelId.replace("gpt-4o-", "")})`;
    if (modelId === "gpt-4-turbo") return "GPT-4 Turbo";
    if (modelId.includes("gpt-4-turbo-"))
      return `GPT-4 Turbo (${modelId.replace("gpt-4-turbo-", "")})`;
    if (modelId === "gpt-4") return "GPT-4";
    if (modelId.includes("gpt-4-")) return `GPT-4 (${modelId.replace("gpt-4-", "")})`;
    if (modelId === "gpt-3.5-turbo") return "GPT-3.5 Turbo";
    if (modelId.includes("gpt-3.5-turbo-"))
      return `GPT-3.5 Turbo (${modelId.replace("gpt-3.5-turbo-", "")})`;
    if (modelId === "o1") return "o1";
    if (modelId === "o1-mini") return "o1 Mini";
    if (modelId === "o1-preview") return "o1 Preview";
    if (modelId === "o3-mini") return "o3 Mini";
    // ChatGPT internal models
    if (modelId === "gpt-5.1") return "GPT-5.1";
    if (modelId === "gpt-5.1-codex-mini") return "GPT-5.1 Codex Mini";
    if (modelId === "gpt-5.1-codex-max") return "GPT-5.1 Codex Max";
    if (modelId === "gpt-5.2") return "GPT-5.2";
    if (modelId === "gpt-5.2-codex") return "GPT-5.2 Codex";
    if (modelId === "gpt-5.3-codex") return "GPT-5.3 Codex";
    return modelId;
  }

  private getModelDescription(modelId: string): string {
    if (modelId.includes("gpt-4o") && !modelId.includes("mini"))
      return "Most capable model for complex tasks";
    if (modelId.includes("gpt-4o-mini")) return "Fast and affordable for most tasks";
    if (modelId.includes("gpt-4-turbo")) return "Previous generation flagship";
    if (modelId.includes("gpt-4")) return "High capability model";
    if (modelId.includes("gpt-3.5")) return "Fast and cost-effective";
    if (modelId === "o1" || modelId === "o1-preview") return "Advanced reasoning model";
    if (modelId === "o1-mini") return "Fast reasoning model";
    if (modelId.includes("o3")) return "Next generation reasoning";
    // ChatGPT internal models
    if (modelId === "gpt-5.1") return "Balanced performance and capability";
    if (modelId === "gpt-5.1-codex-mini") return "Fast and efficient for most tasks";
    if (modelId === "gpt-5.1-codex-max") return "Maximum capability for complex tasks";
    if (modelId === "gpt-5.2") return "Most advanced reasoning";
    if (modelId === "gpt-5.2-codex") return "Advanced reasoning model";
    if (modelId === "gpt-5.3-codex") return "Advanced reasoning model";
    return "OpenAI model";
  }

  /**
   * Convert messages to pi-ai SDK format
   */
  private convertMessagesToPiAi(messages: LLMMessage[]): PiAiMessage[] {
    const result: PiAiMessage[] = [];
    const now = Date.now();

    for (const msg of messages) {
      if (typeof msg.content === "string") {
        if (msg.role === "user") {
          result.push({
            role: "user",
            content: [{ type: "text", text: msg.content }],
            timestamp: now,
          });
        } else {
          // Assistant message
          result.push({
            role: "assistant",
            content: [{ type: "text", text: msg.content }],
            api: "openai-codex-responses",
            provider: "openai-codex",
            model: this.model,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: now,
          });
        }
      } else if (Array.isArray(msg.content)) {
        // Check if this is a tool result array
        const toolResults = msg.content.filter(
          (item): item is LLMToolResult => item.type === "tool_result",
        );

        if (toolResults.length > 0) {
          // Convert tool results to pi-ai format
          for (const toolResult of toolResults) {
            result.push({
              role: "toolResult",
              toolCallId: toolResult.tool_use_id,
              toolName: "", // Will be filled by the SDK
              content: [{ type: "text", text: toolResult.content }],
              isError: toolResult.is_error || false,
              timestamp: now,
            });
          }
        } else {
          // Handle mixed content (text, tool_use, image)
          if (msg.role === "user") {
            const textContent: Array<{ type: "text"; text: string }> = [];
            for (const item of msg.content) {
              if (item.type === "text") {
                textContent.push({ type: "text" as const, text: (item as Any).text });
              } else if (item.type === "image") {
                // pi-ai SDK doesn't support inline images; use text fallback
                textContent.push({ type: "text" as const, text: imageToTextFallback(item) });
              }
            }

            if (textContent.length > 0) {
              result.push({
                role: "user",
                content: textContent,
                timestamp: now,
              });
            }
          } else {
            // Assistant message with tool calls
            const content: Any[] = [];

            for (const item of msg.content) {
              if (item.type === "text") {
                content.push({ type: "text", text: (item as Any).text });
              } else if (item.type === "tool_use") {
                content.push({
                  type: "toolCall",
                  id: (item as Any).id,
                  name: (item as Any).name,
                  arguments: (item as Any).input,
                });
              }
            }

            if (content.length > 0) {
              result.push({
                role: "assistant",
                content,
                api: "openai-codex-responses",
                provider: "openai-codex",
                model: this.model,
                usage: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
                stopReason: "stop",
                timestamp: now,
              });
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Convert tools to pi-ai SDK format
   */
  private convertToolsToPiAi(tools: LLMTool[]): PiAiTool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema as Any,
    }));
  }

  /**
   * Convert pi-ai response to our format
   */
  private convertPiAiResponse(response: Any): LLMResponse {
    const content: LLMContent[] = [];

    if (response.content) {
      for (const block of response.content) {
        if (block.type === "text") {
          content.push({
            type: "text",
            text: block.text,
          });
        } else if (block.type === "toolCall") {
          content.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments || {},
          });
        }
      }
    }

    // Map stop reason
    let stopReason: LLMResponse["stopReason"] = "end_turn";
    if (response.stopReason === "toolUse") {
      stopReason = "tool_use";
    } else if (response.stopReason === "length") {
      stopReason = "max_tokens";
    }

    return {
      content,
      stopReason,
      usage: response.usage
        ? {
            inputTokens: response.usage.input || 0,
            outputTokens: response.usage.output || 0,
            cachedTokens: response.usage.cacheRead || undefined,
            cacheWriteTokens: response.usage.cacheWrite || undefined,
          }
        : undefined,
    };
  }

  /**
   * Convert messages to OpenAI format (for API key auth)
   */
  private convertMessages(
    messages: LLMMessage[],
    system?: string,
    systemBlocks?: LLMSystemBlock[],
  ): OpenAI.ChatCompletionMessageParam[] {
    return toOpenAICompatibleMessages(messages, system, {
      supportsImages: true,
      systemBlocks,
    }) as OpenAI.ChatCompletionMessageParam[];
  }

  private convertTools(tools: LLMTool[]): OpenAI.ChatCompletionTool[] {
    return tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
  }

  private convertResponse(response: OpenAI.ChatCompletion): LLMResponse {
    const choice = response.choices[0];
    const content: LLMContent[] = [];

    // Add text content if present
    if (choice.message.content) {
      content.push({
        type: "text",
        text: choice.message.content,
      });
    }

    // Add tool calls if present
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        // Only handle function-type tool calls
        if (toolCall.type === "function") {
          content.push({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: JSON.parse(toolCall.function.arguments || "{}"),
          });
        }
      }
    }

    return {
      content,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            ...extractOpenAICompatibleCacheUsage(response.usage),
          }
        : undefined,
    };
  }

  private mapStopReason(
    reason: OpenAI.ChatCompletion.Choice["finish_reason"],
  ): LLMResponse["stopReason"] {
    switch (reason) {
      case "stop":
        return "end_turn";
      case "tool_calls":
        return "tool_use";
      case "length":
        return "max_tokens";
      case "content_filter":
        return "stop_sequence";
      default:
        return "end_turn";
    }
  }
}
