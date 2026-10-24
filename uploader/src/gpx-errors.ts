// Codes/counts only: never retain XML values, parser causes, paths or worker messages.
export class GpxError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly invalidPoints?: number;

  constructor(code: string, statusCode = 422, invalidPoints?: number) {
    super(code);
    this.name = 'GpxError';
    this.code = code;
    this.statusCode = statusCode;
    if (invalidPoints !== undefined) this.invalidPoints = invalidPoints;
  }
}
