// @vitest-environment jsdom

/**
 * Merchant → Settings → the two receipt channels, and the floor underneath them.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Aftab's item 11 is "invoice through emails or WhatsApp, option set by merchant".
 * The API had both halves — `salon.emailEnabled` stored, in `MERCHANT_EDITABLE`,
 * served by `serialiseSalon`, and read by `services/receipts.ts §
 * decideReceiptChannels` — and this dashboard exposed ONE of them. `emailEnabled`
 * appeared zero times under `apps/dashboard/`, so a merchant could turn WhatsApp
 * off and could not turn email on. Measured on the demo database before this
 * change: 107 `receipt_job` rows, every one of them `whatsapp`.
 *
 * THE PART THAT IS NOT A SECOND TOGGLE
 * ------------------------------------
 * `design/README.md` § Known gaps 7: a receipt is "a record-keeping obligation,
 * not marketing". So the merchant's choice must never be able to produce NO
 * receipt at all — and the email channel has a customer-side precondition she
 * cannot see, because `decideReceiptChannels` queues email only for a member with
 * `email && emailVerified`. "Email only" for a customer who never verified an
 * address is silence.
 *
 * The server already refuses to let that happen, in two independent places, and
 * this file pins both of them from the client that now depends on them:
 *
 *   the CHECK      `salon_receipt_channel_floor` — `whatsapp_enabled OR
 *                  email_enabled` — makes both-off unstorable.
 *   the handler    `PATCH /salons/{id}` computes the merged next state and
 *                  answers 409 `receipt_channels_required` with a sentence
 *                  written to be read, rather than letting the CHECK surface as
 *                  a 500.
 *   the queue      `decideReceiptChannels` falls back to WhatsApp — the floor,
 *                  because `member.phone` is NOT NULL — and stamps
 *                  `fallbackReason: 'email_unavailable'` on the row.
 *
 * So the merchant cannot choose silence, and a customer with no verified address
 * still gets her receipt. The client must not re-implement any of that, and must
 * not pre-empt it: see "the client does not own this rule" below.
 *
 * WHAT THIS FILE DOES NOT ASSERT, NAMED SO THE ABSENCE IS A DECISION
 * -----------------------------------------------------------------
 * 1. THAT THE SCREEN EXPLAINS THE FALLBACK. It does not explain it, and that is
 *    reported rather than built: the design bundle has NO merchant-facing string
 *    for "WhatsApp receipts still go to customers who have not verified an email
 *    address". `AVO Merchant Dashboard.dc.html:1090` draws one channel row and no
 *    second one; the only fallback wording anywhere in the bundle is
 *    `api-contract.md:116`, which is a rule written for an implementer, not copy.
 *    Inventing a sentence here would be inventing product copy (CLAUDE.md § Keep
 *    the copy verbatim), so the state has no words and is reported as needing
 *    them. What the screen does instead is refuse to ASSERT the opposite — two
 *    independent switches, never a "WhatsApp | Email | Both" radio, because a
 *    radio would state an exclusivity the server does not implement.
 * 2. THAT THE ENDPOINT ACCEPTS THE BODY. A source scan cannot; only driving it
 *    can. Driven before this was written — see the transcript in
 *    `api/settings.ts § SalonPatch`.
 *
 * COMMENTS ARE BLANKED BEFORE EVERY SOURCE SEARCH, for `settingsModules.test.ts`'
 * reason: both files under test discuss their own identifiers in prose at a ratio
 * that makes a naive `includes()` pass while the code says the opposite.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fils, type Salon } from '@avo/types';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.js';
import { stripComments } from '../testing/stripComments.js';
import { EmailReceiptsPanel, WhatsAppPanel } from './Settings.js';
import { WriteError } from './sectionState.js';

/* See `shopRender.test.tsx`: vitest does not run with `globals`, so nothing
 * registers `@testing-library/react`'s own cleanup and every render would
 * accumulate in one document. */
afterEach(cleanup);

/** `apps/dashboard/src/routes` → repo root. */
const REPO = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => stripComments(readFileSync(join(REPO, rel), 'utf8'));

const SALONS_ROUTE = 'api/src/routes/salons.ts';
const RECEIPTS_SERVICE = 'api/src/services/receipts.ts';
const SALON_SCHEMA = 'api/src/db/schema/salon.ts';

