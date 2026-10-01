import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite persistence. Migrations are idempotent (IF NOT EXISTS + user_version
 * gate) and safe to re-run on every startup.
 */

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft','frozen')),
      lot_size INTEGER NOT NULL,
      n1 INTEGER NOT NULL, n2 INTEGER NOT NULL,
      ac1 INTEGER NOT NULL, re1 INTEGER NOT NULL,
      ac2 INTEGER NOT NULL, re2 INTEGER NOT NULL,
      degenerate INTEGER NOT NULL,
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      frozen_at TEXT
    );
    CREATE TABLE IF NOT EXISTS batches (
      id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(id),
      label TEXT NOT NULL,
      true_defectives INTEGER,           -- fictional fixture ground truth, may be NULL
      state TEXT NOT NULL CHECK (state IN
        ('pending','round1_done','accepted','rejected')),
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sampling_records (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(id),
      round INTEGER NOT NULL CHECK (round IN (1,2)),
      defectives_observed INTEGER NOT NULL,
      good_observed INTEGER NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('accept','reject','continue')),
      idempotency_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      UNIQUE (batch_id, round)
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES batches(id),
      plan_snapshot TEXT NOT NULL,       -- frozen plan JSON
      record_snapshot TEXT NOT NULL,     -- JSON array of sampling records
      final_decision TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    `,
  },
];

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let current = row.user_version;
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.exec('BEGIN');
      try {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      current = m.version;
    }
  }
}
