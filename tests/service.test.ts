import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDatabase, migrate, type DB } from '../src/db.js';
import { Service, type Clock } from '../src/service.js';
import { AppError } from '../src/errors.js';

let dir: string;
let db: DB;
let svc: Service;
let seq = 0;

const clock: Clock = {
  now: () => '2026-01-01T00:00:00.000Z',
  id: () => `id-${seq++}`,
};

beforeEach(() => {
  dir = join(tmpdir(), `dblsamp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  db = openDatabase(join(dir, 't.sqlite'));
  migrate(db, clock.now);
  svc = new Service(db, clock);
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

function makePlan() {
  return svc.createPlan('P', {
    N: 100, n1: 20, n2: 30, ac1: 1, re1: 4, ac2: 4, re2: 5,
  });
}

test('plan versions increment and records link to frozen snapshot', () => {
  const p1 = makePlan();
  const p2 = svc.createPlan('P', {
    N: 100, n1: 25, n2: 25, ac1: 1, re1: 4, ac2: 4, re2: 5,
  });
  assert.equal(p1.version, 1);
  assert.equal(p2.version, 2);
  const rec = svc.openRecord('L1', p1.id, null);
  assert.equal(rec.row.plan_id, p1.id);
});

test('open record and first/second entry flow', () => {
  const p = makePlan();
  const rec = svc.openRecord('L1', p.id, null).row;
  const f = svc.enterFirst(rec.id, 2);
  assert.equal(f.decision, 'CONTINUE');
  assert.equal(f.row.status, 'PENDING');
  const s = svc.enterSecond(rec.id, 1, 10);
  assert.equal(s.decision, 'ACCEPTED');
});

test('first-stage decision cannot be rewritten at second stage', () => {
  const p = makePlan();
  const rec = svc.openRecord('L1', p.id, null).row;
  svc.enterFirst(rec.id, 0); // ACCEPTED
  assert.throws(() => svc.enterSecond(rec.id, 5), AppError);
});

test('duplicate first observation conflicts; identical is replay', () => {
  const p = makePlan();
  const rec = svc.openRecord('L1', p.id, null).row;
  svc.enterFirst(rec.id, 2);
  const replay = svc.enterFirst(rec.id, 2);
  assert.equal(replay.replay, true);
  assert.throws(() => svc.enterFirst(rec.id, 3), (e: any) => e.code === 'CONFLICT');
});

test('idempotent open via key returns same record', () => {
  const p = makePlan();
  const a = svc.openRecord('L1', p.id, 'key-1');
  const b = svc.openRecord('L1', p.id, 'key-1');
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.row.id, b.row.id);
});

test('transaction rolls back when second stage is invalid', () => {
  const p = makePlan();
  const rec = svc.openRecord('L1', p.id, null).row;
  svc.enterFirst(rec.id, 2);
  assert.throws(() => svc.enterSecond(rec.id, 99, 10), /d2 exceed/);
  const fresh = svc.getRecord(rec.id);
  assert.equal(fresh.status, 'PENDING');
  assert.equal(fresh.d2, null);
});

test('frozen report is idempotent and cannot precede decision', () => {
  const p = makePlan();
  const rec = svc.openRecord('L1', p.id, null).row;
  assert.throws(() => svc.freezeReport(rec.id, null), /final decision/);
  svc.enterFirst(rec.id, 0);
  const a = svc.freezeReport(rec.id, 'rep-1');
  const b = svc.freezeReport(rec.id, 'rep-1');
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.report.id, b.report.id);
});

test('pagination and status filter', () => {
  const p = makePlan();
  for (let i = 0; i < 5; i++) svc.openRecord(`L${i}`, p.id, null);
  const page1 = svc.listRecords(2, 0);
  assert.equal(page1.items.length, 2);
  assert.equal(page1.total, 5);
  assert.equal(svc.listRecords(50, 0, 'PENDING').total, 5);
});

test('state persists after reopening the database (restart)', () => {
  const p = makePlan();
  const rec = svc.openRecord('L-PERSIST', p.id, null).row;
  svc.enterFirst(rec.id, 2);
  svc.enterSecond(rec.id, 1, 10);
  svc.freezeReport(rec.id, 'rep-persist');
  db.close();

  const db2 = openDatabase(join(dir, 't.sqlite'));
  migrate(db2, clock.now); // repeatable migration is a no-op
  const svc2 = new Service(db2, clock);
  const loaded = svc2.getRecord(rec.id);
  assert.equal(loaded.status, 'ACCEPTED');
  assert.equal(loaded.d1, 2);
  assert.equal(loaded.d2, 1);
  const reports = svc2.listReports(10, 0, rec.id);
  assert.equal(reports.total, 1);
  const trace = svc2.trace(rec.id);
  assert.ok(trace.trail.some((t) => t.includes('stage2')));
  db2.close();
  db = db2;
});
