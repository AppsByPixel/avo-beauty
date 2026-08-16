/**
 * Error responses.
 *
 * Two rules, both of them Lane D findings:
 *
 * 1. BAD INPUT IS A 400 THE CLIENT CAN ACT ON, NOT A 500. A fractional
 *    `amountFils` reaching `fils()` throws a TypeError; if that escapes, the
 *    caller gets a 500 and a message written for whoever wrote the money helper.
 *    Every boundary validates first and answers with a code and a sentence a
 *    scanner can render.
 *
 * 2. AN INTERNAL EXCEPTION MESSAGE NEVER REACHES THE CALLER. The error handler
 *    at the bottom of this file logs the real error and returns a fixed body.
 *    "Money must be an integer number of fils" tells an attacker the shape of
 *    the money layer; more importantly it tells the customer nothing.
 *
 * The `error` string is the contract — packages/mock and the clients switch on
 * it. The `message` is display copy, taken from the design files where the
 * design specifies it.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * An error that is safe to show a caller. Anything thrown that is NOT one of
 * these is treated as a bug and flattened to a 500 with no detail.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  /** Extra fields merged into the body — the 402's shortfall, for instance. */
  readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  toBody(): Record<string, unknown> {
    return { error: this.code, message: this.message, ...this.details };
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(400, code, message, details);

export const unauthorized = (message = 'Sign in to continue.', code = 'unauthorized') =>
  new ApiError(401, code, message);

/**
 * The 403 copy names who can grant the permission — design/AVO Staff Scanner.dc.html,
 * locked state. Lane D asserts on that phrasing, and the scanner renders it verbatim.
 */
export const forbidden = (message: string) => new ApiError(403, 'forbidden', message);

export const notFound = (code: string, message: string) => new ApiError(404, code, message);

export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, message, details);

/** 410 Gone — the wallet token is consumed, expired or unknown. */
export const gone = (code: string, message: string) => new ApiError(410, code, message);

export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(422, code, message, details);

export const tooManyRequests = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(429, code, message, details);

// ------------------------------------------------------------ named errors --

/** Non-negotiable #4. The same body on every money-moving POST. */
export const idempotencyKeyRequired = () =>
  badRequest(
    'idempotency_key_required',
    'Every money-moving POST needs an Idempotency-Key header.',
  );

/** 402 with the exact shortfall — api-contract.md § Charging. */
export function insufficientBalance(dueFils: number, balanceFils: number): ApiError {
  return new ApiError(402, 'insufficient_balance', 'Balance too low.', {
    shortfallFils: dueFils - balanceFils,
    balanceFils,
    dueFils,
  });
}

export const tokenConsumedOrUnknown = () =>
  gone(
    'token_consumed_or_unknown',
    'That code has already been used. Ask the customer to show a fresh one.',
  );

export const tokenExpired = () =>
  gone('token_expired', 'That code expired. Ask the customer to show a fresh one.');

// ------------------------------------------------------------- the handler --

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ApiError) {
      req.log.info({ code: err.code, status: err.statusCode }, 'request refused');
      return reply.code(err.statusCode).send(err.toBody());
    }

    // Fastify's own schema/parse failures arrive with a statusCode already.
    const status = (err as { statusCode?: number })?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status).send({
        error: 'bad_request',
        message: 'That request could not be read. Check the fields and try again.',
      });
    }

    // Anything else is a bug. Log it in full; tell the caller nothing.
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: 'server_error', message: 'Something went wrong on our side.' });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: 'not_found', message: 'No such endpoint.' }),
  );
}
