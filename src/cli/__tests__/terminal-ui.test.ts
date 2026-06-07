import { describe, expect, it } from "vitest";
import { promptMarker, renderWelcomeScreen } from "../terminal-ui";

describe("terminal UI", () => {
  it("renders a CoWork OS welcome screen", () => {
    const screen = renderWelcomeScreen({
      version: "0.0.0-test",
      cwd: "/tmp/cowork",
      width: 90,
      color: false,
    });

    expect(screen).toContain("CoWork OS 0.0.0-test");
    expect(screen).toContain("Getting started");
    expect(screen).toContain("/doctor");
    expect(screen).toContain("/workspace list");
    expect(screen).toContain("/effort");
  });

  it("uses the agent-style prompt marker", () => {
    expect(promptMarker(false)).toBe("❯ ");
  });
});
