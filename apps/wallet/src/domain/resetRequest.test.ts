/**
 * The reset-request classifier's spec — and the anti-enumeration property,
 * asserted structurally.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { resetRequestRefusal } from './resetRequest';

describe('the throttle is the flow working, not failing', () => {
  it("renders the server's own sentence, not an our-side failure", () => {
    const err = new ApiError(
      'server',
      'Too many attempts. Wait a moment and try again.',
      'WLT-1-1',
      429,
      'reset_rate_limited',
    );
    const refusal = resetRequestRefusal(err);
    expect(refusal).toEqual({
      kind: 'throttled',
      message: 'Too many attempts. Wait a moment and try again.',
    });
  });

  it('treats both throttle codes identically', () => {
    for (const code of ['reset_hourly_limit', 'reset_rate_limited']) {
      const err = new ApiError('server', 'Too many.', 'WLT-2-2', 429, code);
      expect(resetRequestRefusal(err).kind).toBe('throttled');
    }
  });

  it('classifies a 429 by status even if the code were lost in transit', () => {
    const err = new ApiError('server', 'Too many.', 'WLT-3-3', 429, null);
    expect(resetRequestRefusal(err).kind).toBe('throttled');
  });

  /**
   * THE ORDER IS THE SPEC. A proxy answering 503 with a throttle code must not
   * read as a dead connection — same collision orderRefusal.ts pins for
   * invalid_products, same reason.
   */
  it('stays throttled even when the transport kind says offline', () => {
    const err = new ApiError('offline', 'Too many.', 'WLT-4-4', 503, 'reset_rate_limited');
    expect(resetRequestRefusal(err).kind).toBe('throttled');
  });
});

describe('the other three', () => {
  it('her connection is offline, with nothing else attached', () => {
    const err = new ApiError('offline', 'No connection.', 'WLT-5-5', null);
    expect(resetRequestRefusal(err)).toEqual({ kind: 'offline' });
  });

  it("a malformed phone is her field to fix, in the server's words", () => {
    const err = new ApiError(
      'server',
      'Enter the phone number in international format.',
      'WLT-6-6',
      400,
      'invalid_phone',
    );
    const refusal = resetRequestRefusal(err);
    expect(refusal.kind).toBe('invalid');
  });

  it('anything else is ours, including a non-ApiError', () => {
    expect(resetRequestRefusal(new TypeError('x'))).toEqual({
      kind: 'failed',
      message: 'Something went wrong.',
    });
    const server = resetRequestRefusal(new ApiError('server', 'Boom.', 'WLT-7-7', 500));
    expect(server).toEqual({ kind: 'failed', message: 'Boom.' });
  });
});

describe('anti-enumeration, structurally', () => {
  /**
   * The union must stay incapable of expressing "that phone has no account".
   * The server erased the distinction on the wire; a client-side member for it
   * would be the hole waiting for a helpful branch. This walks every kind the
   * classifier can produce and asserts none of them is phone-existence-shaped.
   */
  it('has no member that could carry "unknown phone"', () => {
    const everyKind = [
      resetRequestRefusal(new ApiError('server', 'x', 'r', 429, 'reset_rate_limited')).kind,
      resetRequestRefusal(new ApiError('server', 'x', 'r', 400, 'invalid_phone')).kind,
      resetRequestRefusal(new ApiError('offline', 'x', 'r', null)).kind,
      resetRequestRefusal(new Error('x')).kind,
    ];
    expect(everyKind.sort()).toEqual(['failed', 'invalid', 'offline', 'throttled']);
    for (const k of everyKind) {
      expect(k).not.toMatch(/unknown|not_?found|no_?such|missing/i);
    }
  });
});
