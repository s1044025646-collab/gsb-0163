import type { DoublePlan, PlanInput } from './model/plan.js';

export interface Fixture {
  name: string;
  description: string;
  plan: PlanInput;
  /** assumed true defective counts to evaluate */
  scenarios: {
    label: string;
    K?: number;
    d1: number;
    d2?: number;
    expect: 'ACCEPT' | 'REJECT' | 'CONTINUE';
  }[];
}

export const FIXTURES: Fixture[] = [
  {
    name: 'standard-double',
    description: 'Classic N=100 double-sampling plan with a real continue region.',
    plan: { N: 100, n1: 20, n2: 30, ac1: 1, re1: 4, ac2: 4, re2: 5 },
    scenarios: [
      { label: 'all-conforming lot (K=0)', K: 0, d1: 0, expect: 'ACCEPT' },
      { label: 'all-defective lot (K=100)', K: 100, d1: 20, expect: 'REJECT' },
      { label: 'continue then accept', K: 10, d1: 2, d2: 1, expect: 'ACCEPT' },
      { label: 'continue then reject', K: 40, d1: 3, d2: 6, expect: 'REJECT' },
      { label: 'boundary first accept d1=ac1', K: 5, d1: 1, expect: 'ACCEPT' },
      { label: 'boundary first reject d1=re1', K: 30, d1: 4, expect: 'REJECT' },
    ],
  },
  {
    name: 'zero-continue-single',
    description:
      'Empty continue region (re1=ac1+1): explicit degeneration to single sampling.',
    plan: { N: 50, n1: 10, n2: 0, ac1: 2, re1: 3, ac2: 2, re2: 3 },
    scenarios: [
      { label: 'accept boundary d1=2', K: 5, d1: 2, expect: 'ACCEPT' },
      { label: 'reject boundary d1=3', K: 20, d1: 3, expect: 'REJECT' },
    ],
  },
  {
    name: 'whole-lot-sampled',
    description: 'n1+n2 equals N: both stages together inspect the full lot.',
    plan: { N: 20, n1: 8, n2: 12, ac1: 1, re1: 4, ac2: 5, re2: 6 },
    scenarios: [
      { label: 'exact full-lot decision', K: 6, d1: 3, d2: 3, expect: 'REJECT' },
    ],
  },
  {
    name: 'tiny-enumerable',
    description: 'Small lot fully enumerable for independent combinatoric checks.',
    plan: { N: 8, n1: 3, n2: 3, ac1: 0, re1: 2, ac2: 2, re2: 3 },
    scenarios: [
      { label: 'K=0 accept', K: 0, d1: 0, expect: 'ACCEPT' },
      { label: 'K=8 reject', K: 8, d1: 3, expect: 'REJECT' },
      { label: 'continue path', K: 4, d1: 1, d2: 2, expect: 'ACCEPT' },
    ],
  },
  {
    name: 'rare-event',
    description:
      'Very low defective proportion in a large lot (extreme-tail hypergeometric).',
    plan: { N: 100000, n1: 200, n2: 400, ac1: 1, re1: 6, ac2: 7, re2: 8 },
    scenarios: [
      { label: 'K=5 rare defects', K: 5, d1: 0, expect: 'ACCEPT' },
      { label: 'K=2000 poor lot', K: 2000, d1: 30, expect: 'REJECT' },
    ],
  },
];

export function planOf(f: Fixture): DoublePlan {
  return f.plan as DoublePlan;
}
