import { describe, expect, it } from "vitest";
import {
  extractArtifactPathCandidates,
  isArtifactPathLikeToken,
  isLikelyCommandSnippet,
} from "../step-contract";

describe("step-contract path extraction", () => {
  it("does not treat command snippets as artifact paths", () => {
    const text =
      "Verification: run the app via local server (`python3 -m http.server` or equivalent), then validate interactions.";
    const candidates = extractArtifactPathCandidates(text);
    expect(candidates).toEqual([]);
  });

  it("anchors extraction to path-like tokens while ignoring command-like backticks", () => {
    const text =
      "Create project scaffold under `./win95-ui/` with files `index.html` and `scripts/main.js`, then run `python win95-ui/scripts/validate.py`.";
    const candidates = extractArtifactPathCandidates(text);
    expect(candidates).toEqual(
      expect.arrayContaining(["./win95-ui/", "index.html", "scripts/main.js"]),
    );
    expect(candidates).not.toEqual(expect.arrayContaining(["win95-ui/scripts/validate.py"]));
  });
});

describe("step-contract token classification", () => {
  it("flags CLI snippets as commands", () => {
    expect(isLikelyCommandSnippet("python3 -m http.server")).toBe(true);
    expect(isLikelyCommandSnippet("npm run build")).toBe(true);
  });

  it("recognizes source file paths as artifact-like tokens", () => {
    expect(isArtifactPathLikeToken("scripts/main.js")).toBe(true);
    expect(isArtifactPathLikeToken("index.html")).toBe(true);
    expect(isArtifactPathLikeToken("python3 -m http.server")).toBe(false);
  });
});
