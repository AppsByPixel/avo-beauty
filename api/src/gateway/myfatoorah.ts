/**
 * The real MyFatoorah driver. `GATEWAY_DRIVER=myfatoorah`.
 *
 * WHAT THIS IS AND IS NOT THE DEFAULT
 * -----------------------------------
 * The sandbox driver stays the default for tests and CI, deliberately. `e2e/`
 * must be deterministic and offline: `gateway.test.ts`'s duplicate and
 * out-of-order callback specs describe orderings that a third-party network
 * service cannot be asked to produce on cue, and an unreliable green is worse
 * than no green. This driver is selected explicitly, by an operator, and it is
 * exercised deliberately against `apitest.myfatoorah.com`.
 *
 * NOTHING ABOUT THE CREDIT PATH CHANGES. Non-negotiable #2 and the phase 2
 * criterion both say the wallet is credited only after a SERVER READ of payment
 * status — never from the redirect, never from a callback body. That rule lives
 * in services/topup.ts and this file does not touch it. `fetchPayment` is the
 * read; `parseEvent` normalises a callback into the same vocabulary and the
 * webhook is a latency optimisation on top of the read, not a second source of
 * truth.
 *
 * THE CALL SEQUENCE, verified against the live test environment rather than read
 * off a summary:
 *
 *   POST /v2/InitiatePayment    → the account's enabled methods, so a
 *                                 `PaymentMethodId` is looked up rather than
 *                                 guessed. KWT sandbox answers kn=1, vm=2, ap=11.
 *   POST /v2/ExecutePayment     → `Data.InvoiceId` and `Data.PaymentURL`.
 *   POST /v2/GetPaymentStatus   → `{ Key, KeyType: 'InvoiceId' }`, the
 *                                 authoritative read.
 *
 * `Data.InvoiceId` is our `pspReference`. That choice is not arbitrary: it is
 * also the field MyFatoorah signs its webhooks over (`Invoice.Id`), so the
 * callback and the read key off the same identifier and a mismatch between them
 * is impossible by construction.
 *
 * THREE THINGS THAT SURPRISED ME, ALL VERIFIED LIVE
 * -------------------------------------------------
 * 1. `CallBackUrl` MUST BE HTTP(S). Sending the design's deep link
 *    `avo://topup/return?intent=…` is refused outright:
 *
 *        "The field CallBackUrl must be a url. Example http://www.example.com"
 *
 *    So `TOPUP_RETURN_URL` cannot be handed to this processor. The driver
 *    requires `MYFATOORAH_RETURN_URL` — an https URL AVO owns — and carries the
 *    deep link along in `to=` for whatever serves it to forward. Where that URL
 *    is hosted is an infrastructure decision, not one to invent here, and the
 *    driver refuses to boot without it rather than sending a URL that 404s.
 *
 * 2. NO DIRECT PAYMENT ON THIS ACCOUNT. Every method the sandbox returns has
 *    `IsDirectPayment: false`, so a payment can only be completed on the hosted
 *    page by a human. There is no API call that marks a test invoice paid.
 *
 * 3. THEIR STATUS VOCABULARY CONTAINS TYPOS AND THEY ARE LOAD-BEARING.
 *    `TransactionStatus` is documented and returned as `"Succss"`, and the
 *    transaction amount field is `"TransationValue"`. Both are matched as
 *    spelled — and the correct spellings are accepted too, because the day they
 *    fix it must not be the day top-ups stop settling.
 *
 * WHAT THEIR SIGNATURE SCHEME DOES NOT PROTECT — READ THIS BEFORE TRUSTING IT
 * --------------------------------------------------------------------------
 * The sandbox driver signs `${timestamp}.${rawBody}`, which makes its freshness
 * window a real control. MyFatoorah's scheme signs a fixed list of IDENTITY
 * fields and nothing else:
 *
 *   Invoice.Id, Invoice.Status, Transaction.Status, Transaction.PaymentId,
 *   Invoice.ExternalIdentifier
 *
 * Two consequences, neither of which is a reason not to verify, both of which
 * are reasons not to lean on verification alone:
 *
 *   * THERE IS NO TIMESTAMP IN THE MAC, so a captured callback replays forever.
 *   * `Event.Reference` — the per-delivery id, and therefore OUR `eventId` — IS
 *     NOT SIGNED. An attacker replaying a captured body can change it freely and
 *     the signature still verifies, which defeats the `UNIQUE (provider,
 *     event_id)` dedupe on `gateway_event` completely.
 *
 * So under this processor the state machine in services/topup.ts is the
 * load-bearing duplicate guard, not the event index. That file says its two
 * guards are "two independent guards on the same failure"; with MyFatoorah one
 * of the two is forgeable, and the surviving one — `succeeded → succeeded` is
 * not a legal arrow — is what actually stops a replayed callback crediting
 * twice. Worth knowing before anyone simplifies it.
 *
 * MONEY: every amount crosses `money/kwd.ts` and nothing else. MyFatoorah speaks
 * decimal KWD, this system speaks integer fils, and that conversion is the
 * highest-risk line in the integration — see that file for why neither direction
 * multiplies.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Fils, PaymentMethod } from '@avo/types';
import { env } from '../env';
import { KwdConversionError, filsToKwd, positiveKwdToFils, requestBodyWithDecimal } from '../money/kwd';
import {
  GatewayEventMalformedError,
  GatewayEventUnsupportedError,
  GatewayUnavailableError,
  type CreatePaymentInput,
  type CreatedPayment,
  type GatewayEventPayload,
  type GatewayOutcome,
  type GatewayPaymentState,
  type PaymentGateway,
} from './types';

/** The header MyFatoorah puts its signature in. Node lower-cases header names. */
export const MYFATOORAH_SIGNATURE_HEADER = 'myfatoorah-signature';

