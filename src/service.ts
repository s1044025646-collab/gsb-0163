import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import {
  createPlanVersion,
  createRecord,
  createReport,
  getRecord,
  listRecords,
  listReports,
  listPlans,
  requirePlan,
  requireRecord,
  saveRecord,
  type PlanRow,
  type RecordRow,
  type ReportRow,
} from './db.js';
import { AppError } from './errors.js';
import { evaluate, ocCurve, risks, stageProbabilities } from './math/engine.js';
import { firstDecision, secondDecision, audit } from './model/decision.js';
import { validatePlan, type PlanInput } from './model/plan.js';

export interface Clock {
  now: () => string;
  id: () => string;
}

export const realClock: Clock = {
  now: () => new Date().toISOString(),
  id: () => randomUUID(),
};

export class Service {
  constructor(
    private readonly db: DB,
    private readonly clock: Clock = realClock,
  ) {}

  createPlan(code: string, input: PlanInput): PlanRow {
    if (typeof code !== 'string' || !code.trim())
      throw new AppError('VALIDATION_ERROR', 'code must be a non-empty string');
    const params = validatePlan(input);
    return createPlanVersion(this.db, {
      id: this.clock.id(),
      code: code.trim(),
      params,
      now: this.clock.now(),
    });
  }

  getPlan(id: string): PlanRow {
    return requirePlan(this.db, id);
  }

  listPlans(limit: number, offset: number) {
    return listPlans(this.db, { limit, offset });
  }

  openRecord(
    lotRef: string,
    planId: string,
    idemKey: string | null,
  ): { row: RecordRow; created: boolean } {
    if (typeof lotRef !== 'string' || !lotRef.trim())
      throw new AppError('VALIDATION_ERROR', 'lotRef is required');
    return createRecord(this.db, {
      id: this.clock.id(),
      idemKey,
      lotRef: lotRef.trim(),
      planId,
      now: this.clock.now(),
    });
  }

  getRecord(id: string): RecordRow {
    return requireRecord(this.db, id);
  }

  listRecords(limit: number, offset: number, status?: string, lotRef?: string) {
    return listRecords(this.db, { limit, offset, status, lotRef });
  }

  /** Idempotent first-stage entry. Re-posting the same result returns the row. */
  enterFirst(
    id: string,
    d1: number,
    idemKey?: string | null,
  ): { row: RecordRow; decision: string; replay: boolean } {
    const existing = requireRecord(this.db, id);
    const plan = requirePlan(this.db, existing.plan_id).params;
    const decision = firstDecision(plan, d1).decision;
    if (existing.d1 !== null) {
      if (existing.d1 !== d1)
        throw new AppError(
          'CONFLICT',
          'record already has a different first-stage observation',
          { stored: existing.d1, given: d1 },
        );
      return { row: existing, decision: existing.status, replay: true };
    }
    const status =
      decision === 'ACCEPT'
        ? 'ACCEPTED'
        : decision === 'REJECT'
          ? 'REJECTED'
          : 'PENDING';
    const ts = this.clock.now();
    this.db.exec('BEGIN');
    try {
      const row: RecordRow = {
        ...existing,
        d1,
        status,
        updated_at: ts,
        decided_at: status === 'PENDING' ? null : ts,
      };
      saveRecord(this.db, row, ts);
      this.db.exec('COMMIT');
      return { row, decision, replay: false };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Second-stage entry. Refuses to rewrite a lot already decided at stage one.
   * The plan snapshot used is the frozen version linked to the record.
   */
  enterSecond(
    id: string,
    d2: number,
    trueK?: number,
  ): { row: RecordRow; decision: string } {
    const existing = requireRecord(this.db, id);
    const plan = requirePlan(this.db, existing.plan_id).params;
    if (existing.d1 === null)
      throw new AppError(
        'NOT_POSSIBLE',
        'first-stage result must be recorded before the second stage',
      );
    if (existing.status !== 'PENDING' || existing.d2 !== null)
      throw new AppError(
        'DECISION_FINAL',
        `record is already ${existing.status}; the decision cannot be rewritten`,
        { status: existing.status },
      );
    const result = secondDecision(plan, existing.d1, d2, trueK);
    const ts = this.clock.now();
    this.db.exec('BEGIN');
    try {
      const row: RecordRow = {
        ...existing,
        d2,
        status: result.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED',
        updated_at: ts,
        decided_at: ts,
      };
      saveRecord(this.db, row, ts);
      this.db.exec('COMMIT');
      return { row, decision: row.status };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  trace(id: string): {
    record: RecordRow;
    plan: PlanRow;
    trail: string[];
  } {
    const record = requireRecord(this.db, id);
    const plan = requirePlan(this.db, record.plan_id);
    if (record.d1 === null)
      return { record, plan, trail: ['no stage observations recorded yet'] };
    return {
      record,
      plan,
      trail: audit(plan.params, record.d1, record.d2, record.status),
    };
  }

  evaluatePlan(planId: string, K: number) {
    const plan = requirePlan(this.db, planId);
    return { plan, result: evaluate(plan.params, K) };
  }

  stageBreakdown(planId: string, K: number) {
    const plan = requirePlan(this.db, planId);
    return { plan, stages: stageProbabilities(plan.params, K) };
  }

  oc(planId: string) {
    const plan = requirePlan(this.db, planId);
    return { plan, curve: ocCurve(plan.params) };
  }

  risk(planId: string, aql: number, rql: number) {
    const plan = requirePlan(this.db, planId);
    return { plan, risk: risks(plan.params, aql, rql) };
  }

  /** Freeze an immutable report capturing the plan snapshot and decision. */
  freezeReport(
    recordId: string,
    idemKey: string | null,
  ): { report: ReportRow; created: boolean } {
    const trace = this.trace(recordId);
    if (trace.record.status === 'PENDING')
      throw new AppError(
        'NOT_POSSIBLE',
        'cannot freeze a report for a lot without a final decision',
      );
    const payload = JSON.stringify(
      {
        frozen_at: this.clock.now(),
        record: trace.record,
        plan: { id: trace.plan.id, code: trace.plan.code,
          version: trace.plan.version, params: trace.plan.params },
        trail: trace.trail,
      },
      null,
      2,
    );
    const r = createReport(this.db, {
      id: this.clock.id(),
      recordId,
      planId: trace.plan.id,
      idemKey,
      payload,
      now: this.clock.now(),
    });
    return { report: r.row, created: r.created };
  }

  listReports(limit: number, offset: number, recordId?: string) {
    return listReports(this.db, { limit, offset, recordId });
  }

  reportDetail(id: string): ReportRow {
    const r = this.db
      .prepare('SELECT * FROM reports WHERE id=?')
      .get(id) as ReportRow | undefined;
    if (!r) throw new AppError('NOT_FOUND', `report ${id} not found`);
    return r;
  }
}

export function paginate(query: URLSearchParams): { limit: number; offset: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const limit = Math.min(
    200,
    Math.max(1, parseInt(query.get('pageSize') ?? '50', 10) || 50),
  );
  return { limit, offset: (page - 1) * limit };
}
