import type { LLMToolResult } from "../llm/types";
import { LLMProviderFactory } from "../llm/provider-factory";
import type { ToolScheduleCallReport } from "./ToolScheduler";

export interface ToolBatchSummaryInput {
  phase: "step" | "follow_up" | "verification" | "delegation" | "team";
  callReports: ToolScheduleCallReport[];
  assistantIntent?: string;
  disableModel?: boolean;
}

export interface ToolBatchSummaryResult {
  semanticSummary: string;
  source: "model" | "fallback";
}

function compactText(value: unknown, maxLength = 120): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function describeToolResult(toolResult: LLMToolResult): string {
  const content = compactText(toolResult.content, 80);
  if (!content) return "";
  return content;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeLabel(text: string): string {
  const trimmed = compactText(text, 80).replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "");
  if (!trimmed) return "";
  const cleaned = trimmed
    .replace(/[`"'*_]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim();
  if (!cleaned) return "";
  return titleCase(cleaned.slice(0, 64));
}

function buildDeterministicLabel(input: ToolBatchSummaryInput): string {
  const toolNames = input.callReports.map((report) => report.effectiveToolName || report.call.toolUse.name);
  const firstTool = toolNames[0] || "tool";
  const plural = toolNames.length > 1 ? "s" : "";
  const readableTool = firstTool
    .replace(/^read_/, "read ")
    .replace(/^write_/, "write ")
    .replace(/^edit_/, "edit ")
    .replace(/^list_/, "list ")
    .replace(/^get_/, "get ")
    .replace(/^search_/, "search ")
    .replace(/^browser_/, "browser ")
    .replace(/^web_/, "web ")
    .replace(/_/g, " ");
  if (input.assistantIntent) {
    const intent = normalizeLabel(input.assistantIntent);
    if (intent) return intent;
  }
  if (toolNames.length === 1) {
    const report = input.callReports[0];
    const detail =
      describeToolResult(report.toolResult) ||
      (() => {
        const rawInput = compactText(JSON.stringify(report.call.toolUse.input || {}), 48);
        return rawInput && rawInput !== "{}" && rawInput !== "[]" ? rawInput : "";
      })();
    if (detail) {
      return normalizeLabel(`${readableTool} ${detail}`) || titleCase(readableTool);
    }
    return titleCase(readableTool);
  }
  return titleCase(`${readableTool} batch${plural}`.trim());
}

function getSummaryPrompt(input: ToolBatchSummaryInput): string {
  const toolLines = input.callReports.map((report, index) => {
    const inputText = compactText(JSON.stringify(report.call.toolUse.input || {}), 160);
    const outputText = describeToolResult(report.toolResult);
    return [
      `${index + 1}. ${report.effectiveToolName || report.call.toolUse.name}`,
      inputText ? `   input: ${inputText}` : "",
      outputText ? `   output: ${outputText}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    "You label completed tool batches for a timeline UI.",
    "Return only a short label of 2-6 words.",
    "Prefer an action-oriented phrase such as 'Read auth config' or 'Ran failing tests'.",
    "Do not use punctuation, quotes, bullets, or explanations.",
    "",
    `Phase: ${input.phase}`,
    ...(input.assistantIntent ? [`Assistant intent: ${compactText(input.assistantIntent, 240)}`] : []),
    "",
    "Completed tools:",
    ...toolLines,
  ].join("\n");
}

export class ToolBatchSummaryGenerator {
  async generateSummary(input: ToolBatchSummaryInput): Promise<ToolBatchSummaryResult> {
    const fallback = buildDeterministicLabel(input);
    if (input.disableModel || input.callReports.length <= 1) {
      return {
        semanticSummary: fallback,
        source: "fallback",
      };
    }

    try {
      const provider = LLMProviderFactory.createProvider({
        type: LLMProviderFactory.loadSettings().providerType,
      });
      const selection = LLMProviderFactory.resolveTaskModelSelection(
        { llmProfile: "cheap" },
        { forceProfile: "cheap" },
      );
      const response = await provider.createMessage({
        model: selection.modelId,
        maxTokens: 32,
        system: "You label completed tool batches with short, timeline-friendly phrases.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: getSummaryPrompt(input) }],
          },
        ],
      });
      const text = response.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n")
        .trim();
      const label = normalizeLabel(text);
      if (label) {
        return {
          semanticSummary: label,
          source: "model",
        };
      }
    } catch {
      // best-effort fallback
    }

    return {
      semanticSummary: fallback,
      source: "fallback",
    };
  }
}

export function createToolBatchSummaryGenerator(): ToolBatchSummaryGenerator {
  return new ToolBatchSummaryGenerator();
}
