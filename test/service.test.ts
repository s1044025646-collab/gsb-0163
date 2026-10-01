import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { SamplingService, ApiError } from '../src/service.ts';

function makeSvc() {
  let tick = 0;
  let seq = 0;
  const svc = new SamplingService(openDb(':memory:'), {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    idgen: () => `t-${++seq}`,
  });
  return svc;
}

const PLAN = { name: 'p', lotSize: 50, n1: 5, n2: 10, ac1: 1, re1: 3, ac2: 3, re2: 4 };

function frozenPlan(svc: SamplingService, over: Partial<typeof PLAN> = {}) {
  const p = svc.createPlan({ ...PLAN, ...over });
  return svc.freezePlan(p.id);
}

test('plan lifecycle: draft -> frozen, versions increment per name', () => {
  const s = makeSvc();
  const p1 = s.createPlan(PLAN);
  assert.equal(p1.status, 'draft');
  assert.equal(p1.version, 1);
  const p2 = s.createPlan(PLAN);
  assert.equal(p2.version, 2);
  const f = s.freezePlan(p1.id);
  assert.equal(f.status, 'frozen');
  assert.ok(f.frozenAt?.startsWith('2026-01-01')); // injected clock
  assert.equal(s.freezePlan(p1.id).frozenAt, f.frozenAt); // idempotent
});

test('invalid plan input rejected with VALIDATION_ERROR', () => {
  const s = makeSvc();
  assert.throws(() => s.createPlan({ ...PLAN, re1: 1 }), (e: ApiError) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => s.createPlan({ ...PLAN, n1: 60 }), /exceeds lotSize/);
});

test('batches require a frozen plan', () => {
  const s = makeSvc();
  const p = s.createPlan(PLAN);
  assert.throws(() => s.createBatch({ planId: p.id, label: 'B' }),
    (e: ApiError) => e.code === 'STATE_ERROR');
});

test('full double-sampling flow with frozen report linked to frozen plan', () => {
  const s = makeSvc();
  const p = frozenPlan(s);
  const b = s.createBatch({ planId: p.id, label: 'B1', trueDefectives: 8 });

  let d = s.recordRound(b.id, 1, 2, 3); // ac1=1 < 2 < re1=3 -> continue
  assert.equal(d.batch.state, 'round1_done');
  assert.equal((d.records as Array<{ decision: string }>)[0].decision, 'continue');

  d = s.recordRound(b.id, 2, 1, 9); // cumulative 3 <= ac2=3 -> accept
  assert.equal(d.batch.state, 'accepted');
  assert.ok(d.report, 'report frozen on final decision');
  assert.equal(d.report!.finalDecision, 'accept');
  assert.equal(d.report!.frozenPlan.id, p.id);
  assert.equal(d.report!.frozenPlan.status, 'frozen');
  assert.equal((d.report!.frozenRecords as unknown[]).length, 2);
});

test('round 1 conclusion forbids round 2 rewrite', () => {
  const s = makeSvc();
  const p = frozenPlan(s);
  const b = s.createBatch({ planId: p.id, label: 'B2' });
  s.recordRound(b.id, 1, 0, 5); // accept immediately
  assert.throws(() => s.recordRound(b.id, 2, 0, 10),
    (e: ApiError) => e.code === 'STATE_ERROR' && /cannot rewrite/.test(e.message));
  const d = s.getDecision(b.id);
  assert.equal((d.records as unknown[]).length, 1);
});

test('round 2 requires round 1 and continue decision', () => {
  const s = makeSvc();
  const p = frozenPlan(s);
  const b = s.createBatch({ planId: p.id, label: 'B3' });
  assert.throws(() => s.recordRound(b.id, 2, 0, 10), (e: ApiError) => e.code === 'STATE_ERROR');
});

