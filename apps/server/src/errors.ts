import type { LimitCode } from "@whiteboard/shared/entitlements";

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

export class BadRequestError extends AppError {
  constructor(message = "Invalid request") {
    super(400, "BAD_REQUEST", message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Please sign in to continue.") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You don't have permission to do that.") {
    super(403, "FORBIDDEN", message);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, "CONFLICT", message);
  }
}

/**
 * The feature needs to read the board, and this board is end-to-end encrypted: the server
 * can't (and must not try to). The message tells the user why.
 */
export class PrivateBoardError extends AppError {
  constructor(message: string) {
    super(409, "PRIVATE_BOARD", message);
  }
}

export interface ErrorBody {
  error: { code: string; message: string };
}

/** The caller's plan doesn't include this, or its allowance is used up (upgrade prompt). */
export class PaymentRequiredError extends AppError {
  constructor(code: LimitCode, message: string) {
    super(402, code, message);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(code: string, message: string) {
    super(429, code, message);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string) {
    super(413, "TOO_LARGE", message);
  }
}

export class UnprocessableError extends AppError {
  constructor(code: string, message: string) {
    super(422, code, message);
  }
}

/** A dependency is switched off or unavailable (AI disabled, spend limit reached, ...). */
export class ServiceUnavailableError extends AppError {
  constructor(code: string, message: string) {
    super(503, code, message);
  }
}