/** The only event this integration acts on. */
const PAYMENT_STATUS_CHANGED = 'PAYMENT_STATUS_CHANGED';

/**
 * The signed field list, per event type, IN ORDER. Copied from
 * docs.myfatoorah.com/docs/webhook-v2-payment-status-data-model.md and
 * .../webhook-v2-refund-data-model.md, which give the exact strings:
 *
 *   Invoice.Id=6409988,Invoice.Status=PAID,Transaction.Status=SUCCESS,
 *   Transaction.PaymentId=07076409988323998875,
 *   Invoice.ExternalIdentifier=asdqwd-f13sdf-fasjkz
 *
 *   Refund.Id=111147,Refund.Status=REFUNDED,
 *   Amount.ValueInBaseCurrency=30,ReferencedInvoice.Id=5620277
 *
 * The refund order is here even though non-negotiable #5 means AVO never issues
 * a gateway refund — a `REFUND_STATUS_CHANGED` delivery would mean somebody
 * refunded through the portal, which is exactly the event that must be
 * VERIFIABLE and then loudly not acted on. Verifying it and ignoring it is a
 * different statement from being unable to read it.
 */
const SIGNED_FIELDS: Record<string, readonly string[]> = {
  PAYMENT_STATUS_CHANGED: [
    'Invoice.Id',
    'Invoice.Status',
    'Transaction.Status',
    'Transaction.PaymentId',
    'Invoice.ExternalIdentifier',
  ],
  REFUND_STATUS_CHANGED: [
    'Refund.Id',
    'Refund.Status',
    'Amount.ValueInBaseCurrency',
    'ReferencedInvoice.Id',
  ],
};

