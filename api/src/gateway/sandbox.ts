/**
 * The sandbox driver — a PSP that does what you tell it to.
 *
 * It implements `PaymentGateway` exactly as a real processor's adapter will, and
 * it is the only file that knows the sandbox exists. Two properties matter more
 * than the simulation:
 *
 * 1. IT KEEPS ITS STATE IN A TABLE, NOT A MAP. `sandbox_gateway_payment` stands
 *    in for the processor's own records. A `Map` would make every concurrency
 *    demonstration in this phase a property of running one Node process — which
 *    is the exact criticism Lane D levelled at the mock's idempotency layer.
 *
 * 2. IT REALLY SIGNS ITS CALLBACKS. `verifySignature` is not a stub returning
 *    `true`. The sandbox computes an HMAC over the raw body the same way a
 *    processor does, so the verification path is exercised from day one rather
 *    than written for the first time on the morning the real PSP is connected.
 *    A webhook that trusts its payload is an unauthenticated credit endpoint.
 *
 * Every outcome is reachable on demand — success, declined, cancelled, pending
 * and gateway error — through the hosted page (`POST /_gateway/:ref`) or an
 * `x-avo-scenario` hint. In both cases the outcome is WRITTEN to the payment row
 * first and then READ back, so what the API reports is always an honest read of
 * gateway state and never a status the API invented for a caller.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { fils, type Fils } from '@avo/types';
import { db } from '../db/client';
import { sandboxGatewayPayment } from '../db/schema/sandboxGateway';
import { env } from '../env';
import {
  GatewayEventMalformedError,
  GatewayUnavailableError,
  type CreatePaymentInput,
  type CreatedPayment,
  type FetchOptions,
  type GatewayEventPayload,
  type GatewayOutcome,
  type GatewayPaymentState,
  type PaymentGateway,
} from './types';

const OUTCOMES: GatewayOutcome[] = [
  'succeeded',
  'declined',
  'cancelled',
  'pending',
  'gateway_error',
];

export function isGatewayOutcome(value: unknown): value is GatewayOutcome {
  return typeof value === 'string' && (OUTCOMES as string[]).includes(value);
}

/** `x-avo-signature: t=1755380000,v1=<hex>`, the shape most processors use. */
export const SIGNATURE_HEADER = 'x-avo-signature';

/**
 * Sign `${timestamp}.${rawBody}` rather than the body alone.
 *
 * Binding the timestamp into the MAC is what makes the freshness window a
 * control: a captured callback replayed tomorrow carries yesterday's `t`, and
 * moving `t` forward invalidates the signature. Signing the body alone lets an
 * attacker replay it forever with a fresh header.
 */
export function signGatewayPayload(rawBody: string, timestampSeconds: number): string {
  const mac = createHmac('sha256', env.gatewayWebhookSecret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

function parseSignatureHeader(header: string): { t: number; v1: string } | null {
  const parts = header.split(',').map((p) => p.trim());
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (name === 't') t = Number(value);
    if (name === 'v1') v1 = value;
  }
  if (t === null || !Number.isFinite(t) || !v1) return null;
  return { t, v1 };
}

function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export class SandboxGateway implements PaymentGateway {
  readonly provider = 'sandbox';

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    // The sandbox's own failure mode, so `POST /topups` can be shown refusing
    // when the processor is unreachable rather than issuing an intent with no
    // payment behind it.
    if (input.intentId.endsWith('-GWFAIL')) {
      throw new GatewayUnavailableError('sandbox: createPayment was told to fail');
    }

    const pspReference = `SBX-${randomBytes(6).toString('hex').toUpperCase()}`;

    await db.insert(sandboxGatewayPayment).values({
      pspReference,
      intentId: input.intentId,
      amountFils: input.amountFils,
      method: input.method,
      outcome: 'succeeded',
    });

    const redirectUrl = new URL(`/_gateway/${pspReference}`, env.publicBaseUrl);
    redirectUrl.searchParams.set('return', input.returnUrl);
    return { pspReference, redirectUrl: redirectUrl.toString() };
  }

  async fetchPayment(
    pspReference: string,
    options: FetchOptions = {},
  ): Promise<GatewayPaymentState> {
    // A hint WRITES the outcome and then reads it back. The read below is the
    // same read an un-hinted call makes, which is what keeps this honest: the
    // API never reports a status it did not read from the gateway's records.
    if (options.simulate) {
      await this.setOutcome(pspReference, options.simulate);
    }

    const rows = await db
      .select()
      .from(sandboxGatewayPayment)
      .where(eq(sandboxGatewayPayment.pspReference, pspReference))
      .limit(1);

    const row = rows[0];
    if (!row) {
      // A real processor 404s a reference it never issued. Treating that as
      // "not succeeded yet" would be a guess; it is an operational fault.
      throw new GatewayUnavailableError(`sandbox: no payment ${pspReference}`);
    }
    if (!isGatewayOutcome(row.outcome)) {
      throw new GatewayUnavailableError(`sandbox: unreadable outcome ${row.outcome}`);
    }

    return {
      pspReference: row.pspReference,
      outcome: row.outcome,
      amountFils: fils(row.amountFils),
    };
  }

  verifySignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const raw = headers[SIGNATURE_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (!header) return false;

    const parsed = parseSignatureHeader(header);
    if (!parsed) return false;

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - parsed.t);
    if (ageSeconds > env.gatewayWebhookToleranceSeconds) return false;

    const expected = createHmac('sha256', env.gatewayWebhookSecret)
      .update(`${parsed.t}.${rawBody}`)
      .digest('hex');

    return hexEqual(expected, parsed.v1);
  }

  parseEvent(payload: unknown): GatewayEventPayload {
    const body = payload as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      throw new GatewayEventMalformedError('callback body is not an object');
    }

    const eventId = body.eventId;
    const pspReference = body.pspReference;
    const status = body.status;
    const amountFils = body.amountFils;

    if (typeof eventId !== 'string' || eventId === '') {
      throw new GatewayEventMalformedError('callback has no eventId');
    }
    if (typeof pspReference !== 'string' || pspReference === '') {
      throw new GatewayEventMalformedError('callback has no pspReference');
    }
    if (!isGatewayOutcome(status)) {
      throw new GatewayEventMalformedError(`callback status is not one we know: ${String(status)}`);
    }
    if (typeof amountFils !== 'number' || !Number.isInteger(amountFils) || amountFils <= 0) {
      throw new GatewayEventMalformedError('callback amountFils is not a whole number of fils');
    }

    return {
      eventId,
      pspReference,
      outcome: status,
      amountFils: fils(amountFils),
      reportedStatus: status,
    };
  }

  // ------------------------------------------------- sandbox-only controls --
  // Used by the hosted page in routes/sandboxGateway.ts. Not part of
  // `PaymentGateway`: a real adapter cannot make a processor decline on request.

  /** Drive a payment to an outcome, as a customer completing the hosted page would. */
  async setOutcome(pspReference: string, outcome: GatewayOutcome): Promise<void> {
    await db
      .update(sandboxGatewayPayment)
      .set({ outcome, updatedAt: new Date() })
      .where(eq(sandboxGatewayPayment.pspReference, pspReference));
  }

  async readPayment(
    pspReference: string,
  ): Promise<{ pspReference: string; intentId: string; amountFils: Fils; outcome: string } | null> {
    const rows = await db
      .select()
      .from(sandboxGatewayPayment)
      .where(eq(sandboxGatewayPayment.pspReference, pspReference))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      pspReference: row.pspReference,
      intentId: row.intentId,
      amountFils: fils(row.amountFils),
      outcome: row.outcome,
    };
  }
}
