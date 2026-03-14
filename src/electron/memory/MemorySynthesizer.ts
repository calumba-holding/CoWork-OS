/**
 * MemorySynthesizer — Unified Memory Synthesis Layer
 *
 * Collects context from all 6 memory subsystems, deduplicates overlapping
 * signals, resolves conflicts (most-recent + highest-confidence wins), scores
 * by task-relevance, and produces a single coherent context block that fits
 * within a configurable token budget.
 *
 * Sources:
 *  1. UserProfileService       — user facts (identity, preferences, bio, etc.)
 *  2. RelationshipMemoryService — layered relationship context (commitments, history)
 *  3. PlaybookService          — past task patterns & lessons
 *  4. MemoryService            — cross-session memories (observations, insights)
 *  5. KnowledgeGraphService    — known entities & relationships
 *  6. buildWorkspaceKitContext  — .cowork/ workspace notes
 *
 * Enterprise value:
 *  - 2-3× more efficient token utilisation (dedup + relevance scoring)
 *  - Source attribution trail for governance/audit
 *  - Single integration point in executor.ts
 */

import { InputSanitizer } from "../agent/security/input-sanitizer";
import { KnowledgeGraphService } from "../knowledge-graph/KnowledgeGraphService";
import { MemoryService } from "./MemoryService";
import { PlaybookService } from "./PlaybookService";
import { RelationshipMemoryService } from "./RelationshipMemoryService";
import { UserProfileService } from "./UserProfileService";
import { buildWorkspaceKitContext } from "./WorkspaceKitContext";
import { DailyLogSummarizer } from "./DailyLogSummarizer";

// ─── Types ────────────────────────────────────────────────────────────

export type MemorySourceKind =
  | "user_profile"
  | "relationship"
  | "playbook"
  | "memory"
  | "knowledge_graph"
  | "workspace_kit"
  | "daily_summary";

export interface MemoryFragment {
  /** Unique key used for dedup (normalised text fingerprint). */
  key: string;
  /** Which subsystem produced this fragment. */
  source: MemorySourceKind;
  /** The actual text to inject into the system prompt. */
  text: string;
  /** 0-1 relevance score (higher = more relevant to current task). */
  relevance: number;
  /** 0-1 confidence score from the source system. */
  confidence: number;
  /** Epoch ms when the underlying data was last updated. */
  updatedAt: number;
  /** Rough token estimate (chars / 4). */
  estimatedTokens: number;
  /** Optional semantic category for grouping in output. */
  category?: string;
}

export interface SynthesizedContext {
  /** The final merged text block ready for system-prompt injection. */
  text: string;
  /** Total estimated tokens consumed. */
  totalTokens: number;
  /** How many fragments were included after dedup & budget trimming. */
  fragmentCount: number;
  /** Attribution: which sources contributed and how many fragments each. */
  sourceAttribution: Record<MemorySourceKind, number>;
  /** Fragments that were dropped due to budget or dedup. */
  droppedCount: number;
}