/**
 * The body of `const MERCHANT_EDITABLE = new Set([ … ])`, as string literals.
 *
 * Sliced to the Set rather than grepped file-wide, for `settingsModules.test.ts`'
 * reason: `salons.ts` also declares `PLATFORM_ONLY_EDITABLE` and
 * `PLATFORM_EDITABLE`, and a file-wide search answers for whichever it lands in.
 */
function merchantEditable(): string[] {
  const src = read(SALONS_ROUTE);
  const open = src.indexOf('const MERCHANT_EDITABLE = new Set([');
  expect(open, `MERCHANT_EDITABLE not found in ${SALONS_ROUTE}`).toBeGreaterThan(-1);
  const close = src.indexOf('])', open);
  expect(close).toBeGreaterThan(open);
  return [...src.slice(open, close).matchAll(/'([^']+)'/g)].flatMap((m) => m[1] ?? []);
}

/** The body of `export function decideReceiptChannels(`, to its column-0 brace. */
function decideBody(): string {
  const src = read(RECEIPTS_SERVICE);
  const open = src.indexOf('export function decideReceiptChannels(');
  expect(open, `decideReceiptChannels not found in ${RECEIPTS_SERVICE}`).toBeGreaterThan(-1);
  const close = src.indexOf('\n}', open);
  expect(close).toBeGreaterThan(open);
  return src.slice(open, close);
}

