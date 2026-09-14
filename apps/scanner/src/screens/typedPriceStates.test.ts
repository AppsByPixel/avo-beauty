/**
 * The typed-price rules that live inside components, where no test in this
 * package can call them.
 *
 * SOURCE SCANS, NOT RENDERS — the same choice `chargeStates.test.ts` makes and
 * for the same stated reason: there is no renderer in this workspace (no jsdom,
 * no testing-library, `react-test-renderer` gone in React 19), and adding one
 * rewrites the trunk-owned `pnpm-lock.yaml`, which is not a lane B call.
 *
 * And, as there, a render test would aim at the wrong risk. None of the rules
 * below is about a component drawing a value wrongly. They are about a gate
 * being REMOVED, a refusal branch being COLLAPSED into a generic one, and a
 * distinction being DROPPED from a list — three deletions, each cheap to undo at
 * the moment somebody writes it and expensive afterwards.
 *
 * WHAT THIS FILE IS NOT. A source scan cannot prove behaviour, and these
 * assertions are worth exactly what they say: this text is present in this file.
 * The behaviour they stand in for — the conversion, the refusal mapping, the
 * readiness rule — is proved properly in `domain/customAmount.test.ts` and
 * `api/customAmountWire.test.ts`, against the functions themselves. This file
 * only pins that the screens still call them.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copy } from '../copy/en';

const read = (dir: string, name: string) => readFileSync(join(__dirname, dir, name), 'utf8');
const memberScreen = read('.', 'MemberScreen.tsx');
const chargesScreen = read('.', 'ChargesScreen.tsx');
const card = read('../components', 'TypedAmountCard.tsx');

/**
 * The same source with every comment removed.
 *
 * REQUIRED FOR THE NEGATIVE ASSERTIONS, and finding out why is the point.
 * `chargeStates.test.ts` records a scan that stayed green because the screen's
 * HEADER COMMENT contained the string it asserted — "a test a comment can
 * satisfy is the same defect as a green typecheck bought with a cast". The
 * inverse bites just as hard: `not.toMatch(/toFixed\(/)` went red against a
 * comment that says a hand-rolled `.toFixed(3)` is what NOT to write, and
 * `canTypeAmount` counted three because the doc block names it.
 *
 * Both readings were about prose rather than code. So a "does this file contain
 * a float multiply" question is asked of the code, and a "does this file still
 * call the tested module" question is asked of the whole text — prose that
 * mentions a call is not a call, but prose cannot fake an import either.
 */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const memberCode = code(memberScreen);
const cardCode = code(card);

// ──────────────────────────────────────────────── the gate, and its limits ──

describe('the entry control is gated on the permission the server gates on', () => {
  /**
   * ONE READ OF AUTHORITY, REUSED. `useSession().can` is the only way this app
   * asks what a staff member may do — `ChargesScreen`'s void button and
   * `HomeScreen`'s padlocked tiles both go through it, and it is re-fetched by
   * `refreshPerms()` on foreground. A second mechanism here would be a second
   * thing to keep in sync with a permission that changes mid-shift.
   */
  it("reads perms through useSession().can, not a second mechanism", () => {
    expect(memberScreen).toContain("const canTypeAmount = can('void');");
    expect(memberScreen).toMatch(/const \{[^}]*\bcan\b[^}]*\} = useSession\(\);/);
  });

  /**
   * `void`, because that is what the SERVER gates `amountFils` on. Gating the
   * control on `charges` — the read permission, and the supervisor shape
   * `charges: true, void: false` — would draw a button whose every use is a 403.
   */
  it('gates on void rather than charges or scanner', () => {
    expect(memberScreen).not.toContain("canTypeAmount = can('charges')");
    expect(memberScreen).not.toContain("canTypeAmount = can('scanner')");
  });

  /**
   * THE LINE THAT MATTERS MOST (non-negotiable #7). `canTypeAmount` may gate the
   * DISCLOSURE and nothing else. The moment it also guards the submit, the
   * request builder or the refusal panel, the client's cached belief has become
   * load-bearing and a revoked permission stops being rendered.
   */
  it('lets the gate decide the disclosure and nothing else', () => {
    // The declaration, and the single JSX guard. Nothing else may consult it.
    expect(memberCode.match(/canTypeAmount/g)?.length).toBe(2);
    expect(memberCode).not.toMatch(/canTypeAmount\s*&&\s*typedChargeReady/);
    expect(memberCode).not.toMatch(/if\s*\(\s*!?\s*canTypeAmount\s*\)\s*return/);
  });

  /** The 403 disagrees with our cached authority, so re-read it — as ChargesScreen does. */
  it('re-reads authority when the server refuses', () => {
    expect(memberScreen).toContain('if (err.status === 403) void refreshPerms();');
  });
});

// ───────────────────────────────────────────────────── the refusals render ──

