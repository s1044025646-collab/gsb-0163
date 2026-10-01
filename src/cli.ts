#!/usr/bin/env node
import { openDb } from './db.ts';
import { SamplingService, ApiError } from './service.ts';
import { startApi } from './api.ts';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';

const DB_PATH = process.env.DB_PATH ?? resolve('data', 'app.db');
const PID_FILE = resolve('data', 'server.json');

function svc(): SamplingService {
  return new SamplingService(openDb(DB_PATH));
}

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  const rest = process.argv.slice(2);
  const start = rest.findIndex((x) => x.startsWith('--'));
  const a = start === -1 ? [] : rest.slice(start);
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1];
  return out;
}

function num(v: string | undefined, name: string): number {
  const n = Number(v);
  if (v === undefined || Number.isNaN(n)) throw new ApiError('VALIDATION_ERROR', `--${name} is required and must be numeric`);
  return n;
}

const fmtPct = (x: number) => (x * 100).toFixed(4) + '%';

async function main() {
  const [, , cmd, subRaw] = process.argv;
  const sub = subRaw && !subRaw.startsWith('--') ? subRaw : undefined;
  const a = args();
  const s = svc();

  switch (`${cmd} ${sub ?? ''}`.trim()) {
    case 'plan create': {
      const input = {
        name: a.name, lotSize: num(a.lot, 'lot'), n1: num(a.n1, 'n1'), n2: num(a.n2, 'n2'),
        ac1: num(a.ac1, 'ac1'), re1: num(a.re1, 're1'),
        ac2: num(a.ac2, 'ac2'), re2: num(a.ac2, 'ac2') + 1,
      };
      console.log('BEFORE: creating draft plan', JSON.stringify(input));
      const p = s.createPlan(input, a['idem']);
      console.log('AFTER :', JSON.stringify(p, null, 2));
      break;
    }
    case 'plan freeze': {
      const before = s.getPlan(a.id);
      console.log(`BEFORE: plan ${before.id} status=${before.status}`);
      const after = s.freezePlan(a.id);
      console.log(`AFTER : plan ${after.id} status=${after.status} frozenAt=${after.frozenAt}`);
      break;
    }
    case 'plan list': {
      console.log(JSON.stringify(s.listPlans(a.limit ? Number(a.limit) : 50, a.offset ? Number(a.offset) : 0), null, 2));
      break;
    }
    case 'oc-scan': {
      const pts = s.ocScan(a.plan, a.dMin !== undefined ? Number(a.dMin) : undefined, a.dMax !== undefined ? Number(a.dMax) : undefined);
      console.log('D\tPa\tP1acc\tP1rej\tPcont\tASN');
      for (const p of pts) {
        console.log(`${p.defectives}\t${fmtPct(p.pAccept)}\t${fmtPct(p.pAcceptRound1)}\t${fmtPct(p.pRejectRound1)}\t${fmtPct(p.pContinue)}\t${p.asn.toFixed(3)}`);
      }
      break;
    }
    case 'risk-compare': {
      const r = s.riskCompare(a.plan, num(a.aql, 'aql'), num(a.lql, 'lql'));
      console.log(`mapping: ${r.mapping}`);
      console.log(`AQL ${r.aqlInput} -> D=${r.aqlDefectives}, producer risk alpha=${fmtPct(r.producerRisk)}`);
      console.log(`LQL ${r.lqlInput} -> D=${r.lqlDefectives}, consumer risk beta =${fmtPct(r.consumerRisk)}`);
      console.log(`note: ${r.disclaimer}`);
      break;
    }
    case 'batch create': {
      const b = s.createBatch(
        { planId: a.plan, label: a.label, trueDefectives: a.trueDefectives !== undefined ? Number(a.trueDefectives) : undefined },
        a['idem'],
      );
      console.log('AFTER :', JSON.stringify(b, null, 2));
      break;
    }
    case 'batch list': {
      console.log(JSON.stringify(s.listBatches(a.limit ? Number(a.limit) : 50, a.offset ? Number(a.offset) : 0), null, 2));
      break;
    }
    case 'record': {
      const before = s.getBatch(a.batch);
      console.log(`BEFORE: batch ${before.id} state=${before.state}`);
      const res = s.recordRound(a.batch, Number(a.round) as 1 | 2, num(a.defectives, 'defectives'), num(a.good, 'good'), a['idem']);
      const last = (res.records as Array<{ round: number; decision: string }>).at(-1);
      console.log(`AFTER : batch ${res.batch.id} state=${res.batch.state} round=${last?.round} decision=${last?.decision}`);
      break;
    }
    case 'decision': {
      console.log(JSON.stringify(s.getDecision(a.batch), null, 2));
      break;
    }
    case 'export': {
      const out = { decision: s.getDecision(a.batch), records: s.listRecords(500, 0).items };
      const file = a.out ?? resolve('data', `export-${a.batch}.json`);
      writeFileSync(file, JSON.stringify(out, null, 2));
      console.log(`exported to ${file}`);
      break;
    }
    case 'serve': {
      const { server, port } = await startApi(s);
      writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port, db: DB_PATH }));
      console.log(`API listening on http://127.0.0.1:${port} (pid ${process.pid})`);
      const shutdown = () => { server.close(); if (existsSync(PID_FILE)) unlinkSync(PID_FILE); process.exit(0); };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    case 'stop': {
      if (!existsSync(PID_FILE)) { console.log('no server state file; nothing to stop'); break; }
      const info = JSON.parse(readFileSync(PID_FILE, 'utf8'));
      try { process.kill(info.pid, 'SIGTERM'); console.log(`stopped pid ${info.pid} (port ${info.port})`); }
      catch { console.log(`pid ${info.pid} not running`); }
      unlinkSync(PID_FILE);
      break;
    }
    default:
      console.log(`commands:
  plan create --name N --lot N --n1 N --n2 N --ac1 N --re1 N --ac2 N [--idem K]
  plan freeze --id ID | plan list
  oc-scan --plan ID [--dMin N --dMax N]
  risk-compare --plan ID --aql X --lql Y
  batch create --plan ID --label L [--trueDefectives N] [--idem K] | batch list
  record --batch ID --round 1|2 --defectives N --good N [--idem K]
  decision --batch ID | export --batch ID [--out FILE]
  serve | stop`);
  }
}

main().catch((e) => {
  if (e instanceof ApiError) console.error(`${e.code}: ${e.message}`);
  else console.error(e);
  process.exit(1);
});