describe('the server half — what the merchant may set, and what she may not', () => {
  it('lets a merchant edit BOTH channels, not just one', () => {
    const editable = merchantEditable();
    expect(editable).toContain('whatsappEnabled');
    // The half this screen could not reach. Its absence here is the day the
    // email switch below starts sending a `not_editable` 400 on every flip.
    expect(editable).toContain('emailEnabled');
  });

  /**
   * THE FLOOR, IN THE DATABASE. A handler check can be edited around; a CHECK
   * constraint cannot, and it is what makes "the merchant cannot choose silence"
   * a property of the data rather than of a code path.
   */
  it('makes both-off unstorable at the column level', () => {
    const src = read(SALON_SCHEMA);
    expect(src).toContain('salon_receipt_channel_floor');
    expect(src).toMatch(/whatsappEnabled\}\s*OR\s*\$\{t\.emailEnabled/);
  });

  /**
   * THE FLOOR, IN WORDS. The CHECK alone surfaces as a 500, which tells a
   * merchant her salon is broken rather than that her change is not allowed —
   * and `WriteError` would render "Something went wrong on our side."
   *
   * Asserted on the MERGE, not on the throw alone. A handler that read the body
   * instead of the body merged over the current row would wave through the one
   * request that can actually turn the last channel off: `{ whatsappEnabled:
   * false }` sent by a salon whose email is already off.
   */
  it('refuses the last channel in a sentence, computed from the merged state', () => {
    const src = read(SALONS_ROUTE);
    expect(src).toContain('patch.whatsappEnabled ?? before.whatsappEnabled');
    expect(src).toContain('patch.emailEnabled ?? before.emailEnabled');
    expect(src).toContain("'receipt_channels_required'");
  });

  /**
   * THE FLOOR, AT THE QUEUE — the one the merchant cannot see and the reason a
   * second toggle is not the whole feature.
   *
   * Two properties, and the second is the one that matters: every `return` out
   * of this function carries a non-empty `channels`, and the fall-through — the
   * only path where the merchant's own preference produced nothing — returns
   * WhatsApp with the reason stamped on it.
   */
  it('never returns a customer no channel at all', () => {
    const body = decideBody();
    expect(body).toContain('if (channels.length > 0) return { channels, fallbackReason: null }');
    expect(body).toContain("return { channels: ['whatsapp'], fallbackReason: 'email_unavailable' }");
    // No early exit that could answer with an empty list.
    expect(body).not.toMatch(/return\s*\{\s*channels:\s*\[\s*\]/);
  });

  /**
   * `emailEnabled` has to come BACK, or the control below has nothing to reflect
   * and would have to remember what it sent — the optimistic lie
   * `DepositPanel` is written at length to avoid.
   */
  it('serves the value the control reflects', () => {
    expect(read(SALONS_ROUTE)).toContain('emailEnabled: s.emailEnabled');
  });
});

/* ------------------------------------------------------------------- client */

const SALON: Salon = {
  id: 'SAL-AMARA',
  name: 'Amara Salon',
  nameAr: 'صالون أمارة',
  plan: 'growth',
  city: 'Kuwait City',
  /*
   * A TENANT'S OWN HEX, DELIBERATELY ARBITRARY AND DELIBERATELY NOT A PRESET.
   *
   * This was `'#6E7F6C'`, and unlike the console's swatch list that was not a
   * transcription bug — `brandColor` is a white-label INPUT, so a fixed literal
   * is the honest shape for it and nothing here asserts on the value. It is
   * changed anyway, for a different reason: `#6E7F6C` is no longer a hex a salon
   * row can hold. Migration 0055 rewrites every occurrence of the retired
   * shipped default to `#459A3C` (case-insensitively), so after it runs the only
   * salons on that value are ones the seed re-creates — trunk's open item, not a
   * state this fixture should stand for.
   *
   * NOT READ FROM `brandPresets.amaraSage.brand` EITHER, which would be the
   * reflex after the swatch fix one directory along. That hex IS the platform
   * default, and a fixture for "the salon chose its own colour" must not be the
   * value that means "nobody chose" — the two are indistinguishable at the point
   * the screen reads the row. It would also tie an unrelated spec to the brand
   * ramp, so the next revision would silently move an input these tests do not
   * care about.
   *
   * `#7A5C8E` is SAL-LUMIERE's, the salon 0055's own message names as owning its
   * hex, and it is already what `api/platformSalonDetail.test.ts:42` uses. One
   * arbitrary tenant colour across the dashboard's fixtures.
   */
  brandColor: '#7A5C8E',
  modules: { booking: false, shop: false },
  loyaltyMode: 'tiers',
  tiers: [{ name: 'bronze', minVisits: 0, bonusPercent: 0 }],
  depositFils: fils(5000),
  noShowReturnMinutes: 60,
  timezone: 'Asia/Kuwait',
  businessHours: { morning: ['10:00', '13:00'], evening: ['16:00', '21:00'] },
  branches: [{ id: 'BR-SAL', salonId: 'SAL-AMARA', name: 'Salmiya', nameAr: 'السالمية' }],
  social: [],
  whatsappEnabled: true,
  emailEnabled: false,
};

const salonWith = (over: Partial<Salon>): Salon => ({ ...SALON, ...over });

describe('the client half — a merchant can finally choose', () => {
  it('draws a control for each channel', () => {
    render(
      <>
        <WhatsAppPanel salon={SALON} busy={false} onChange={() => {}} />
        <EmailReceiptsPanel salon={SALON} busy={false} onChange={() => {}} />
      </>,
    );
    expect(screen.getByRole('switch', { name: 'WhatsApp notifications' })).toBeTruthy();
    // The half that did not exist. `emailEnabled` appeared zero times under
    // `apps/dashboard/` before this change.
    expect(screen.getByRole('switch', { name: 'Email receipts' })).toBeTruthy();
  });

  /**
   * THE SERVER'S VALUE, NOT A LOCAL ONE — `ModuleRow`'s argument, and it applies
   * harder here: a switch reading On for a channel the salon has off is a
   * merchant believing her customers are being receipted by email when they are
   * not.
   */
  it('reflects the salon the server served, both ways round', () => {
    const { unmount } = render(
      <EmailReceiptsPanel
        salon={salonWith({ emailEnabled: false })}
        busy={false}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
    unmount();

    render(
      <EmailReceiptsPanel
        salon={salonWith({ emailEnabled: true })}
        busy={false}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
  });

  it('sends the flip, one key per switch', () => {
    const sent: boolean[] = [];
    render(
      <EmailReceiptsPanel salon={SALON} busy={false} onChange={(next) => sent.push(next)} />,
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(sent).toEqual([true]);
  });

  it('still sends the WhatsApp flip it always did', () => {
    const sent: boolean[] = [];
    render(<WhatsAppPanel salon={SALON} busy={false} onChange={(next) => sent.push(next)} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(sent).toEqual([false]);
  });

  it('skeletons rather than painting a channel state it does not have yet', () => {
    render(<EmailReceiptsPanel salon={undefined} busy={false} onChange={() => {}} />);
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('will not let a flip be sent twice while the first is in flight', () => {
    render(<EmailReceiptsPanel salon={SALON} busy onChange={() => {}} />);
    expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true);
  });
});

/**
 * ===========================================================================
 * THE STATE WORTH TESTING HARDEST — turning off the only channel a given
 * customer could have received.
 * ===========================================================================
 */
describe('the merchant turns off the last channel', () => {
  /**
   * THE CLIENT DOES NOT OWN THIS RULE, AND MUST NOT PRE-EMPT IT.
   *
   * The tempting version of this screen greys the email switch once WhatsApp is
   * off, so the request is never sent. That is non-negotiable #7 inverted: the
   * UI would become the control, and it would drift — it can see
   * `salon.whatsappEnabled` and CANNOT see whether any of this salon's members
   * has a verified address, which is the other half of what makes a channel
   * choice safe. A client veto also cannot be the audit row the API writes.
   *
   * So the flip goes to the server, and the server answers. Asserted on the
   * SEND, because a disabled switch would emit nothing and this test would go
   * quiet rather than red.
   */
  it('sends the refusable change instead of vetoing it locally', () => {
    const sent: boolean[] = [];
    const lastOne = salonWith({ whatsappEnabled: false, emailEnabled: true });
    render(<EmailReceiptsPanel salon={lastOne} busy={false} onChange={(n) => sent.push(n)} />);

    const sw = screen.getByRole('switch');
    expect(sw.hasAttribute('disabled')).toBe(false);
    fireEvent.click(sw);
    expect(sent).toEqual([false]);
  });

  /**
   * AND SHE READS THE SERVER'S OWN SENTENCE, verbatim.
   *
   * `WriteError` renders a 409's message rather than "Something went wrong on
   * our side." — the distinction `sectionState.tsx` exists for. This state could
   * not be reached from this screen at all until the email switch shipped, so
   * the assertion is new even though the renderer is not: a merchant with one
   * channel left now has a way to try removing it, and what she gets back has to
   * be the reason rather than a shrug.
   *
   * The sentence is the API's, not this lane's. It is the only merchant-facing
   * copy that exists for this rule anywhere — the design bundle has none.
   */
  it('renders the API refusal word for word, and says nothing changed', () => {
    const refusal = new ApiError(
      'A receipt has to reach the customer somehow. Keep WhatsApp or email switched on.',
      { status: 409, code: 'receipt_channels_required' },
    );
    render(<WriteError error={refusal} reassurance="That setting is unchanged." />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(
      'A receipt has to reach the customer somehow. Keep WhatsApp or email switched on.',
    );
    expect(alert.textContent).toContain('That setting is unchanged.');
  });

  /**
   * THE SCREEN DOES NOT KEEP ITS OWN COPY OF THE RULE'S WORDS. A paraphrase in
   * this column is a second source of truth for a sentence the server owns, and
   * it is how a client ends up explaining a refusal the API stopped giving.
   */
  it('keeps no client-side copy of the refusal', () => {
    const src = read('apps/dashboard/src/routes/Settings.tsx');
    expect(src).not.toContain('receipt_channels_required');
    expect(src).not.toContain('A receipt has to reach the customer');
  });

  /**
   * NOT A RADIO, NOT A SEGMENT, NOT A SELECT. Two independent switches, because
   * the server's model is two independent booleans with a floor — and because a
   * "WhatsApp | Email | Both" control would state an exclusivity that
   * `decideReceiptChannels` does not implement. A merchant who picked "Email"
   * from such a control would be told, by the control itself, that WhatsApp is
   * off for everyone; it is not off for any customer without a verified address.
   *
   * This is what the screen does INSTEAD of the explanatory sentence the bundle
   * has no copy for: it declines to assert the thing that would be false.
   */
  it('offers two switches rather than a choice between the channels', () => {
    render(
      <>
        <WhatsAppPanel salon={SALON} busy={false} onChange={() => {}} />
        <EmailReceiptsPanel salon={SALON} busy={false} onChange={() => {}} />
      </>,
    );
    expect(screen.getAllByRole('switch')).toHaveLength(2);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
  });
});

describe('the wiring between them', () => {
  it('declares emailEnabled on SalonPatch', () => {
    // Without it the screen cannot type the write, and a cast would compile a
    // key the endpoint might have stopped accepting.
    expect(read('apps/dashboard/src/api/settings.ts')).toContain("'emailEnabled'");
  });

  it('sends each channel under its own key', () => {
    const src = read('apps/dashboard/src/routes/Settings.tsx');
    expect(src).toContain('update.mutate({ whatsappEnabled: next })');
    expect(src).toContain('update.mutate({ emailEnabled: next })');
  });
});
