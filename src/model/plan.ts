import { AppError } from '../errors.js';

export interface DoublePlan {
  N: number; // lot size
  n1: number; // first sample size
  n2: number; // second sample size (0 when degenerate single sampling)
  ac1: number; // first-stage accept threshold
  re1: number; // first-stage reject threshold
  ac2: number; // cumulative accept threshold (second stage)
  re2: number; // cumulative reject threshold (second stage)
}

export interface PlanInput {
  N?: number;
  n1?: number;
  n2?: number;
  ac1?: number;
  re1?: number;
  ac2?: number;
  re2?: number;
}

export function isInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * Validate a double-sampling plan.
 * Empty first-stage continue region (re1 = ac1 + 1) is an explicit, allowed
 * degeneration to single sampling; n2 must then be 0.
 */
export function validatePlan(input: PlanInput): DoublePlan {
  const fields = ['N', 'n1', 'n2', 'ac1', 're1', 'ac2', 're2'] as const;
  for (const f of fields) {
    if (!isInteger(input[f])) {
      throw new AppError('VALIDATION_ERROR', `field ${f} must be an integer`, {
        field: f,
        value: input[f],
      });
    }
  }
  const { N, n1, n2, ac1, re1, ac2, re2 } = input as Record<
    (typeof fields)[number],
    number
  >;

  if (N < 1) throw new AppError('INVALID_THRESHOLDS', 'N must be >= 1');
  if (n1 < 1) throw new AppError('INVALID_THRESHOLDS', 'n1 must be >= 1');
  if (n1 > N)
    throw new AppError('SAMPLE_EXCEEDS_LOT', 'first sample n1 exceeds lot N', {
      n1,
      N,
    });
  if (ac1 < 0)
    throw new AppError('INVALID_THRESHOLDS', 'ac1 must be >= 0');
  if (re1 <= ac1)
    throw new AppError('INVALID_THRESHOLDS', 're1 must be > ac1', {
      ac1,
      re1,
    });

  const single = re1 === ac1 + 1;
  if (single) {
    if (n2 !== 0)
      throw new AppError(
        'INVALID_THRESHOLDS',
        'empty continue region requires n2 = 0 (degenerate single sampling)',
        { n2 },
      );
    return { N, n1, n2: 0, ac1, re1, ac2: ac1, re2: re1 };
  }

  // Genuine double sampling.
  if (n2 < 1)
    throw new AppError('INVALID_THRESHOLDS', 'n2 must be >= 1', { n2 });
  if (n1 + n2 > N)
    throw new AppError(
      'SAMPLE_EXCEEDS_LOT',
      'n1 + n2 exceeds lot N (both samples drawn without replacement)',
      { n1, n2, N },
    );
  if (ac2 < re1 - 1)
    throw new AppError(
      'INVALID_THRESHOLDS',
      'ac2 must be >= re1 - 1 so a continued lot can still be accepted',
      { ac2, re1 },
    );
  if (re2 !== ac2 + 1)
    throw new AppError(
      'INVALID_THRESHOLDS',
      're2 must equal ac2 + 1 so the second stage always reaches a decision',
      { ac2, re2 },
    );
  if (ac2 > re1 - 1 + n2)
    throw new AppError(
      'INVALID_THRESHOLDS',
      'ac2 unreachable: even zero second-stage defects cannot exceed it',
      { ac2, re1, n2 },
    );
  return { N, n1, n2, ac1, re1, ac2, re2 };
}

export function isDegenerate(plan: DoublePlan): boolean {
  return plan.n2 === 0;
}
