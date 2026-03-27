import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { ChannelRepository } from "../database/repositories";
import { GoogleWorkspaceSettingsManager } from "../settings/google-workspace-manager";
import { gmailRequest } from "../utils/gmail-api";
import { googleCalendarRequest } from "../utils/google-calendar-api";
import { EmailClient } from "../gateway/channels/email-client";
import { LoomEmailClient } from "../gateway/channels/loom-client";
import { assertSafeLoomMailboxFolder } from "../utils/loom";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import type {
  MailboxAccount,
  MailboxActionProposal,
  MailboxApplyActionInput,
  MailboxBulkReviewInput,
  MailboxBulkReviewResult,
  MailboxCommitment,
  MailboxCommitmentState,
  MailboxContactMemory,
  MailboxDraftOptions,
  MailboxDraftSuggestion,
  MailboxListThreadsInput,
  MailboxMessage,
  MailboxParticipant,
  MailboxPriorityBand,
  MailboxProposalStatus,
  MailboxProposalType,
  MailboxProvider,
  MailboxResearchResult,
  MailboxSummaryCard,
  MailboxSyncResult,
  MailboxSyncStatus,
  MailboxThreadCategory,
  MailboxThreadDetail,
  MailboxThreadListItem,
} from "../../shared/mailbox";

type MailboxAccountRow = {
  id: string;
  provider: MailboxProvider;
  address: string;
  display_name: string | null;
  status: "connected" | "degraded" | "disconnected";
  capabilities_json: string | null;
  last_synced_at: number | null;
};

type MailboxThreadRow = {
  id: string;
  account_id: string;
  provider: MailboxProvider;
  provider_thread_id: string;
  subject: string;
  snippet: string;
  participants_json: string | null;
  labels_json: string | null;
  category: MailboxThreadCategory;
  priority_score: number;
  urgency_score: number;
  needs_reply: number;
  stale_followup: number;
  cleanup_candidate: number;
  handled: number;
  unread_count: number;
  message_count: number;
  last_message_at: number;
};

type MailboxMessageRow = {
  id: string;
  thread_id: string;
  provider_message_id: string;
  direction: "incoming" | "outgoing";
  from_name: string | null;
  from_email: string | null;
  to_json: string | null;
  cc_json: string | null;
  bcc_json: string | null;
  subject: string;
  snippet: string;
  body_text: string;
  received_at: number;
  is_unread: number;
};

type MailboxSummaryRow = {
  thread_id: string;
  summary_text: string;
  key_asks_json: string | null;
  extracted_questions_json: string | null;
  suggested_next_action: string;
  confidence: number;
  updated_at: number;
};

type MailboxDraftRow = {
  id: string;
  thread_id: string;
  subject: string;
  body_text: string;
  tone: string;
  rationale: string;
  schedule_notes: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxProposalRow = {
  id: string;
  thread_id: string;
  proposal_type: MailboxProposalType;
  title: string;
  reasoning: string;
  preview_json: string | null;
  status: MailboxProposalStatus;
  created_at: number;
  updated_at: number;
};

type MailboxCommitmentRow = {
  id: string;
  thread_id: string;
  message_id: string | null;
  title: string;
  due_at: number | null;
  state: MailboxCommitmentState;
  owner_email: string | null;
  source_excerpt: string | null;
  created_at: number;
  updated_at: number;
};

type MailboxContactRow = {
  id: string;
  account_id: string;
  email: string;
  name: string | null;
  company: string | null;
  role: string | null;
  crm_links_json: string | null;
  learned_facts_json: string | null;
  response_tendency: string | null;
  last_interaction_at: number | null;
  open_commitments: number;
};

type ScheduleSuggestion = {
  slots: string[];
  summary: string;
};

type NormalizedThreadInput = {
  id: string;
  accountId: string;
  provider: MailboxProvider;
  providerThreadId: string;
  subject: string;
  snippet: string;
  participants: MailboxParticipant[];
  labels: string[];
  category: MailboxThreadCategory;
  priorityScore: number;
  urgencyScore: number;
  needsReply: boolean;
  staleFollowup: boolean;
  cleanupCandidate: boolean;
  handled: boolean;
  unreadCount: number;
  lastMessageAt: number;
  messages: Array<{
    id: string;
    providerMessageId: string;
    direction: "incoming" | "outgoing";
    from?: MailboxParticipant;
    to: MailboxParticipant[];
    cc: MailboxParticipant[];
    bcc: MailboxParticipant[];
    subject: string;
    snippet: string;
    body: string;
    receivedAt: number;
    unread: boolean;
  }>;
};

type NormalizedMailboxMessage = NormalizedThreadInput["messages"][number];

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalizeWhitespace(value: string, maxLength = 600): string {
  const text = String(value || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function normalizeEmailAddress(value?: string | null): string | null {
  const raw = asString(value);
  if (!raw) return null;
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] || raw).trim().toLowerCase();
}

function extractDisplayName(value?: string | null): string | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const match = raw.match(/^(.*?)\s*<[^>]+>$/);
  const name = (match?.[1] || "").replace(/^"|"$/g, "").trim();
  return name || undefined;
}

function parseAddressList(input: unknown): MailboxParticipant[] {
  if (Array.isArray(input)) {
    return input.flatMap((entry) => parseAddressList(entry));
  }

  const raw = asString(input);
  if (!raw) return [];

  return raw
    .split(",")
    .map((part) => {
      const email = normalizeEmailAddress(part);
      if (!email) return null;
      return {
        email,
        name: extractDisplayName(part),
      } as MailboxParticipant;
    })
    .filter((entry): entry is MailboxParticipant => Boolean(entry));
}

