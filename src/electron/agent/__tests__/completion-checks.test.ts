import { describe, expect, it } from "vitest";

import { getLoopGuardrailConfig } from "../completion-checks";

describe("completion-checks loop guardrails", () => {
  it("uses tighter follow-up lock thresholds for code-domain tasks", () => {
    const config = getLoopGuardrailConfig("code");
    expect(config.followUpLockMinStreak).toBe(6);
    expect(config.followUpLockMinToolCalls).toBe(6);
  });
});

