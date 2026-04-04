import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type {
  SubconsciousBacklogItem,
  SubconsciousCritique,
  SubconsciousDecision,
  SubconsciousDispatchRecord,
  SubconsciousEvidence,
  SubconsciousHypothesis,
  SubconsciousRun,
  SubconsciousTargetKind,
  SubconsciousTargetSummary,
} from "../../shared/subconscious";

type Any = any;

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class SubconsciousTargetRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(summary: SubconsciousTargetSummary): SubconsciousTargetSummary {
    this.db
      .prepare(
        `INSERT INTO subconscious_targets (
          target_key, kind, workspace_id, ref_json, health, state, last_winner,
          last_run_at, last_evidence_at, backlog_count, evidence_fingerprint,
          last_dispatch_kind, last_dispatch_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_key) DO UPDATE SET
          kind = excluded.kind,
          workspace_id = excluded.workspace_id,
          ref_json = excluded.ref_json,
          health = excluded.health,
          state = excluded.state,
          last_winner = excluded.last_winner,
          last_run_at = excluded.last_run_at,
          last_evidence_at = excluded.last_evidence_at,
          backlog_count = excluded.backlog_count,
          evidence_fingerprint = excluded.evidence_fingerprint,
          last_dispatch_kind = excluded.last_dispatch_kind,
          last_dispatch_status = excluded.last_dispatch_status,
          updated_at = excluded.updated_at`,
      )
      .run(
        summary.key,
        summary.target.kind,
        summary.target.workspaceId || null,
        JSON.stringify(summary.target),
        summary.health,
        summary.state,
        summary.lastWinner || null,
        summary.lastRunAt || null,
        summary.lastEvidenceAt || null,
        summary.backlogCount,
        summary.evidenceFingerprint || null,
        summary.lastDispatchKind || null,
        summary.lastDispatchStatus || null,
        Date.now(),
        Date.now(),
      );
    return this.findByKey(summary.key) || summary;
  }

  update(
    key: string,
    updates: Partial<Pick<
      SubconsciousTargetSummary,
      | "health"
      | "state"
      | "lastWinner"
      | "lastRunAt"
      | "lastEvidenceAt"
      | "backlogCount"
      | "evidenceFingerprint"
      | "lastDispatchKind"
      | "lastDispatchStatus"
    >>,
  ): void {
    const row = this.findByKey(key);
    if (!row) return;
    this.upsert({
      ...row,
      ...updates,
    });
  }

  findByKey(key: string): SubconsciousTargetSummary | undefined {
    const row = this.db
      .prepare("SELECT * FROM subconscious_targets WHERE target_key = ?")
      .get(key) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(params?: { workspaceId?: string; kinds?: string[] }): SubconsciousTargetSummary[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params?.workspaceId) {
      conditions.push("(workspace_id = ? OR workspace_id IS NULL)");
      values.push(params.workspaceId);
    }
    if (params?.kinds?.length) {
      conditions.push(`kind IN (${params.kinds.map(() => "?").join(", ")})`);
      values.push(...params.kinds);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM subconscious_targets ${where}
         ORDER BY (last_run_at IS NULL) ASC, last_run_at DESC, (last_evidence_at IS NULL) ASC, last_evidence_at DESC, updated_at DESC`,
      )
      .all(...values) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Any): SubconsciousTargetSummary {
    return {
      key: String(row.target_key),
      target: safeJsonParse(row.ref_json, {
        key: String(row.target_key),
        kind: String(row.kind) as SubconsciousTargetKind,
        label: String(row.target_key),
      }),
      health: row.health,
      state: row.state,
      lastWinner: row.last_winner || undefined,
      lastRunAt: row.last_run_at ? Number(row.last_run_at) : undefined,
      lastEvidenceAt: row.last_evidence_at ? Number(row.last_evidence_at) : undefined,
      backlogCount: Number(row.backlog_count || 0),
      evidenceFingerprint: row.evidence_fingerprint || undefined,
      lastDispatchKind: row.last_dispatch_kind || undefined,
      lastDispatchStatus: row.last_dispatch_status || undefined,
    };
  }
}

export class SubconsciousRunRepository {
  constructor(private readonly db: Database.Database) {}

  create(
    input: Omit<SubconsciousRun, "id" | "createdAt"> & { id?: string; createdAt?: number },
  ): SubconsciousRun {
    const run: SubconsciousRun = {
      ...input,
      id: input.id || randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO subconscious_runs (
          id, target_key, workspace_id, stage, outcome, evidence_fingerprint, evidence_summary,
          artifact_root, dispatch_kind, dispatch_status, blocked_reason, error,
          rejected_hypothesis_ids_json, started_at, completed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.targetKey,
        run.workspaceId || null,
        run.stage,
        run.outcome || null,
        run.evidenceFingerprint,
        run.evidenceSummary,
        run.artifactRoot,
        run.dispatchKind || null,
        run.dispatchStatus || null,
        run.blockedReason || null,
        run.error || null,
        JSON.stringify(run.rejectedHypothesisIds || []),
        run.startedAt,
        run.completedAt || null,
        run.createdAt,
      );
    return run;
  }

  update(id: string, updates: Partial<SubconsciousRun>): void {
    const fields: string[] = [];
    const values: unknown[] = [];
    const mapped: Record<string, string> = {
      targetKey: "target_key",
      workspaceId: "workspace_id",
      evidenceFingerprint: "evidence_fingerprint",
      evidenceSummary: "evidence_summary",
      artifactRoot: "artifact_root",
      dispatchKind: "dispatch_kind",
      dispatchStatus: "dispatch_status",
      blockedReason: "blocked_reason",
      rejectedHypothesisIds: "rejected_hypothesis_ids_json",
      startedAt: "started_at",
      completedAt: "completed_at",
      createdAt: "created_at",
    };
    for (const [key, value] of Object.entries(updates)) {
      const column = mapped[key] || key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
      fields.push(`${column} = ?`);
      values.push(key === "rejectedHypothesisIds" ? JSON.stringify(value || []) : (value ?? null));
    }
    if (!fields.length) return;
    values.push(id);
    this.db.prepare(`UPDATE subconscious_runs SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  findById(id: string): SubconsciousRun | undefined {
    const row = this.db.prepare("SELECT * FROM subconscious_runs WHERE id = ?").get(id) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findLatestByFingerprint(targetKey: string, evidenceFingerprint: string): SubconsciousRun | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM subconscious_runs
         WHERE target_key = ? AND evidence_fingerprint = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(targetKey, evidenceFingerprint) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  list(params?: { targetKey?: string; workspaceId?: string; activeOnly?: boolean; limit?: number }): SubconsciousRun[] {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (params?.targetKey) {
      conditions.push("target_key = ?");
      values.push(params.targetKey);
    }
    if (params?.workspaceId) {
      conditions.push("(workspace_id = ? OR workspace_id IS NULL)");
      values.push(params.workspaceId);
    }
    if (params?.activeOnly) {
      conditions.push("stage IN ('collecting_evidence', 'ideating', 'critiquing', 'synthesizing', 'dispatching')");
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitSql = params?.limit ? `LIMIT ${Math.max(1, params.limit)}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM subconscious_runs ${where}
         ORDER BY created_at DESC ${limitSql}`,
      )
      .all(...values) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Any): SubconsciousRun {
    return {
      id: String(row.id),
      targetKey: String(row.target_key),
      workspaceId: row.workspace_id || undefined,
      stage: row.stage,
      outcome: row.outcome || undefined,
      evidenceFingerprint: String(row.evidence_fingerprint || ""),
      evidenceSummary: String(row.evidence_summary || ""),
      artifactRoot: String(row.artifact_root || ""),
      dispatchKind: row.dispatch_kind || undefined,
      dispatchStatus: row.dispatch_status || undefined,
      blockedReason: row.blocked_reason || undefined,
      error: row.error || undefined,
      rejectedHypothesisIds: safeJsonParse(row.rejected_hypothesis_ids_json, []),
      startedAt: Number(row.started_at || row.created_at || Date.now()),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
      createdAt: Number(row.created_at || Date.now()),
    };
  }
}

class JsonListRepository<T extends { id: string }> {
  constructor(
    private readonly db: Database.Database,
    private readonly table: string,
    private readonly mapper: (row: Any) => T,
  ) {}

  insertMany(rows: Array<Record<string, unknown>>, sql: string): void {
    const stmt = this.db.prepare(sql);
    const tx = this.db.transaction((items: Array<Record<string, unknown>>) => {
      for (const item of items) {
        stmt.run(...Object.values(item));
      }
    });
    tx(rows);
  }

  list(whereSql: string, values: unknown[] = []): T[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${this.table} ${whereSql}`)
      .all(...values) as Any[];
    return rows.map((row) => this.mapper(row));
  }
}

export class SubconsciousHypothesisRepository {
  constructor(private readonly db: Database.Database) {}

  replaceForRun(runId: string, hypotheses: SubconsciousHypothesis[]): void {
    this.db.prepare("DELETE FROM subconscious_hypotheses WHERE run_id = ?").run(runId);
    const stmt = this.db.prepare(
      `INSERT INTO subconscious_hypotheses (
        id, run_id, target_key, title, summary, rationale, confidence, evidence_refs_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((items: SubconsciousHypothesis[]) => {
      for (const item of items) {
        stmt.run(
          item.id,
          item.runId,
          item.targetKey,
          item.title,
          item.summary,
          item.rationale,
          item.confidence,
          JSON.stringify(item.evidenceRefs || []),
          item.status,
          item.createdAt,
        );
      }
    });
    tx(hypotheses);
  }

  listByRun(runId: string): SubconsciousHypothesis[] {
    const rows = this.db
      .prepare("SELECT * FROM subconscious_hypotheses WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Any[];
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      targetKey: String(row.target_key),
      title: String(row.title),
      summary: String(row.summary),
      rationale: String(row.rationale),
      confidence: Number(row.confidence || 0),
      evidenceRefs: safeJsonParse(row.evidence_refs_json, []),
      status: row.status,
      createdAt: Number(row.created_at || Date.now()),
    }));
  }
}

export class SubconsciousCritiqueRepository {
  constructor(private readonly db: Database.Database) {}

  replaceForRun(runId: string, critiques: SubconsciousCritique[]): void {
    this.db.prepare("DELETE FROM subconscious_critiques WHERE run_id = ?").run(runId);
    const stmt = this.db.prepare(
      `INSERT INTO subconscious_critiques (
        id, run_id, target_key, hypothesis_id, verdict, objection, response, evidence_refs_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((items: SubconsciousCritique[]) => {
      for (const item of items) {
        stmt.run(
          item.id,
          item.runId,
          item.targetKey,
          item.hypothesisId,
          item.verdict,
          item.objection,
          item.response || null,
          JSON.stringify(item.evidenceRefs || []),
          item.createdAt,
        );
      }
    });
    tx(critiques);
  }

  listByRun(runId: string): SubconsciousCritique[] {
    const rows = this.db
      .prepare("SELECT * FROM subconscious_critiques WHERE run_id = ? ORDER BY created_at ASC")
      .all(runId) as Any[];
    return rows.map((row) => ({
      id: String(row.id),
      runId: String(row.run_id),
      targetKey: String(row.target_key),
      hypothesisId: String(row.hypothesis_id),
      verdict: row.verdict,
      objection: String(row.objection),
      response: row.response || undefined,
      evidenceRefs: safeJsonParse(row.evidence_refs_json, []),
      createdAt: Number(row.created_at || Date.now()),
    }));
  }
}

export class SubconsciousDecisionRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(decision: SubconsciousDecision): SubconsciousDecision {
    this.db
      .prepare(
        `INSERT INTO subconscious_decisions (
          id, run_id, target_key, winning_hypothesis_id, winner_summary, recommendation,
          rejected_hypothesis_ids_json, rationale, next_backlog_json, outcome, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          id = excluded.id,
          target_key = excluded.target_key,
          winning_hypothesis_id = excluded.winning_hypothesis_id,
          winner_summary = excluded.winner_summary,
          recommendation = excluded.recommendation,
          rejected_hypothesis_ids_json = excluded.rejected_hypothesis_ids_json,
          rationale = excluded.rationale,
          next_backlog_json = excluded.next_backlog_json,
          outcome = excluded.outcome,
          created_at = excluded.created_at`,
      )
      .run(
        decision.id,
        decision.runId,
        decision.targetKey,
        decision.winningHypothesisId,
        decision.winnerSummary,
        decision.recommendation,
        JSON.stringify(decision.rejectedHypothesisIds || []),
        decision.rationale,
        JSON.stringify(decision.nextBacklog || []),
        decision.outcome,
        decision.createdAt,
      );
    return this.findByRun(decision.runId) || decision;
  }

  findByRun(runId: string): SubconsciousDecision | undefined {
    const row = this.db
      .prepare("SELECT * FROM subconscious_decisions WHERE run_id = ?")
      .get(runId) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  findLatestByTarget(targetKey: string): SubconsciousDecision | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM subconscious_decisions
         WHERE target_key = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(targetKey) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  private mapRow(row: Any): SubconsciousDecision {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      targetKey: String(row.target_key),
      winningHypothesisId: String(row.winning_hypothesis_id),
      winnerSummary: String(row.winner_summary),
      recommendation: String(row.recommendation),
      rejectedHypothesisIds: safeJsonParse(row.rejected_hypothesis_ids_json, []),
      rationale: String(row.rationale || ""),
      nextBacklog: safeJsonParse(row.next_backlog_json, []),
      outcome: row.outcome,
      createdAt: Number(row.created_at || Date.now()),
    };
  }
}

export class SubconsciousBacklogRepository {
  constructor(private readonly db: Database.Database) {}

  create(
    input: Omit<SubconsciousBacklogItem, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
      createdAt?: number;
      updatedAt?: number;
    },
  ): SubconsciousBacklogItem {
    const item: SubconsciousBacklogItem = {
      ...input,
      id: input.id || randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
      updatedAt: input.updatedAt ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO subconscious_backlog_items (
          id, target_key, title, summary, status, priority, executor_kind, source_run_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.targetKey,
        item.title,
        item.summary,
        item.status,
        item.priority,
        item.executorKind || null,
        item.sourceRunId || null,
        item.createdAt,
        item.updatedAt,
      );
    return item;
  }

  listByTarget(targetKey: string, limit?: number): SubconsciousBacklogItem[] {
    const limitSql = limit ? `LIMIT ${Math.max(1, limit)}` : "";
    const rows = this.db
      .prepare(
        `SELECT * FROM subconscious_backlog_items
         WHERE target_key = ?
         ORDER BY status = 'open' DESC, priority DESC, updated_at DESC ${limitSql}`,
      )
      .all(targetKey) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  countOpenByTarget(targetKey: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM subconscious_backlog_items
         WHERE target_key = ? AND status = 'open'`,
      )
      .get(targetKey) as Any;
    return Number(row?.count || 0);
  }

  deleteLegacyNoiseByTarget(targetKey: string): number {
    const result = this.db
      .prepare(
        `DELETE FROM subconscious_backlog_items
         WHERE target_key = ? AND source_run_id IS NULL`,
      )
      .run(targetKey);
    return Number(result.changes || 0);
  }

  update(id: string, updates: Partial<SubconsciousBacklogItem>): void {
    const current = this.db
      .prepare("SELECT * FROM subconscious_backlog_items WHERE id = ?")
      .get(id) as Any;
    if (!current) return;
    const merged = {
      ...this.mapRow(current),
      ...updates,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE subconscious_backlog_items
         SET title = ?, summary = ?, status = ?, priority = ?, executor_kind = ?, source_run_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.title,
        merged.summary,
        merged.status,
        merged.priority,
        merged.executorKind || null,
        merged.sourceRunId || null,
        merged.updatedAt,
        id,
      );
  }

  private mapRow(row: Any): SubconsciousBacklogItem {
    return {
      id: String(row.id),
      targetKey: String(row.target_key),
      title: String(row.title),
      summary: String(row.summary),
      status: row.status,
      priority: Number(row.priority || 0),
      executorKind: row.executor_kind || undefined,
      sourceRunId: row.source_run_id || undefined,
      createdAt: Number(row.created_at || Date.now()),
      updatedAt: Number(row.updated_at || Date.now()),
    };
  }
}

export class SubconsciousDispatchRepository {
  constructor(private readonly db: Database.Database) {}

  create(
    input: Omit<SubconsciousDispatchRecord, "id" | "createdAt"> & {
      id?: string;
      createdAt?: number;
    },
  ): SubconsciousDispatchRecord {
    const record: SubconsciousDispatchRecord = {
      ...input,
      id: input.id || randomUUID(),
      createdAt: input.createdAt ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO subconscious_dispatch_records (
          id, run_id, target_key, kind, status, task_id, external_ref_id, summary,
          error, metadata_json, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.targetKey,
        record.kind,
        record.status,
        record.taskId || null,
        record.externalRefId || null,
        record.summary,
        record.error || null,
        JSON.stringify(record.metadata || {}),
        record.createdAt,
        record.completedAt || null,
      );
    return record;
  }

  listByTarget(targetKey: string, limit = 20): SubconsciousDispatchRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM subconscious_dispatch_records
         WHERE target_key = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(targetKey, Math.max(1, limit)) as Any[];
    return rows.map((row) => this.mapRow(row));
  }

  private mapRow(row: Any): SubconsciousDispatchRecord {
    return {
      id: String(row.id),
      runId: String(row.run_id),
      targetKey: String(row.target_key),
      kind: row.kind,
      status: row.status,
      taskId: row.task_id || undefined,
      externalRefId: row.external_ref_id || undefined,
      summary: String(row.summary || ""),
      error: row.error || undefined,
      metadata: safeJsonParse(row.metadata_json, {}),
      createdAt: Number(row.created_at || Date.now()),
      completedAt: row.completed_at ? Number(row.completed_at) : undefined,
    };
  }
}

export function clearSubconsciousHistoryData(db: Database.Database): {
  targets: number;
  runs: number;
  hypotheses: number;
  critiques: number;
  decisions: number;
  backlogItems: number;
  dispatchRecords: number;
} {
  const count = (table: string) =>
    Number((db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as Any)?.count || 0);
  const deleted = {
    targets: count("subconscious_targets"),
    runs: count("subconscious_runs"),
    hypotheses: count("subconscious_hypotheses"),
    critiques: count("subconscious_critiques"),
    decisions: count("subconscious_decisions"),
    backlogItems: count("subconscious_backlog_items"),
    dispatchRecords: count("subconscious_dispatch_records"),
  };
  db.exec(`
    DELETE FROM subconscious_dispatch_records;
    DELETE FROM subconscious_backlog_items;
    DELETE FROM subconscious_decisions;
    DELETE FROM subconscious_critiques;
    DELETE FROM subconscious_hypotheses;
    DELETE FROM subconscious_runs;
    DELETE FROM subconscious_targets;
  `);
  return deleted;
}
