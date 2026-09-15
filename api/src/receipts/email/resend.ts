/**
 * The first `EmailTransport`: Resend's REST API, over the runtime's own `fetch`.
 *
 * ============================================================================
 * WHY THIS PROVIDER, AND WHAT IT COSTS TO CHANGE ITS MIND
 * ============================================================================
 * The choice was made on ONE criterion, deliberately: which provider's wire
 * shape is closest to the neutral one, so that the adapter carries the least
 * vendor in it.
 *
 *   Resend    POST /emails  { from, to, subject, text }  ->  { id }
 *   Postmark  POST /email   { From, To, Subject, TextBody } -> { MessageID }
 *   SES v2    POST /v2/email/outbound-emails with a nested
 *             Content.Simple.Body.Text.Data, plus SigV4 request signing
 *
 * `EmailMessage` in `transport.ts` IS the first of those three, which is not a
 * coincidence — it is the shape all of them collapse to once the nesting is
 * removed. So this file is a field rename and a status map, and Postmark's
 * equivalent is the same two things spelled differently. SES would additionally
 * need SigV4, which is real work and an argument against it rather than for it.
 *
 * WHAT IT COSTS TO REVERSE. One new file in this directory implementing
 * `EmailTransport`, one value on `RECEIPT_EMAIL_TRANSPORT`, one case in
 * `email/index.ts`, and the credential variables in `env.ts`. Nothing in
 * `compose.ts`, nothing in the driver, nothing in the worker, no migration, and
 * no change to a single row already queued. The reversal cost is bounded by
 * construction and that is the reason for the seam, not a hope about it.
 *
 * WHAT WAS NOT DECIDED HERE, and must not be read as though it was: whether
 * receipts send from AVO's domain or from per-salon subdomains. CLAUDE.md §
 * Escalate, don't guess still lists it as the CLIENT'S, and it is still open.
 * This file never names a sender — the address arrives in `EmailMessage.from`,
 * assembled in `email/index.ts` from configuration. Picking a postman does not
 * pick a return address.
 *
 * ============================================================================
 * NO SDK, AND NOTHING IN pnpm-lock.yaml
 * ============================================================================
 * `resend` on npm is a wrapper over one POST. Taking it would mean a new entry
 * in the workspace-root lockfile, outside this lane's column — the wall
 * `images/supabase.ts` hit for Supabase's SDK and refused for the same reason.
 * One endpoint, one bearer token, one JSON body: `fetch` is enough.
 *
 * ============================================================================
 * NOT VERIFIED AGAINST A LIVE ACCOUNT, AND THAT IS SAID RATHER THAN HIDDEN
 * ============================================================================
 * `gateway/myfatoorah.ts` could claim verification because MyFatoorah publishes a
 * sandbox key. There is no such thing here: reaching Resend needs an API key, and
 * an API key must not exist in this tree in any form — not in `.env.example`
 * (which is committed), not in a fixture, not in a comment. Repo policy, and the
 * rule the Supabase driver states at the same point in its own header.
 *
 * So the shapes below come from Resend's published request and response
 * documentation, and the SPECS DRIVE THIS FILE WITH A STUBBED `fetch` rather than
 * over a network: `resend.test.ts` asserts the URL, the method, the headers, the
 * body, both id shapes the response has used (`id`, and an older `data.id`), and
 * every arm of the status map. What is proved is this adapter's behaviour given a
 * response; what is NOT proved is that Resend sends exactly that response. Said
 * plainly so nobody reads a green suite as a live integration.
 */

import type { EmailMessage, EmailTransport } from './transport';
import { classifyHttpStatus } from './transport';
import { ReceiptTransientError } from '../types';

/** Resend's public endpoint. Overridable so a relay or a proxy is a variable. */
export const RESEND_DEFAULT_BASE_URL = 'https://api.resend.com';

export interface ResendTransportConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

