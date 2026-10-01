import { AppError } from '../errors.js';
import { isDegenerate, type DoublePlan } from './plan.js';

export type FirstDecision = 'ACCEPT' | 'REJECT' | 'CONTINUE';
export type FinalDecision = 'ACCEPT' | 'REJECT' | 'PENDING';

export interface FirstResult {
  decision: FirstDecision;
  cumulative: number;
}

export function firstDecision(plan: DoublePlan, d1: number): FirstResult {
  if (!Number.isInteger(d1) || d1 < 0)
    throw new AppError('VALIDATION_ERROR', 'd1 must be a non-negative integer', {
      d1,
    });
  if (d1 > plan.n1)
    throw new AppError(
      'IMPOSSIBLE_OBSERVATION',
      'observed first-stage defectives d1 exceed n1',
      { d1, n1: plan.n1 },
    );
  if (d1 <= plan.ac1) return { decision: 'ACCEPT', cumulative: d1 };
  if (d1 >= plan.re1) return { decision: 'REJECT', cumulative: d1 };
  return { decision: 'CONTINUE', cumulative: d1 };
}

export interface SecondResult {
  decision: Exclude<FinalDecision, 'PENDING'>;
  d1: number;
  d2: number;
  cumulative: number;
}

/**
 * Apply the second stage. Only CONTINUE lots may enter it; a lot already
 * decided at stage one cannot be rewritten. When trueK is supplied, the
 * observation is checked against the remaining hypergeometric population.
 */
export function secondDecision(
  plan: DoublePlan,
  d1: number,
  d2: number,
  trueK?: number,
): SecondResult {
  if (isDegenerate(plan))
    throw new AppError(
      'NOT_POSSIBLE',
      'this plan is degenerate single sampling; there is no second stage',
    );
  const first = firstDecision(plan, d1);
  if (first.decision !== 'CONTINUE')
    throw new AppError(
      'DECISION_FINAL',
      `lot already ${first.decision} at the first stage; second stage cannot rewrite it`,
      { first: first.decision, d1 },
    );
  if (!Number.isInteger(d2) || d2 < 0)
    throw new AppError('VALIDATION_ERROR', 'd2 must be a non-negative integer', {
      d2,
    });
  if (d2 > plan.n2)
    throw new AppError(
      'IMPOSSIBLE_OBSERVATION',
      'observed second-stage defectives d2 exceed n2',
      { d2, n2: plan.n2 },
    );
  if (trueK !== undefined) {
    if (!Number.isInteger(trueK) || trueK < 0)
      throw new AppError('VALIDATION_ERROR', 'trueK must be integer >= 0');
    if (trueK > plan.N)
      throw new AppError('IMPOSSIBLE_OBSERVATION', 'trueK exceeds N');
    if (d1 > trueK)
      throw new AppError(
        'IMPOSSIBLE_OBSERVATION',
        'd1 defectives observed but lot contains only trueK',
        { d1, trueK },
      );
    const remainLot = plan.N - plan.n1;
    const remainDef = trueK - d1;
    const lo = Math.max(0, plan.n2 + remainDef - remainLot);
    const hi = Math.min(plan.n2, remainDef);
    if (d2 < lo || d2 > hi)
      throw new AppError(
        'IMPOSSIBLE_OBSERVATION',
        'd2 is infeasible for the remaining hypergeometric population',
        { d2, feasible: [lo, hi], remainLot, remainDef },
      );
  }
  const cumulative = d1 + d2;
  return {
    decision: cumulative <= plan.ac2 ? 'ACCEPT' : 'REJECT',
    d1,
    d2,
    cumulative,
  };
}

/** Audit-trail reconstruction from stored stage values. */
export function audit(
  plan: DoublePlan,
  d1: number,
  d2: number | null,
  status: string,
): string[] {
  const trail: string[] = [];
  const f = firstDecision(plan, d1);
  trail.push(
    `stage1: d1=${d1}, ac1=${plan.ac1}, re1=${plan.re1} -> ${f.decision}`,
  );
  if (f.decision === 'CONTINUE' && d2 !== null) {
    const s = secondDecision(plan, d1, d2);
    trail.push(
      `stage2: d2=${d2}, cumulative=${s.cumulative}, ac2=${plan.ac2}, re2=${plan.re2} -> ${s.decision}`,
    );
  }
  trail.push(`record status: ${status}`);
  return trail;
}
