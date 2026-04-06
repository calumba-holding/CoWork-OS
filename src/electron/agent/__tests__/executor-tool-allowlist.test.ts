import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";

describe("TaskExecutor tool allow-list semantics", () => {
  function createExecutor(allowedTools?: string[]) {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = { agentConfig: { allowedTools } };
    executor.toolRegistry = {
      getTools: vi
        .fn()
        .mockReturnValue([
          { name: "read_file" },
          { name: "write_file" },
          { name: "canvas_push" },
          { name: "create_diagram" },
          { name: "generate_video" },
          { name: "get_video_generation_job" },
        ]),
    };
    executor.toolFailureTracker = {
      getDisabledTools: vi.fn().mockReturnValue([]),
    };
    executor.isVisualCanvasTask = vi.fn().mockReturnValue(false);
    executor.isCanvasTool = vi.fn((toolName: string) => toolName.startsWith('canvas_'));
    executor.workspace = { permissions: { shell: true } };
    executor.logTag = "[Executor:test]";
    return executor;
  }

  it("treats an explicitly configured empty allow-list as deny-all", () => {
    const executor = createExecutor([]);
    const availableTools = (executor as Any).getAvailableTools();

    expect(availableTools).toEqual([]);
    expect((executor as Any).isToolRestrictedByPolicy("read_file")).toBe(true);
  });

  it("does not enforce allow-list when it is not configured", () => {
    const executor = createExecutor(undefined);
    const availableTools = (executor as Any).getAvailableTools();

    expect(availableTools).toEqual([
      { name: "read_file" },
      { name: "write_file" },
      { name: "create_diagram" },
      { name: "generate_video" },
      { name: "get_video_generation_job" },
    ]);
    expect((executor as Any).isToolRestrictedByPolicy("read_file")).toBe(false);
  });

  it("does not recurse through getAvailableTools when resolving via tool hints", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("plan");
    executor.normalizeToolName = vi.fn((name: string) => ({ name }));
    executor.toolRegistry = {
      getTools: vi.fn().mockReturnValue([{ name: "custom_picker" }]),
    };
    executor.getAvailableTools = vi.fn(() => {
      throw new Error("getAvailableTools should not be called");
    });

    const requiredTools = (executor as Any).extractRequiredToolsFromStepDescription(
      "Ask clarifying questions via custom_picker before drafting.",
    ) as Set<string>;

    expect(requiredTools.has("custom_picker")).toBe(true);
    expect(executor.getAvailableTools).not.toHaveBeenCalled();
  });

  it("chat-intent tasks in execute mode use the standard analysis allowlist", () => {
    // Chat tasks no longer get a special empty allowlist — they receive the full
    // analysis toolset so that scratchpad, text analysis, and search tools work
    // during inline answer delivery.
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      agentConfig: {
        taskIntent: "chat",
      },
    };
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");

    const allowlist = (TaskExecutor as Any).prototype.buildStepToolAllowlist.call(
      executor,
      { requiredTools: new Set<string>() },
      "analysis",
      "general",
    );

    // Standard analysis tools are present for chat tasks.
    expect(allowlist.has("scratchpad_write")).toBe(true);
    expect(allowlist.has("count_text")).toBe(true);
    expect(allowlist.has("text_metrics")).toBe(true);
    expect(allowlist.size).toBeGreaterThan(0);
  });

  it("adds native desktop GUI tools for calculator-style steps", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.task = {
      title: "Open Calculator",
      prompt: "Open Calculator and show me the 159th Fibonacci number.",
      agentConfig: {
        taskIntent: "execution",
      },
    };
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");

    const allowlist = (TaskExecutor as Any).prototype.buildStepToolAllowlist.call(
      executor,
      { requiredTools: new Set<string>() },
      "mutation_required",
      "general",
      "Open Calculator and clear any existing value so the display starts from a clean state.",
    );

    expect(allowlist.has("open_application")).toBe(true);
    expect(allowlist.has("computer_screenshot")).toBe(true);
    expect(allowlist.has("computer_click")).toBe(true);
    expect(allowlist.has("computer_type")).toBe(true);
    expect(allowlist.has("computer_key")).toBe(true);
    expect(allowlist.has("computer_move_mouse")).toBe(true);
  });

  it("infers create_diagram for inline diagram steps", () => {
    const executor = Object.create(TaskExecutor.prototype) as Any;
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");
    executor.normalizeToolName = vi.fn((name: string) => ({ name }));
    executor.toolRegistry = {
      getTools: vi.fn().mockReturnValue([{ name: "create_diagram" }]),
    };

    const requiredTools = (executor as Any).extractRequiredToolsFromStepDescription(
      "Create a Mermaid flowchart showing the CI/CD pipeline stages.",
    ) as Set<string>;

    expect(requiredTools.has("create_diagram")).toBe(true);
  });

  it("infers generate_video for steps that explicitly call the video generation tool", () => {
    const executor = createExecutor();
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");
    executor.normalizeToolName = vi.fn((name: string) => ({ name }));

    const requiredTools = (executor as Any).extractRequiredToolsFromStepDescription(
      "Call the video generation tool with the armadillo prompt and capture the returned job ID or output reference.",
    ) as Set<string>;

    expect(requiredTools.has("generate_video")).toBe(true);
  });

  it("infers get_video_generation_job for polling steps", () => {
    const executor = createExecutor();
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");
    executor.normalizeToolName = vi.fn((name: string) => ({ name }));

    const requiredTools = (executor as Any).extractRequiredToolsFromStepDescription(
      "If the generation is asynchronous, poll the job status until it reaches succeeded, then save the generated video asset to outputs/armadillo.mp4.",
    ) as Set<string>;

    expect(requiredTools.has("get_video_generation_job")).toBe(true);
  });

  it("treats pure video job submission steps as non-write steps without forcing write_file", () => {
    const executor = createExecutor();
    executor.agentPolicyConfig = null;
    executor.workspace = { path: process.cwd() };
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");

    const step = {
      id: "video-step",
      description:
        "Call the video generation tool with the armadillo prompt and capture the returned job ID or output reference.",
      kind: "primary",
      status: "pending",
    };

    const contract = (executor as Any).resolveStepExecutionContract(step);

    expect(contract.mode).toBe("analysis_only");
    expect(Array.from(contract.requiredTools)).toContain("generate_video");
    expect(Array.from(contract.requiredTools)).not.toContain("write_file");
  });

  it("treats video polling steps that save the final asset as mutation-required without forcing write_file", () => {
    const executor = createExecutor();
    executor.agentPolicyConfig = null;
    executor.workspace = { path: process.cwd() };
    executor.getEffectiveExecutionMode = vi.fn().mockReturnValue("execute");

    const step = {
      id: "video-poll-step",
      description:
        "If the generation is asynchronous, poll the job until it succeeds, then save the generated video asset to outputs/armadillo.mp4.",
      kind: "primary",
      status: "pending",
    };

    const contract = (executor as Any).resolveStepExecutionContract(step);

    expect(contract.mode).toBe("mutation_required");
    expect(Array.from(contract.requiredTools)).toContain("get_video_generation_job");
    expect(Array.from(contract.requiredTools)).not.toContain("write_file");
  });

  it("promotes a single-step research report task to mutation-required when the task prompt asks for a report artifact", () => {
    const executor = createExecutor();
    executor.agentPolicyConfig = null;
    executor.workspace = { path: process.cwd() };
    executor.task = {
      title: "Daily AI Agent Trends Research",
      prompt:
        "Research the latest trends in AI agents from the last 1 day and summarize findings. Search for AI agent trends across Reddit, X, and tech news sources. Compile and summarize the key findings, trends, and notable developments into a comprehensive report.",
      agentConfig: {},
    };

    const step = {
      id: "research-report",
      description:
        "I'll research the latest AI agent trends from the last 24 hours. Let me first check the existing report format from previous days to maintain consistency, then execute the research.",
      kind: "primary",
      status: "pending",
    };

    executor.plan = {
      description: "Plan",
      steps: [step],
    };

    const contract = (executor as Any).resolveStepExecutionContract(step);

    expect(contract.requiresArtifactEvidence).toBe(true);
    expect(contract.mode).toBe("mutation_required");
  });
});