describe('every refusal the typed path can get is rendered as itself', () => {
  it('maps the failure through the tested module rather than inline', () => {
    expect(memberScreen).toContain('customAmountRefusal(failure)');
    expect(memberScreen).toContain('typedRefusal.body');
    expect(memberScreen).toContain('typedRefusal.hint');
    expect(memberScreen).toContain('typedRefusal.outcomeUnknown');
    expect(memberScreen).toContain('typedRefusal.offline');
  });

  /**
   * The 422 carries the unknown-outcome line, because an EARLIER request under
   * that key may have charged. A refusal that reads as reassuring is the
   * dangerous one.
   */
  it('pairs the reused key with the check-her-balance sentence', () => {
    expect(memberScreen).toMatch(/typedRefusal\.outcomeUnknown[\s\S]{0,400}copy\.chargeUnknownOutcome/);
  });

  /**
   * THE NO-RETRY RULE EXTENDS TO THIS PATH. `chargeStates.test.ts` asserts the
   * screen as a whole grows no retry affordance; this says the typed branch did
   * not smuggle one in under another name.
   */
  it('offers no retry control on the typed failure either', () => {
    expect(memberCode).not.toMatch(/onRetry/);
    expect(memberCode).not.toMatch(/copy\.tryAgain/);
    expect(copy).not.toHaveProperty('typedPriceStartOver');
  });

  /** The keyboard-side notes exist, and they are courtesies — the server still refuses. */
  it('says something specific for each shape the field can refuse', () => {
    expect(card).toContain('copy.typedPriceTooPrecise');
    expect(card).toContain('copy.typedPriceZero');
    expect(card).toContain('copy.typedPriceNotANumber');
    expect(card).toContain('copy.typedPriceAboveCeiling');
  });
});

// ───────────────────────────────────────────────── the money stays integer ──

describe('no float reaches the amount (#1)', () => {
  /**
   * The conversion is `parseTypedKd`'s and nothing else's. A `parseFloat`, a
   * `Number(raw) * 1000` or a `toFixed` anywhere on this path is the defect the
   * module exists to prevent — `Number('1.005') * 1000` is 1004.9999999999999.
   */
  it('does the KD conversion in the domain module, not in a component', () => {
    for (const source of [memberCode, cardCode]) {
      expect(source).not.toMatch(/parseFloat/);
      expect(source).not.toMatch(/Number\([^)]*\)\s*\*\s*1000/);
      expect(source).not.toMatch(/toFixed\(/);
    }
    expect(memberScreen).toContain('parseTypedKd(typedRaw)');
  });

  /** The figure is formatted through the display boundary, never hand-built. */
  it('formats money through @avo/types', () => {
    expect(card).toContain("from '@avo/types'");
    expect(card).toContain('formatMoney(');
  });

  /**
   * The basket's service and deposit rows are the MENU path's. A typed price is
   * priced by nothing — the server sums no services and applies no hold — so
   * rendering `Services 0.000` beneath it would be this screen inventing a figure
   * about money.
   */
  it('does not show a basket total against a typed figure', () => {
    expect(memberScreen).toMatch(/\{!typing && \(\s*<>\s*<Row label=\{copy\.totalServices\}/);
  });
});

// ───────────────────────────────────────── today's charges tells them apart ──

describe("today's charges distinguishes a typed charge from a menu one", () => {
  /**
   * The person most likely to be reading this list is a manager reviewing the
   * day, and a charge somebody invented the price of was rendering identically
   * to one that came off the menu — the same defect `voidedAt` had, one field
   * over.
   */
  it('branches on customAmount', () => {
    expect(chargesScreen).toContain('row.customAmount');
    expect(chargesScreen).toContain('copy.typedPriceRowTag');
  });

  /**
   * The REASON is the point, not the tag. A custom charge has no service row
   * anywhere, so this string is the only thing that will ever answer "what was
   * this for" — a tag alone would say a price was typed and still not say why.
   */
  it('shows the reason the server sent with it', () => {
    expect(chargesScreen).toContain('row.note');
    expect(chargesScreen).toContain('copy.typedPriceRowReason');
  });

  /**
   * READ OFF THIS ROUTE'S OWN SCHEMA. `TransactionSchema` declares `customAmount`
   * and deliberately does NOT declare `note` — it is a merchant-route key that
   * also carries void reasons and owner adjustment text, annotated `wireOnly` in
   * `e2e/contract.test.ts`. So the widening belongs to `api/charges.ts`, and
   * "fixing" it by adding `note` to the trunk-owned schema is the thing not to do.
   */
  it('parses the row with the widened schema, not a bare Transaction', () => {
    const api = read('../api', 'charges.ts');
    expect(api).toContain('export const ChargeRowSchema = TransactionSchema.extend({');
    expect(api).toContain('items: z.array(ChargeRowSchema)');
  });
});
