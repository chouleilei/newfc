/** 统一业务错误结构(方案十一.2) */

export type RowError = { row: number; field: string; message: string };

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public errors?: RowError[],
    public details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  notFound: (what: string) => new AppError('NOT_FOUND', `${what}不存在`, 404),
  validation: (message: string, errors?: RowError[]) =>
    new AppError(errors && errors.length ? 'IMPORT_VALIDATION_FAILED' : 'VALIDATION_FAILED', message, 400, errors),
  conflict: (message: string) => new AppError('CONFLICT', message, 409),
  forbidden: (message: string) => new AppError('FORBIDDEN', message, 403),
  importValidation: (message: string, errors: RowError[]) =>
    new AppError('IMPORT_VALIDATION_FAILED', message, 400, errors),
};

export function errorBody(err: AppError): Record<string, unknown> {
  const body: Record<string, unknown> = { code: err.code, message: err.message };
  if (err.errors) body.errors = err.errors;
  if (err.details !== undefined) body.details = err.details;
  return body;
}
