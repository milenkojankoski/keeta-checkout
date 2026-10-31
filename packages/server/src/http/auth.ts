/**
 * Bearer API-key authentication for the merchant routes.
 *
 * Two access levels, and the split matters:
 *
 * - **Merchant routes** (create a session, list tokens, read the merchant view)
 *   need an API key. That key can create and read sessions. It cannot move funds:
 *   the server holds no signing key at all.
 * - **Payer routes** (read one session's status, its event stream, cancel it) are
 *   authorised by holding the session id, which carries 128 random bits. A browser
 *   cannot keep a secret, so the pay button could not use a key even if we wanted
 *   it to.
 *
 * Keys are compared with `timingSafeEqual` over SHA-256 digests. Hashing first
 * means the comparison is over equal-length buffers, so a wrong key's *length* does
 * not leak through timing either.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { CheckoutError } from '../errors.ts';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Extract a bearer token from an Authorization header. */
function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

export interface ApiKeyAuthOptions {
  apiKeys: readonly string[];
}

/**
 * Middleware that rejects any request without a configured API key.
 *
 * Every candidate key is compared even after a match, so the time taken does not
 * reveal which key matched or how many keys are configured.
 */
export function requireApiKey(options: ApiKeyAuthOptions): RequestHandler {
  const expected = options.apiKeys.map(digest);

  return function apiKeyAuth(req: Request, _res: Response, next: NextFunction): void {
    const presented = bearerToken(req.get('authorization'));
    if (presented === undefined || presented === '') {
      next(CheckoutError.unauthorized('an Authorization: Bearer <api key> header is required'));
      return;
    }

    const candidate = digest(presented);
    let matched = false;
    for (const key of expected) {
      if (timingSafeEqual(candidate, key)) matched = true;
    }

    next(matched ? undefined : CheckoutError.unauthorized('the API key is not recognised'));
  };
}
