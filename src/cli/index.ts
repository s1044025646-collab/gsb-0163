#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openDatabase, migrate } from '../db.js';
import { Service, realClock } from '../service.js';
import { startApi } from '../api.js';
import { AppError } from '../errors.js';
import { mapProportion } from '../math/engine.js';
import { FIXTURES } from '../fixtures.js';

function projectRoot(): string {
  return resolve(process.cwd());
}

function dataDir(): string {
  return process.env.DOUBLE_SAMPLING_DATA
    ? resolve(process.env.DOUBLE_SAMPLING_DATA)
    : join(projectRoot(), '.data');
}

function dbPath(): string {
  return join(dataDir(), 'app.sqlite');
}

function loadService() {
  mkdirSync(dataDir(), { recursive: true });
  const db = openDatabase(dbPath());
  migrate(db, realClock.now);
  return { db, svc: new Service(db) };
}

function args(argv: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        m.set(a.slice(2), next);
        i++;
      } else m.set(a.slice(2), 'true');
    }
  }
  return m;
}

const num = (m: Map<string, string>, k: string): number => {
  const v = m.get(k);
  const n = v === undefined ? NaN : Number(v);
  if (!Number.isFinite(n))
    throw new AppError('VALIDATION_ERROR', `--${k} must be a number`, { v });
  return n;
};

const int = (m: Map<string, string>, k: string): number => {
  const v = m.get(k);
  const n = v === undefined ? NaN : Number(v);
  if (!Number.isInteger(n))
    throw new AppError('VALIDATION_ERROR', `--${k} must be an integer`, { v });
  return n;
};

const planInput = (m: Map<string, string>) => ({
  N: int(m, 'N'),
  n1: int(m, 'n1'),
  n2: int(m, 'n2'),
  ac1: int(m, 'ac1'),
  re1: int(m, 're1'),
  ac2: int(m, 'ac2'),
  re2: int(m, 're2'),
});

function line(): string {
  return '-'.repeat(64);
}