/**
 * Our `PaymentMethod` → MyFatoorah's `PaymentMethodCode`.
 *
 * The CODE, not the id. Ids are per-account configuration — the live Kuwait
 * sandbox answers kn=1, vm=2, ap=11 — but a white-label account with a different
 * set of gateways enabled answers differently, and a hardcoded `1` would
 * silently charge through whatever gateway happened to be first in someone
 * else's list.
 *
 * TOTAL over `PaymentMethod`, not a partial map, which is what makes adding a
 * fourth method a type error here rather than an `undefined` reaching
 * `ExecutePayment`. `wallet` is deliberately NOT in that union in
 * @avo/types — a wallet-funded movement never reaches a processor — so there is
 * nothing to exclude and no unreachable branch to write. The first draft of this
 * file guarded against `method === 'wallet'` and the compiler refused it; the
 * guard is gone rather than cast away.
 */
const METHOD_CODES: Record<PaymentMethod, string> = {
  knet: 'kn',
  card: 'vm',
  applepay: 'ap',
};

// -------------------------------------------------------------- their shapes --

interface MfEnvelope<T> {
  IsSuccess?: boolean;
  Message?: string;
  ValidationErrors?: { Name?: string; Error?: string }[] | null;
  Data?: T | null;
}

interface MfInitiateData {
  PaymentMethods?: {
    PaymentMethodId?: number;
    PaymentMethodCode?: string;
    PaymentMethodEn?: string;
  }[];
}

interface MfExecuteData {
  InvoiceId?: number;
  PaymentURL?: string;
}

interface MfStatusData {
  InvoiceId?: number;
  InvoiceStatus?: string;
  InvoiceValue?: number | string;
  InvoiceTransactions?: { TransactionStatus?: string }[];
}

// ------------------------------------------------------------- the outcomes --

/**
 * Their status vocabulary → ours. ONE function, used by both the read and the
 * callback, because those two must not be able to disagree about what "paid"
 * means. The webhook uses `PAID`/`SUCCESS` and the read uses `Paid`/`Succss`, so
 * both are upper-cased first and both spellings of every word are listed.
 *
 * THE ONE DECISION IN HERE, and it is a money decision.
 *
 * A FAILED TRANSACTION ON AN OPEN INVOICE IS `pending`, NOT `declined`.
 * MyFatoorah's `InvoiceStatus` is only ever `Pending`, `Paid` or `Canceled` — a
 * declined card leaves the invoice `Pending`, and the customer can still pay the
 * SAME `PaymentURL` until it expires. Reporting `declined` would drive our
 * intent to `failed`, which is terminal and has no arrow out of it; if she then
 * completed that invoice, MyFatoorah would hold her money against an intent this
 * system had already given up on and no read could ever credit it.
 *
 * So an open invoice reports open, which is what it is. `pending` is
 * non-negotiable-#2-safe (it credits nothing), it stays in `OPEN_STATUSES` so
 * every `GET /topups/{id}` re-reads it, and it settles the moment the invoice
 * really becomes `Paid` or `Canceled`. The cost is that the wallet shows
 * "pending" rather than "declined" for a bad card — a worse sentence, in
 * exchange for not being able to strand a real payment. She can start a new
 * top-up at any time; it is the intent that waits, not her.
 *
 * ANYTHING UNRECOGNISED THROWS. `readTopUp` catches that and returns the intent
 * unchanged, so an undocumented status is a loud log line and a top-up that
 * stays open — never a guess written into `failure_reason`.
 */
export function outcomeFor(
  invoiceStatus: string,
  transactionStatuses: readonly string[],
): GatewayOutcome {
  const invoice = invoiceStatus.trim().toUpperCase();
  const transactions = transactionStatuses.map((s) => s.trim().toUpperCase());

  if (invoice === 'PAID') return 'succeeded';
  if (invoice === 'CANCELED' || invoice === 'CANCELLED') return 'cancelled';

  if (invoice === 'PENDING') {
    // Authorised-not-captured. The seam's own description of `pending`.
    if (transactions.includes('AUTHORIZE') || transactions.includes('AUTHORISE')) return 'pending';
    // `Succss` is theirs, not a typo here. A successful transaction on an
    // invoice that has not flipped to Paid yet is settlement in flight.
    if (transactions.includes('SUCCSS') || transactions.includes('SUCCESS')) return 'pending';
    // Everything else on an open invoice — InProgress, Failed, Canceled, or no
    // attempt at all — is an invoice that is still open. See above.
    return 'pending';
  }

  throw new GatewayUnavailableError(
    `myfatoorah: unrecognised InvoiceStatus ${JSON.stringify(invoiceStatus)}. ` +
      'Refusing to map it — a guess here writes a wrong failure_reason or strands a real payment.',
  );
}

