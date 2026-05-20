import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Probe = module.default;
      const probe = new Probe(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("DatabaseManager legacy_type migration", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-schema-legacy-type-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const dbPath = path.join(tmpDir, "cowork-os.db");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
    `);
    db.close();
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds legacy_type before creating indexes that depend on it", async () => {
    const { DatabaseManager } = await import("../schema");
    const manager = new DatabaseManager();
    const db = manager.getDatabase();

    const taskEventColumns = db.prepare("PRAGMA table_info(task_events)").all() as Array<{
      name: string;
    }>;
    const taskEventIndexes = db.prepare("PRAGMA index_list(task_events)").all() as Array<{
      name: string;
    }>;

    expect(taskEventColumns.map((column) => column.name)).toContain("legacy_type");
    expect(taskEventIndexes.map((index) => index.name)).toContain(
      "idx_task_events_legacy_type_timestamp_task",
    );
    expect(taskEventIndexes.map((index) => index.name)).toContain(
      "idx_task_events_task_legacy_type_timestamp",
    );
    expect(taskEventIndexes.map((index) => index.name)).toContain(
      "idx_task_events_task_order_expr",
    );
    expect(taskEventIndexes.map((index) => index.name)).toContain(
      "idx_task_events_task_effective_type_order_expr",
    );

    manager.close();
  });
});