/**
 * RFC 5322 display-name quoting, and it is not cosmetic.
 *
 * The display name is the SALON'S NAME — merchant-supplied, free text, and
 * routinely carrying a comma ("Amara, Salmiya") or an apostrophe. Interpolated
 * raw into `Name <addr>` a comma makes the header parse as TWO addresses, the
 * second of which is a bare word and is rejected. Backslash-escape the two
 * characters a quoted-string may not hold, then quote the whole thing.
 *
 * Control characters are STRIPPED, not escaped: a newline in a header value is
 * header injection, and there is no correct rendering of one.
 */
export function formatAddress(name: string, address: string): string {
  const safe = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/(["\\])/g, '\\$1')
    .trim();
  return safe.length > 0 ? `"${safe}" <${address}>` : address;
}

/**
 * As much of a response body as an error may carry, WITH THE CREDENTIAL TAKEN
 * OUT OF IT.
 *
 * TRUNCATION IS NOT REDACTION, and this file learned that from its own spec.
 * `resend.test.ts § the key` asserts that no error message contains the API key
 * for any status or any body; it went red on the first run, against an `excerpt`
 * that only sliced. A provider is entitled to echo the request it could not
 * parse, headers included, and this message is written to `receipt_job.last_error`
 * — a column that is read by whoever investigates a parked receipt, and that
 * outlives the job by a century.
 *
 * `images/supabase.ts` is safe from the same shape only because its credential
 * never appears in a request BODY. That is a property of Supabase's API, not of
 * the code, and it is not a property this one gets to assume.
 */
function excerpt(text: string, secret: string): string {
  const cut = text.slice(0, 300);
  return secret.length > 0 ? cut.split(secret).join('[redacted]') : cut;
}

export class ResendEmailTransport implements EmailTransport {
  readonly name = 'resend';

  constructor(private readonly config: ResendTransportConfig) {}

  async send(message: EmailMessage): Promise<{ providerReference: string }> {
    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/emails`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          /**
           * THE KEY IS NEVER A MEMBER OF ANY OTHER STRING BUILT IN THIS FILE.
           * `images/supabase.ts` states the rule it inherited from
           * `gateway/myfatoorah.ts`: "the whole thing in a log line is how an API
           * key ends up in a log line." Nothing below interpolates `config`.
           */
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: formatAddress(message.from.name, message.from.address),
          to: [message.to.address],
          subject: message.subject,
          text: message.text,
        }),
        /** Without an abort the socket outlives the caller that gave up on it. */
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (cause) {
      /**
       * TRANSIENT, INCLUDING THE TIMEOUT. A DNS failure, a reset connection and
       * an `AbortSignal.timeout` all land here, and none of them is evidence
       * that this message can never send. The `cause` chain keeps the real error
       * for the log without putting it in the message.
       */
      throw new ReceiptTransientError('resend: the request could not be completed', { cause });
    }

    const body = await response.text().catch(() => '');

    if (!response.ok) {
      throw classifyHttpStatus(
        response.status,
        `resend: POST /emails answered ${response.status} — ${excerpt(body, this.config.apiKey)}`,
      );
    }

    /**
     * BOTH ID SHAPES ARE ACCEPTED. The documented success body is `{ "id": ... }`
     * and an older one nested it under `data`. A transport that insisted on one
     * would turn a SUCCESSFUL send into a thrown error and the worker would then
     * retry a message the customer has already received — the one failure mode
     * worse than not sending, because it cannot be undone.
     *
     * AND A MISSING ID IS NOT AN ERROR EITHER, for the same reason plus one:
     * `providerReference` is not persisted (decision 74), so an absent id costs
     * a log line's precision and nothing else. `accepted` is a truthful stand-in.
     */
    const parsed: unknown = body === '' ? null : safeJson(body);
    return { providerReference: referenceFrom(parsed) ?? 'accepted' };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function referenceFrom(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const top = parsed as Record<string, unknown>;
  if (typeof top.id === 'string' && top.id.length > 0) return top.id;
  const data = top.data;
  if (typeof data === 'object' && data !== null) {
    const id = (data as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return null;
}