// ------------------------------------------------------------------ the driver --

export class MyFatoorahGateway implements PaymentGateway {
  readonly provider = 'myfatoorah';

  /**
   * `PaymentMethodCode` → `PaymentMethodId`, resolved once per process.
   *
   * A `Map` here, where the sandbox driver was explicitly built to keep its
   * state in a table instead. The difference is what the state IS: this caches
   * ACCOUNT CONFIGURATION read from the processor, not payment state. A stale
   * entry cannot mis-settle anything — a wrong id fails loudly at
   * `ExecutePayment` — and it is re-read on restart. The sandbox's payments were
   * a stand-in for the processor's own records, and holding those in a Map would
   * have made every concurrency demonstration a property of one Node process.
   */
  private methodIds = new Map<string, number>();

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    const methodId = await this.paymentMethodId(input.method, input.amountFils);

    /**
     * `InvoiceValue` is spliced in as a raw decimal that was never a JS number
     * — see money/kwd.ts. `DisplayCurrencyIso: 'KWD'` is explicit so the
     * processor cannot pick a currency from account defaults and hand back an
     * amount in a different one.
     *
     * `CustomerReference` and `UserDefinedField` both carry our intent id. Two
     * copies on purpose: `CustomerReference` is queryable
     * (`KeyType: 'CustomerReference'`) and `UserDefinedField` is what shows in
     * the portal's own invoice view, which is what "reconcilable by eye" in
     * gateway/types.ts asks for.
     */
    const body = requestBodyWithDecimal(
      {
        PaymentMethodId: methodId,
        DisplayCurrencyIso: 'KWD',
        Language: 'EN',
        CustomerReference: input.intentId,
        UserDefinedField: input.intentId,
        CallBackUrl: this.returnUrl(input),
        ErrorUrl: this.returnUrl(input),
      },
      'InvoiceValue',
      filsToKwd(input.amountFils),
    );

    const data = await this.post<MfExecuteData>('/v2/ExecutePayment', body);

    const invoiceId = data.InvoiceId;
    const paymentUrl = data.PaymentURL;
    if (typeof invoiceId !== 'number' || !Number.isInteger(invoiceId)) {
      throw new GatewayUnavailableError(
        `myfatoorah: ExecutePayment returned no usable InvoiceId (${JSON.stringify(invoiceId)})`,
      );
    }
    if (typeof paymentUrl !== 'string' || !/^https?:\/\//.test(paymentUrl)) {
      // `TopUpIntentSchema` requires an absolute URL, and a relative one would
      // reach the wallet as a link to nowhere.
      throw new GatewayUnavailableError('myfatoorah: ExecutePayment returned no absolute PaymentURL');
    }

