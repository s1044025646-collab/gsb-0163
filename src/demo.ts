/**
 * Reproducible end-to-end demo: loads fictional fixtures into a fresh
 * throwaway DB (data/demo.db), with injected clock and id generator, and
 * prints every step. Run: npm run demo
 */
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from './db.ts';
import { SamplingService } from './service.ts';

const DB = resolve('data', 'demo.db');
rmSync(DB, { force: true });
rmSync(DB + '-wal', { force: true });
rmSync(DB + '-shm', { force: true });

// Injected deterministic clock + ids -> fully reproducible output.
let tick = 0;
const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
let seq = 0;
const idgen = () => `demo-${String(++seq).padStart(4, '0')}`;

const fx = JSON.parse(readFileSync(resolve('fixtures', 'batches.json'), 'utf8'));
const s = new SamplingService(openDb(DB), { now, idgen });

const planIds: Record<string, string> = {};
for (const p of fx.plans) {
  const plan = s.createPlan(p, `plan-${p.key}`);
  s.freezePlan(plan.id);
  planIds[p.key] = plan.id;
  console.log(`plan ${p.key}: id=${plan.id} v${plan.version} frozen degenerate=${plan.degenerate}`);
}

console.log('\n-- OC curve (standard plan, D=0..40) --');
for (const pt of s.ocScan(planIds.standard, 0, 40)) {
  console.log(`D=${String(pt.defectives).padStart(3)} Pa=${pt.pAccept.toFixed(4)} ASN=${pt.asn.toFixed(2)}`);
}

const risk = s.riskCompare(planIds.standard, 0.02, 0.15);
console.log(`\nrisks: AQL 0.02 -> D=${risk.aqlDefectives} alpha=${risk.producerRisk.toFixed(4)}; LQL 0.15 -> D=${risk.lqlDefectives} beta=${risk.consumerRisk.toFixed(4)}`);
console.log(`mapping: ${risk.mapping}`);
console.log(`note: ${risk.disclaimer}`);

console.log('\n-- fixture batches --');
for (const b of fx.batches) {
  const batch = s.createBatch(
    { planId: planIds[b.plan], label: b.label, trueDefectives: b.trueDefectives },
    `batch-${b.key}`,
  );
  let out = s.getDecision(batch.id);
  for (const r of b.rounds) {
    out = s.recordRound(batch.id, r.round, r.defectives, r.good, `rec-${b.key}-r${r.round}`);
  }
  const last = (out.records as Array<{ decision: string }>).at(-1);
  console.log(`${b.label}: state=${out.batch.state} finalDecision=${last?.decision} report=${out.report ? out.report.id : '-'}`);
}

// Idempotency proof: replay every key, expect identical ids.
const replay = s.createBatch({ planId: planIds.standard, label: 'FXT-TWO-STAGE', trueDefectives: 20 }, 'batch-twoStage');
console.log(`\nidempotent replay returned same batch: ${replay.label} state=${replay.state}`);
console.log(`demo db persisted at ${DB}`);
