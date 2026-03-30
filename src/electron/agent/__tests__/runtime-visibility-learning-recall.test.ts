import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeVisibilityService } from "../RuntimeVisibilityService";
import { MemoryService } from "../../memory/MemoryService";
import { KnowledgeGraphService } from "../../knowledge-graph/KnowledgeGraphService";

describe("RuntimeVisibilityService learning + recall", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a full learning progression in the expected order", () => {
    const now = Date.now();
    const progress = RuntimeVisibilityService.buildLearningProgress({
      task: {
        id: "task-1",
        workspaceId: "workspace-1",
        title: "Ship the feature",
        status: "completed",
        prompt: "Ship the feature",
      } as Any,
      outcome: "pending_review",
      summary: "Cowork captured the outcome and promoted a skill proposal.",
      memoryCaptured: true,
      playbookReinforced: true,
      skillProposal: {
        proposalId: "proposal-1",
        proposalStatus: "pending",
        reason: "The pattern has repeated enough times.",
      },
      evidenceRefs: [
        {
          evidenceId: "ev-1",
          sourceType: "file",
          sourceUrlOrPath: "/tmp/result.md",
          capturedAt: now,
        },
      ],
      nextAction: "Review the skill proposal",
    });

    expect(progress.taskId).toBe("task-1");
    expect(progress.summary).toContain("captured");
    expect(progress.steps.map((step) => step.stage)).toEqual([
      "memory_captured",
      "playbook_reinforced",
      "skill_proposed",
      "skill_reviewed",
    ]);
    expect(progress.steps[0]?.status).toBe("done");
    expect(progress.steps[1]?.status).toBe("done");
    expect(progress.steps[2]?.status).toBe("pending");
    expect(progress.steps[3]?.status).toBe("pending");
  });

  it("collects unified recall results across sources in a stable ranking order", () => {
    vi.spyOn(MemoryService, "searchForPromptRecall").mockReturnValue([
      {
        id: "memory-1",
        taskId: "task-1",
        type: "note",
        snippet: "alpha memory note",
        createdAt: 100,
        relevanceScore: 0.8,
      } as Any,
    ]);
    vi.spyOn(MemoryService, "searchWorkspaceMarkdown").mockReturnValue([
      {
        id: "note-1",
        path: "/workspace/notes.md",
        type: "workspace_note",
        snippet: "alpha workspace note",
        createdAt: 100,
        relevanceScore: 0.75,
      } as Any,
    ]);
    vi.spyOn(KnowledgeGraphService, "search").mockReturnValue([
      {
        entity: {
          id: "kg-1",
          name: "Alpha entity",
          description: "alpha knowledge graph node",
          updatedAt: 100,
          entityTypeName: "Concept",
          confidence: 0.8,
        },
        score: 0.7,
      } as Any,
    ]);

    const response = RuntimeVisibilityService.collectUnifiedRecall(
      {
        taskRepo: {
          findByCreatedAtRange: () => [
            {
              id: "task-1",
              workspaceId: "workspace-1",
              title: "Alpha task",
              prompt: "alpha prompt",
              resultSummary: "alpha result",
              status: "completed",
              createdAt: 100,
              updatedAt: 100,
            },
          ],
        } as Any,
        eventRepo: {
          findByTaskIds: () => [
            {
              id: "event-1",
              taskId: "task-1",
              type: "assistant_message",
              payload: { message: "alpha message" },
              timestamp: 100,
            },
            {
              id: "event-2",
              taskId: "task-1",
              type: "file_created",
              payload: { path: "/workspace/alpha.ts", message: "alpha file" },
              timestamp: 100,
            },
          ],
        } as Any,
        activityRepo: {
          list: () => [
            {
              id: "activity-1",
              taskId: "task-1",
              title: "Alpha activity",
              description: "alpha activity note",
              createdAt: 100,
              activityType: "info",
              actorType: "system",
            },
          ],
        } as Any,
        workspaceRepo: {
          findById: () => ({ path: "/workspace" }),
        } as Any,
      },
      {
        workspaceId: "workspace-1",
        workspacePath: "/workspace",
        query: "alpha",
        limit: 10,
      },
    );

    expect(response.results.map((result) => result.sourceType)).toEqual([
      "task",
      "message",
      "file",
      "memory",
      "workspace_note",
      "message",
      "knowledge_graph",
    ]);
    expect(response.results[0]?.rank).toBeGreaterThan(response.results[1]?.rank ?? 0);
    expect(response.results[1]?.rank).toBeGreaterThan(response.results[2]?.rank ?? 0);
    expect(response.results.some((result) => result.sourceType === "workspace_note")).toBe(true);
    expect(response.results.some((result) => result.sourceType === "knowledge_graph")).toBe(true);
    expect(response.results[1]?.snippet).toContain("alpha message");
    expect(response.results[2]?.snippet).toContain("alpha file");
  });
});