function base64UrlDecode(data?: string): string {
  if (!data) return "";
  try {
    const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4 || 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function extractGmailHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  const lower = name.toLowerCase();
  const header = headers.find((entry) => entry?.name?.toLowerCase() === lower);
  return header?.value || null;
}

function extractGmailBody(payload: Any): string {
  const mimeType = asString(payload?.mimeType) || "";
  if (payload?.body?.data && mimeType === "text/plain") {
    return normalizeWhitespace(base64UrlDecode(payload.body.data), 4000);
  }

  const parts = Array.isArray(payload?.parts) ? payload.parts : [];
  for (const part of parts) {
    const text = extractGmailBody(part);
    if (text) return text;
  }

  if (payload?.body?.data && mimeType === "text/html") {
    return normalizeWhitespace(stripHtml(base64UrlDecode(payload.body.data)), 4000);
  }

  if (payload?.body?.data) {
    return normalizeWhitespace(base64UrlDecode(payload.body.data), 4000);
  }

  return "";
}

function uniqueParticipants(participants: MailboxParticipant[]): MailboxParticipant[] {
  const byEmail = new Map<string, MailboxParticipant>();
  for (const participant of participants) {
    const email = normalizeEmailAddress(participant.email);
    if (!email) continue;
    const current = byEmail.get(email);
    if (!current || (!current.name && participant.name)) {
      byEmail.set(email, { email, name: participant.name });
    }
  }
  return Array.from(byEmail.values());
}

function deriveCategory(subject: string, labels: string[], body: string): MailboxThreadCategory {
  const lowerSubject = subject.toLowerCase();
  const lowerBody = body.toLowerCase();
  const labelSet = new Set(labels.map((label) => label.toUpperCase()));

  if (labelSet.has("CATEGORY_PROMOTIONS") || /\bnewsletter|sale|discount|unsubscribe\b/.test(lowerBody)) {
    return "promotions";
  }
  if (labelSet.has("CATEGORY_UPDATES") || /\breceipt|invoice|notification|alert\b/.test(lowerSubject)) {
    return "updates";
  }
  if (/\bmeet|schedule|calendar|availability|slot\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "calendar";
  }
  if (/\bfollow up|checking in|circling back|nudge\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "follow_up";
  }
  if (labelSet.has("IMPORTANT") || /\burgent|asap|deadline|today|blocking\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "priority";
  }
  if (/\bthanks|family|friend|personal\b/.test(`${lowerSubject} ${lowerBody}`)) {
    return "personal";
  }
  return "other";
}

function computeScores(params: {
  subject: string;
  body: string;
  unreadCount: number;
  lastMessageAt: number;
  needsReply: boolean;
  cleanupCandidate: boolean;
  category: MailboxThreadCategory;
}): { priorityScore: number; urgencyScore: number; staleFollowup: boolean; handled: boolean } {
  const text = `${params.subject} ${params.body}`.toLowerCase();
  let priorityScore = 20;
  let urgencyScore = 10;

  if (params.unreadCount > 0) {
    priorityScore += 18;
    urgencyScore += 8;
  }
  if (params.needsReply) {
    priorityScore += 14;
    urgencyScore += 12;
  }
  if (/\burgent|asap|critical|today|deadline|immediately|eod\b/.test(text)) {
    priorityScore += 22;
    urgencyScore += 24;
  }
  if (params.category === "priority") {
    priorityScore += 16;
    urgencyScore += 12;
  }
  if (params.category === "calendar") {
    priorityScore += 10;
    urgencyScore += 18;
  }
  if (params.cleanupCandidate) {
    priorityScore -= 10;
    urgencyScore -= 8;
  }

  const ageHours = Math.max(0, Date.now() - params.lastMessageAt) / (60 * 60 * 1000);
  const staleFollowup = params.needsReply && ageHours >= 36;
  if (staleFollowup) {
    urgencyScore += 18;
  }

  priorityScore = Math.max(0, Math.min(100, priorityScore));
  urgencyScore = Math.max(0, Math.min(100, urgencyScore));
  return {
    priorityScore,
    urgencyScore,
    staleFollowup,
    handled: !params.needsReply && params.unreadCount === 0,
  };
}

function priorityBandFromScore(score: number): MailboxPriorityBand {
  if (score >= 80) return "critical";
  if (score >= 60) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function companyFromEmail(email?: string): string | undefined {
  const normalized = normalizeEmailAddress(email || "");
  if (!normalized || normalized.endsWith("@gmail.com") || normalized.endsWith("@outlook.com")) {
    return undefined;
  }
  const domain = normalized.split("@")[1] || "";
  const label = domain.split(".")[0] || "";
  if (!label) return undefined;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function excerptLines(text: string, count = 2): string[] {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, count);
}

function parseDueAt(text: string): number | undefined {
  const normalized = text.toLowerCase();
  if (/\btoday\b/.test(normalized)) {
    return Date.now() + 10 * 60 * 60 * 1000;
  }
  if (/\btomorrow\b/.test(normalized)) {
    return Date.now() + 34 * 60 * 60 * 1000;
  }
  const weekdayMatch = normalized.match(
    /\b(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?)\b/,
  );
  if (weekdayMatch) {
    const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const target = weekdays.findIndex((entry) => weekdayMatch[1].startsWith(entry));
    if (target >= 0) {
      const now = new Date();
      const result = new Date(now);
      let diff = target - now.getDay();
      if (diff <= 0) diff += 7;
      result.setDate(now.getDate() + diff);
      result.setHours(16, 0, 0, 0);
      return result.getTime();
    }
  }
  return undefined;
}

export class MailboxService {
  private channelRepo: ChannelRepository;
  private syncInFlight = false;

  constructor(private db: Database.Database) {
    this.channelRepo = new ChannelRepository(db);
  }

  isAvailable(): boolean {
    return GoogleWorkspaceSettingsManager.loadSettings().enabled || this.hasEmailChannel();
  }

  async getSyncStatus(): Promise<MailboxSyncStatus> {
    const accountRows = this.db
      .prepare(
        `SELECT id, provider, address, display_name, status, capabilities_json, last_synced_at
         FROM mailbox_accounts
         ORDER BY updated_at DESC`,
      )
      .all() as MailboxAccountRow[];

    const accounts = accountRows.map((row) => this.mapAccountRow(row));
    const countsRow = this.db
      .prepare(
        `SELECT
           COUNT(*) AS thread_count,
           COALESCE(SUM(unread_count), 0) AS unread_count,
           COALESCE(SUM(CASE WHEN needs_reply = 1 THEN 1 ELSE 0 END), 0) AS needs_reply_count
         FROM mailbox_threads`,
      )
      .get() as { thread_count: number; unread_count: number; needs_reply_count: number };
    const proposalCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mailbox_action_proposals
         WHERE status = 'suggested'`,
      )
      .get() as { count: number };
    const commitmentCountRow = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM mailbox_commitments
         WHERE state IN ('suggested', 'accepted')`,
      )
      .get() as { count: number };

    const lastSyncedAt =
      accounts
        .map((account) => account.lastSyncedAt || 0)
        .sort((a, b) => b - a)[0] || undefined;
    const primaryProvider = accounts[0]?.provider;

    return {
      connected: accounts.length > 0,
      primaryProvider,
      accounts,
      lastSyncedAt,
      syncInFlight: this.syncInFlight,
      threadCount: countsRow.thread_count || 0,
      unreadCount: countsRow.unread_count || 0,
      needsReplyCount: countsRow.needs_reply_count || 0,
      proposalCount: proposalCountRow.count || 0,
      commitmentCount: commitmentCountRow.count || 0,
      statusLabel:
        accounts.length === 0
          ? "Connect Gmail or Email channel"
          : `${accounts.length} account${accounts.length === 1 ? "" : "s"} synced`,
    };
  }

  async sync(limit = 25): Promise<MailboxSyncResult> {
    this.syncInFlight = true;
    try {
      const accounts: MailboxAccount[] = [];
      let syncedThreads = 0;
      let syncedMessages = 0;

      if (GoogleWorkspaceSettingsManager.loadSettings().enabled) {
        const result = await this.syncGmail(limit);
        if (result) {
          accounts.push(result.account);
          syncedThreads += result.syncedThreads;
          syncedMessages += result.syncedMessages;
        }
      }

      if (accounts.length === 0 && this.hasEmailChannel()) {
        const result = await this.syncImap(limit);
        if (result) {
          accounts.push(result.account);
          syncedThreads += result.syncedThreads;
          syncedMessages += result.syncedMessages;
        }
      }

      if (accounts.length === 0) {
        throw new Error(
          "No connected mailbox was found. Enable Google Workspace or configure the Email channel.",
        );
      }

      const lastSyncedAt = Date.now();
      return {
        accounts,
        syncedThreads,
        syncedMessages,
        lastSyncedAt,
      };
    } finally {
      this.syncInFlight = false;
    }
  }

  async listThreads(input: MailboxListThreadsInput = {}): Promise<MailboxThreadListItem[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (input.query) {
      conditions.push("(subject LIKE ? OR snippet LIKE ?)");
      values.push(`%${input.query}%`, `%${input.query}%`);
    }
    if (input.category && input.category !== "all") {
      conditions.push("category = ?");
      values.push(input.category);
    }
    if (typeof input.needsReply === "boolean") {
      conditions.push("needs_reply = ?");
      values.push(input.needsReply ? 1 : 0);
    }
    if (typeof input.cleanupCandidate === "boolean") {
      conditions.push("cleanup_candidate = ?");
      values.push(input.cleanupCandidate ? 1 : 0);
    }

    const limit = Math.min(Math.max(input.limit ?? 40, 1), 100);
    const rows = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           unread_count,
           message_count,
           last_message_at
         FROM mailbox_threads
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY priority_score DESC, urgency_score DESC, last_message_at DESC
         LIMIT ?`,
      )
      .all(...values, limit) as MailboxThreadRow[];

    return rows.map((row) => this.mapThreadRow(row, this.getSummaryForThread(row.id) ?? undefined));
  }

  async getThread(threadId: string): Promise<MailboxThreadDetail | null> {
    const row = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           unread_count,
           message_count,
           last_message_at
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(threadId) as MailboxThreadRow | undefined;
    if (!row) return null;

    const summary = this.getSummaryForThread(threadId) ?? (await this.summarizeThread(threadId));
    const messages = this.getMessagesForThread(threadId);
    const drafts = this.getDraftsForThread(threadId);
    const proposals = this.getProposalsForThread(threadId);
    const commitments = this.getCommitmentsForThread(threadId);
    const contactMemory = this.getPrimaryContactMemory(threadId);
    const research = await this.researchContact(threadId);

    return {
      ...this.mapThreadRow(row, summary || undefined),
      messages,
      drafts,
      proposals,
      commitments,
      contactMemory,
      research,
    };
  }

  async summarizeThread(threadId: string): Promise<MailboxSummaryCard | null> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return null;

    const combinedText = detail.messages
      .map((message) => message.body || message.snippet)
      .join("\n\n")
      .trim();
    const lines = excerptLines(combinedText, 4);
    const questions = detail.messages
      .flatMap((message) =>
        excerptLines(message.body, 6).filter((line) => line.includes("?")),
      )
      .slice(0, 3);
    const asks = detail.messages
      .flatMap((message) =>
        excerptLines(message.body, 6).filter((line) =>
          /\bplease|can you|could you|need|action|required|review\b/i.test(line),
        ),
      )
      .slice(0, 3);

    const summaryText =
      lines[0] ||
      detail.snippet ||
      `Recent email activity in ${detail.subject || "this thread"}`;
    const nextAction = detail.needsReply
      ? "Draft a reply"
      : detail.cleanupCandidate
        ? "Queue for cleanup review"
        : detail.category === "calendar"
          ? "Propose scheduling options"
          : "Keep as reference";
    const confidence = Math.min(
      0.94,
      0.58 + (asks.length > 0 ? 0.16 : 0) + (questions.length > 0 ? 0.12 : 0),
    );
    const updatedAt = Date.now();

    this.db
      .prepare(
        `INSERT INTO mailbox_summaries
          (thread_id, summary_text, key_asks_json, extracted_questions_json, suggested_next_action, confidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           summary_text = excluded.summary_text,
           key_asks_json = excluded.key_asks_json,
           extracted_questions_json = excluded.extracted_questions_json,
           suggested_next_action = excluded.suggested_next_action,
           confidence = excluded.confidence,
           updated_at = excluded.updated_at`,
      )
      .run(
        threadId,
        normalizeWhitespace(summaryText, 340),
        JSON.stringify(asks),
        JSON.stringify(questions),
        nextAction,
        confidence,
        updatedAt,
      );

    this.refreshThreadProposals(detail);

    return {
      summary: normalizeWhitespace(summaryText, 340),
      keyAsks: asks,
      extractedQuestions: questions,
      suggestedNextAction: nextAction,
      confidence,
      updatedAt,
    };
  }

  async generateDraft(
    threadId: string,
    options: MailboxDraftOptions = {},
  ): Promise<MailboxDraftSuggestion | null> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return null;

    const summary = this.getSummaryForThread(threadId) || (await this.summarizeThread(threadId));
    const scheduleSuggestion =
      options.includeAvailability !== false && detail.category === "calendar"
        ? await this.getScheduleSuggestion()
        : null;
    const relationshipContext = RelationshipMemoryService.buildPromptContext({
      maxPerLayer: 1,
      maxChars: 420,
    });
    const latestIncoming =
      detail.messages.filter((message) => message.direction === "incoming").slice(-1)[0] ||
      detail.messages[detail.messages.length - 1];
    const recipient =
      latestIncoming?.from?.name || latestIncoming?.from?.email || detail.participants[0]?.email || "there";
    const greeting = recipient && recipient !== "there" ? `Hi ${recipient.split(" ")[0]},` : "Hi,";
    const keyAsk = summary?.keyAsks[0];
    const tone = options.tone || "concise";

    const bodyLines = [greeting, ""];
    if (keyAsk) {
      bodyLines.push(`Thanks for the note. I reviewed the request about ${keyAsk.replace(/[.?!]$/, "")}.`);
    } else {
      bodyLines.push(`Thanks for the update on ${detail.subject.toLowerCase()}.`);
    }

    if (scheduleSuggestion?.slots.length) {
      bodyLines.push("");
      bodyLines.push(`I can make time for this. A few options on my side: ${scheduleSuggestion.slots.join(", ")}.`);
    } else if (detail.needsReply) {
      bodyLines.push("");
      bodyLines.push("I can take this forward and will follow up with the next concrete step shortly.");
    }

    if (relationshipContext) {
      const preferenceHint = relationshipContext
        .split("\n")
        .find((line) => line.toLowerCase().includes("feedback preference"));
      if (preferenceHint && !/brief|concise/i.test(tone)) {
        bodyLines.push("");
        bodyLines.push("Keeping this short and practical.");
      }
    }

    bodyLines.push("");
    bodyLines.push("Best,");

    const body = bodyLines.join("\n");
    const draftId = randomUUID();
    const now = Date.now();
    const rationale = summary?.suggestedNextAction || "Drafted from latest thread context and mailbox memory.";
    const scheduleNotes = scheduleSuggestion?.summary;

    this.db
      .prepare(
        `INSERT INTO mailbox_drafts
          (id, thread_id, subject, body_text, tone, rationale, schedule_notes, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        draftId,
        threadId,
        detail.subject.startsWith("Re:") ? detail.subject : `Re: ${detail.subject}`,
        body,
        tone,
        rationale,
        scheduleNotes || null,
        JSON.stringify({
          source: "mailbox-draft-engine",
          includeAvailability: Boolean(scheduleSuggestion),
        }),
        now,
        now,
      );

    this.upsertProposal({
      threadId,
      type: "reply",
      title: "Review reply draft",
      reasoning: rationale,
      preview: {
        draftId,
        subject: detail.subject.startsWith("Re:") ? detail.subject : `Re: ${detail.subject}`,
      },
    });

    return {
      id: draftId,
      threadId,
      subject: detail.subject.startsWith("Re:") ? detail.subject : `Re: ${detail.subject}`,
      body,
      tone,
      rationale,
      scheduleNotes,
      createdAt: now,
      updatedAt: now,
    };
  }

  async extractCommitments(threadId: string): Promise<MailboxCommitment[]> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return [];

    const candidates: Array<Pick<MailboxCommitment, "title" | "dueAt" | "sourceExcerpt">> = [];
    for (const message of detail.messages) {
      for (const line of excerptLines(message.body, 12)) {
        if (/\bplease|can you|need to|follow up|action item|todo|deliver\b/i.test(line)) {
          candidates.push({
            title: normalizeWhitespace(line, 180),
            dueAt: parseDueAt(line),
            sourceExcerpt: normalizeWhitespace(line, 180),
          });
        }
      }
    }

    const existingTitles = new Set(
      this.getCommitmentsForThread(threadId).map((item) => item.title.toLowerCase()),
    );
    const created: MailboxCommitment[] = [];
    const now = Date.now();

    for (const candidate of candidates.slice(0, 6)) {
      if (existingTitles.has(candidate.title.toLowerCase())) continue;
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO mailbox_commitments
            (id, thread_id, message_id, title, due_at, state, owner_email, source_excerpt, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          threadId,
          null,
          candidate.title,
          candidate.dueAt || null,
          "suggested",
          detail.participants[0]?.email || null,
          candidate.sourceExcerpt || null,
          JSON.stringify({ source: "mailbox-extraction" }),
          now,
          now,
        );
      RelationshipMemoryService.rememberMailboxInsights({
        commitments: [
          {
            text: candidate.title,
            dueAt: candidate.dueAt,
          },
        ],
      });
      created.push({
        id,
        threadId,
        title: candidate.title,
        dueAt: candidate.dueAt,
        state: "suggested",
        ownerEmail: detail.participants[0]?.email,
        sourceExcerpt: candidate.sourceExcerpt,
        createdAt: now,
        updatedAt: now,
      });
    }

    this.updateContactOpenCommitments(threadId);
    return this.getCommitmentsForThread(threadId);
  }

  async updateCommitmentState(
    commitmentId: string,
    state: MailboxCommitmentState,
  ): Promise<MailboxCommitment | null> {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE mailbox_commitments
         SET state = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(state, now, commitmentId);

    const row = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           message_id,
           title,
           due_at,
           state,
           owner_email,
           source_excerpt,
           created_at,
           updated_at
         FROM mailbox_commitments
         WHERE id = ?`,
      )
      .get(commitmentId) as MailboxCommitmentRow | undefined;
    if (!row) return null;

    if (state === "done") {
      const text = row.title;
      const items = RelationshipMemoryService.listOpenCommitments(200);
      for (const item of items) {
        if (text.toLowerCase().includes(item.text.toLowerCase()) || item.text.toLowerCase().includes(text.toLowerCase())) {
          RelationshipMemoryService.updateItem(item.id, { status: "done" });
        }
      }
    }

    this.updateContactOpenCommitments(row.thread_id);
    return this.mapCommitmentRow(row);
  }

  async proposeCleanup(limit = 20): Promise<MailboxActionProposal[]> {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           unread_count,
           message_count,
           last_message_at
         FROM mailbox_threads
         WHERE cleanup_candidate = 1 OR (handled = 1 AND category IN ('promotions', 'updates'))
         ORDER BY last_message_at ASC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 100)) as MailboxThreadRow[];

    for (const row of rows) {
      this.upsertProposal({
        threadId: row.id,
        type: "cleanup",
        title: `Queue cleanup for ${row.subject}`,
        reasoning: "Low-priority handled thread suitable for archive or trash review.",
        preview: {
          threadId: row.id,
          suggestedAction: row.category === "promotions" ? "trash" : "archive",
        },
      });
    }

    return rows.flatMap((row) =>
      this.getProposalsForThread(row.id).filter((proposal) => proposal.type === "cleanup"),
    );
  }

  async proposeFollowups(limit = 20): Promise<MailboxActionProposal[]> {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           unread_count,
           message_count,
           last_message_at
         FROM mailbox_threads
         WHERE needs_reply = 1 AND stale_followup = 1
         ORDER BY urgency_score DESC, last_message_at ASC
         LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 100)) as MailboxThreadRow[];

    for (const row of rows) {
      this.upsertProposal({
        threadId: row.id,
        type: "follow_up",
        title: `Follow up on ${row.subject}`,
        reasoning: "Thread still needs a response and has been waiting long enough to escalate.",
        preview: {
          threadId: row.id,
          lastMessageAt: row.last_message_at,
        },
      });
    }

    return rows.flatMap((row) =>
      this.getProposalsForThread(row.id).filter((proposal) => proposal.type === "follow_up"),
    );
  }

  async reviewBulkAction(input: MailboxBulkReviewInput): Promise<MailboxBulkReviewResult> {
    const proposals =
      input.type === "cleanup"
        ? await this.proposeCleanup(input.limit)
        : await this.proposeFollowups(input.limit);
    return {
      type: input.type,
      proposals,
      count: proposals.length,
    };
  }

  async scheduleReply(threadId: string): Promise<{ threadId: string; suggestions: string[]; summary: string }> {
    const suggestion = await this.getScheduleSuggestion();
    this.upsertProposal({
      threadId,
      type: "schedule",
      title: "Review suggested meeting slots",
      reasoning: suggestion.summary,
      preview: {
        suggestions: suggestion.slots,
      },
    });
    return {
      threadId,
      suggestions: suggestion.slots,
      summary: suggestion.summary,
    };
  }

  async researchContact(threadId: string): Promise<MailboxResearchResult | null> {
    const detail = await this.getThreadCore(threadId);
    if (!detail) return null;

    const primary = detail.participants[0] || null;
    const domain = primary?.email?.split("@")[1];
    const company = companyFromEmail(primary?.email);
    const contactMemory = this.getPrimaryContactMemory(threadId);

    return {
      primaryContact: primary,
      company,
      domain,
      crmHints: contactMemory?.crmLinks || [],
      learnedFacts: contactMemory?.learnedFacts || [],
      recommendedQueries: [
        primary?.email ? `"${primary.email}"` : undefined,
        company ? `${company} leadership` : undefined,
        domain ? `site:${domain} team` : undefined,
      ].filter((entry): entry is string => Boolean(entry)),
    };
  }

  async applyAction(input: MailboxApplyActionInput): Promise<{ success: boolean; action: string; threadId?: string }> {
    if (input.type === "dismiss_proposal" && input.proposalId) {
      this.updateProposalStatus(input.proposalId, "dismissed");
      return { success: true, action: input.type };
    }

    const threadId = input.threadId || this.threadIdFromProposal(input.proposalId);
    if (!threadId) {
      throw new Error("Missing threadId or proposalId for mailbox action");
    }

    const thread = await this.getThreadCore(threadId);
    if (!thread) {
      throw new Error("Mailbox thread not found");
    }

    switch (input.type) {
      case "archive":
        await this.applyArchive(thread);
        break;
      case "trash":
        await this.applyTrash(thread);
        break;
      case "mark_read":
        await this.applyMarkRead(thread);
        break;
      case "label":
        if (!input.label) throw new Error("Missing label for label action");
        await this.applyLabel(thread, input.label);
        break;
      case "send_draft":
        await this.applySendDraft(thread, input.draftId);
        break;
      case "schedule_event":
        await this.applyScheduleEvent(thread);
        break;
      default:
        throw new Error(`Unsupported mailbox action: ${input.type}`);
    }

    if (input.proposalId) {
      this.updateProposalStatus(input.proposalId, "applied");
    }

    return {
      success: true,
      action: input.type,
      threadId,
    };
  }

  private async syncGmail(limit: number): Promise<{
    account: MailboxAccount;
    syncedThreads: number;
    syncedMessages: number;
  } | null> {
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.enabled) return null;

    const profileResult = await gmailRequest(settings, {
      method: "GET",
      path: "/users/me/profile",
    });
    const emailAddress = asString(profileResult.data?.emailAddress);
    if (!emailAddress) return null;

    const accountId = `gmail:${emailAddress.toLowerCase()}`;
    const now = Date.now();
    this.upsertAccount({
      id: accountId,
      provider: "gmail",
      address: emailAddress.toLowerCase(),
      displayName: emailAddress,
      status: "connected",
      capabilities: ["threads", "labels", "drafts", "archive", "trash", "schedule"],
      lastSyncedAt: now,
    });

    const listResult = await gmailRequest(settings, {
      method: "GET",
      path: "/users/me/messages",
      query: {
        maxResults: Math.min(Math.max(limit, 5), 50),
        q: "newer_than:30d",
      },
    });

    const messageRefs = (Array.isArray(listResult.data?.messages) ? listResult.data.messages : []) as Array<{
      threadId?: unknown;
    }>;
    const threadIds = Array.from(
      new Set(
        messageRefs
          .map((entry: Any) => asString(entry?.threadId))
          .filter((entry): entry is string => Boolean(entry)),
      ),
    ).slice(0, limit);

    let syncedMessages = 0;
    for (const threadId of threadIds) {
      const threadResult = await gmailRequest(settings, {
        method: "GET",
        path: `/users/me/threads/${threadId}`,
        query: {
          format: "full",
        },
      });
      const normalized = this.normalizeGmailThread(accountId, emailAddress.toLowerCase(), threadResult.data);
      if (!normalized) continue;
      this.upsertThread(normalized);
      syncedMessages += normalized.messages.length;
    }

    return {
      account: this.mapAccountRow(
        this.db
          .prepare(
            `SELECT id, provider, address, display_name, status, capabilities_json, last_synced_at
             FROM mailbox_accounts WHERE id = ?`,
          )
          .get(accountId) as MailboxAccountRow,
      ),
      syncedThreads: threadIds.length,
      syncedMessages,
    };
  }

  private normalizeGmailThread(
    accountId: string,
    accountEmail: string,
    thread: Any,
  ): NormalizedThreadInput | null {
    const threadId = asString(thread?.id);
    const messagesRaw = Array.isArray(thread?.messages) ? thread.messages : [];
    if (!threadId || messagesRaw.length === 0) return null;

    const messages: NormalizedMailboxMessage[] = messagesRaw.map(
      (message: Any): NormalizedMailboxMessage => {
        const payload = asObject(message?.payload) || {};
        const headers = Array.isArray(payload.headers) ? payload.headers : [];
        const subject = extractGmailHeader(headers, "Subject") || "(No subject)";
        const fromRaw = extractGmailHeader(headers, "From");
        const toRaw = extractGmailHeader(headers, "To");
        const ccRaw = extractGmailHeader(headers, "Cc");
        const bccRaw = extractGmailHeader(headers, "Bcc");
        const internalDate = Number(message?.internalDate || Date.now());
        const body = extractGmailBody(payload);
        const snippet = normalizeWhitespace(asString(message?.snippet) || body || subject, 260);
        const fromEmail = normalizeEmailAddress(fromRaw);
        const direction = fromEmail === accountEmail ? "outgoing" : "incoming";
        return {
          id: `gmail-message:${asString(message?.id) || randomUUID()}`,
          providerMessageId: asString(message?.id) || randomUUID(),
          direction,
          from: fromEmail
            ? {
                email: fromEmail,
                name: extractDisplayName(fromRaw || undefined),
              }
            : undefined,
          to: parseAddressList(toRaw),
          cc: parseAddressList(ccRaw),
          bcc: parseAddressList(bccRaw),
          subject,
          snippet,
          body,
          receivedAt: Number.isFinite(internalDate) ? internalDate : Date.now(),
          unread: Array.isArray(message?.labelIds) ? message.labelIds.includes("UNREAD") : false,
        };
      },
    );
    messages.sort((a: NormalizedMailboxMessage, b: NormalizedMailboxMessage) => a.receivedAt - b.receivedAt);

    const latest = messages[messages.length - 1];
    const labels = Array.isArray(messagesRaw[messagesRaw.length - 1]?.labelIds)
      ? (messagesRaw[messagesRaw.length - 1].labelIds as string[])
      : [];
    const participants = uniqueParticipants(
      messages.flatMap((message) => [
        ...(message.from ? [message.from] : []),
        ...message.to,
        ...message.cc,
      ]),
    ).filter((participant) => participant.email !== accountEmail);
    const unreadCount = messages.filter((message) => message.unread).length;
    const needsReply = latest.direction === "incoming" && /\?|please|can you|could you|review/i.test(`${latest.body} ${latest.subject}`);
    const category = deriveCategory(latest.subject, labels, latest.body);
    const cleanupCandidate = category === "promotions" || /\bunsubscribe\b/i.test(latest.body);
    const scoring = computeScores({
      subject: latest.subject,
      body: latest.body,
      unreadCount,
      lastMessageAt: latest.receivedAt,
      needsReply,
      cleanupCandidate,
      category,
    });

    return {
      id: `gmail-thread:${threadId}`,
      accountId,
      provider: "gmail",
      providerThreadId: threadId,
      subject: latest.subject,
      snippet: latest.snippet,
      participants,
      labels,
      category,
      priorityScore: scoring.priorityScore,
      urgencyScore: scoring.urgencyScore,
      needsReply,
      staleFollowup: scoring.staleFollowup,
      cleanupCandidate,
      handled: scoring.handled,
      unreadCount,
      lastMessageAt: latest.receivedAt,
      messages,
    };
  }

  private async syncImap(limit: number): Promise<{
    account: MailboxAccount;
    syncedThreads: number;
    syncedMessages: number;
  } | null> {
    const channel = this.channelRepo.findByType("email");
    if (!channel || !channel.enabled) return null;
    const cfg = (channel.config as Any) || {};
    const protocol = asString(cfg.protocol) === "loom" ? "loom" : "imap-smtp";
    const now = Date.now();

    if (protocol === "loom") {
      const loomBaseUrl = asString(cfg.loomBaseUrl);
      const accessToken = asString(cfg.loomAccessToken);
      const identity = asString(cfg.loomIdentity) || loomBaseUrl;
      if (!loomBaseUrl || !accessToken || !identity) return null;
      const mailbox = asString(cfg.loomMailboxFolder) || "INBOX";
      const client = new LoomEmailClient({
        baseUrl: loomBaseUrl,
        accessTokenProvider: () => accessToken,
        identity,
        folder: assertSafeLoomMailboxFolder(mailbox),
        pollInterval: asNumber(cfg.loomPollInterval) ?? 30000,
        verbose: process.env.NODE_ENV === "development",
      });
      const messages = await client.fetchUnreadEmails(Math.min(Math.max(limit, 5), 50));
      const accountId = `imap:${identity.toLowerCase()}`;
      this.upsertAccount({
        id: accountId,
        provider: "imap",
        address: identity.toLowerCase(),
        displayName: identity,
        status: "connected",
        capabilities: ["send", "mark_read"],
        lastSyncedAt: now,
      });
      const threads = this.normalizeImapThreads(accountId, identity.toLowerCase(), messages);
      for (const thread of threads) {
        this.upsertThread(thread);
      }
      return {
        account: this.mapAccountRow(
          this.db
            .prepare(
              `SELECT id, provider, address, display_name, status, capabilities_json, last_synced_at
               FROM mailbox_accounts WHERE id = ?`,
            )
            .get(accountId) as MailboxAccountRow,
        ),
        syncedThreads: threads.length,
        syncedMessages: messages.length,
      };
    }

    const email = asString(cfg.email);
    const password = asString(cfg.password);
    const imapHost = asString(cfg.imapHost);
    const smtpHost = asString(cfg.smtpHost);
    if (!email || !password || !imapHost || !smtpHost) return null;

    const client = new EmailClient({
      imapHost,
      imapPort: asNumber(cfg.imapPort) ?? 993,
      imapSecure: asBoolean(cfg.imapSecure) ?? true,
      smtpHost,
      smtpPort: asNumber(cfg.smtpPort) ?? 587,
      smtpSecure: asBoolean(cfg.smtpSecure) ?? false,
      email,
      password,
      displayName: asString(cfg.displayName) || undefined,
      mailbox: asString(cfg.mailbox) || "INBOX",
      pollInterval: 30000,
      verbose: process.env.NODE_ENV === "development",
    });
    const messages = await client.fetchUnreadEmails(Math.min(Math.max(limit, 5), 50));
    const accountId = `imap:${email.toLowerCase()}`;
    this.upsertAccount({
      id: accountId,
      provider: "imap",
      address: email.toLowerCase(),
      displayName: email,
      status: "connected",
      capabilities: ["send", "mark_read"],
      lastSyncedAt: now,
    });
    const threads = this.normalizeImapThreads(accountId, email.toLowerCase(), messages);
    for (const thread of threads) {
      this.upsertThread(thread);
    }

    return {
      account: this.mapAccountRow(
        this.db
          .prepare(
            `SELECT id, provider, address, display_name, status, capabilities_json, last_synced_at
             FROM mailbox_accounts WHERE id = ?`,
          )
          .get(accountId) as MailboxAccountRow,
      ),
      syncedThreads: threads.length,
      syncedMessages: messages.length,
    };
  }

  private normalizeImapThreads(
    accountId: string,
    accountEmail: string,
    messagesRaw: Any[],
  ): NormalizedThreadInput[] {
    const groups = new Map<string, Any[]>();
    for (const message of messagesRaw) {
      const subject = normalizeWhitespace(asString(message?.subject) || "(No subject)", 160);
      const from = normalizeEmailAddress(message?.from);
      const key = `${subject.toLowerCase()}::${from || "unknown"}`;
      const bucket = groups.get(key) || [];
      bucket.push(message);
      groups.set(key, bucket);
    }

    return Array.from(groups.entries()).map(([groupKey, group]: [string, Any[]]) => {
      const normalizedMessages: NormalizedMailboxMessage[] = group.map(
        (message: Any): NormalizedMailboxMessage => {
          const fromEmail = normalizeEmailAddress(message?.from);
          const body = normalizeWhitespace(asString(message?.text) || asString(message?.snippet) || "", 4000);
          const subject = normalizeWhitespace(asString(message?.subject) || "(No subject)", 160);
          return {
            id: `imap-message:${asString(message?.uid) || randomUUID()}`,
            providerMessageId: String(message?.uid || message?.messageId || randomUUID()),
            direction: fromEmail === accountEmail ? ("outgoing" as const) : ("incoming" as const),
            from: fromEmail
              ? {
                  email: fromEmail,
                  name: extractDisplayName(message?.from),
                }
              : undefined,
            to: parseAddressList(message?.to),
            cc: [],
            bcc: [],
            subject,
            snippet: normalizeWhitespace(asString(message?.snippet) || body || subject, 260),
            body,
            receivedAt: new Date(message?.date || Date.now()).getTime(),
            unread: !message?.isRead,
          };
        },
      );
      normalizedMessages.sort((a: NormalizedMailboxMessage, b: NormalizedMailboxMessage) => a.receivedAt - b.receivedAt);

      const latest = normalizedMessages[normalizedMessages.length - 1];
      const participants = uniqueParticipants(
        normalizedMessages.flatMap((message) => [
          ...(message.from ? [message.from] : []),
          ...message.to,
        ]),
      ).filter((participant) => participant.email !== accountEmail);
      const unreadCount = normalizedMessages.filter((message) => message.unread).length;
      const needsReply =
        latest.direction === "incoming" &&
        /\?|please|can you|could you|review/i.test(`${latest.body} ${latest.subject}`);
      const category = deriveCategory(latest.subject, [], latest.body);
      const cleanupCandidate = category === "promotions";
      const scoring = computeScores({
        subject: latest.subject,
        body: latest.body,
        unreadCount,
        lastMessageAt: latest.receivedAt,
        needsReply,
        cleanupCandidate,
        category,
      });

      return {
        id: `imap-thread:${groupKey}`,
        accountId,
        provider: "imap" as const,
        providerThreadId: groupKey,
        subject: latest.subject,
        snippet: latest.snippet,
        participants,
        labels: [],
        category,
        priorityScore: scoring.priorityScore,
        urgencyScore: scoring.urgencyScore,
        needsReply,
        staleFollowup: scoring.staleFollowup,
        cleanupCandidate,
        handled: scoring.handled,
        unreadCount,
        lastMessageAt: latest.receivedAt,
        messages: normalizedMessages,
      };
    });
  }

  private upsertAccount(account: MailboxAccount): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mailbox_accounts
          (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           address = excluded.address,
           display_name = excluded.display_name,
           status = excluded.status,
           capabilities_json = excluded.capabilities_json,
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        account.id,
        account.provider,
        account.address,
        account.displayName || null,
        account.status,
        JSON.stringify(account.capabilities),
        null,
        account.lastSyncedAt || null,
        now,
        now,
      );
  }

  private upsertThread(thread: NormalizedThreadInput): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO mailbox_threads
          (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, unread_count, message_count, last_message_at, last_synced_at, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           account_id = excluded.account_id,
           provider_thread_id = excluded.provider_thread_id,
           provider = excluded.provider,
           subject = excluded.subject,
           snippet = excluded.snippet,
           participants_json = excluded.participants_json,
           labels_json = excluded.labels_json,
           category = excluded.category,
           priority_score = excluded.priority_score,
           urgency_score = excluded.urgency_score,
           needs_reply = excluded.needs_reply,
           stale_followup = excluded.stale_followup,
           cleanup_candidate = excluded.cleanup_candidate,
           handled = excluded.handled,
           unread_count = excluded.unread_count,
           message_count = excluded.message_count,
           last_message_at = excluded.last_message_at,
           last_synced_at = excluded.last_synced_at,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        thread.id,
        thread.accountId,
        thread.providerThreadId,
        thread.provider,
        thread.subject,
        thread.snippet,
        JSON.stringify(thread.participants),
        JSON.stringify(thread.labels),
        thread.category,
        thread.priorityScore,
        thread.urgencyScore,
        thread.needsReply ? 1 : 0,
        thread.staleFollowup ? 1 : 0,
        thread.cleanupCandidate ? 1 : 0,
        thread.handled ? 1 : 0,
        thread.unreadCount,
        thread.messages.length,
        thread.lastMessageAt,
        now,
        JSON.stringify({
          priorityBand: priorityBandFromScore(thread.priorityScore),
        }),
        now,
        now,
      );

    for (const message of thread.messages) {
      this.db
        .prepare(
          `INSERT INTO mailbox_messages
            (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             provider_message_id = excluded.provider_message_id,
             direction = excluded.direction,
             from_name = excluded.from_name,
             from_email = excluded.from_email,
             to_json = excluded.to_json,
             cc_json = excluded.cc_json,
             bcc_json = excluded.bcc_json,
             subject = excluded.subject,
             snippet = excluded.snippet,
             body_text = excluded.body_text,
             received_at = excluded.received_at,
             is_unread = excluded.is_unread,
             metadata_json = excluded.metadata_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          message.id,
          thread.id,
          message.providerMessageId,
          message.direction,
          message.from?.name || null,
          message.from?.email || null,
          JSON.stringify(message.to),
          JSON.stringify(message.cc),
          JSON.stringify(message.bcc),
          message.subject,
          message.snippet,
          message.body,
          message.receivedAt,
          message.unread ? 1 : 0,
          JSON.stringify({}),
          now,
          now,
        );
    }

    this.upsertPrimaryContact(thread);
    RelationshipMemoryService.rememberMailboxInsights({
      facts: thread.participants
        .slice(0, 1)
        .map((participant) => `Recent email contact: ${participant.name || participant.email}`),
    });
    this.refreshThreadProposals(thread);
  }

  private refreshThreadProposals(thread: Pick<
    NormalizedThreadInput,
    "id" | "subject" | "needsReply" | "cleanupCandidate" | "staleFollowup" | "category"
  >): void {
    this.db
      .prepare(
        `DELETE FROM mailbox_action_proposals
         WHERE thread_id = ?
           AND status = 'suggested'
           AND proposal_type IN ('reply', 'cleanup', 'follow_up', 'schedule')`,
      )
      .run(thread.id);

    if (thread.needsReply) {
      this.upsertProposal({
        threadId: thread.id,
        type: "reply",
        title: `Reply to ${thread.subject}`,
        reasoning: "Latest message appears to require a response.",
      });
    }
    if (thread.cleanupCandidate) {
      this.upsertProposal({
        threadId: thread.id,
        type: "cleanup",
        title: `Clean up ${thread.subject}`,
        reasoning: "Thread looks promotional or low value and is a candidate for archive/trash review.",
      });
    }
    if (thread.staleFollowup) {
      this.upsertProposal({
        threadId: thread.id,
        type: "follow_up",
        title: `Follow up on ${thread.subject}`,
        reasoning: "This thread still needs a reply and has gone stale.",
      });
    }
    if (thread.category === "calendar") {
      this.upsertProposal({
        threadId: thread.id,
        type: "schedule",
        title: `Propose meeting slots for ${thread.subject}`,
        reasoning: "Thread content looks scheduling related.",
      });
    }
  }

  private upsertPrimaryContact(thread: NormalizedThreadInput): void {
    const primary = thread.participants[0];
    if (!primary?.email) return;
    const now = Date.now();
    const company = companyFromEmail(primary.email);
    const learnedFacts = [
      primary.name ? `Name: ${primary.name}` : null,
      company ? `Company: ${company}` : null,
    ].filter((entry): entry is string => Boolean(entry));

    this.db
      .prepare(
        `INSERT INTO mailbox_contacts
          (id, account_id, email, name, company, role, crm_links_json, learned_facts_json, response_tendency, last_interaction_at, open_commitments, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           account_id = excluded.account_id,
           name = COALESCE(excluded.name, mailbox_contacts.name),
           company = COALESCE(excluded.company, mailbox_contacts.company),
           learned_facts_json = excluded.learned_facts_json,
           last_interaction_at = excluded.last_interaction_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        `contact:${primary.email}`,
        thread.accountId,
        primary.email,
        primary.name || null,
        company || null,
        null,
        JSON.stringify([]),
        JSON.stringify(learnedFacts),
        thread.needsReply ? "awaiting_reply" : "fyi",
        thread.lastMessageAt,
        this.getCommitmentsForThread(thread.id).filter((item) => item.state !== "done").length,
        now,
        now,
      );
  }

  private getSummaryForThread(threadId: string): MailboxSummaryCard | null {
    const row = this.db
      .prepare(
        `SELECT
           thread_id,
           summary_text,
           key_asks_json,
           extracted_questions_json,
           suggested_next_action,
           confidence,
           updated_at
         FROM mailbox_summaries
         WHERE thread_id = ?`,
      )
      .get(threadId) as MailboxSummaryRow | undefined;
    if (!row) return null;
    return this.mapSummaryRow(row);
  }

  private getMessagesForThread(threadId: string): MailboxMessage[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           provider_message_id,
           direction,
           from_name,
           from_email,
           to_json,
           cc_json,
           bcc_json,
           subject,
           snippet,
           body_text,
           received_at,
           is_unread
         FROM mailbox_messages
         WHERE thread_id = ?
         ORDER BY received_at ASC`,
      )
      .all(threadId) as MailboxMessageRow[];
    return rows.map((row) => this.mapMessageRow(row));
  }

  private getDraftsForThread(threadId: string): MailboxDraftSuggestion[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           subject,
           body_text,
           tone,
           rationale,
           schedule_notes,
           created_at,
           updated_at
         FROM mailbox_drafts
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as MailboxDraftRow[];
    return rows.map((row) => this.mapDraftRow(row));
  }

  private getProposalsForThread(threadId: string): MailboxActionProposal[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           proposal_type,
           title,
           reasoning,
           preview_json,
           status,
           created_at,
           updated_at
         FROM mailbox_action_proposals
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as MailboxProposalRow[];
    return rows.map((row) => this.mapProposalRow(row));
  }

  private getCommitmentsForThread(threadId: string): MailboxCommitment[] {
    const rows = this.db
      .prepare(
        `SELECT
           id,
           thread_id,
           message_id,
           title,
           due_at,
           state,
           owner_email,
           source_excerpt,
           created_at,
           updated_at
         FROM mailbox_commitments
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
      )
      .all(threadId) as MailboxCommitmentRow[];
    return rows.map((row) => this.mapCommitmentRow(row));
  }

  private getPrimaryContactMemory(threadId: string): MailboxContactMemory | null {
    const thread = this.db
      .prepare("SELECT account_id, participants_json FROM mailbox_threads WHERE id = ?")
      .get(threadId) as { account_id: string; participants_json: string | null } | undefined;
    const email = parseJsonArray<MailboxParticipant>(thread?.participants_json).find(Boolean)?.email;
    if (!thread?.account_id || !email) return null;
    const row = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           email,
           name,
           company,
           role,
           crm_links_json,
           learned_facts_json,
           response_tendency,
           last_interaction_at,
           open_commitments
         FROM mailbox_contacts
         WHERE email = ?`,
      )
      .get(email) as MailboxContactRow | undefined;
    return row ? this.mapContactRow(row) : null;
  }

  private async getThreadCore(
    threadId: string,
  ): Promise<(MailboxThreadListItem & { messages: MailboxMessage[] }) | null> {
    const row = this.db
      .prepare(
        `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           unread_count,
           message_count,
           last_message_at
         FROM mailbox_threads
         WHERE id = ?`,
      )
      .get(threadId) as MailboxThreadRow | undefined;
    if (!row) return null;
    return {
      ...this.mapThreadRow(row, this.getSummaryForThread(threadId) || undefined),
      messages: this.getMessagesForThread(threadId),
    };
  }

  private async getScheduleSuggestion(): Promise<ScheduleSuggestion> {
    if (!GoogleWorkspaceSettingsManager.loadSettings().enabled) {
      return {
        slots: ["tomorrow 11:00", "tomorrow 15:00", "Thursday 10:30"],
        summary: "Google Calendar not connected, using lightweight default availability placeholders.",
      };
    }

    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString();
    const response = await googleCalendarRequest(settings, {
      method: "GET",
      path: "/calendars/primary/events",
      query: {
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 25,
      },
    });
    const busy = Array.isArray(response.data?.items) ? response.data.items : [];
    const taken = (busy as Array<{ start?: { dateTime?: string } }>)
      .map((item: { start?: { dateTime?: string } }) => asString(item?.start?.dateTime))
      .filter((value: string | null): value is string => Boolean(value))
      .map((value: string) => new Date(value).getHours());

    const preferredHours = [10, 11, 14, 15, 16];
    const slots: string[] = [];
    for (let dayOffset = 1; dayOffset <= 5 && slots.length < 3; dayOffset++) {
      const date = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      if (date.getDay() === 0 || date.getDay() === 6) continue;
      for (const hour of preferredHours) {
        if (taken.includes(hour)) continue;
        const candidate = new Date(date);
        candidate.setHours(hour, 0, 0, 0);
        slots.push(
          candidate.toLocaleString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
        );
        if (slots.length >= 3) break;
      }
    }

    return {
      slots: slots.length ? slots : ["tomorrow 11:00", "tomorrow 15:00", "Thursday 10:30"],
      summary: "Suggested free windows based on the next few days of Google Calendar events.",
    };
  }

  private async applyArchive(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): Promise<void> {
    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
        body: {
          removeLabelIds: ["INBOX"],
        },
      });
    } else {
      throw new Error("Archive is not supported for the current IMAP adapter.");
    }

    this.db
      .prepare("UPDATE mailbox_threads SET handled = 1, cleanup_candidate = 0, updated_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);
  }

  private async applyTrash(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): Promise<void> {
    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/trash`,
      });
    } else {
      throw new Error("Trash is not supported for the current IMAP adapter.");
    }

    this.db
      .prepare("UPDATE mailbox_threads SET handled = 1, cleanup_candidate = 0, updated_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);
  }

  private async applyMarkRead(thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] })): Promise<void> {
    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      await gmailRequest(settings, {
        method: "POST",
        path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
        body: {
          removeLabelIds: ["UNREAD"],
        },
      });
    } else {
      const channel = this.channelRepo.findByType("email");
      if (!channel) throw new Error("Email channel is not configured");
      const cfg = (channel.config as Any) || {};
      if (asString(cfg.protocol) === "loom") {
        throw new Error("Mark as read is not implemented for LOOM mode yet.");
      }
      const client = new EmailClient({
        imapHost: asString(cfg.imapHost) || "",
        imapPort: asNumber(cfg.imapPort) ?? 993,
        imapSecure: asBoolean(cfg.imapSecure) ?? true,
        smtpHost: asString(cfg.smtpHost) || "",
        smtpPort: asNumber(cfg.smtpPort) ?? 587,
        smtpSecure: asBoolean(cfg.smtpSecure) ?? false,
        email: asString(cfg.email) || "",
        password: asString(cfg.password) || "",
        displayName: asString(cfg.displayName) || undefined,
        mailbox: asString(cfg.mailbox) || "INBOX",
        pollInterval: 30000,
        verbose: process.env.NODE_ENV === "development",
      });
      const latest = thread.messages.filter((message) => message.unread).slice(-1)[0];
      const uid = Number(latest?.providerMessageId);
      if (!Number.isFinite(uid)) {
        throw new Error("Unable to resolve IMAP UID for mark_read");
      }
      await client.markAsRead(uid);
    }

    this.db.prepare("UPDATE mailbox_messages SET is_unread = 0 WHERE thread_id = ?").run(thread.id);
    this.db
      .prepare("UPDATE mailbox_threads SET unread_count = 0, handled = CASE WHEN needs_reply = 0 THEN 1 ELSE handled END, updated_at = ? WHERE id = ?")
      .run(Date.now(), thread.id);
  }

  private async applyLabel(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    label: string,
  ): Promise<void> {
    if (thread.provider !== "gmail") {
      throw new Error("Label actions are only supported for Gmail-backed threads.");
    }
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    await gmailRequest(settings, {
      method: "POST",
      path: `/users/me/threads/${encodeURIComponent(thread.providerThreadId)}/modify`,
      body: {
        addLabelIds: [label],
      },
    });

    const labels = Array.from(new Set([...thread.labels, label]));
    this.db
      .prepare("UPDATE mailbox_threads SET labels_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(labels), Date.now(), thread.id);
  }

  private async applySendDraft(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
    draftId?: string,
  ): Promise<void> {
    const drafts = this.getDraftsForThread(thread.id);
    const draft = draftId ? drafts.find((entry) => entry.id === draftId) : drafts[0];
    if (!draft) throw new Error("Draft not found");

    const recipient = thread.participants[0]?.email;
    if (!recipient) throw new Error("No recipient found for draft");

    if (thread.provider === "gmail") {
      const settings = GoogleWorkspaceSettingsManager.loadSettings();
      const raw = Buffer.from(
        [
          `To: ${recipient}`,
          `Subject: ${draft.subject}`,
          "MIME-Version: 1.0",
          'Content-Type: text/plain; charset="UTF-8"',
          "",
          draft.body,
        ].join("\r\n"),
      )
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      await gmailRequest(settings, {
        method: "POST",
        path: "/users/me/messages/send",
        body: {
          raw,
          threadId: thread.providerThreadId,
        },
      });
    } else {
      const channel = this.channelRepo.findByType("email");
      if (!channel) throw new Error("Email channel is not configured");
      const cfg = (channel.config as Any) || {};
      const client = new EmailClient({
        imapHost: asString(cfg.imapHost) || "",
        imapPort: asNumber(cfg.imapPort) ?? 993,
        imapSecure: asBoolean(cfg.imapSecure) ?? true,
        smtpHost: asString(cfg.smtpHost) || "",
        smtpPort: asNumber(cfg.smtpPort) ?? 587,
        smtpSecure: asBoolean(cfg.smtpSecure) ?? false,
        email: asString(cfg.email) || "",
        password: asString(cfg.password) || "",
        displayName: asString(cfg.displayName) || undefined,
        mailbox: asString(cfg.mailbox) || "INBOX",
        pollInterval: 30000,
        verbose: process.env.NODE_ENV === "development",
      });
      await client.sendEmail({
        to: recipient,
        subject: draft.subject,
        text: draft.body,
      });
    }

    this.updateProposalStatusByThreadAndType(thread.id, "reply", "applied");
  }

  private async applyScheduleEvent(
    thread: MailboxThreadDetail | (MailboxThreadListItem & { messages: MailboxMessage[] }),
  ): Promise<void> {
    if (!GoogleWorkspaceSettingsManager.loadSettings().enabled) {
      throw new Error("Google Calendar must be connected before creating schedule events.");
    }
    const suggestion = await this.getScheduleSuggestion();
    const firstSlot = suggestion.slots[0];
    if (!firstSlot) {
      throw new Error("No schedule slot is available");
    }

    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    start.setHours(11, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    await googleCalendarRequest(GoogleWorkspaceSettingsManager.loadSettings(), {
      method: "POST",
      path: "/calendars/primary/events",
      body: {
        summary: thread.subject,
        description: `Scheduled from Inbox Agent. Suggested slot: ${firstSlot}`,
        start: { dateTime: start.toISOString() },
        end: { dateTime: end.toISOString() },
        attendees: thread.participants.slice(0, 1).map((participant) => ({ email: participant.email })),
      },
    });

    this.updateProposalStatusByThreadAndType(thread.id, "schedule", "applied");
  }

  private updateProposalStatus(proposalId: string, status: MailboxProposalStatus): void {
    this.db
      .prepare(
        `UPDATE mailbox_action_proposals
         SET status = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(status, Date.now(), proposalId);
  }

  private updateProposalStatusByThreadAndType(
    threadId: string,
    type: MailboxProposalType,
    status: MailboxProposalStatus,
  ): void {
    this.db
      .prepare(
        `UPDATE mailbox_action_proposals
         SET status = ?, updated_at = ?
         WHERE thread_id = ? AND proposal_type = ?`,
      )
      .run(status, Date.now(), threadId, type);
  }

  private threadIdFromProposal(proposalId?: string): string | undefined {
    if (!proposalId) return undefined;
    const row = this.db
      .prepare("SELECT thread_id FROM mailbox_action_proposals WHERE id = ?")
      .get(proposalId) as { thread_id: string } | undefined;
    return row?.thread_id;
  }

  private updateContactOpenCommitments(threadId: string): void {
    const contact = this.getPrimaryContactMemory(threadId);
    if (!contact) return;
    const openCount = this.getCommitmentsForThread(threadId).filter((item) =>
      item.state === "suggested" || item.state === "accepted",
    ).length;
    this.db
      .prepare(
        `UPDATE mailbox_contacts
         SET open_commitments = ?, updated_at = ?
         WHERE email = ?`,
      )
      .run(openCount, Date.now(), contact.email);
  }

  private upsertProposal(input: {
    threadId: string;
    type: MailboxProposalType;
    title: string;
    reasoning: string;
    preview?: Record<string, unknown>;
  }): void {
    const existing = this.db
      .prepare(
        `SELECT id
         FROM mailbox_action_proposals
         WHERE thread_id = ? AND proposal_type = ? AND status = 'suggested'
         LIMIT 1`,
      )
      .get(input.threadId, input.type) as { id: string } | undefined;
    const now = Date.now();
    if (existing?.id) {
      this.db
        .prepare(
          `UPDATE mailbox_action_proposals
           SET title = ?, reasoning = ?, preview_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.title,
          input.reasoning,
          input.preview ? JSON.stringify(input.preview) : null,
          now,
          existing.id,
        );
      return;
    }

    this.db
      .prepare(
        `INSERT INTO mailbox_action_proposals
          (id, thread_id, proposal_type, title, reasoning, preview_json, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        input.threadId,
        input.type,
        input.title,
        input.reasoning,
        input.preview ? JSON.stringify(input.preview) : null,
        "suggested",
        JSON.stringify({ source: "mailbox-service" }),
        now,
        now,
      );
  }

  private hasEmailChannel(): boolean {
    const channel = this.channelRepo.findByType("email");
    return Boolean(channel?.enabled);
  }

  private mapAccountRow(row: MailboxAccountRow): MailboxAccount {
    return {
      id: row.id,
      provider: row.provider,
      address: row.address,
      displayName: row.display_name || undefined,
      status: row.status,
      capabilities: parseJsonArray<string>(row.capabilities_json),
      lastSyncedAt: row.last_synced_at || undefined,
    };
  }

  private mapThreadRow(row: MailboxThreadRow, summary?: MailboxSummaryCard | null): MailboxThreadListItem {
    return {
      id: row.id,
      accountId: row.account_id,
      provider: row.provider,
      providerThreadId: row.provider_thread_id,
      subject: row.subject,
      snippet: row.snippet,
      participants: parseJsonArray<MailboxParticipant>(row.participants_json),
      labels: parseJsonArray<string>(row.labels_json),
      category: row.category,
      priorityBand: priorityBandFromScore(row.priority_score),
      priorityScore: row.priority_score,
      urgencyScore: row.urgency_score,
      needsReply: Boolean(row.needs_reply),
      staleFollowup: Boolean(row.stale_followup),
      cleanupCandidate: Boolean(row.cleanup_candidate),
      handled: Boolean(row.handled),
      unreadCount: row.unread_count,
      messageCount: row.message_count,
      lastMessageAt: row.last_message_at,
      summary: summary ?? undefined,
    };
  }

  private mapMessageRow(row: MailboxMessageRow): MailboxMessage {
    return {
      id: row.id,
      threadId: row.thread_id,
      providerMessageId: row.provider_message_id,
      direction: row.direction,
      from: row.from_email
        ? {
            email: row.from_email,
            name: row.from_name || undefined,
          }
        : undefined,
      to: parseJsonArray<MailboxParticipant>(row.to_json),
      cc: parseJsonArray<MailboxParticipant>(row.cc_json),
      bcc: parseJsonArray<MailboxParticipant>(row.bcc_json),
      subject: row.subject,
      snippet: row.snippet,
      body: row.body_text,
      receivedAt: row.received_at,
      unread: Boolean(row.is_unread),
    };
  }

  private mapSummaryRow(row: MailboxSummaryRow): MailboxSummaryCard {
    return {
      summary: row.summary_text,
      keyAsks: parseJsonArray<string>(row.key_asks_json),
      extractedQuestions: parseJsonArray<string>(row.extracted_questions_json),
      suggestedNextAction: row.suggested_next_action,
      confidence: row.confidence,
      updatedAt: row.updated_at,
    };
  }

  private mapDraftRow(row: MailboxDraftRow): MailboxDraftSuggestion {
    return {
      id: row.id,
      threadId: row.thread_id,
      subject: row.subject,
      body: row.body_text,
      tone: row.tone,
      rationale: row.rationale,
      scheduleNotes: row.schedule_notes || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapProposalRow(row: MailboxProposalRow): MailboxActionProposal {
    return {
      id: row.id,
      threadId: row.thread_id,
      type: row.proposal_type,
      title: row.title,
      reasoning: row.reasoning,
      preview: row.preview_json ? (JSON.parse(row.preview_json) as Record<string, unknown>) : undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapCommitmentRow(row: MailboxCommitmentRow): MailboxCommitment {
    return {
      id: row.id,
      threadId: row.thread_id,
      messageId: row.message_id || undefined,
      title: row.title,
      dueAt: row.due_at || undefined,
      state: row.state,
      ownerEmail: row.owner_email || undefined,
      sourceExcerpt: row.source_excerpt || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapContactRow(row: MailboxContactRow): MailboxContactMemory {
    return {
      id: row.id,
      accountId: row.account_id,
      email: row.email,
      name: row.name || undefined,
      company: row.company || undefined,
      role: row.role || undefined,
      crmLinks: parseJsonArray<string>(row.crm_links_json),
      learnedFacts: parseJsonArray<string>(row.learned_facts_json),
      responseTendency: row.response_tendency || undefined,
      lastInteractionAt: row.last_interaction_at || undefined,
      openCommitments: row.open_commitments || 0,
    };
  }
}
