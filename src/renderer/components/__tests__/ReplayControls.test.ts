import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReplayControlsBar } from "../ReplayControls";
import type { ReplayControls } from "../../hooks/useReplayMode";

function makeControls(overrides: Partial<ReplayControls> = {}): ReplayControls {
  return {
    isReplayMode: true,
    isPlaying: false,
    areControlsVisible: true,
    replayIndex: 4,
    totalEvents: 12,
    speed: 1,
    replayEvents: [],
    startReplay: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    reset: vi.fn(),
    hideControls: vi.fn(),
    showControls: vi.fn(),
    setSpeed: vi.fn(),
    ...overrides,
  };
}

describe("ReplayControlsBar", () => {
  it("renders a dedicated control to hide the replay frame", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ReplayControlsBar, { controls: makeControls() }),
    );

    expect(markup).toContain("Step 4 / 12");
    expect(markup).toContain("Hide replay controls");
    expect(markup).toContain("replay-btn-hide");
  });
});
