/**
 * Base class for errors whose message is safe to show to API clients. Anything that is not
 * an AppError is treated as unexpected: logged in full, returned as a generic 500.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, publicMessage: string, options?: ErrorOptions) {
    super(publicMessage, options);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, "NOT_FOUND", message);
  }
}

export interface ErrorBody {
  error: { code: string; message: string };
}
