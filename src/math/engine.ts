import { AppError } from '../errors.js';
import {
  hyperDistribution,
  hyperPmf,
  hyperSupport,
  validateHyper,
  type HyperParams,
} from './hypergeom.js';
import { isDegenerate, type DoublePlan } from '../model/plan.js';

export interface StageProbabilities {
  acceptFirst: number;
  rejectFirst: number;
  continueToSecond: number;
  acceptSecond: number;
  rejectSecond: number;
}

export interface OcPoint {
  K: number;
  p: number;
  pa: number;
  asn: number;
  stages: StageProbabilities;
}

function assertDefectives(plan: DoublePlan, K: number): void {
  if (!Number.isInteger(K) || K < 0)
    throw new AppError('VALIDATION_ERROR', 'K must be a non-negative integer', {
      K,
    });
  if (K > plan.N)
    throw new AppError(
      'IMPOSSIBLE_OBSERVATION',
      'assumed defectives K cannot exceed lot N',
      { K, N: plan.N },
    );
}

/**
 * Probabilities for a fixed assumed lot with K defectives. The second stage is
 * conditioned on defectives/good units already removed by the first sample
 * (hypergeometric on remaining N-n1 units); the stages are not independent
 * binomial draws.
 */
export function stageProbabilities(
  plan: DoublePlan,
  K: number,
): StageProbabilities {
  assertDefectives(plan, K);
  const { N, n1, n2, ac1, re1, ac2 } = plan;

  const firstDist = hyperDistribution({ N, K, n: n1 });
  let acceptFirst = 0;
  let rejectFirst = 0;
  let continueToSecond = 0;
  let acceptSecond = 0;
  let rejectSecond = 0;

  const addSecond = (d1: number, p1: number): void => {
    const remainLot = N - n1;
    const remainDef = K - d1;
    const p2: HyperParams = { N: remainLot, K: remainDef, n: n2 };
    validateHyper(p2);
    const [lo2, hi2] = hyperSupport(p2);
    for (let d2 = lo2; d2 <= hi2; d2++) {
      const joint = p1 * hyperPmf(p2, d2);
      if (d1 + d2 <= ac2) acceptSecond += joint;
      else rejectSecond += joint;
    }
  };

  for (const [d1, p1] of firstDist) {
    if (d1 <= ac1) acceptFirst += p1;
    else if (d1 >= re1) rejectFirst += p1;
    else {
      continueToSecond += p1;
      if (!isDegenerate(plan)) addSecond(d1, p1);
    }
  }

  return {
    acceptFirst,
    rejectFirst,
    continueToSecond,
    acceptSecond,
    rejectSecond,
  };
}

export function evaluate(plan: DoublePlan, K: number): OcPoint {
  const s = stageProbabilities(plan, K);
  const pa = s.acceptFirst + s.acceptSecond;
  const asn = plan.n1 + plan.n2 * s.continueToSecond;
  return { K, p: K / plan.N, pa, asn, stages: s };
}

/** Full OC/ASN sweep over every feasible integer defective count. */
export function ocCurve(plan: DoublePlan): OcPoint[] {
  const out: OcPoint[] = [];
  for (let K = 0; K <= plan.N; K++) out.push(evaluate(plan, K));
  return out;
}

export interface QualityMapping {
  level: 'AQL' | 'RQL';
  proportion: number;
  K: number;
  rule: string;
}

/**
 * Map a quality proportion q in [0,1] to an integer defective count.
 * Public rule: K = Math.round(q * N) (half-up), clamped to [0,N]. The rounded
 * integer is stored and shown by the CLI.
 */
export function mapProportion(
  N: number,
  level: 'AQL' | 'RQL',
  q: number,
): QualityMapping {
  if (typeof q !== 'number' || !Number.isFinite(q) || q < 0 || q > 1) {
    throw new AppError(
      'VALIDATION_ERROR',
      `${level} proportion must be a finite number in [0,1]`,
      { q },
    );
  }
  const K = clampInt(Math.round(q * N), 0, N);
  return {
    level,
    proportion: q,
    K,
    rule: 'K = Math.round(q * N), clamped to [0,N]',
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface RiskResult {
  aql: { proportion: number; K: number; pa: number; producerRisk: number };
  rql: { proportion: number; K: number; pa: number; consumerRisk: number };
  note: string;
}

/**
 * Producer risk = P(reject | lot at AQL).
 * Consumer risk = P(accept | lot at RQL).
 * These are sampling-probability statements about the PLAN, not guarantees
 * about any already-inspected lot.
 */
export function risks(
  plan: DoublePlan,
  aqlQ: number,
  rqlQ: number,
): RiskResult {
  const aql = mapProportion(plan.N, 'AQL', aqlQ);
  const rql = mapProportion(plan.N, 'RQL', rqlQ);
  const atAql = evaluate(plan, aql.K);
  const atRql = evaluate(plan, rql.K);
  return {
    aql: {
      proportion: aqlQ,
      K: aql.K,
      pa: atAql.pa,
      producerRisk: 1 - atAql.pa,
    },
    rql: {
      proportion: rqlQ,
      K: rql.K,
      pa: atRql.pa,
      consumerRisk: atRql.pa,
    },
    note:
      'Risks describe plan behaviour under assumed defectives; they are not quality guarantees for observed lots.',
  };
}
