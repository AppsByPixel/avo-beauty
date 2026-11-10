/**
 * The two receipt sentences tell the truth.
 *
 * DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt
 * line — Aftab, 2026-11-10", ruling 3. The result screen said "WhatsApp receipt
 * sent" and the lookup note promised "a WhatsApp confirmation for every charge
 * taken this way". No WhatsApp sender exists (`RECEIPT_DRIVER` is
 * `logging | email`), so both were false at a counter, in front of a customer.
 * What IS true whatever the driver: the receipt job is queued inside the charge
 * transaction and the wallet's bell is built from it.
 *
 * Asserted as WORDS, the way `failureStates.test.ts` asserts the schedule
 * refusal — a presence test would have passed on the false sentence for ever.
 *
 * WHEN A WHATSAPP SENDER SHIPS this file is expected to fail, and the fix is to
 * revert both values to the design (design:386, design:235) and this file with
 * them — not to loosen the assertions.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copy } from '../copy/en';

const read = (name: string) => readFileSync(join(__dirname, name), 'utf8');

describe('the receipt line on the result screen', () => {
  it('reads as ruled, verbatim', () => {
    expect(copy.receiptSent).toBe("Receipt in the customer's AVO app");
  });

  it('promises no WhatsApp message', () => {
    expect(copy.receiptSent).not.toMatch(/whatsapp/i);
    expect(copy.receiptSent).not.toMatch(/\bsent\b/i);
  });

  it('is the sentence the result screen renders', () => {
    expect(read('ResultScreen.tsx')).toContain('copy.receiptSent');
  });
});

describe('the note under a manual lookup', () => {
  it('reads as ruled, verbatim', () => {
    expect(copy.lookupLogged).toBe(
      "Manual lookups are logged with your name. Every charge taken this way shows in the customer's AVO app.",
    );
  });

  it('keeps the first sentence the design wrote, and drops only the false promise', () => {
    expect(copy.lookupLogged.startsWith('Manual lookups are logged with your name.')).toBe(true);
    expect(copy.lookupLogged).not.toMatch(/whatsapp/i);
  });

  it('is the sentence the lookup screen renders', () => {
    expect(read('LookupScreen.tsx')).toContain('copy.lookupLogged');
  });
});

describe('the dictionary says where the words came from', () => {
  /**
   * The brief's own condition on the change: each changed string cites the
   * ruling and says to revert when a sender ships. Checked on the source, so a
   * later tidy-up that drops the comment fails here rather than silently
   * leaving a reader to wonder why the copy disagrees with the design.
   */
  it.each(['receiptSent', 'lookupLogged'])('%s carries the ruling and the revert note', (key) => {
    const src = readFileSync(join(__dirname, '..', 'copy', 'en.ts'), 'utf8');
    const at = src.indexOf(`  ${key}:`);
    expect(at).toBeGreaterThan(-1);
    const comment = src.slice(src.lastIndexOf('/**', at), at);
    expect(comment).toContain('Aftab, 2026-11-10');
    expect(comment).toContain('DECISIONS.md');
    expect(comment).toMatch(/REVERT/);
    expect(comment).toMatch(/WhatsApp sender ships/);
  });
});