const HELP = `
Commands (all data stays under ./.data unless DOUBLE_SAMPLING_DATA is set):
  migrate
  plan-create --code C --N --n1 --n2 --ac1 --re1 --ac2 --re2
  plan-list [--page 1 --pageSize 50]
  oc --planId ID                 full OC/ASN curve (every integer K)
  risk --planId ID --aql 0.02 --rql 0.10
  evaluate --planId ID --K 5
  record-open --lotRef L --planId ID [--idemKey K]
  first --id ID --d1 D [--idemKey K]
  second --id ID --d2 D [--trueK K]
  trace --id ID
  report --id ID [--idemKey K]
  reports [--recordId ID]
  serve [--port 0]                 binds 127.0.0.1 only; 0 = automatic port
  demo                             reproducible end-to-end walkthrough
  fixtures                         list built-in fictional lot fixtures
`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const m = args(rest);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(HELP);
    return;
  }

  if (cmd === 'migrate') {
    mkdirSync(dataDir(), { recursive: true });
    const db = openDatabase(dbPath());
    const v = migrate(db, realClock.now);
    console.log(`migrations at version ${v} (db: ${dbPath()})`);
    db.close();
    return;
  }

  if (cmd === 'fixtures') {
    for (const f of FIXTURES)
      console.log(`${f.name.padEnd(22)} ${f.description}`);
    return;
  }

  if (cmd === 'serve') {
    const { db } = loadService();
    const port = m.get('port') ? Number(m.get('port')) : 0;
    const started = await startApi(db, { host: '127.0.0.1', port });
    console.log(`API listening on http://127.0.0.1:${started.port} (localhost only)`);
    console.log('Ctrl+C to stop.');
    const stop = async () => {
      await started.close();
      db.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  const { db, svc } = loadService();
  try {
    switch (cmd) {
      case 'plan-create': {
        const code = m.get('code')!;
        console.log('before: creating a new frozen version of code', code);
        const plan = svc.createPlan(code, planInput(m));
        console.log('after :', JSON.stringify(plan, null, 2));
        break;
      }
      case 'plan-list': {
        const page = Number(m.get('page') ?? 1);
        const pageSize = Number(m.get('pageSize') ?? 50);
        const r = svc.listPlans(pageSize, (page - 1) * pageSize);
        console.log(`plans ${r.items.length}/${r.total}`);
        for (const p of r.items)
          console.log(
            `${p.id}  ${p.code} v${p.version}  N=${p.params.N} n1=${p.params.n1} n2=${p.params.n2} ac1=${p.params.ac1} re1=${p.params.re1} ac2=${p.params.ac2} re2=${p.params.re2}`,
          );
        break;
      }
      case 'oc': {
        const r = svc.oc(m.get('planId')!);
        console.log(
          'K'.padStart(6), 'p'.padStart(9), 'Pa'.padStart(10),
          'ASN'.padStart(8), 'P(acc1)'.padStart(10), 'P(rej1)'.padStart(10),
          'P(cont)'.padStart(10), 'P(acc2)'.padStart(10),
        );
        for (const pt of r.curve) {
          if (pt.K % Math.max(1, Math.floor(r.plan.params.N / 20)) !== 0 &&
              pt.K !== r.plan.params.N) continue;
          console.log(
            String(pt.K).padStart(6),
            pt.p.toFixed(4).padStart(9),
            pt.pa.toFixed(6).padStart(10),
            pt.asn.toFixed(3).padStart(8),
            pt.stages.acceptFirst.toFixed(6).padStart(10),
            pt.stages.rejectFirst.toFixed(6).padStart(10),
            pt.stages.continueToSecond.toFixed(6).padStart(10),
            pt.stages.acceptSecond.toFixed(6).padStart(10),
          );
        }
        break;
      }
      case 'evaluate': {
        console.log(JSON.stringify(svc.evaluatePlan(m.get('planId')!, int(m, 'K')), null, 2));
        break;
      }
      case 'risk': {
        const aql = num(m, 'aql');
        const rql = num(m, 'rql');
        const plan = svc.getPlan(m.get('planId')!);
        const a = mapProportion(plan.params.N, 'AQL', aql);
        const b = mapProportion(plan.params.N, 'RQL', rql);
        console.log(`AQL ${aql} maps to integer K=${a.K} (${a.rule})`);
        console.log(`RQL ${rql} maps to integer K=${b.K} (${b.rule})`);
        console.log(JSON.stringify(svc.risk(plan.id, aql, rql).risk, null, 2));
        break;
      }
      case 'record-open': {
        const before = svc.listRecords(1, 0).total;
        const r = svc.openRecord(m.get('lotRef')!, m.get('planId')!, m.get('idemKey') ?? null);
        const after = svc.listRecords(1, 0).total;
        console.log(`records ${before} -> ${after}; created=${r.created}`);
        console.log(JSON.stringify(r.row, null, 2));
        break;
      }
      case 'first': {
        const id = m.get('id')!;
        console.log('before:', JSON.stringify(svc.getRecord(id)));
        const r = svc.enterFirst(id, int(m, 'd1'), m.get('idemKey') ?? null);
        console.log(`after : decision=${r.decision} replay=${r.replay}`);
        console.log(JSON.stringify(r.row, null, 2));
        break;
      }
      case 'second': {
        const id = m.get('id')!;
        console.log('before:', JSON.stringify(svc.getRecord(id)));
        const r = svc.enterSecond(
          id, int(m, 'd2'),
          m.get('trueK') !== undefined ? int(m, 'trueK') : undefined,
        );
        console.log(`after : decision=${r.decision}`);
        console.log(JSON.stringify(r.row, null, 2));
        break;
      }
      case 'trace': {
        const t = svc.trace(m.get('id')!);
        console.log(line());
        console.log(`lot ${t.record.lot_ref}  plan ${t.plan.code} v${t.plan.version}  status ${t.record.status}`);
        for (const s of t.trail) console.log('  ' + s);
        console.log(line());
        break;
      }
      case 'report': {
        const r = svc.freezeReport(m.get('id')!, m.get('idemKey') ?? null);
        console.log(`frozen report created=${r.created}`);
        console.log(r.report.payload);
        break;
      }
      case 'reports': {
        const r = svc.listReports(50, 0, m.get('recordId') ?? undefined);
        console.log(`reports ${r.items.length}/${r.total}`);
        for (const rep of r.items)
          console.log(`${rep.id}  record=${rep.record_id}  at=${rep.created_at}`);
        break;
      }
      case 'demo': {
        await runDemo(svc);
        break;
      }
      default:
        console.log(`unknown command: ${cmd}\n${HELP}`);
        process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

async function runDemo(svc: Service): Promise<void> {
  const out = join(dataDir(), 'demo-report.json');
  console.log(line());
  console.log('REPRODUCIBLE END-TO-END DEMO');
  console.log(line());
  const plan = svc.createPlan('DEMO-PLAN', {
    N: 100, n1: 20, n2: 30, ac1: 1, re1: 4, ac2: 4, re2: 5,
  });
  console.log('created frozen plan', plan.id, 'v' + plan.version);

  const risk = svc.risk(plan.id, 0.02, 0.10).risk;
  console.log('AQL producer risk =', risk.aql.producerRisk.toFixed(4),
    ' RQL consumer risk =', risk.rql.consumerRisk.toFixed(4));

  const rec = svc.openRecord('LOT-DEMO', plan.id, 'demo-open-1');
  console.log('opened record', rec.row.id, 'created=', rec.created);

  const f = svc.enterFirst(rec.row.id, 2, 'demo-first-1');
  console.log('stage1 d1=2 ->', f.decision);
  const s = svc.enterSecond(rec.row.id, 1, 10);
  console.log('stage2 d2=1 (trueK=10) ->', s.decision);

  const t = svc.trace(rec.row.id);
  t.trail.forEach((x) => console.log('  ' + x));

  const rep = svc.freezeReport(rec.row.id, 'demo-report-1');
  console.log('frozen report created=', rep.created);
  writeFileSync(out, rep.report.payload, 'utf8');
  console.log('detail exported to', out);

  // Prove idempotency and rewrite protection.
  const replay = svc.openRecord('LOT-DEMO', plan.id, 'demo-open-1');
  console.log('replayed open returns same record, created=', replay.created);
  try {
    svc.enterSecond(rec.row.id, 9, 10);
  } catch (e) {
    console.log('rewrite blocked:', (e as AppError).code);
  }
  console.log(line());
}

main().catch((err: unknown) => {
  if (err instanceof AppError) {
    console.error(`error [${err.code}]: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details));
  } else {
    console.error(err);
  }
  process.exit(1);
});
