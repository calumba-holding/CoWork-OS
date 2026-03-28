import { beforeEach, describe, expect, it, vi } from "vitest";

const rankModelInvocableSkillsForQuery = vi.fn();
const getSkill = vi.fn();
const matchesSkillRoutingQuery = vi.fn();

vi.mock("../custom-skill-loader", () => ({
  getCustomSkillLoader: () => ({
    rankModelInvocableSkillsForQuery,
    getSkill,
    matchesSkillRoutingQuery,
  }),
}));

import { TaskExecutor } from "../executor";

describe("TaskExecutor high-confidence natural-language skill routing", () => {
  function createExecutor(prompt: string, taskOverrides: Any = {}) {
    const executor = Object.create(TaskExecutor.prototype) as Any;

    executor.task = {
      id: "task-skill-route-1",
      title: "Routing test",
      prompt,
      rawPrompt: taskOverrides.rawPrompt,
      parentTaskId: taskOverrides.parentTaskId,
      agentType: taskOverrides.agentType,
      createdAt: Date.now() - 1000,
      ...taskOverrides,
    };

    executor.getAvailableTools = vi.fn(() => [{ name: "use_skill" }]);
    executor.emitEvent = vi.fn();
    executor.toolRegistry = {
      executeTool: vi.fn(async (_name: string, _input: Any) => ({
        success: true,
        expanded_prompt: "Expanded dual-agent review workflow",
      })),
    };

    return executor as TaskExecutor & {
      toolRegistry: { executeTool: ReturnType<typeof vi.fn> };
      emitEvent: ReturnType<typeof vi.fn>;
      getAvailableTools: ReturnType<typeof vi.fn>;
    };
  }

  beforeEach(() => {
    rankModelInvocableSkillsForQuery.mockReset();
    getSkill.mockReset();
    matchesSkillRoutingQuery.mockReset();
    getSkill.mockImplementation((skillId: string) => ({ id: skillId, parameters: [] }));
    matchesSkillRoutingQuery.mockReturnValue(true);
  });

  it("deterministically expands the strongest matching skill for the PR review prompt", async () => {
    rankModelInvocableSkillsForQuery.mockReturnValue([
      {
        skill: {
          id: "codex-cli",
          name: "Codex CLI Agent",
          description: "Review a PR with Codex CLI.",
          parameters: [],
        },
        score: 0.93,
      },
      {
        skill: {
          id: "coding-agent",
          name: "Coding-agent",
          description: "Run coding agents via background process.",
          parameters: [],
        },
        score: 0.58,
      },
    ]);

    const prompt =
      "We need to review PR #55 on cowork os repo. Spin up Codex to review it.";
    const executor = createExecutor(prompt);

    const handled = await (TaskExecutor as Any).prototype.maybeHandleHighConfidenceSkillRouting.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.toolRegistry.executeTool).toHaveBeenCalledWith("use_skill", {
      skill_id: "codex-cli",
      parameters: {},
    });
    expect(executor.task.prompt).toBe("Expanded dual-agent review workflow");
  });

  it("does not auto-route when the top skill still needs required parameters", async () => {
    const repoReviewSkill = {
      id: "repo-review",
      name: "Repo Review",
      description: "Review a repository with custom inputs.",
      parameters: [
        {
          name: "repoPath",
          type: "string",
          description: "Repository path",
          required: true,
        },
      ],
    };
    rankModelInvocableSkillsForQuery.mockReturnValue([
      {
        skill: repoReviewSkill,
        score: 0.96,
      },
    ]);
    getSkill.mockReturnValue(repoReviewSkill);

    const executor = createExecutor("Review this repo with the specialized reviewer.");
    const originalPrompt = executor.task.prompt;

    const handled = await (TaskExecutor as Any).prototype.maybeHandleHighConfidenceSkillRouting.call(
      executor,
    );

    expect(handled).toBe(false);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
    expect(executor.task.prompt).toBe(originalPrompt);
  });

  it("does not auto-route when the top two skills are too close to call safely", async () => {
    rankModelInvocableSkillsForQuery.mockReturnValue([
      {
        skill: {
          id: "codex-cli",
          name: "Codex CLI Agent",
          description: "Review with Codex.",
          parameters: [],
        },
        score: 0.82,
      },
      {
        skill: {
          id: "coding-agent",
          name: "Coding-agent",
          description: "Run coding agents.",
          parameters: [],
        },
        score: 0.75,
      },
    ]);

    const executor = createExecutor("Use codex and figure out the best next step.");
    const handled = await (TaskExecutor as Any).prototype.maybeHandleHighConfidenceSkillRouting.call(
      executor,
    );

    expect(handled).toBe(false);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
  });

  it("explicitly routes when the prompt names a skill, even if the confidence score is modest", async () => {
    rankModelInvocableSkillsForQuery.mockReturnValue([
      {
        skill: {
          id: "novelist",
          name: "Novelist",
          description: "Run an autonomous fiction pipeline.",
          parameters: [],
        },
        score: 0.62,
      },
      {
        skill: {
          id: "summarize",
          name: "Summarize",
          description: "Summarize text.",
          parameters: [],
        },
        score: 0.17,
      },
    ]);

    const executor = createExecutor("Use the novelist skill. Seed: a climatologist discovers a fog city.");
    executor.getAvailableTools = vi.fn(() => [{ name: "read_file" }]);
    const handled = await (TaskExecutor as Any).prototype.maybeHandleHighConfidenceSkillRouting.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.toolRegistry.executeTool).toHaveBeenCalledWith("use_skill", {
      skill_id: "novelist",
      parameters: {},
    });
    expect(executor.task.prompt).toBe("Expanded dual-agent review workflow");
    expect(executor.task.rawPrompt).toBe(
      "Use the novelist skill. Seed: a climatologist discovers a fog city.",
    );
  });

  it("explicitly routes when the prompt names the autoresearch-report skill", async () => {
    rankModelInvocableSkillsForQuery.mockReturnValue([
      {
        skill: {
          id: "autoresearch-report",
          name: "AutoResearch Report",
          description: "Run an autonomous scientific research pipeline.",
          parameters: [],
        },
        score: 0.61,
      },
      {
        skill: {
          id: "summarize",
          name: "Summarize",
          description: "Summarize text.",
          parameters: [],
        },
        score: 0.14,
      },
    ]);

    const executor = createExecutor(
      "Use the autoresearch-report skill. Question: how do genetic changes in the brain contribute to Alzheimer's?",
    );
    executor.getAvailableTools = vi.fn(() => [{ name: "read_file" }]);

    const handled = await (TaskExecutor as Any).prototype.maybeHandleHighConfidenceSkillRouting.call(
      executor,
    );

    expect(handled).toBe(true);
    expect(executor.toolRegistry.executeTool).toHaveBeenCalledWith("use_skill", {
      skill_id: "autoresearch-report",
      parameters: {},
    });
    expect(executor.task.prompt).toBe("Expanded dual-agent review workflow");
  });

  it("does not deterministically auto-route delegated child tasks", async () => {
    rankModelInvocableSkillsForQuery.mockReturnValue([
      {
        skill: {
          id: "usecase-chief-of-staff-briefing",
          name: "Chief of Staff Briefing",
          description: "Produce a morning chief-of-staff briefing.",
          parameters: [],
        },
        score: 0.97,
      },
    ]);

    const prompt =
      "Your mission is to found, design, and launch a public micro-state with working institutions.";
    const executor = createExecutor(prompt, {
      parentTaskId: "parent-1",
      agentType: "sub",
    });

    const handled = await (TaskExecutor as Any).prototype.maybeHandleHighConfidenceSkillRouting.call(
      executor,
    );

    expect(handled).toBe(false);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
    expect(executor.task.prompt).toBe(prompt);
  });

  it("skips stale auto-routed skills that no longer satisfy the current keyword gate", async () => {
    const novelist = {
      id: "novelist",
      name: "Novelist",
      description: "Run an autonomous fiction pipeline.",
      parameters: [],
      metadata: {
        routing: {
          keywords: ["novel", "fiction"],
        },
      },
    };

    rankModelInvocableSkillsForQuery.mockReturnValue([
      {
        skill: novelist,
        score: 0.95,
      },
    ]);
    getSkill.mockReturnValue(novelist);
    matchesSkillRoutingQuery.mockReturnValue(false);

    const executor = createExecutor(
      "check this pdf to see how much of the concept is integrated to cowork os via the latest commits and whats still missing?",
    );

    const handled = await (TaskExecutor as Any).prototype.maybeHandleHighConfidenceSkillRouting.call(
      executor,
    );

    expect(handled).toBe(false);
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
    expect(executor.task.prompt).toContain("check this pdf");
  });
});