    return { pspReference: String(invoiceId), redirectUrl: paymentUrl };
  }

  /**
   * The authoritative read. The only thing entitled to move a balance.
   *
   * `FetchOptions.simulate` is IGNORED, as gateway/types.ts says a real driver
   * must: it is the sandbox's affordance for reaching every outcome without a
   * card, and honouring it here would turn a test header into an instruction to
   * a real processor's state.
   */
  async fetchPayment(pspReference: string): Promise<GatewayPaymentState> {
    const data = await this.post<MfStatusData>(
      '/v2/GetPaymentStatus',
      JSON.stringify({ Key: pspReference, KeyType: 'InvoiceId' }),
    );

    const invoiceStatus = data.InvoiceStatus;
    if (typeof invoiceStatus !== 'string' || invoiceStatus === '') {
      throw new GatewayUnavailableError('myfatoorah: GetPaymentStatus returned no InvoiceStatus');
    }

    const transactionStatuses = (data.InvoiceTransactions ?? [])
      .map((t) => t.TransactionStatus)
      .filter((s): s is string => typeof s === 'string');

    const outcome = outcomeFor(invoiceStatus, transactionStatuses);

    // The mismatch check in services/topup.ts compares this against what the
    // intent was created for, so a conversion that rounded would read as a
    // processor charging the wrong amount. It does not round; it throws.
    let amountFils: Fils;
    try {
      amountFils = positiveKwdToFils(data.InvoiceValue, 'InvoiceValue');
    } catch (err) {
      if (err instanceof KwdConversionError) {
        throw new GatewayUnavailableError(`myfatoorah: ${err.message}`, { cause: err });
      }
      throw err;
    }

    return { pspReference: String(data.InvoiceId ?? pspReference), outcome, amountFils };
  }

  /**
   * Verify against the RAW body, and parse it here rather than trusting the one
   * Fastify already made.
   *
   * MyFatoorah does not sign the body — it signs an ordered `key=value` list
   * derived from it — so unlike the sandbox this cannot be a MAC over the bytes.
   * That makes reading the fields out of the raw string, rather than out of
   * whatever object was handed along, the whole of the protection: a body that
   * parses differently from the one the route acts on would otherwise let a
   * signature check pass over a different document than the one that was signed,
   * which gateway/types.ts names as the classic failure.
   */
  verifySignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean {
    const raw = headers[MYFATOORAH_SIGNATURE_HEADER];
    const provided = Array.isArray(raw) ? raw[0] : raw;
    if (!provided) return false;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return false;
    }

    const eventName = readPath(parsed, 'Event.Name');
    if (typeof eventName !== 'string') return false;

    const fields = SIGNED_FIELDS[eventName.trim().toUpperCase()];
    // An event type whose signed field order we do not have cannot be verified,
    // and "cannot verify" is never "accept".
    if (!fields) return false;

    /**
     * `Data`, not the envelope. The documented field names are relative to it —
     * see `signatureDataFor`, and note that getting this wrong makes the MAC a
     * constant rather than merely wrong.
     */
    const data = readPath(parsed, 'Data');
    if (data === null || typeof data !== 'object') return false;
    if (everyFieldAbsent(data, fields)) return false;

    const expected = signatureFor(data, fields, env.gatewayWebhookSecret);
    return base64Equal(expected, provided.trim());
  }

  parseEvent(payload: unknown): GatewayEventPayload {
    const eventName = readPath(payload, 'Event.Name');
    if (typeof eventName !== 'string' || eventName === '') {
      throw new GatewayEventMalformedError('callback has no Event.Name');
    }
    if (eventName.trim().toUpperCase() !== PAYMENT_STATUS_CHANGED) {
      /**
       * Signed, readable, and not ours to act on. `REFUND_STATUS_CHANGED` is the
       * live example: non-negotiable #5 means AVO never issues a gateway refund,
       * so one arriving is a portal-side action that must be recorded by a human
       * and must certainly not move a wallet balance.
       *
       * Distinct from malformed because the answers differ — see webhooks.ts.
       */
      throw new GatewayEventUnsupportedError(
        `myfatoorah: ${eventName} is verified but not acted on by this integration`,
      );
    }

    // The per-delivery id. NOT SIGNED — see the header. It is still the right
    // dedupe key, it is simply not a trustworthy one on its own.
    const eventId = readPath(payload, 'Event.Reference');
    const invoiceId = readPath(payload, 'Data.Invoice.Id');
    const invoiceStatus = readPath(payload, 'Data.Invoice.Status');
    const baseCurrency = readPath(payload, 'Data.Amount.BaseCurrency');
    const baseValue = readPath(payload, 'Data.Amount.ValueInBaseCurrency');
    const transactionStatus = readPath(payload, 'Data.Transaction.Status');

    if (typeof eventId !== 'string' || eventId === '') {
      throw new GatewayEventMalformedError('callback has no Event.Reference');
    }
    if ((typeof invoiceId !== 'string' && typeof invoiceId !== 'number') || invoiceId === '') {
      throw new GatewayEventMalformedError('callback has no Data.Invoice.Id');
    }
    if (typeof invoiceStatus !== 'string' || invoiceStatus === '') {
      throw new GatewayEventMalformedError('callback has no Data.Invoice.Status');
    }
    if (baseCurrency !== 'KWD') {
      // Never convert a currency to settle a top-up. A non-KWD base currency
      // means this account is not the one this integration was built against.
      throw new GatewayEventMalformedError(
        `callback Amount.BaseCurrency is ${JSON.stringify(baseCurrency)}, not KWD`,
      );
    }

    const statuses = typeof transactionStatus === 'string' ? [transactionStatus] : [];

    let outcome: GatewayOutcome;
    try {
      outcome = outcomeFor(invoiceStatus, statuses);
    } catch (err) {
      // An unreadable status is malformed here, not an outage: the route answers
      // 400 and the delivery becomes visible instead of being 200'd away.
      throw new GatewayEventMalformedError(
        err instanceof Error ? err.message : 'callback status could not be mapped',
      );
    }

    let amountFils: Fils;
    try {
      amountFils = positiveKwdToFils(baseValue, 'Amount.ValueInBaseCurrency');
    } catch (err) {
      throw new GatewayEventMalformedError(
        err instanceof KwdConversionError ? err.message : 'callback amount could not be read',
      );
    }

    return {
      eventId,
      pspReference: String(invoiceId),
      outcome,
      amountFils,
      // Both halves, verbatim. `Invoice.Status` alone loses why a pending
      // invoice is pending, which is the first thing anyone reconciling asks.
      reportedStatus: `${invoiceStatus}/${typeof transactionStatus === 'string' ? transactionStatus : ''}`,
    };
  }

  // ------------------------------------------------------------- internals --

  /**
   * The deep link cannot go to MyFatoorah — it refuses a non-http scheme
   * outright. So the processor is given an https URL AVO owns, with the deep
   * link carried in `to=` for whatever serves that URL to forward to.
   *
   * `intent` is on the URL as well so the bridge can act without decoding `to`.
   * Neither is a result: `readTopUp` re-reads the processor regardless of what
   * any browser arrives carrying.
   */
  private returnUrl(input: CreatePaymentInput): string {
    const base = env.myfatoorahReturnUrl;
    if (!base) {
      throw new GatewayUnavailableError(
        'MYFATOORAH_RETURN_URL is not set. MyFatoorah refuses a non-http CallBackUrl, so ' +
          `TOPUP_RETURN_URL (${env.topupReturnUrl}) cannot be given to it — set an https URL AVO owns.`,
      );
    }
    const url = new URL(base);
    url.searchParams.set('intent', input.intentId);
    url.searchParams.set('to', input.returnUrl);
    return url.toString();
  }

  /**
   * Look the id up rather than hardcode it. One `InitiatePayment` per process per
   * method; see `methodIds` for why a cache is acceptable here specifically.
   */
  private async paymentMethodId(method: PaymentMethod, amountFils: Fils): Promise<number> {
    const code = METHOD_CODES[method];
    const cached = this.methodIds.get(code);
    if (cached !== undefined) return cached;

    const data = await this.post<MfInitiateData>(
      '/v2/InitiatePayment',
      requestBodyWithDecimal({ CurrencyIso: 'KWD' }, 'InvoiceAmount', filsToKwd(amountFils)),
    );

    for (const m of data.PaymentMethods ?? []) {
      if (typeof m.PaymentMethodCode === 'string' && typeof m.PaymentMethodId === 'number') {
        this.methodIds.set(m.PaymentMethodCode.toLowerCase(), m.PaymentMethodId);
      }
    }

    const found = this.methodIds.get(code);
    if (found === undefined) {
      // Not an outage — a configuration gap. Still a `GatewayUnavailableError`,
      // because the answer to the customer is the same and the alternative is
      // charging her through a method the merchant did not enable.
      throw new GatewayUnavailableError(
        `myfatoorah: payment method ${method} (code ${code}) is not enabled on this account. ` +
          `Enabled: ${[...this.methodIds.keys()].join(', ') || 'none'}`,
      );
    }
    return found;
  }

  /**
   * One POST, one envelope check. Every MyFatoorah endpoint answers the same
   * `{ IsSuccess, Message, ValidationErrors, Data }` shape, so unwrapping it in
   * one place is the difference between three call sites that each remember to
   * check `IsSuccess` and three that mostly do.
   */
  private async post<T>(path: string, body: string): Promise<T> {
    const { baseUrl, apiKey } = requireConfig();
    const url = new URL(path, baseUrl).toString();

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          // Their documented scheme, verbatim: "Add "Authorization": "Bearer
          // token" to request header."
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
        // `withGatewayTimeout` already races this call, but that only stops US
        // waiting. Without an abort the socket stays open behind it.
        signal: AbortSignal.timeout(env.gatewayTimeoutMs),
      });
    } catch (err) {
      throw new GatewayUnavailableError(`myfatoorah: ${path} could not be reached`, { cause: err });
    }

    const text = await res.text();

    if (!res.ok) {
      // Truncated: their error bodies can be long, and the whole thing in a log
      // line is how an API key ends up in a log line.
      throw new GatewayUnavailableError(
        `myfatoorah: ${path} answered ${res.status} — ${text.slice(0, 300)}`,
      );
    }

    let envelope: MfEnvelope<T>;
    try {
      envelope = JSON.parse(text) as MfEnvelope<T>;
    } catch (err) {
      throw new GatewayUnavailableError(`myfatoorah: ${path} answered unparseable JSON`, {
        cause: err,
      });
    }

    if (envelope.IsSuccess !== true || !envelope.Data) {
      /**
       * A validation error is OUR bug, not an outage, and it will fail
       * identically on every retry. It is still raised as
       * `GatewayUnavailableError`, because that is what `createTopUp` turns into
       * a 502 that ROLLS THE IDEMPOTENCY KEY BACK — the alternative is a
       * committed key with a permanent failure cached behind it, which the
       * client can only wait on. The message carries the field names so the bug
       * is nameable from one log line.
       */
      const details = (envelope.ValidationErrors ?? [])
        .map((v) => `${v.Name ?? '?'}: ${v.Error ?? '?'}`)
        .join('; ');
      throw new GatewayUnavailableError(
        `myfatoorah: ${path} refused the request — ${envelope.Message ?? 'no message'}` +
          (details ? ` [${details}]` : ''),
      );
    }

    return envelope.Data;
  }
}

