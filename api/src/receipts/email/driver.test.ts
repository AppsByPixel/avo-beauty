/**
 * The driver between the worker and the postman.
 *
 * Three things live here that live nowhere else, and each is a decision rather
 * than plumbing:
 *
 *   `handles()`            selecting this driver is the first configuration in
 *                          which `handles` returns false for anything, which is
 *                          the first configuration in which `processJob`'s
 *                          give-back branch executes in production.
 *
 *   the address re-check   `decideReceiptChannels` decided at CHARGE time that
 *                          this member had a verified address. This asks again
 *                          at SEND time, because `services/erasure.ts:437` and a
 *                          profile edit can both have happened in between.
 *
 *   the sending identity   the open client decision, expressed as configuration.
 */

import { describe, expect, it, vi } from 'vitest';
import { ReceiptPermanentError, type ReceiptDelivery } from '../types';
import { EmailReceiptSender, mailLabelFor } from './index';
import type { EmailMessage, EmailTransport } from './transport';

function recordingTransport(): EmailTransport & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    name: 'recording',
    sent,
    async send(message) {
      sent.push(message);
      return { providerReference: 'rec-1' };
    },
  };
}

function delivery(over: Partial<ReceiptDelivery> = {}): ReceiptDelivery {
  return {
    jobId: 'job-1',
    channel: 'email',
    transactionId: 'TRX-1',
    memberId: 'MEM-1',
    attempt: 1,
    payload: { kind: 'charge', amountFils: 1_000, balanceAfterFils: 500, services: [] },
    recipient: { name: 'Dana A.', email: 'dana@example.com', emailVerified: true },
    salon: { id: 'SAL-AMARA', name: 'Amara' },
    ...over,
  };
}

function sender(fromAddress = 'receipts@avo.beauty') {
  const transport = recordingTransport();
  return { sender: new EmailReceiptSender({ fromAddress, transport }), transport };
}

describe('which channels it handles', () => {
  it('handles email and refuses whatsapp, which is the point of naming it by channel', () => {
    const { sender: s } = sender();
    expect(s.handles('email')).toBe(true);
    expect(s.handles('whatsapp')).toBe(false);
  });

  /**
   * Unreachable through `processJob`, which asks `handles()` first. Asserted
   * anyway for the reason `images/supabase.ts § segmentsFor` gives about its own
   * unreachable guard: "nothing user-supplied reaches here TODAY" is a statement
   * about the current callers, and callers change. A WhatsApp payload posted to a
   * mail provider is not a thing to discover from a customer.
   */
  it('refuses outright if the worker ever hands it a whatsapp row anyway', async () => {
    const { sender: s, transport } = sender();
    await expect(s.send(delivery({ channel: 'whatsapp' }))).rejects.toBeInstanceOf(
      ReceiptPermanentError,
    );
    expect(transport.sent).toHaveLength(0);
  });
});

describe('the address, re-checked at send time', () => {
  it('sends to the verified address, with the salon as the display name', async () => {
    const { sender: s, transport } = sender();
    await s.send(delivery());
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      from: { name: 'Amara', address: 'receipts@avo.beauty' },
      to: { name: 'Dana A.', address: 'dana@example.com' },
      subject: 'Your receipt from Amara',
    });
  });

  /**
   * `services/erasure.ts:437` sets `email` to NULL when a deletion falls due. A
   * receipt job outlives its transaction by design, so this is a real ordering
   * and not a hypothetical: erasure runs, the worker wakes, and the only correct
   * answer is to stop — permanently, with the `risk` audit `markFailed` writes.
   */
  it('is PERMANENT when the member has been erased since the charge', async () => {
    const { sender: s, transport } = sender();
    const err = await s
      .send(delivery({ recipient: { name: 'Erased', email: null, emailVerified: false } }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReceiptPermanentError);
    expect(transport.sent).toHaveLength(0);
  });

  /**
   * A profile edit clears `email_verified` until she confirms again. PERMANENT
   * even though it may fix itself in an hour: six attempts over a fifteen-minute
   * cap cannot outlast a verification email, so retrying spends the whole budget
   * to arrive at the same answer — and hides a real outage inside a queue of rows
   * that cannot succeed (`receipts/types.ts`).
   */
  it('is PERMANENT when the address is present but no longer verified', async () => {
    const { sender: s, transport } = sender();
    const err = await s
      .send(
        delivery({
          recipient: { name: 'Dana A.', email: 'dana@example.com', emailVerified: false },
        }),
      )
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReceiptPermanentError);
    expect(transport.sent).toHaveLength(0);
  });

  /**
   * It does NOT reach for WhatsApp. `decideReceiptChannels` owns the floor and
   * owns `fallback_reason`, and it makes that call inside the money transaction.
   * A driver inventing a second, later, unrecorded fallback would produce a
   * WhatsApp receipt whose row says the merchant chose it.
   */
  it('never falls back to another channel', async () => {
    const { sender: s, transport } = sender();
    await s
      .send(delivery({ recipient: { name: 'X', email: null, emailVerified: false } }))
      .catch(() => undefined);
    expect(transport.sent.map((m) => m.to.address)).toEqual([]);
  });
});

describe('the sending identity, which is the open client decision', () => {
  it('sends from the configured address as written — the one-domain answer', async () => {
    const { sender: s, transport } = sender('receipts@avo.beauty');
    await s.send(delivery());
    expect(transport.sent[0]?.from.address).toBe('receipts@avo.beauty');
  });

  it('substitutes {salon} — the per-salon-subdomain answer, same code', async () => {
    const { sender: s, transport } = sender('receipts@{salon}.avo.beauty');
    await s.send(delivery());
    expect(transport.sent[0]?.from.address).toBe('receipts@sal-amara.avo.beauty');
  });

  it('refuses rather than sending from an address the token could not build', async () => {
    const { sender: s, transport } = sender('receipts@{salon}.avo.beauty');
    await expect(
      s.send(delivery({ salon: { id: '///', name: 'Nameless' } })),
    ).rejects.toBeInstanceOf(ReceiptPermanentError);
    expect(transport.sent).toHaveLength(0);
  });

  it('reduces a salon id to something that may sit in a hostname', () => {
    expect(mailLabelFor('SAL-AMARA')).toBe('sal-amara');
    expect(mailLabelFor('SAL_LUMIÈRE 2')).toBe('sal-lumi-re-2');
    expect(mailLabelFor('!!!')).toBeNull();
    expect(mailLabelFor('a'.repeat(64))).toBeNull();
  });
});

describe('the log line', () => {
  /**
   * `logging.ts` keeps the customer's phone number out of its own line — "a log
   * line is not the place for it". The same rule, and here it is sharper: this
   * driver HAS the mailbox in hand, and a log is not where a mailbox goes.
   */
  it('carries no address, no name and no payload', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((v: unknown) => {
      lines.push(String(v));
    });
    const { sender: s } = sender();
    await s.send(delivery());
    spy.mockRestore();

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toContain('dana@example.com');
    expect(line).not.toContain('Dana A.');
    expect(line).not.toContain('balanceAfterFils');
    expect(JSON.parse(line)).toMatchObject({
      event: 'receipt.send',
      driver: 'email',
      transport: 'recording',
      jobId: 'job-1',
      memberId: 'MEM-1',
    });
  });
});
