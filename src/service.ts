import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { evaluatePlan, ocCurve, compareRisks, validatePlan } from './math.ts';
import type { DoubleSamplingPlan, CurvePoint, RiskPair } from './math.ts';

/** Error with a stable machine-readable code and HTTP-ish status. */
export class ApiError extends Error {
  code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'STATE_ERROR';
  status: number;
  constructor(
    code: 'VALIDATION_ERROR' | 'NOT_FOUND' | 'CONFLICT' | 'STATE_ERROR',
    message: string,
    status = 400,
  ) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface Deps {
  now?: () => Date;
  idgen?: () => string;
}

export interface PlanRow extends DoubleSamplingPlan {
  id: string;
  name: string;
  version: number;
  status: 'draft' | 'frozen';
  degenerate: boolean;
  createdAt: string;
  frozenAt: string | null;
}

interface PlanDbRow {
  id: string; name: string; version: number; status: 'draft' | 'frozen';
  lot_size: number; n1: number; n2: number;
  ac1: number; re1: number; ac2: number; re2: number;
  degenerate: number; created_at: string; frozen_at: string | null;
}

function toPlan(r: PlanDbRow): PlanRow {
  return {
    id: r.id, name: r.name, version: r.version, status: r.status,
    lotSize: r.lot_size, n1: r.n1, n2: r.n2,
    ac1: r.ac1, re1: r.re1, ac2: r.ac2, re2: r.re2,
    degenerate: r.degenerate === 1,
    createdAt: r.created_at, frozenAt: r.frozen_at,
  };
}

export class SamplingService {
  private now: () => Date;
  private idgen: () => string;
  private db: DatabaseSync;

  constructor(db: DatabaseSync, deps: Deps = {}) {
    this.db = db;
    this.now = deps.now ?? (() => new Date());
    this.idgen = deps.idgen ?? (() => randomUUID());
  }

  // ---------- plans ----------

