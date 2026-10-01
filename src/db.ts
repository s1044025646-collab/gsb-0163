import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './errors.js';
import type { DoublePlan } from './model/plan.js';

export interface PlanRow {
  id: string;
  code: string;
  version: number;
  frozen_at: string | null;
  created_at: string;
  params: DoublePlan;
}

export type RecordStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED';

export interface RecordRow {
  id: string;
  idem_key: string | null;
  lot_ref: string;
  plan_id: string;
  status: RecordStatus;
  d1: number | null;
  d2: number | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

export interface ReportRow {
  id: string;
  record_id: string;
  plan_id: string;
  idem_key: string | null;
  payload: string;
  created_at: string;
}

const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS schema_migrations (
     version INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS plan_versions (
     id TEXT PRIMARY KEY,
     code TEXT NOT NULL,
     version INTEGER NOT NULL,
     n INTEGER NOT NULL, n1 INTEGER NOT NULL, n2 INTEGER NOT NULL,
     ac1 INTEGER NOT NULL, re1 INTEGER NOT NULL,
     ac2 INTEGER NOT NULL, re2 INTEGER NOT NULL,
     frozen_at TEXT, created_at TEXT NOT NULL,
     UNIQUE(code, version)
   );`,
  `CREATE TABLE IF NOT EXISTS records (
     id TEXT PRIMARY KEY,
     idem_key TEXT UNIQUE,
     lot_ref TEXT NOT NULL,
     plan_id TEXT NOT NULL REFERENCES plan_versions(id),
     status TEXT NOT NULL CHECK (status IN ('PENDING','ACCEPTED','REJECTED')),
     d1 INTEGER, d2 INTEGER,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL, decided_at TEXT
   );
  CREATE INDEX IF NOT EXISTS idx_records_lot ON records(lot_ref);
  CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);`,
  `CREATE TABLE IF NOT EXISTS reports (
     id TEXT PRIMARY KEY,
     record_id TEXT NOT NULL REFERENCES records(id),
     plan_id TEXT NOT NULL REFERENCES plan_versions(id),
     idem_key TEXT UNIQUE,
     payload TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
  CREATE INDEX IF NOT EXISTS idx_reports_record ON reports(record_id);`,
];

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  return db;
}

export type DB = DatabaseSync;

/** Idempotent, repeatable migration runner. */
export function migrate(db: DB, now: () => string): number {
  db.exec(MIGRATIONS[0]!);
  const appliedRow = db
    .prepare('SELECT COALESCE(MAX(version),0) AS v FROM schema_migrations')
    .get() as { v: number };
  let current = appliedRow.v;
  for (let v = 1; v < MIGRATIONS.length; v++) {
    if (v <= current) continue;
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare(
        'INSERT INTO schema_migrations(version, applied_at) VALUES (?,?)',
      ).run(v, now());
      db.exec('COMMIT');
      current = v;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return current;
}

function rowToPlan(r: Record<string, unknown>): PlanRow {
  return {
    id: r.id as string,
    code: r.code as string,
    version: r.version as number,
    frozen_at: (r.frozen_at as string | null) ?? null,
    created_at: r.created_at as string,
    params: {
      N: r.n as number,
      n1: r.n1 as number,
      n2: r.n2 as number,
      ac1: r.ac1 as number,
      re1: r.re1 as number,
      ac2: r.ac2 as number,
      re2: r.re2 as number,
    },
  };
}

export function createPlanVersion(
  db: DB,
  args: {
    id: string;
    code: string;
    params: DoublePlan;
    now: string;
  },
): PlanRow {
  const max = db
    .prepare('SELECT COALESCE(MAX(version),0) AS v FROM plan_versions WHERE code=?')
    .get(args.code) as { v: number };
  const version = max.v + 1;
  db.prepare(
    `INSERT INTO plan_versions(id,code,version,n,n1,n2,ac1,re1,ac2,re2,frozen_at,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    args.id,
    args.code,
    version,
    args.params.N,
    args.params.n1,
    args.params.n2,
    args.params.ac1,
    args.params.re1,
    args.params.ac2,
    args.params.re2,
    args.now,
    args.now,
  );
  return getPlan(db, args.id)!;
}

export function getPlan(db: DB, id: string): PlanRow | null {
  const r = db.prepare('SELECT * FROM plan_versions WHERE id=?').get(id) as
    | Record<string, unknown>
    | undefined;
  return r ? rowToPlan(r) : null;
}

export function requirePlan(db: DB, id: string): PlanRow {
  const p = getPlan(db, id);
  if (!p) throw new AppError('PLAN_NOT_FOUND', `plan ${id} not found`, { id });
  return p;
}

export function listPlanVersions(db: DB, code: string): PlanRow[] {
  const rows = db
    .prepare('SELECT * FROM plan_versions WHERE code=? ORDER BY version')
    .all(code) as Record<string, unknown>[];
  return rows.map(rowToPlan);
}

export function listPlans(
  db: DB,
  opts: { limit: number; offset: number },
): { items: PlanRow[]; total: number } {
  const total = (
    db.prepare('SELECT COUNT(*) AS c FROM plan_versions').get() as { c: number }
  ).c;
  const rows = db
    .prepare(
      'SELECT * FROM plan_versions ORDER BY code, version LIMIT ? OFFSET ?',
    )
    .all(opts.limit, opts.offset) as Record<string, unknown>[];
  return { items: rows.map(rowToPlan), total };
}

export function createRecord(
  db: DB,
  args: {
    id: string;
    idemKey: string | null;
    lotRef: string;
    planId: string;
    now: string;
  },
): { row: RecordRow; created: boolean } {
  requirePlan(db, args.planId);
  if (args.idemKey) {
    const existing = db
      .prepare('SELECT * FROM records WHERE idem_key=?')
      .get(args.idemKey) as Record<string, unknown> | undefined;
    if (existing) return { row: existing as unknown as RecordRow, created: false };
  }
  try {
    db.prepare(
      `INSERT INTO records(id,idem_key,lot_ref,plan_id,status,d1,d2,created_at,updated_at,decided_at)
       VALUES (?,?,?,?, 'PENDING', NULL,NULL, ?,?,NULL)`,
    ).run(
      args.id,
      args.idemKey,
      args.lotRef,
      args.planId,
      args.now,
      args.now,
    );
  } catch (err) {
    if (args.idemKey && String((err as Error).message).includes('UNIQUE')) {
      const existing = db
        .prepare('SELECT * FROM records WHERE idem_key=?')
        .get(args.idemKey) as Record<string, unknown>;
      return { row: existing as unknown as RecordRow, created: false };
    }
    throw err;
  }
  return { row: getRecord(db, args.id)!, created: true };
}

export function getRecord(db: DB, id: string): RecordRow | null {
  return (
    (db.prepare('SELECT * FROM records WHERE id=?').get(id) as
      | RecordRow
      | undefined) ?? null
  );
}

export function requireRecord(db: DB, id: string): RecordRow {
  const r = getRecord(db, id);
  if (!r)
    throw new AppError('RECORD_NOT_FOUND', `record ${id} not found`, { id });
  return r;
}

export function listRecords(
  db: DB,
  opts: {
    limit: number;
    offset: number;
    status?: string;
    lotRef?: string;
  },
): { items: RecordRow[]; total: number } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status) {
    where.push('status=?');
    params.push(opts.status);
  }
  if (opts.lotRef) {
    where.push('lot_ref=?');
    params.push(opts.lotRef);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM records ${clause}`)
      .get(...params) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT * FROM records ${clause} ORDER BY created_at, id LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit, opts.offset) as unknown as RecordRow[];
  return { items: rows, total };
}

export function saveRecord(db: DB, row: RecordRow, now: string): void {
  db.prepare(
    `UPDATE records SET status=?, d1=?, d2=?, updated_at=?, decided_at=? WHERE id=?`,
  ).run(row.status, row.d1, row.d2, now, row.decided_at, row.id);
}

export function createReport(
  db: DB,
  args: {
    id: string;
    recordId: string;
    planId: string;
    idemKey: string | null;
    payload: string;
    now: string;
  },
): { row: ReportRow; created: boolean } {
  if (args.idemKey) {
    const existing = db
      .prepare('SELECT * FROM reports WHERE idem_key=?')
      .get(args.idemKey) as ReportRow | undefined;
    if (existing) return { row: existing, created: false };
  }
  db.prepare(
    `INSERT INTO reports(id,record_id,plan_id,idem_key,payload,created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    args.id,
    args.recordId,
    args.planId,
    args.idemKey,
    args.payload,
    args.now,
  );
  const row = db
    .prepare('SELECT * FROM reports WHERE id=?')
    .get(args.id) as unknown as ReportRow;
  return { row, created: true };
}

export function listReports(
  db: DB,
  opts: { limit: number; offset: number; recordId?: string },
): { items: ReportRow[]; total: number } {
  const clause = opts.recordId ? 'WHERE record_id=?' : '';
  const params = opts.recordId ? [opts.recordId] : [];
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM reports ${clause}`)
      .get(...params) as { c: number }
  ).c;
  const rows = db
    .prepare(
      `SELECT * FROM reports ${clause} ORDER BY created_at, id LIMIT ? OFFSET ?`,
    )
    .all(...params, opts.limit, opts.offset) as unknown as ReportRow[];
  return { items: rows, total };
}
