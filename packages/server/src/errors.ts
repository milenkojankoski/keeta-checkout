/**
 * API errors, shaped like the ones merchants already handle from Stripe:
 *
 * ```json
 * { "error": { "type": "invalid_request_error", "code": "AMOUNT_NOT_POSITIVE",
 *              "message": "amount must be greater than zero", "param": "amount" } }
 * ```
 *
 * Every error that reaches a client goes through {@link CheckoutError}, so no
 * stack trace, SQL fragment or internal path is ever serialised into a response.
 */

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'not_found_error'
  | 'conflict_error'
  | 'rate_limit_error'
  | 'api_error';

const STATUS_BY_TYPE: Record<ErrorType, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  not_found_error: 404,
  conflict_error: 409,
  rate_limit_error: 429,
  api_error: 500
};

export interface SerialisedError {
  error: {
    type: ErrorType;
    code: string;
    message: string;
    param?: string;
  };
}

export class CheckoutError extends Error {
  override readonly name = 'CheckoutError';

  constructor(
    readonly type: ErrorType,
    readonly code: string,
    message: string,
    /** The request field at fault, when there is one. */
    readonly param?: string
  ) {
    super(message);
  }

  get status(): number {
    return STATUS_BY_TYPE[this.type];
  }

  toJSON(): SerialisedError {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        ...(this.param === undefined ? {} : { param: this.param })
      }
    };
  }

  static invalid(code: string, message: string, param?: string): CheckoutError {
    return new CheckoutError('invalid_request_error', code, message, param);
  }

  static unauthorized(message = 'a valid API key is required'): CheckoutError {
    return new CheckoutError('authentication_error', 'UNAUTHORIZED', message);
  }

  static notFound(message: string): CheckoutError {
    return new CheckoutError('not_found_error', 'NOT_FOUND', message);
  }

  static conflict(code: string, message: string): CheckoutError {
    return new CheckoutError('conflict_error', code, message);
  }

  /**
   * 429. The `rate_limit_error` type has existed since the error shapes were
   * settled, because merchants expect it from a payments API; this is the first
   * caller, the cap on concurrent event streams per session.
   */
  static tooManyRequests(code: string, message: string): CheckoutError {
    return new CheckoutError('rate_limit_error', code, message);
  }

  static internal(message = 'the server could not complete this request'): CheckoutError {
    return new CheckoutError('api_error', 'INTERNAL', message);
  }
}
