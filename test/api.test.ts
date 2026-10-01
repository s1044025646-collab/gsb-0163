import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { SamplingService } from '../src/service.ts';
import { startApi } from '../src/api.ts';
import { Server } from 'node:http';

let server: Server;
let base: string;

before(async () => {
  const svc = new SamplingService(openDb(':memory:'));
  const started = await startApi(svc);
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(() => server.close());

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const PLAN = { name: 'api-plan', lotSize: 50, n1: 5, n2: 10, ac1: 1, re1: 3, ac2: 3, re2: 4 };

test('health endpoint', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('plan validation errors carry stable codes', async () => {
  const r = await call('POST', '/plans', { ...PLAN, re1: 0 });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'VALIDATION_ERROR');
});

test('unknown route and unknown plan give NOT_FOUND', async () => {
  assert.equal((await call('GET', '/nope')).body.error.code, 'NOT_FOUND');
  assert.equal((await call('GET', '/plans/missing')).status, 404);
});

test('full API flow: plan, freeze, oc, risks, batch, rounds, decision, pagination', async () => {
  let r = await call('POST', '/plans', PLAN, { 'idempotency-key': 'api-p1' });
  assert.equal(r.status, 201);
  const plan = r.body;
  // idempotent replay via header
  const replay = await call('POST', '/plans', PLAN, { 'idempotency-key': 'api-p1' });
  assert.equal(replay.body.id, plan.id);

  r = await call('POST', `/plans/${plan.id}/freeze`);
  assert.equal(r.body.status, 'frozen');

  r = await call('GET', `/plans/${plan.id}/oc?dMin=0&dMax=5`);
  assert.equal(r.body.points.length, 6);
  assert.ok(r.body.points[0].pAccept > r.body.points[5].pAccept);

  r = await call('GET', `/plans/${plan.id}/risks?aql=0.02&lql=0.4`);
  assert.equal(r.body.aqlDefectives, 1);
  assert.ok(r.body.mapping.includes('round(p * lotSize)'));
  assert.ok(r.body.disclaimer.includes('not guarantees'));

  r = await call('GET', `/plans/${plan.id}/risks?aql=0.4`);
  assert.equal(r.body.error.code, 'VALIDATION_ERROR');

  r = await call('POST', '/batches', { planId: plan.id, label: 'API-B1', trueDefectives: 5 }, { 'idempotency-key': 'api-b1' });
  assert.equal(r.status, 201);
  const batch = r.body;

  r = await call('POST', `/batches/${batch.id}/rounds`, { round: 1, defectives: 2, good: 3 });
  assert.equal(r.status, 201);
  assert.equal(r.body.batch.state, 'round1_done');

  r = await call('POST', `/batches/${batch.id}/rounds`, { round: 2, defectives: 2, good: 8 });
  assert.equal(r.body.batch.state, 'rejected'); // cumulative 4 > ac2=3
  assert.equal(r.body.report.finalDecision, 'reject');

  // round 3 attempt rejected
  r = await call('POST', `/batches/${batch.id}/rounds`, { round: 2, defectives: 0, good: 10 });
  assert.equal(r.body.error.code, 'STATE_ERROR');

  r = await call('GET', `/batches/${batch.id}/decision`);
  assert.equal(r.body.records.length, 2);
  assert.equal(r.body.plan.status, 'frozen');

  r = await call('GET', '/records?limit=1&offset=0');
  assert.equal(r.body.items.length, 1);
  assert.ok(r.body.total >= 2);
  r = await call('GET', '/records?limit=0');
  assert.equal(r.body.error.code, 'VALIDATION_ERROR');

  r = await call('GET', '/plans?limit=10&offset=0');
  assert.ok(r.body.total >= 1);
});

test('recording against a draft plan is rejected', async () => {
  const p = await call('POST', '/plans', { ...PLAN, name: 'draft-only' });
  const r = await call('POST', '/batches', { planId: p.body.id, label: 'X' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'STATE_ERROR');
});

test('malformed JSON body rejected', async () => {
  const res = await fetch(base + '/plans', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});
