import { describe, expect, it, vi } from "vitest";
import {
  SHARED_PROMPT_POLICY_CORE,
  buildModeDomainContract,
  composePromptSections,
  resolvePromptSections,
} from "../executor-prompt-sections";

describe("executor-prompt-sections", () => {
  it("buildModeDomainContract returns execute/code guidance", () => {
    const text = buildModeDomainContract("execute", "code");

    expect(text).toContain("EXECUTION MODE: execute");
    expect(text).toContain("TASK DOMAIN: code");
    expect(text).toContain("full tool execution is allowed");
    expect(text).toContain("technical depth and verification are expected");
  });

  it("composePromptSections truncates section by per-section budget", () => {
    const result = composePromptSections([
      {
        key: "required",
        text: "x ".repeat(1200),
        required: true,
        maxTokens: 120,
      },
    ]);

    expect(result.truncatedSections).toContain("required");
    expect(result.prompt).toContain("truncated for budget");
  });

  it("composePromptSections drops optional sections before required when total budget is exceeded", () => {
    const result = composePromptSections(
      [
        { key: "required", text: SHARED_PROMPT_POLICY_CORE, required: true },
        { key: "optional-a", text: "a ".repeat(1400), required: false, dropPriority: 10 },
        { key: "optional-b", text: "b ".repeat(1400), required: false, dropPriority: 5 },
      ],
      800,
    );

    expect(result.droppedSections.length).toBeGreaterThan(0);
    expect(result.droppedSections).toContain("optional-a");
    expect(result.prompt).toContain("CONFIDENTIALITY");
  });

  it("reuses cached session sections and recomputes turn sections", async () => {
    const sessionResolve = vi.fn(async () => "session text");
    const turnResolve = vi.fn(async () => "turn text");
    const cache = new Map<string, string | null>();

    await resolvePromptSections(
      [
        { key: "session", resolve: sessionResolve, cacheScope: "session", stableInputHash: "a" },
        { key: "turn", resolve: turnResolve, cacheScope: "turn", stableInputHash: "b" },
      ],
      cache,
    );
    await resolvePromptSections(
      [
        { key: "session", resolve: sessionResolve, cacheScope: "session", stableInputHash: "a" },
        { key: "turn", resolve: turnResolve, cacheScope: "turn", stableInputHash: "b" },
      ],
      cache,
    );

    expect(sessionResolve).toHaveBeenCalledTimes(1);
    expect(turnResolve).toHaveBeenCalledTimes(2);
  });
});
