/**
 * The two receipt sentences, and the void sheet's line, tell the truth.
 *
 * DECISIONS.md § "Staff phone pairing, phone sign-in, and a truthful receipt
 * line — Aftab, 2026-11-10", ruling 3. The result screen said "WhatsApp receipt
 * sent" and the lookup note promised "a WhatsApp confirmation for every charge
 * taken this way". No WhatsApp sender exists (`RECEIPT_DRIVER` is
 * `logging | email`), so both were false at a counter, in front of a customer.
 * What IS true whatever the driver: the receipt job is queued inside the charge
 * transaction and the wallet's bell is built from it.
 *
 * THE VOID SHEET, by the same ruling extended the same day ("yes change the void
 * WhatsApp line too"). It told the staff member "she gets a WhatsApp notice".
 * That was false twice over: no sender, and `POST /voids`
 * (api/src/routes/charges.ts § performVoid) queues no receipt and no
 * notification at all. What IS true: the wallet's bell marks the voided charge
 * (`bellChargeVoided`, from the reversal the void writes).
 *
 * Asserted as WORDS, the way `failureStates.test.ts` asserts the schedule
 * refusal — a presence test would have passed on the false sentence for ever.
 *
 * WHEN A WHATSAPP SENDER SHIPS this file is expected to fail, and the fix is to
 * revert the receipt values to the design (design:386, design:235) and this file
 * with them — not to loosen the assertions. The void line reverts (design:310)
 * only when `POST /voids` ALSO queues a notice; a sender alone does not make
 * "she gets a WhatsApp notice" true.
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

describe('the void sheet line', () => {
  const voidSheetSrc = () =>
    readFileSync(join(__dirname, '..', 'components', 'VoidSheet.tsx'), 'utf8');

  it('reads as ruled, verbatim', () => {
    expect(copy.voidSheetBody).toBe(
      'The full amount goes straight back to her wallet, the visit is removed, and her AVO app shows the void. This is recorded against your name.',
    );
  });

  it('keeps everything else the design wrote, and drops only the false promise', () => {
    expect(
      copy.voidSheetBody.startsWith(
        'The full amount goes straight back to her wallet, the visit is removed, and ',
      ),
    ).toBe(true);
    expect(copy.voidSheetBody.endsWith(' This is recorded against your name.')).toBe(true);
    expect(copy.voidSheetBody).not.toMatch(/whatsapp/i);
    expect(copy.voidSheetBody).not.toMatch(/\bnotice\b/i);
  });

  it('is the sentence the void sheet renders', () => {
    expect(voidSheetSrc()).toContain('copy.voidSheetBody');
  });

  /**
   * VoidSheet.tsx carried the report that this line was false ("that is design
   * copy, kept verbatim, and it is false against this API today"). Once the
   * line is true, that report is itself false — and a reader of the component
   * would believe the copy still lies. Read with the comment gutters folded, so
   * a re-wrap of the paragraph cannot hide the sentence.
   */
  it("VoidSheet's comment no longer says the line is false", () => {
    const prose = voidSheetSrc().replace(/\n\s*\*\s?/g, ' ').replace(/\s+/g, ' ');
    expect(prose).not.toMatch(/she gets a WhatsApp notice/);
    expect(prose).not.toMatch(/kept verbatim, and it is false/);
  });
});

describe('the dictionary says where the words came from', () => {
  /**
   * The brief's own condition on the change: each changed string cites the
   * ruling and says to revert when a sender ships. Checked on the source, so a
   * later tidy-up that drops the comment fails here rather than silently
   * leaving a reader to wonder why the copy disagrees with the design.
   */
  const commentAbove = (key: string) => {
    const src = readFileSync(join(__dirname, '..', 'copy', 'en.ts'), 'utf8');
    const at = src.indexOf(`  ${key}:`);
    expect(at).toBeGreaterThan(-1);
    return src.slice(src.lastIndexOf('/**', at), at);
  };

  it.each(['receiptSent', 'lookupLogged', 'voidSheetBody'])(
    '%s carries the ruling and the revert note',
    (key) => {
      const comment = commentAbove(key);
      expect(comment).toContain('Aftab, 2026-11-10');
      expect(comment).toContain('DECISIONS.md');
      expect(comment).toMatch(/REVERT/);
      expect(comment).toMatch(/WhatsApp sender ships/);
    },
  );

  /**
   * The void line's revert has a second condition the receipt lines do not: a
   * sender alone sends nothing on a void, because `POST /voids` queues nothing.
   * The comment has to say so, or the revert lands on a sender and the sheet
   * goes back to promising a message that still never comes.
   */
  it('voidSheetBody says it is ruled wording, and reverts only when POST /voids queues a notice', () => {
    const comment = commentAbove('voidSheetBody');
    expect(comment).toMatch(/worded in the ruling, not the design/);
    expect(comment).toContain('POST /voids');
    expect(comment).toMatch(/queues a notice/);
    expect(comment).toContain('design:310');
  });
});