  createPlan(input: { name: string } & DoubleSamplingPlan, idemKey?: string): PlanRow {
    if (!input.name || typeof input.name !== 'string') {
      throw new ApiError('VALIDATION_ERROR', 'name is required');
    }
    if (idemKey) {
      const dup = this.db.prepare('SELECT * FROM plans WHERE idempotency_key = ?').get(idemKey) as PlanDbRow | undefined;
      if (dup) return toPlan(dup);
    }
    const v = validatePlan(input);
    if (!v.ok) throw new ApiError('VALIDATION_ERROR', v.errors.join('; '));

    const verRow = this.db.prepare('SELECT COALESCE(MAX(version), 0) AS mv FROM plans WHERE name = ?')
      .get(input.name) as { mv: number };
    const id = this.idgen();
    const now = this.now().toISOString();
    this.db.prepare(`INSERT INTO plans
      (id, name, version, status, lot_size, n1, n2, ac1, re1, ac2, re2, degenerate, idempotency_key, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.name, verRow.mv + 1, 'draft', input.lotSize, input.n1, input.n2,
      input.ac1, input.re1, input.ac2, input.re2, v.degenerate ? 1 : 0, idemKey ?? null, now);
    return this.getPlan(id);
  }

  getPlan(id: string): PlanRow {
    const r = this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as PlanDbRow | undefined;
    if (!r) throw new ApiError('NOT_FOUND', `plan ${id} not found`, 404);
    return toPlan(r);
  }

  listPlans(limit = 50, offset = 0): { items: PlanRow[]; limit: number; offset: number; total: number } {
    checkPage(limit, offset);
    const total = (this.db.prepare('SELECT COUNT(*) c FROM plans').get() as { c: number }).c;
    const rows = this.db.prepare('SELECT * FROM plans ORDER BY created_at, id LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as PlanDbRow[];
    return { items: rows.map(toPlan), limit, offset, total };
  }

  freezePlan(id: string): PlanRow {
    const p = this.getPlan(id);
    if (p.status === 'frozen') return p; // idempotent
    this.db.prepare('UPDATE plans SET status = ?, frozen_at = ? WHERE id = ?')
      .run('frozen', this.now().toISOString(), id);
    return this.getPlan(id);
  }

  // ---------- analytics (pure, separate from observed batch results) ----------

  ocScan(planId: string, dMin?: number, dMax?: number): CurvePoint[] {
    const p = this.getPlan(planId);
    try {
      return ocCurve(p, dMin ?? 0, dMax ?? p.lotSize);
    } catch (e) {
      throw new ApiError('VALIDATION_ERROR', (e as Error).message);
    }
  }

  riskCompare(planId: string, aql: number, lql: number): RiskPair & { disclaimer: string } {
    const p = this.getPlan(planId);
    try {
      return {
        ...compareRisks(p, aql, lql),
        disclaimer: 'Risk figures are probabilistic properties of the sampling plan, not guarantees about any inspected lot.',
      };
    } catch (e) {
      throw new ApiError('VALIDATION_ERROR', (e as Error).message);
    }
  }

  // ---------- batches & records ----------

  createBatch(input: { planId: string; label: string; trueDefectives?: number }, idemKey?: string) {
    if (!input.label) throw new ApiError('VALIDATION_ERROR', 'label is required');
    const plan = this.getPlan(input.planId);
    if (plan.status !== 'frozen') {
      throw new ApiError('STATE_ERROR', `plan ${plan.id} is not frozen; freeze it before recording batches`, 409);
    }
    if (idemKey) {
      const dup = this.db.prepare('SELECT * FROM batches WHERE idempotency_key = ?').get(idemKey);
      if (dup) return this.getBatch((dup as { id: string }).id);
    }
    if (input.trueDefectives !== undefined) {
      const d = input.trueDefectives;
      if (!Number.isInteger(d) || d < 0 || d > plan.lotSize) {
        throw new ApiError('VALIDATION_ERROR', `trueDefectives must be an integer in [0, ${plan.lotSize}]`);
      }
    }
    const id = this.idgen();
    this.db.prepare(`INSERT INTO batches (id, plan_id, label, true_defectives, state, idempotency_key, created_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      id, plan.id, input.label, input.trueDefectives ?? null, 'pending', idemKey ?? null,
      this.now().toISOString());
    return this.getBatch(id);
  }

  getBatch(id: string) {
    const b = this.db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as
      { id: string; plan_id: string; label: string; true_defectives: number | null; state: string; created_at: string } | undefined;
    if (!b) throw new ApiError('NOT_FOUND', `batch ${id} not found`, 404);
    return {
      id: b.id, planId: b.plan_id, label: b.label, trueDefectives: b.true_defectives,
      state: b.state, createdAt: b.created_at,
    };
  }

  listBatches(limit = 50, offset = 0) {
    checkPage(limit, offset);
    const total = (this.db.prepare('SELECT COUNT(*) c FROM batches').get() as { c: number }).c;
    const rows = this.db.prepare('SELECT id FROM batches ORDER BY created_at, id LIMIT ? OFFSET ?')
      .all(limit, offset) as unknown as Array<{ id: string }>;
    return { items: rows.map((r) => this.getBatch(r.id)), limit, offset, total };
  }

  /**
   * Record a sampling round. The decision is DERIVED from the frozen plan,
   * never supplied by the caller. Round 2 is rejected once round 1 concluded.
   * All writes happen in one transaction.
   */
  recordRound(batchId: string, round: 1 | 2, defectives: number, good: number, idemKey?: string) {
    if (round !== 1 && round !== 2) throw new ApiError('VALIDATION_ERROR', 'round must be 1 or 2');
    if (!Number.isInteger(defectives) || !Number.isInteger(good) || defectives < 0 || good < 0) {
      throw new ApiError('VALIDATION_ERROR', 'defectives and good must be non-negative integers');
    }
    if (idemKey) {
      const dup = this.db.prepare('SELECT * FROM sampling_records WHERE idempotency_key = ?').get(idemKey);
      if (dup) return this.getDecision((dup as { batch_id: string }).batch_id);
    }

    this.db.exec('BEGIN');
    try {
      const batch = this.getBatch(batchId);
      const plan = this.getPlan(batch.planId);
      if (batch.state === 'accepted' || batch.state === 'rejected') {
        throw new ApiError('STATE_ERROR', `batch already concluded (${batch.state}); further rounds cannot rewrite the result`, 409);
      }
      const existing = this.db.prepare('SELECT * FROM sampling_records WHERE batch_id = ? ORDER BY round')
        .all(batchId) as unknown as Array<{ round: number; defectives_observed: number; good_observed: number; decision: string }>;
      const r1 = existing.find((r) => r.round === 1);

      if (round === 1) {
        if (r1) throw new ApiError('CONFLICT', 'round 1 already recorded for this batch', 409);
        if (defectives + good !== plan.n1) {
          throw new ApiError('VALIDATION_ERROR', `round 1 sample must total n1=${plan.n1}, got ${defectives + good}`);
        }
      } else {
        if (!r1) throw new ApiError('STATE_ERROR', 'round 1 must be recorded before round 2', 409);
        if (r1.decision !== 'continue') {
          throw new ApiError('STATE_ERROR', `round 1 already concluded (${r1.decision}); round 2 cannot rewrite the result`, 409);
        }
        if (existing.some((r) => r.round === 2)) throw new ApiError('CONFLICT', 'round 2 already recorded', 409);
        if (defectives + good !== plan.n2) {
          throw new ApiError('VALIDATION_ERROR', `round 2 sample must total n2=${plan.n2}, got ${defectives + good}`);
        }
      }

      // Impossible-observation guards. cumDef + cumGood <= lotSize is
      // guaranteed by the sample-size checks; the meaningful guard uses the
      // batch ground truth (fictional fixture) when it exists.
      const cumDef = defectives + (r1?.defectives_observed ?? 0);
      const cumGood = good + (r1?.good_observed ?? 0);
      if (cumDef + cumGood > plan.lotSize) {
        throw new ApiError('VALIDATION_ERROR', 'cumulative sample exceeds lot size');
      }
      if (batch.trueDefectives !== null && batch.trueDefectives !== undefined) {
        if (cumDef > batch.trueDefectives) {
          throw new ApiError('VALIDATION_ERROR',
            `impossible observation: ${cumDef} defectives observed but the lot contains only ${batch.trueDefectives}`);
        }
        const goodInLot = plan.lotSize - batch.trueDefectives;
        if (cumGood > goodInLot) {
          throw new ApiError('VALIDATION_ERROR',
            `impossible observation: ${cumGood} good items observed but the lot contains only ${goodInLot}`);
        }
      }

      let decision: 'accept' | 'reject' | 'continue';
      if (round === 1) {
        if (defectives <= plan.ac1) decision = 'accept';
        else if (defectives >= plan.re1) decision = 'reject';
        else decision = 'continue';
      } else {
        decision = cumDef <= plan.ac2 ? 'accept' : 'reject';
      }

      const recId = this.idgen();
      this.db.prepare(`INSERT INTO sampling_records
        (id, batch_id, round, defectives_observed, good_observed, decision, idempotency_key, created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        recId, batchId, round, defectives, good, decision, idemKey ?? null, this.now().toISOString());

      let newState = batch.state;
      if (round === 1) newState = decision === 'continue' ? 'round1_done' : decision === 'accept' ? 'accepted' : 'rejected';
      else newState = decision === 'accept' ? 'accepted' : 'rejected';
      this.db.prepare('UPDATE batches SET state = ? WHERE id = ?').run(newState, batchId);

      let report = null;
      if (newState === 'accepted' || newState === 'rejected') {
         report = this.freezeReportLocked(batchId, plan, newState === 'accepted' ? 'accept' : 'reject');
      }
      this.db.exec('COMMIT');
      return this.getDecision(batchId);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Must be called inside a transaction. */
  private freezeReportLocked(batchId: string, plan: PlanRow, finalDecision: string) {
    const records = this.db.prepare('SELECT round, defectives_observed, good_observed, decision, created_at FROM sampling_records WHERE batch_id = ? ORDER BY round')
      .all(batchId);
    const id = this.idgen();
    this.db.prepare(`INSERT INTO reports (id, batch_id, plan_snapshot, record_snapshot, final_decision, created_at)
      VALUES (?,?,?,?,?,?)`).run(
      id, batchId, JSON.stringify(plan), JSON.stringify(records), finalDecision, this.now().toISOString());
    return id;
  }

  /** Full audit trail for a batch: batch, frozen plan, records, frozen report. */
  getDecision(batchId: string) {
    const batch = this.getBatch(batchId);
    const plan = this.getPlan(batch.planId);
    const records = this.db.prepare(`SELECT round, defectives_observed AS defectivesObserved,
      good_observed AS goodObserved, decision, created_at AS createdAt
      FROM sampling_records WHERE batch_id = ? ORDER BY round`).all(batchId);
    const report = this.db.prepare('SELECT * FROM reports WHERE batch_id = ?').get(batchId) as
      { id: string; plan_snapshot: string; record_snapshot: string; final_decision: string; created_at: string } | undefined;
    return {
      batch,
      plan,
      records,
      report: report ? {
        id: report.id,
        finalDecision: report.final_decision,
        frozenPlan: JSON.parse(report.plan_snapshot),
        frozenRecords: JSON.parse(report.record_snapshot),
        createdAt: report.created_at,
      } : null,
    };
  }

  listRecords(limit = 50, offset = 0) {
    checkPage(limit, offset);
    const total = (this.db.prepare('SELECT COUNT(*) c FROM sampling_records').get() as { c: number }).c;
    const items = this.db.prepare(`SELECT id, batch_id AS batchId, round,
      defectives_observed AS defectivesObserved, good_observed AS goodObserved,
      decision, created_at AS createdAt
      FROM sampling_records ORDER BY created_at, id LIMIT ? OFFSET ?`).all(limit, offset);
    return { items, limit, offset, total };
  }

  /** Convenience for tests/demo: theoretical evaluation of the plan for a batch's ground truth. */
  evaluateBatchTruth(batchId: string): CurvePoint {
    const batch = this.getBatch(batchId);
    if (batch.trueDefectives === null || batch.trueDefectives === undefined) {
      throw new ApiError('VALIDATION_ERROR', 'batch has no recorded trueDefectives ground truth');
    }
    return evaluatePlan(this.getPlan(batch.planId), batch.trueDefectives);
  }
}

function checkPage(limit: number, offset: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new ApiError('VALIDATION_ERROR', 'limit must be an integer in [1, 500]');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ApiError('VALIDATION_ERROR', 'offset must be a non-negative integer');
  }
}
