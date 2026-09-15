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
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { poolOptionsFor } from '../db/poolOptions';
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

/**
 * =========================================================================
 * THE SANDBOX HAS ITS OWN CONNECTION, BECAUSE IT IS PRETENDING TO BE ANOTHER
 * SYSTEM AND ANOTHER SYSTEM HAS ITS OWN CONNECTION.
 * =========================================================================
 * This used to be `import { db } from '../db/client'` — the APPLICATION pool.
 * That import is what made `POST /topups` unable to answer on the deployed
 * demo, and the mechanism is worth stating exactly, because the shape recurs.
 *
 * `services/topup.ts` § createTopUp calls `gateway.createPayment` from INSIDE
 * `db.transaction(...)`, deliberately, so a failed gateway leg rolls the
 * idempotency key back rather than burning it. A `db.transaction()` RESERVES a
 * connection for its whole life. So the insert below asked the SAME pool for a
 * SECOND connection while the first was still held by the caller's own
 * transaction. Under `DB_POOL_MODE=serverless` — `{ max: 1 }` — there is no
 * second connection and there never will be, because the only one cannot come
 * free until a transaction that is itself waiting on this insert commits.
 *
 * MEASURED, against a real database, three seconds into the hang:
 *
 *     pid  |        state        | wait_event_type | wait_event | xact_age_s
 *    ------+---------------------+-----------------+------------+-----------
 *    17406 | idle in transaction | Client          | ClientRead |       3.07
 *
 * ONE connection, `idle in transaction`, parked on `ClientRead`, its last
 * statement the `insert into "topup_intent"` immediately above this call. The
 * insert below never reached the database at all — it sat in postgres.js's own
 * queue. That is why POSTGRES NEVER BREAKS IT: there is no lock cycle for the
 * deadlock detector to find, no `deadlock_detected`, no rollback. From the
 * database's side one client is simply not talking. `GATEWAY_TIMEOUT_MS` is the
 * only thing that ends it, which is why the symptom is a flat 8s `502
 * gateway_unavailable` naming nothing to do with connections.
 *
 * WHY A SEPARATE POOL AND NOT THE CALLER'S `tx`. Threading the caller's
 * executor through `PaymentGateway` is the obvious repair and it is the wrong
 * one. `gateway/myfatoorah.ts` touches no database whatsoever — it makes an
 * HTTP call — so it would take a Drizzle executor solely to ignore it, and the
 * seam would then advertise to the next adapter's author that a processor is
 * expected to write to OUR database. Worse, it would make the sandbox's payment
 * atomic with our intent, which is a property NO real processor can offer:
 * every caller above the seam would be written against an atomicity that
 * evaporates the day `GATEWAY_DRIVER=myfatoorah` is set. A stand-in that is
 * more transactional than the thing it stands in for is not a better test
 * double, it is a worse one.
 *
 * So the sandbox keeps its records where a processor keeps them — somewhere
 * this application's transactions do not reach. Same database and same role
 * (nothing here escalates privilege); a DIFFERENT pool, so the connection this
 * insert needs is never the connection the caller is holding.
 *
 * SHAPED BY THE SAME KNOB, on purpose. `poolOptionsFor(env.dbPoolMode)` gives
 * this pool `prepare: false` under `serverless` too — against a transaction-mode
 * pooler a named prepared statement does not error, it HANGS (db/poolOptions.ts
 * measured it), and a sandbox that hung would have replaced one 8s timeout with
 * another. `max: 1` here is harmless where it was fatal there: nothing in this
 * file opens a transaction, so two concurrent top-ups queue for a moment rather
 * than starving.
 *
 * LAZY, so that selecting `myfatoorah` costs nothing. `gateway/index.ts` imports
 * this module either way; a pool built at module load would be a second idle
 * connection in every deployment that does not use the sandbox — and production
 * is always one of those, since `env.ts` refuses `GATEWAY_DRIVER=sandbox` there.
 */
let storeSql: ReturnType<typeof postgres> | null = null;
let store: ReturnType<typeof drizzle> | null = null;

function sandboxStore(): NonNullable<typeof store> {
  if (!store) {
    storeSql = postgres(env.appDatabaseUrl, poolOptionsFor(env.dbPoolMode));
    store = drizzle(storeSql);
  }
  return store;
}

/**
 * Release the sandbox's connection. For test teardown and nothing else — a
 * long-running server holds it for its life, exactly as it holds the app pool.
 * Safe to call when no pool was ever built, which is the common case.
 */
export async function closeSandboxStore(): Promise<void> {
  const open = storeSql;
  storeSql = null;
  store = null;
  if (open) await open.end({ timeout: 5 });
}

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

    await sandboxStore().insert(sandboxGatewayPayment).values({
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

    const rows = await sandboxStore()
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
    await sandboxStore()
      .update(sandboxGatewayPayment)
      .set({ outcome, updatedAt: new Date() })
      .where(eq(sandboxGatewayPayment.pspReference, pspReference));
  }

  async readPayment(
    pspReference: string,
  ): Promise<{ pspReference: string; intentId: string; amountFils: Fils; outcome: string } | null> {
    const rows = await sandboxStore()
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
