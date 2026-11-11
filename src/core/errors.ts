export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function requireCondition(value: unknown, code: string, message: string, status = 400): asserts value {
  if (!value) throw new AppError(code, message, status);
}
