import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cssPath = fileURLToPath(new URL("../../../styles/index.css", import.meta.url));
const timelineCss = readFileSync(cssPath, "utf8");

describe("StepFeed layout styles", () => {
  it("reserves a dedicated column for the step timestamp", () => {
    expect(timelineCss).toMatch(/\.step-feed-card \.event-header\s*\{[\s\S]*display:\s*grid;/);
    expect(timelineCss).toMatch(
      /\.step-feed-card \.event-header\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;/,
    );
    expect(timelineCss).toMatch(/\.step-feed-card \.event-time\s*\{[\s\S]*align-self:\s*start;/);
  });

  it("allows long step titles and details to wrap inside the reserved content area", () => {
    expect(timelineCss).toMatch(/\.step-feed-card \.event-title\s*\{[\s\S]*white-space:\s*normal;/);
    expect(timelineCss).toMatch(/\.step-feed-card \.event-title\s*\{[\s\S]*overflow-wrap:\s*anywhere;/);
    expect(timelineCss).toMatch(
      /\.step-feed-card \.event-title > \*,[\s\S]*\.step-feed-card \.event-title > p,[\s\S]*\.step-feed-card \.event-title li\s*\{/,
    );
    expect(timelineCss).toMatch(/\.step-feed-card \.event-details\s*\{[\s\S]*max-width:\s*100%;/);
  });
});
