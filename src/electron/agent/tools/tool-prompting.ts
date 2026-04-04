import type {
  LLMTool,
  LLMToolPromptMetadata,
  LLMToolPromptRenderContext,
  LLMToolPromptRenderResult,
} from "../llm/types";

const TOOL_DESCRIPTION_CHAR_LIMIT = 420;
const TOOL_COMPACT_DESCRIPTION_CHAR_LIMIT = 220;

export const TOOL_PROMPT_METADATA_VERSION = "tool-prompting:v2";

function normalizeText(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: string, maxChars: number): string {
  const normalized = normalizeText(value);
  if (!normalized) return "";
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function joinText(...parts: Array<string | undefined>): string {
  return parts
    .map((part) => normalizeText(part))
    .filter(Boolean)
    .join(" ");
}

function resolvePromptMetadata(
  tool: LLMTool,
  context: LLMToolPromptRenderContext,
): LLMToolPromptRenderResult {
  const prompting = tool.prompting;
  if (!prompting?.render) return {};
  const resolved = prompting.render(context, {
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    runtime: tool.runtime,
  });
  return resolved || {};
}

export function renderToolDescription(
  tool: LLMTool,
  context: LLMToolPromptRenderContext,
): string {
  const resolved = resolvePromptMetadata(tool, context);
  const base = normalizeText(tool.description);
  const merged = resolved.description
    ? normalizeText(resolved.description)
    : joinText(base, resolved.appendDescription);
  return truncateText(merged || base, TOOL_DESCRIPTION_CHAR_LIMIT);
}

export function renderCompactToolDescription(
  tool: LLMTool,
  context: LLMToolPromptRenderContext,
): string {
  const resolved = resolvePromptMetadata(tool, context);
  const base = normalizeText(tool.description);
  const merged = resolved.compactDescription
    ? normalizeText(resolved.compactDescription)
    : resolved.description
      ? normalizeText(resolved.description)
      : joinText(base, resolved.appendDescription, resolved.appendCompactDescription);
  return truncateText(merged || base, TOOL_COMPACT_DESCRIPTION_CHAR_LIMIT);
}

export function renderToolForContext(
  tool: LLMTool,
  context: LLMToolPromptRenderContext,
): LLMTool {
  return {
    ...tool,
    description: renderToolDescription(tool, context),
  };
}

function createPromptMetadata(
  render: NonNullable<LLMToolPromptMetadata["render"]>,
): LLMToolPromptMetadata {
  return {
    version: TOOL_PROMPT_METADATA_VERSION,
    render,
  };
}

const TOOL_PROMPT_METADATA_BY_NAME: Record<string, LLMToolPromptMetadata> = {
  spawn_agent: createPromptMetadata(() => ({
    appendDescription:
      "Delegate a self-contained subtask. Set worker_role explicitly when useful: researcher for read-only investigation, verifier for independent checks, synthesizer to combine upstream outputs, implementer for code changes. Include concrete scope, evidence, and the expected deliverable.",
    compactDescription:
      "Delegate one self-contained subtask with scope, evidence, expected deliverable, and optional worker_role. Use only when specialization or parallelism helps.",
  })),
  orchestrate_agents: createPromptMetadata(() => ({
    appendDescription:
      "Launch 2-8 independent delegated tasks in parallel. Use only when tasks do not block each other and can be summarized separately before synthesis.",
    compactDescription:
      "Run 2-8 independent delegated tasks in parallel. Do not split one blocking serial task across nodes.",
  })),
  run_command: createPromptMetadata(() => ({
    appendDescription:
      "Use for shell, test, build, packaging, git, and local CLI work. Prefer this over browser or web tools for local execution. If a test or build fails, inspect the output, fix the cause, then rerun.",
    compactDescription:
      "Use for shell, test, build, git, and local CLI execution. Fix the root cause before rerunning failed commands.",
  })),
  web_search: createPromptMetadata((context) => ({
    appendDescription:
      context.webSearchMode === "cached"
        ? "Use first for broad discovery and candidate sources. Then use web_fetch to read a specific URL. In cached mode, treat results as discovery only and verify freshness from fetched pages before making date-sensitive claims."
        : "Use first for broad discovery and candidate sources. Then use web_fetch to read a specific URL. Use browser tools instead for interactive or JS-heavy pages.",
    compactDescription:
      context.webSearchMode === "cached"
        ? "Broad discovery first. Then use web_fetch for a specific page. In cached mode, verify freshness from fetched pages."
        : "Broad discovery first. Then use web_fetch for a specific page. Use browser tools for interactive pages.",
  })),
  web_fetch: createPromptMetadata((context) => ({
    appendDescription:
      context.webSearchMode === "cached"
        ? "Use for a known URL or exact page the user named. Prefer web_search for discovery and browser tools for interactive pages. In cached mode, avoid freshness expansion unless the user asked for a specific page."
        : "Use for a known URL or exact page the user named. Prefer web_search for discovery and browser tools for interactive or JS-heavy pages.",
    compactDescription:
      context.webSearchMode === "cached"
        ? "Read a known URL after discovery or when the user names the page. Prefer web_search for discovery."
        : "Read a known URL after discovery or when the user names the page. Prefer web_search for discovery.",
  })),
  browser_navigate: createPromptMetadata(() => ({
    appendDescription:
      "Use for interactive or JS-heavy pages, login flows, or screenshots. After navigating, immediately inspect with browser_get_content or browser_screenshot.",
    compactDescription:
      "Use for interactive or JS-heavy pages, login flows, or screenshots. Navigate, then inspect immediately.",
  })),
  browser_get_content: createPromptMetadata(() => ({
    appendDescription:
      "Extract page content right after browser_navigate when the page depends on client-side rendering or interaction state.",
    compactDescription:
      "Extract rendered page content right after browser_navigate.",
  })),
  browser_get_text: createPromptMetadata(() => ({
    appendDescription:
      "Use after browser_navigate when you need quick text extraction from a rendered page without a full DOM/content dump.",
    compactDescription:
      "Use after browser_navigate for quick rendered-text extraction.",
  })),
  browser_screenshot: createPromptMetadata(() => ({
    appendDescription:
      "Capture visual evidence when layout, images, or rendered state matter, or when text extraction is insufficient.",
    compactDescription:
      "Capture visual page evidence when layout or rendered state matters.",
  })),
  request_user_input: createPromptMetadata((context) => ({
    appendDescription:
      context.allowUserInput === false
        ? "This tool requires user interaction and should not be used when the current task cannot pause for user input."
        : "Use only when a required user choice blocks the plan or execution. Prefer safe defaults when reasonable. Ask 1-3 concise questions with 2-3 options each.",
    compactDescription:
      context.allowUserInput === false
        ? "Requires user interaction; unavailable for autonomous no-input tasks."
        : "Use only for required user choices that block progress. Keep the question set short and structured.",
  })),
  task_list_create: createPromptMetadata(() => ({
    appendDescription:
      "Use for non-trivial multi-step execution work. Track implementation and verification items explicitly so the task does not finish without objective checks.",
    compactDescription:
      "Create a session checklist for non-trivial execution work. Include verification coverage before finishing.",
  })),
  task_list_update: createPromptMetadata(() => ({
    appendDescription:
      "Maintain the full ordered checklist state as the work progresses. Preserve verification items or add one before closing out implementation work.",
    compactDescription:
      "Update the session checklist as work progresses. Preserve or add verification coverage before finishing.",
  })),
  create_diagram: createPromptMetadata(() => ({
    appendDescription:
      "Use for diagrams, flowcharts, ERDs, timelines, and Mermaid-rendered visuals. Prefer this over writing HTML files just to display a diagram.",
    compactDescription:
      "Use for Mermaid-rendered diagrams and charts. Prefer it over HTML files for visualizations.",
  })),
  qa_run: createPromptMetadata(() => ({
    appendDescription:
      "Use as the first automated QA action for web app verification. It starts the app when needed, runs headless checks, and returns screenshots plus categorized issues. Rerun after fixes until major issues are resolved.",
    compactDescription:
      "First automated QA action for web apps. Run it, fix issues, and rerun until major findings are gone.",
  })),
};

export function withToolPromptMetadata(tool: LLMTool): LLMTool {
  const prompting = TOOL_PROMPT_METADATA_BY_NAME[tool.name];
  if (!prompting) return tool;
  return {
    ...tool,
    prompting,
  };
}

export function withToolPromptMetadataList(tools: LLMTool[]): LLMTool[] {
  return tools.map((tool) => withToolPromptMetadata(tool));
}