test('sample size and impossible observations are rejected, transaction rolls back', () => {
  const s = makeSvc();
  const p = frozenPlan(s);
  const b = s.createBatch({ planId: p.id, label: 'B4' });
  // wrong sample size
  assert.throws(() => s.recordRound(b.id, 1, 1, 3), (e: ApiError) => e.code === 'VALIDATION_ERROR');
  // impossible: 49 defectives + 1 good observed in n1=5? use 5 defectives then round2 claims more defectives than remain
  assert.throws(() => s.recordRound(b.id, 1, 6, 0), (e: ApiError) => e.code === 'VALIDATION_ERROR');
  // failed attempts must leave no partial writes
  const d = s.getDecision(b.id);
  assert.equal((d.records as unknown[]).length, 0);
  assert.equal(d.batch.state, 'pending');
  // impossible cumulative vs lot ground truth: lot of 12 with 4 true defectives
  const p2 = frozenPlan(s, { name: 'tiny', lotSize: 12, n1: 4, n2: 8, ac1: 0, re1: 2, ac2: 2, re2: 3 });
  const b2 = s.createBatch({ planId: p2.id, label: 'B5', trueDefectives: 4 });
  s.recordRound(b2.id, 1, 1, 3); // continue (ac1=0 < 1 < re1=2)
  // round2 claims 4 more defectives -> cumulative 5 > trueDefectives 4
  assert.throws(() => s.recordRound(b2.id, 2, 4, 4), /impossible observation/);
  const d2 = s.getDecision(b2.id);
  assert.equal((d2.records as unknown[]).length, 1);
  assert.equal(d2.batch.state, 'round1_done');
});

test('idempotent create and record replay', () => {
  const s = makeSvc();
  const p = frozenPlan(s);
  const b1 = s.createBatch({ planId: p.id, label: 'B6' }, 'key-b');
  const b2 = s.createBatch({ planId: p.id, label: 'B6' }, 'key-b');
  assert.equal(b1.id, b2.id);
  const r1 = s.recordRound(b1.id, 1, 0, 5, 'key-r1');
  const r2 = s.recordRound(b1.id, 1, 0, 5, 'key-r1');
  assert.equal(r1.batch.id, r2.batch.id);
  assert.equal((r2.records as unknown[]).length, 1); // no duplicate record
});

test('duplicate round without idempotency key conflicts', () => {
  const s = makeSvc();
  const p = frozenPlan(s);
  const b = s.createBatch({ planId: p.id, label: 'B7' });
  s.recordRound(b.id, 1, 2, 3); // continue
  assert.throws(() => s.recordRound(b.id, 1, 2, 3), (e: ApiError) => e.code === 'CONFLICT');
});

test('pagination validation', () => {
  const s = makeSvc();
  assert.throws(() => s.listPlans(0, 0), (e: ApiError) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => s.listPlans(10, -1), (e: ApiError) => e.code === 'VALIDATION_ERROR');
  const p = frozenPlan(s);
  const page = s.listPlans(1, 0);
  assert.equal(page.items.length, 1);
  assert.ok(page.total >= 1);
  assert.equal(p.id, page.items[0].id);
});

test('persistence across restart (file-backed db)', async () => {
  const path = `data/test-persist-${process.pid}.db`;
  try {
    let seq = 0;
    const s1 = new SamplingService(openDb(path), { idgen: () => `p-${++seq}` });
    const pl = s1.freezePlan(s1.createPlan(PLAN).id);
    const b = s1.createBatch({ planId: pl.id, label: 'PERSIST' });
    s1.recordRound(b.id, 1, 0, 5);
    // reopen: migrations re-run idempotently, state survives
    const s2 = new SamplingService(openDb(path));
    const d = s2.getDecision(b.id);
    assert.equal(d.batch.state, 'accepted');
    assert.equal(d.report!.finalDecision, 'accept');
    assert.equal(d.plan.status, 'frozen');
  } finally {
    for (const suf of ['', '-wal', '-shm']) {
      try { (await import('node:fs')).rmSync(path + suf, { force: true }); } catch {}
    }
  }
});

test('degenerate plan accepts only single-stage records', () => {
  const s = makeSvc();
  const p = frozenPlan(s, { name: 'deg', lotSize: 30, n1: 10, n2: 0, ac1: 1, re1: 2, ac2: 1, re2: 2 });
  assert.ok(p.degenerate);
  const b = s.createBatch({ planId: p.id, label: 'B8' });
  const d = s.recordRound(b.id, 1, 1, 9);
  assert.equal(d.batch.state, 'accepted');
});