// ---------------------------------------------------------------- helpers ----

/**
 * Fail with the VARIABLE NAME. A driver that reads a missing key and sends
 * `Bearer undefined` gets a 401 from the processor, and the operator then debugs
 * MyFatoorah instead of their own environment.
 *
 * Deliberately not defaulted to the public sandbox token. That token is
 * published in MyFatoorah's own documentation so this is not about secrecy — it
 * is that a token baked into a driver as a default is how the LIVE one gets
 * committed three weeks from now. The public test values are documented in
 * api/.env.example, where a developer will look for them.
 */
function requireConfig(): { baseUrl: string; apiKey: string } {
  const baseUrl = env.myfatoorahBaseUrl;
  const apiKey = env.myfatoorahApiKey;
  if (!baseUrl) {
    throw new GatewayUnavailableError(
      'MYFATOORAH_BASE_URL is not set. Test: https://apitest.myfatoorah.com/ — see api/.env.example.',
    );
  }
  if (!apiKey) {
    throw new GatewayUnavailableError(
      'MYFATOORAH_API_KEY is not set. The public Kuwait sandbox token is in api/.env.example.',
    );
  }
  return { baseUrl, apiKey };
}

/**
 * Read a dotted path out of a parsed body. Written out rather than reached for
 * from a library because the paths come from MyFatoorah's signature
 * documentation as literal dotted strings, and keeping them in that form is what
 * makes `SIGNED_FIELDS` checkable against the doc by eye.
 */
