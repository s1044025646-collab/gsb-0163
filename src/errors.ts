export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_THRESHOLDS'
  | 'SAMPLE_EXCEEDS_LOT'
  | 'IMPOSSIBLE_OBSERVATION'
  | 'PLAN_NOT_FOUND'
  | 'RECORD_NOT_FOUND'
  | 'DECISION_FINAL'
  | 'NOT_POSSIBLE'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function fail(code: ErrorCode, message: string, details?: unknown): never {
  throw new AppError(code, message, details);
}
