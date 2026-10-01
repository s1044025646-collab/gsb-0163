import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDatabase, migrate, type DB } from '../src/db.js';
import { startApi, type StartedServer } from '../src/api.js';

let dir: string;
let db: DB;
let srv: StartedServer;
let base: string;

async function call(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

before(async () => {
  dir = join(tmpdir(), `dblapi-${Date.now()}`);
  db = openDatabase(join(dir, 'a.sqlite'));
  migrate(db, () => '2026-01-01T00:00:00.000Z');
  srv = await startApi(db, { host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
});

after(async () => {
  await srv.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('health', async () => {
  const r = await call('/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('create plan, validation error code, then full workflow', async () => {
  const bad = await call('/plans', {
    method: 'POST',
    body: { code: 'X', N: 10, n1: 12, n2: 0, ac1: 0, re1: 1, ac2: 0, re2: 1 },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'SAMPLE_EXCEEDS_LOT');

  const created = await call('/plans', {
    method: 'POST',
    body: { code: 'API', N: 100, n1: 20, n2: 30, ac1: 1, re1: 4, ac2: 4, re2: 5 },
  });
  assert.equal(created.status, 201);
  const planId = created.json.plan.id;

  const risk = await call(`/plans/${planId}/risk?aql=0.02&rql=0.10`);
  assert.equal(risk.status, 200);
  assert.ok(risk.json.risk.aql.producerRisk >= 0);

  const oc = await call(`/plans/${planId}/oc`);
  assert.equal(oc.json.curve.length, 101);

  const opened = await call('/records', {
    method: 'POST',
    headers: { 'idempotency-key': 'api-open' },
    body: { lotRef: 'LOT-A', planId },
  });
  assert.equal(opened.status, 201);
  const id = opened.json.row.id;

  const replay = await call('/records', {
    method: 'POST',
    headers: { 'idempotency-key': 'api-open' },
    body: { lotRef: 'LOT-A', planId },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.row.id, id);

  await call(`/records/${id}/first`, { method: 'POST', body: { d1: 2 } });
  const blocked = await call(`/records/${id}/first`, {
    method: 'POST',
    body: { d1: 3 },
  });
  assert.equal(blocked.status, 409);

  const second = await call(`/records/${id}/second`, {
    method: 'POST',
    body: { d2: 1, trueK: 10 },
  });
  assert.equal(second.json.decision, 'ACCEPTED');

  const rewrite = await call(`/records/${id}/second`, {
    method: 'POST',
    body: { d2: 9 },
  });
  assert.equal(rewrite.status, 409);

  const trace = await call(`/records/${id}/trace`);
  assert.ok(trace.json.trail.length >= 2);

  const rep = await call(`/records/${id}/report`, {
    method: 'POST',
    headers: { 'idempotency-key': 'api-rep' },
  });
  assert.equal(rep.status, 201);
  const rep2 = await call(`/records/${id}/report`, {
    method: 'POST',
    headers: { 'idempotency-key': 'api-rep' },
  });
  assert.equal(rep2.status, 200);

  const list = await call('/records?page=1&pageSize=1');
  assert.equal(list.json.items.length, 1);
  assert.equal(list.json.total, 1);
  assert.equal(list.json.hasMore, false);
});

test('server binds only localhost', () => {
  const addr = srv.server.address();
  assert.ok(addr && typeof addr === 'object');
  assert.equal(addr.address, '127.0.0.1');
});