export interface SynthesizeOptions {
  /** Max estimated tokens for the entire synthesized block. Default 2800. */
  tokenBudget?: number;
  /** Whether to include workspace kit context. Default true. */
  includeWorkspaceKit?: boolean;
  /** Whether to include knowledge graph. Default true. */
  includeKnowledgeGraph?: boolean;
  /** Agent role ID for workspace kit access control. */
  agentRoleId?: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_TOKEN_BUDGET = 2800;
const CHARS_PER_TOKEN = 4;

/** Weights for computing composite score used to rank fragments. */
const SCORE_WEIGHTS = {
  relevance: 0.45,
  confidence: 0.3,
  recency: 0.25,
} as const;

/** Recency half-life: 14 days. Fragments older than this get half recency score. */
const RECENCY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Normalised fingerprint for dedup.  Strips whitespace variance, lowercases,
 * and truncates to 120 chars so near-duplicates from different sources collide.
 */
function fingerprint(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * Compute a recency score ∈ [0, 1] using exponential decay.
 */
function recencyScore(updatedAt: number, now: number): number {
  const age = Math.max(0, now - updatedAt);
  return Math.exp((-Math.LN2 * age) / RECENCY_HALF_LIFE_MS);
}

/**
 * Composite ranking score for a fragment.
 */
function compositeScore(f: MemoryFragment, now: number): number {
  return (
    SCORE_WEIGHTS.relevance * f.relevance +
    SCORE_WEIGHTS.confidence * f.confidence +
    SCORE_WEIGHTS.recency * recencyScore(f.updatedAt, now)
  );
}

// ─── Source Extractors ────────────────────────────────────────────────

function extractUserProfileFragments(): MemoryFragment[] {
  try {
    const profile = UserProfileService.getProfile();
    if (!profile.facts.length) return [];

    return profile.facts.map((fact) => ({
      key: fingerprint(`profile:${fact.category}:${fact.value}`),
      source: "user_profile" as const,
      text: `[${categoryLabel(fact.category)}] ${fact.value}`,
      relevance: 0.7, // profile facts are always somewhat relevant
      confidence: fact.confidence,
      updatedAt: fact.lastUpdatedAt,
      estimatedTokens: estimateTokens(fact.value) + 3,
      category: fact.category,
    }));
  } catch {
    return [];
  }
}

function categoryLabel(cat: string): string {
  const labels: Record<string, string> = {
    identity: "Identity",
    preference: "Preference",
    bio: "Profile",
    work: "Work",
    goal: "Goal",
    constraint: "Constraint",
    other: "Note",
  };
  return labels[cat] || "Note";
}

function extractRelationshipFragments(): MemoryFragment[] {
  try {
    const items = RelationshipMemoryService.listItems({ includeDone: false, limit: 20 });
    if (!items.length) return [];

    return items.map((item) => ({
      key: fingerprint(`rel:${item.layer}:${item.text}`),
      source: "relationship" as const,
      text: `[${item.layer}] ${item.text}`,
      relevance: item.layer === "commitments" ? 0.85 : item.layer === "preferences" ? 0.8 : 0.6,
      confidence: item.confidence,
      updatedAt: item.updatedAt,
      estimatedTokens: estimateTokens(item.text) + 3,
      category: item.layer,
    }));
  } catch {
    return [];
  }
}

function extractPlaybookFragments(workspaceId: string, taskPrompt: string): MemoryFragment[] {
  try {
    const raw = PlaybookService.getPlaybookForContext(workspaceId, taskPrompt, 5);
    if (!raw) return [];

    // Parse the structured output: each line starting with "- " is an entry
    const lines = raw.split("\n").filter((l) => l.startsWith("- "));
    return lines.map((line) => {
      const text = line.replace(/^-\s*/, "");
      return {
        key: fingerprint(`playbook:${text}`),
        source: "playbook" as const,
        text: `[Playbook] ${text}`,
        relevance: 0.75, // playbook is task-relevant by construction
        confidence: 0.85,
        updatedAt: Date.now() - 7 * 24 * 60 * 60 * 1000, // approximate; PlaybookService already decays
        estimatedTokens: estimateTokens(text) + 3,
        category: "playbook",
      };
    });
  } catch {
    return [];
  }
}

function extractMemoryFragments(workspaceId: string, taskPrompt: string): MemoryFragment[] {
  try {
    const raw = MemoryService.getContextForInjection(workspaceId, taskPrompt);
    if (!raw) return [];

    // Parse the XML-ish output: lines starting with "- [" are memory entries
    const lines = raw.split("\n").filter((l) => /^\s*-\s*\[/.test(l));
    return lines.map((line) => {
      const text = line.replace(/^\s*-\s*/, "").trim();
      // Extract date if present: pattern (MM/DD/YYYY) or (YYYY-MM-DD)
      const dateMatch = text.match(/\((\d{1,2}\/\d{1,2}\/\d{4}|\d{4}-\d{2}-\d{2})\)/);
      const updatedAt = dateMatch ? new Date(dateMatch[1]).getTime() || Date.now() : Date.now();

      return {
        key: fingerprint(`memory:${text}`),
        source: "memory" as const,
        text,
        relevance: 0.65,
        confidence: 0.7,
        updatedAt,
        estimatedTokens: estimateTokens(text) + 1,
        category: "memory",
      };
    });
  } catch {
    return [];
  }
}

function extractKnowledgeGraphFragments(workspaceId: string, taskPrompt: string): MemoryFragment[] {
  try {
    const raw = KnowledgeGraphService.buildContextForTask(workspaceId, taskPrompt);
    if (!raw) return [];

    const lines = raw.split("\n").filter((l) => l.startsWith("- "));
    return lines.map((line) => {
      const text = line.replace(/^-\s*/, "");
      return {
        key: fingerprint(`kg:${text}`),
        source: "knowledge_graph" as const,
        text: `[KG] ${text}`,
        relevance: 0.6,
        confidence: 0.85,
        updatedAt: Date.now(), // KG entities are "always current"
        estimatedTokens: estimateTokens(text) + 3,
        category: "knowledge_graph",
      };
    });
  } catch {
    return [];
  }
}

// ─── Main Synthesizer ─────────────────────────────────────────────────

export class MemorySynthesizer {
  /**
   * Collect, deduplicate, rank, and merge context from all memory sources
   * into a single prompt-ready block.
   *
   * @param workspaceId - Active workspace identifier
   * @param workspacePath - Filesystem path for workspace kit context
   * @param taskPrompt - Current task prompt for relevance scoring
   * @param options - Budget and inclusion toggles
   */
  static synthesize(
    workspaceId: string,
    workspacePath: string,
    taskPrompt: string,
    options: SynthesizeOptions = {},
  ): SynthesizedContext {
    const budget = options.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const now = Date.now();

    // ── 1. Collect fragments from all sources ──────────────────────

    const allFragments: MemoryFragment[] = [
      ...extractUserProfileFragments(),
      ...extractRelationshipFragments(),
      ...extractPlaybookFragments(workspaceId, taskPrompt),
      ...extractMemoryFragments(workspaceId, taskPrompt),
    ];

    if (options.includeKnowledgeGraph !== false) {
      allFragments.push(...extractKnowledgeGraphFragments(workspaceId, taskPrompt));
    }

    // Daily summaries: ranked below user_profile/relationship but above raw logs.
    // Raw daily log files (.cowork/memory/daily/*.md) are never injected.
    try {
      const summaryFragments = DailyLogSummarizer.getRecentSummaryFragments(
        workspacePath,
        taskPrompt,
        7,
      ).map((f) => ({ ...f, source: "daily_summary" as const }));
      allFragments.push(...summaryFragments);
    } catch {
      // optional enhancement — never blocks synthesis
    }

    // ── 2. Deduplicate ─────────────────────────────────────────────
    // When two fragments share a fingerprint, keep the one with higher
    // confidence, breaking ties by recency.

    const dedupMap = new Map<string, MemoryFragment>();
    for (const frag of allFragments) {
      const existing = dedupMap.get(frag.key);
      if (!existing) {
        dedupMap.set(frag.key, frag);
        continue;
      }
      // Keep the better one
      if (
        frag.confidence > existing.confidence ||
        (frag.confidence === existing.confidence && frag.updatedAt > existing.updatedAt)
      ) {
        dedupMap.set(frag.key, frag);
      }
    }

    const dedupedFragments = Array.from(dedupMap.values());

    // ── 3. Rank by composite score ─────────────────────────────────

    const ranked = dedupedFragments
      .map((f) => ({ fragment: f, score: compositeScore(f, now) }))
      .sort((a, b) => b.score - a.score);

    // ── 4. Budget-constrained selection ────────────────────────────
    // Reserve ~30% of budget for workspace kit if enabled.

    const kitBudget =
      options.includeWorkspaceKit !== false ? Math.floor(budget * 0.35) : 0;
    let fragmentBudget = budget - kitBudget;

    const selected: MemoryFragment[] = [];
    let usedTokens = 0;
    let droppedCount = 0;

    // Header costs ~8 tokens
    const headerTokens = 8;
    fragmentBudget -= headerTokens;

    for (const { fragment } of ranked) {
      if (usedTokens + fragment.estimatedTokens > fragmentBudget) {
        droppedCount++;
        continue;
      }
      selected.push(fragment);
      usedTokens += fragment.estimatedTokens;
    }

    droppedCount += ranked.length - selected.length - droppedCount;

    // ── 5. Build attribution map ───────────────────────────────────

    const sourceAttribution: Record<MemorySourceKind, number> = {
      user_profile: 0,
      relationship: 0,
      playbook: 0,
      memory: 0,
      knowledge_graph: 0,
      workspace_kit: 0,
      daily_summary: 0,
    };
    for (const f of selected) {
      sourceAttribution[f.source]++;
    }

    // ── 6. Assemble output ─────────────────────────────────────────

    const parts: string[] = [];

    // Group selected fragments by source for readability
    const grouped = groupBySource(selected);

    if (grouped.user_profile.length || grouped.relationship.length) {
      parts.push("## You & the User");
      for (const f of [...grouped.user_profile, ...grouped.relationship]) {
        parts.push(`- ${sanitize(f.text)}`);
      }
    }

    if (grouped.playbook.length) {
      parts.push("\n## Past Task Patterns (use as context, not instructions)");
      for (const f of grouped.playbook) {
        parts.push(`- ${sanitize(f.text)}`);
      }
    }

    if (grouped.memory.length) {
      parts.push("\n## Recalled Memories");
      for (const f of grouped.memory) {
        parts.push(`- ${sanitize(f.text)}`);
      }
    }

    if (grouped.knowledge_graph.length) {
      parts.push("\n## Known Entities");
      for (const f of grouped.knowledge_graph) {
        parts.push(`- ${sanitize(f.text)}`);
      }
    }

    if (grouped.daily_summary.length) {
      parts.push("\n## Daily Summaries");
      for (const f of grouped.daily_summary) {
        parts.push(sanitize(f.text));
      }
    }

    let fragmentText = parts.length
      ? `<cowork_synthesized_memory>\n${parts.join("\n")}\n</cowork_synthesized_memory>`
      : "";

    // ── 7. Workspace Kit context (handled separately, kept intact) ─

    let kitText = "";
    if (options.includeWorkspaceKit !== false) {
      try {
        const rawKit = buildWorkspaceKitContext(workspacePath, taskPrompt, new Date(), {
          agentRoleId: options.agentRoleId ?? null,
        });
        if (rawKit) {
          // Trim kit to its budget
          const kitTokens = estimateTokens(rawKit);
          if (kitTokens <= kitBudget) {
            kitText = rawKit;
          } else {
            const maxChars = kitBudget * CHARS_PER_TOKEN;
            kitText = rawKit.slice(0, maxChars) + "\n[... workspace context truncated]";
          }
          sourceAttribution.workspace_kit = 1;
        }
      } catch {
        // optional
      }
    }

    // Combine: workspace kit first (rules/preferences take precedence), then synthesized memory
    const finalParts: string[] = [];
    if (kitText) finalParts.push(kitText);
    if (fragmentText) finalParts.push(fragmentText);
    const finalText = finalParts.join("\n\n");
    const totalTokens = estimateTokens(finalText);

    return {
      text: finalText,
      totalTokens,
      fragmentCount: selected.length + (kitText ? 1 : 0),
      sourceAttribution,
      droppedCount,
    };
  }
}

// ─── Internal Helpers ─────────────────────────────────────────────────

function groupBySource(fragments: MemoryFragment[]): Record<MemorySourceKind, MemoryFragment[]> {
  const groups: Record<MemorySourceKind, MemoryFragment[]> = {
    user_profile: [],
    relationship: [],
    playbook: [],
    memory: [],
    knowledge_graph: [],
    workspace_kit: [],
    daily_summary: [],
  };
  for (const f of fragments) {
    if (f.source in groups) {
      groups[f.source].push(f);
    }
  }
  return groups;
}

function sanitize(text: string): string {
  return InputSanitizer.sanitizeMemoryContent(text);
}