export function readPath(source: unknown, path: string): unknown {
  let node: unknown = source;
  for (const segment of path.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * Build their signature: ordered `key=value` pairs joined by commas, HMAC-SHA256
 * with the portal secret in binary, base64.
 *
 * "If the value of any property is null, replace it with the empty string" —
 * their words, and `undefined` gets the same treatment because a field their
 * payload omits and one it sends as null are the same absence to us.
 */
export function signatureFor(
  data: unknown,
  fields: readonly string[],
  secret: string,
): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(signatureDataFor(data, fields), 'utf8'))
    .digest('base64');
}

/**
 * The ordered `key=value` string, before it is hashed.
 *
 * `data` IS THE `Data` OBJECT, not the whole envelope. That is not a convenience
 * — it is the shape of the documentation, and getting it wrong is a
 * vulnerability rather than a mismatch. MyFatoorah's tables are headed "Data
 * Object → Invoice Object" and name the fields `Invoice.Id`, `Invoice.Status`;
 * the delivered payload nests all of them under `Data`. Resolving the documented
 * paths against the ENVELOPE therefore finds nothing, every value renders empty,
 * and the data string becomes a CONSTANT — at which point the MAC no longer
 * depends on the body at all and `verifySignature` accepts any tampered payload
 * that carries the right event name.
 *
 * That is exactly what the first version of this file did, and the two specs in
 * myfatoorah.test.ts that caught it are the two worth keeping forever: the
 * character-for-character comparison against their documented string, and
 * "refuses a body whose signed fields were tampered with". The second is the one
 * that turns the bug from cosmetic into an unauthenticated credit endpoint, which
 * is the thing routes/webhooks.ts opens by naming.
 *
 * Split out from `signatureFor` precisely so that comparison is possible — the
 * base64 cannot be checked without their portal secret, but the string that goes
 * into it can be, and that is where a mistake hides. A wrong field order, or a
 * null rendered as the four characters `null`, produces a perfectly well-formed
 * MAC that simply never matches, which reads at 3am as "MyFatoorah is sending bad
 * signatures".
 */
export function signatureDataFor(data: unknown, fields: readonly string[]): string {
  return fields
    .map((field) => {
      const value = readPath(data, field);
      // "If the value of any property is null, replace it with the empty
      // string" — their words. `undefined` gets the same treatment, because a
      // field their payload omits and one it sends as null are the same absence.
      return `${field}=${value === null || value === undefined ? '' : String(value)}`;
    })
    .join(',');
}

/**
 * Would this data string be a constant?
 *
 * If EVERY signed field is absent, the MAC is the same for any body of that
 * event type and the verification is theatre. That is a specific bug with a
 * specific signature — a path-prefix mistake, made once in this file already —
 * so it is checked rather than trusted not to recur. A real delivery always
 * carries `Invoice.Id`; a payload where nothing resolves is not one.
 */
function everyFieldAbsent(data: unknown, fields: readonly string[]): boolean {
  return fields.every((field) => {
    const value = readPath(data, field);
    return value === null || value === undefined || value === '';
  });
}

/** Constant-time where the lengths allow it, and never `===` on the strings. */
function base64Equal(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
