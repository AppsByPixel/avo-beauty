// @vitest-environment jsdom

/**
 * The voucher panel's guarantees that no source scan can reach.
 *
 * `stateCensus.test.ts` proves this screen HAS the four-state vocabulary. It
 * cannot prove that the 403 arrives WITHOUT a Try again button, that 12750 fils
 * reaches the glass as `12.750`, or that the Void button is withheld from exactly
 * the rows the server would refuse. All three are about what an admin reads, so
 * all three are asserted against rendered text — `shopRender.test.tsx`'s argument,
 * one directory along.
 *
 * EVERY ERROR IN THIS FILE IS A REAL RESPONSE. The 403 sentence, the 409 refusal
 * and the voucher payloads were captured with curl against the real API on
 * `avo_lane_c` (port 4700) before a line of this was written — signed in as
 * `mariam.k`, the seeded analyst whose `perm_accounts` is false. A fixture that
 * paraphrases a refusal tests the paraphrase.
 */

import { fils } from '@avo/types';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client.js';
import type { PlatformAccount } from '../../api/platformAccounts.js';
import { readAmountInput, voucherState, type Voucher } from '../../api/vouchers.js';
import { WriteError } from '../sectionState.js';
import { stripComments } from '../../testing/stripComments.js';
import { AccountRow } from './Accounts.js';
import { IssueForm, VoucherList, VoucherRow } from './AccountVouchers.js';

/*
 * NOT AUTOMATIC — this project does not run vitest with `globals`, so
 * `@testing-library/react` never registers its own `afterEach(cleanup)`. Without
 * this line every `render()` accumulates in one document and the first query
 * matching two nodes fails with "Found multiple elements", pointing at the
 * component instead of at the leftovers. `shopRender.test.tsx` and
 * `ui/moneyRender.test.tsx` carry the same line and the same warning.
 */
afterEach(cleanup);

const DANA: PlatformAccount = {
  id: '8842',
  kind: 'customer',
  name: 'Dana Al-Sabah',
  handle: null,
  role: 'customer',
  salonId: 'SAL-AMARA',
  salon: 'Amara Beauty Lounge',
  passwordSet: true,
  status: 'active',
  createdAt: '2026-08-16T10:00:00.000Z',
};

/** A live 201 from `POST /v1/vouchers`, field for field. */
const LIVE: Voucher = {
  id: 'VCH-efc83329-2b3',
  code: 'AQX45TNSHC7T',
  memberId: '8842',
  amountFils: fils(12750),
  reason: 'Goodwill — colour correction',
  expiresAt: '2026-12-31T20:59:59.000Z',
  createdAt: '2026-09-15T08:47:30.552Z',
  redeemedAt: null,
  redeemedTransactionId: null,
  voidedAt: null,
  redeemable: true,
};

/** The same row after she redeemed it — a real 200 from the redeem endpoint. */
const REDEEMED: Voucher = {
  ...LIVE,
  id: 'VCH-2900f0e0-ae9',
  code: 'VPYNVEGF9YDX',
  amountFils: fils(3000),
  reason: 'Redeem proof',
  expiresAt: null,
  redeemedAt: '2026-09-15T08:48:24.769Z',
  redeemedTransactionId: 'TX-VCH-a1912371-a35',
  redeemable: false,
};

const VOIDED: Voucher = {
  ...LIVE,
  id: 'VCH-34b89bf9-2c3',
  code: '5N792ZHHRU9T',
  amountFils: fils(1000),
  reason: 'Apology',
  expiresAt: null,
  voidedAt: '2026-09-15T08:47:30.724Z',
  redeemable: false,
};

function list(items: Voucher[], truncated = false) {
  return render(
    <VoucherList
      account={DANA}
      isPending={false}
      isError={false}
      error={null}
      isFetching={false}
      onRetry={() => {}}
      data={{ items, truncated }}
      voiding={null}
      onVoid={() => {}}
    />,
  );
}

/* ===================================================== non-negotiable #1 == */

describe('a voucher is integer fils to the last pixel', () => {
  it('renders 12750 fils as 12.750 KD, trailing zeroes intact', () => {
    render(<VoucherRow voucher={LIVE} voiding={false} onVoid={() => {}} />);
    // Not 12.75, and not 12750. The trailing zero is what makes it money.
    expect(screen.getByText('12.750 KD')).toBeTruthy();
  });

  it('announces the amount as dinars, not as a number', () => {
    render(<VoucherRow voucher={LIVE} voiding={false} onVoid={() => {}} />);
    // interaction-spec.md §2: `12.750` must not read as "twelve thousand".
    expect(screen.getByLabelText('12.750 Kuwaiti dinars')).toBeTruthy();
  });

  it('converts typed KWD without a float ever touching it', () => {
    /*
     * `5.5 * 1000` is 5500.000000000001 in IEEE754 for other values of the same
     * shape — `8.7 * 1000` is 8699.999999999999, which is the case `parseKwdInput`
     * exists for. These assert the integer result, which is the only thing that
     * can be sent as `amountFils`.
     */
    expect(readAmountInput('5.5')).toEqual({ kind: 'ok', amountFils: 5500 });
    expect(readAmountInput('8.7')).toEqual({ kind: 'ok', amountFils: 8700 });
    expect(readAmountInput('12.750')).toEqual({ kind: 'ok', amountFils: 12750 });
  });

  it('refuses the amounts the server refuses, before the round trip', () => {
    // 400 invalid_amount: "amountFils must be a positive whole number of fils."
    expect(readAmountInput('0').kind).toBe('invalid');
    expect(readAmountInput('-5').kind).toBe('invalid');
    // Four decimals is not a KWD amount; the server would take 12.7501 nowhere.
    expect(readAmountInput('12.7501').kind).toBe('invalid');
    expect(readAmountInput('abc').kind).toBe('invalid');
    // Empty is a person who started again, not an error to shout about.
    expect(readAmountInput('   ').kind).toBe('empty');
  });
});

/* ===================================================== non-negotiable #7 == */

describe('the permission refusal is a state this screen renders', () => {
  /**
   * THE REAL 403, captured from `GET /v1/vouchers` as `mariam.k`:
   *
   *   {"error":"forbidden",
   *    "message":"Your console account cannot open Accounts. The platform owner
   *               can grant it."}
   *
   * It is the Accounts sentence because it is the Accounts section — all three
   * voucher endpoints are `requirePlatform(req, 'accounts')`.
   */
  const FORBIDDEN = new ApiError(
    'Your console account cannot open Accounts. The platform owner can grant it.',
    { status: 403, code: 'forbidden' },
  );

  function refusal() {
    return render(
      <VoucherList
        account={DANA}
        isPending={false}
        isError
        error={FORBIDDEN}
        isFetching={false}
        onRetry={() => {}}
        data={null}
        voiding={null}
        onVoid={() => {}}
      />,
    );
  }

  it("renders the server's own sentence, not a paraphrase", () => {
    refusal();
    expect(
      screen.getByText(
        'Your console account cannot open Accounts. The platform owner can grant it.',
      ),
    ).toBeTruthy();
    expect(screen.getByText("You don't have access to vouchers")).toBeTruthy();
  });

  it('offers nothing to retry — an identical request is an identical refusal', () => {
    refusal();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('draws no form and no list behind the refusal', () => {
    refusal();
    // The list component owns the whole answer; nothing of the data leaks past it.
    expect(screen.queryByText('AQX45TNSHC7T')).toBeNull();
  });
});

describe('offline is told apart from a server failure', () => {
  it('names the connection and keeps the retry', () => {
    const offline = new ApiError('Failed to fetch', {
      status: 0,
      code: 'network',
      offline: true,
    });
    render(
      <VoucherList
        account={DANA}
        isPending={false}
        isError
        error={offline}
        isFetching={false}
        onRetry={() => {}}
        data={null}
        voiding={null}
        onVoid={() => {}}
      />,
    );
    expect(screen.getByText('No connection')).toBeTruthy();
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });
});

/* ======================================================== the four states == */

describe('the pending and empty states', () => {
  it('paints skeletons rather than an empty list while pending', () => {
    const { container } = render(
      <VoucherList
        account={DANA}
        isPending
        isError={false}
        error={null}
        isFetching
        onRetry={() => {}}
        data={null}
        voiding={null}
        onVoid={() => {}}
      />,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    // And it does not claim an empty history it has not loaded.
    expect(screen.queryByText(/No vouchers for/)).toBeNull();
  });

  it('names whose list is empty and what fills it', () => {
    list([]);
    expect(screen.getByText('No vouchers for Dana Al-Sabah')).toBeTruthy();
    expect(screen.getByText(/Issue one above/)).toBeTruthy();
  });

  it('says so when the 200-row cap was reached', () => {
    list([LIVE], true);
    expect(screen.getByText(/Showing the 200 most recent vouchers/)).toBeTruthy();
  });

  it('says nothing about a cap that was not reached', () => {
    list([LIVE]);
    expect(screen.queryByText(/200 most recent/)).toBeNull();
  });
});

/* ========================================== the state, and whose clock it is */

describe('liveness is the server’s answer and not the browser’s clock', () => {
  it('names the four states from the fields the server sent', () => {
    expect(voucherState(LIVE)).toBe('redeemable');
    expect(voucherState(REDEEMED)).toBe('redeemed');
    expect(voucherState(VOIDED)).toBe('void');
    expect(
      voucherState({ ...LIVE, expiresAt: '2020-01-01T00:00:00.000Z', redeemable: false }),
    ).toBe('expired');
  });

  /**
   * THE ASSERTION THIS WHOLE FILE EXISTS FOR, alongside the 403.
   *
   * A voucher whose `expiresAt` is in the past but which the SERVER still calls
   * `redeemable` is a clock disagreement, and the server's clock is the one that
   * decides whether `POST /members/me/vouchers/redeem` will pay. A client that
   * recomputed expiry from `Date.now()` would draw this row as Expired and
   * withhold the Void button from the one row that still needs it.
   */
  it('trusts `redeemable` over an expiry in the browser’s past', () => {
    const stale = { ...LIVE, expiresAt: '2020-01-01T00:00:00.000Z', redeemable: true };
    expect(voucherState(stale)).toBe('redeemable');
    render(<VoucherRow voucher={stale} voiding={false} onVoid={() => {}} />);
    expect(screen.getByRole('button', { name: /Void the AQX45TNSHC7T voucher/ })).toBeTruthy();
  });
});

/* ===================================================== non-negotiable #5 == */

describe('void is offered on exactly the rows the server would void', () => {
  it('offers it on a live voucher', () => {
    render(<VoucherRow voucher={LIVE} voiding={false} onVoid={() => {}} />);
    expect(screen.getByRole('button', { name: /Void the AQX45TNSHC7T voucher/ })).toBeTruthy();
  });

  it('withholds it on a redeemed one — the credit is already in her wallet', () => {
    render(<VoucherRow voucher={REDEEMED} voiding={false} onVoid={() => {}} />);
    expect(screen.queryByRole('button', { name: /Void/ })).toBeNull();
    expect(screen.getByText('Redeemed')).toBeTruthy();
  });

  it('withholds it on one already void', () => {
    render(<VoucherRow voucher={VOIDED} voiding={false} onVoid={() => {}} />);
    expect(screen.queryByRole('button', { name: /Void the/ })).toBeNull();
  });

  /**
   * THE REAL 409, captured from `DELETE /v1/vouchers/{id}` on a redeemed row:
   *
   *   {"error":"voucher_not_voidable",
   *    "message":"That voucher has been redeemed. Its credit is in the customer’s
   *               wallet and cannot be taken back here.","redeemed":true}
   *
   * This is non-negotiable #5 in the server's own voice, and the clause that
   * matters is "cannot be taken back here" — the sentence that stops an admin
   * going to look for a cash path. `WriteError` renders a 409 verbatim; this pins
   * that it actually reaches the glass rather than being replaced by "Something
   * went wrong on our side."
   */
  it('renders the redeemed refusal verbatim if the courtesy is raced', () => {
    const refused = new ApiError(
      'That voucher has been redeemed. Its credit is in the customer’s wallet and cannot be taken back here.',
      { status: 409, code: 'voucher_not_voidable', details: { redeemed: true } },
    );
    render(<WriteError error={refused} reassurance="That voucher is unchanged." />);
    expect(screen.getByText(/cannot be taken back here/)).toBeTruthy();
    expect(screen.getByText('That voucher is unchanged.')).toBeTruthy();
  });

  it('renders the already-void refusal verbatim too', () => {
    const refused = new ApiError('That voucher is already void.', {
      status: 409,
      code: 'voucher_not_voidable',
      details: { redeemed: false },
    });
    render(<WriteError error={refused} reassurance="That voucher is unchanged." />);
    expect(screen.getByText(/That voucher is already void\./)).toBeTruthy();
  });
});

/* ================================================= the form after a refusal == */

/**
 * A REFUSED ISSUE KEEPS WHAT SHE TYPED — the regression pin for a defect this
 * screen shipped and a real 403 found.
 *
 * `WriteError`'s contract is that a failed write leaves the screen showing what
 * the operator entered and the record showing what it had: "the sentence that
 * stops someone re-entering a tier ladder that never left the browser". The form
 * cleared on submit rather than on success, so the banner said "No voucher was
 * issued to Dana Al-Sabah" over three empty fields — half the promise false, and
 * invisible to every test that only drove the happy path.
 */
describe('a refused issue does not throw away the amount and reason', () => {
  async function typeAndSubmit(result: boolean) {
    const sent: unknown[] = [];
    render(
      <IssueForm
        account={DANA}
        busy={false}
        error={null}
        failed={false}
        onSubmit={(input) => {
          sent.push(input);
          return Promise.resolve(result);
        }}
      />,
    );
    const amount = screen.getByLabelText<HTMLInputElement>('Amount');
    const reason = screen.getByLabelText<HTMLInputElement>('Reason');
    fireEvent.change(amount, { target: { value: '4.000' } });
    fireEvent.change(reason, { target: { value: 'Permission-off proof' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Issue voucher' }));
    });
    return { amount, reason, sent };
  }

  it('keeps both fields when the server refused', async () => {
    const { amount, reason, sent } = await typeAndSubmit(false);
    // Integer fils crossed the boundary, not the typed string.
    expect(sent).toEqual([{ amountFils: 4000, reason: 'Permission-off proof' }]);
    expect(amount.value).toBe('4.000');
    expect(reason.value).toBe('Permission-off proof');
  });

  it('clears both fields when it succeeded', async () => {
    const { amount, reason } = await typeAndSubmit(true);
    expect(amount.value).toBe('');
    expect(reason.value).toBe('');
  });

  it('sends nothing at all while the amount is unreadable', async () => {
    const sent: unknown[] = [];
    render(
      <IssueForm
        account={DANA}
        busy={false}
        error={null}
        failed={false}
        onSubmit={(input) => {
          sent.push(input);
          return Promise.resolve(true);
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '12.7501' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x' } });
    // The server's own sentence, pre-empted — and the button cannot be pressed.
    expect(screen.getByText(/isn’t an amount/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Issue voucher' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(sent).toEqual([]);
  });

  /**
   * THERE IS NO CODE FIELD — `POST /v1/vouchers` refuses a client-supplied one by
   * name (400 `code_not_client_supplied`), because "a console that chose the code
   * could choose a guessable one". `Admins.tsx`'s missing password field, one door
   * along, and pinned the same way: the form cannot send what it has no input for.
   */
  it('offers no field for a code the server would refuse', () => {
    render(
      <IssueForm
        account={DANA}
        busy={false}
        error={null}
        failed={false}
        onSubmit={() => Promise.resolve(true)}
      />,
    );
    expect(screen.queryByLabelText(/code/i)).toBeNull();
    expect(screen.getByText(/AVO generates the code/)).toBeTruthy();
  });
});

/* ============================================ the courtesy on the row cell == */

/**
 * THE SIXTH COLUMN OFFERS THE PANEL ON EXACTLY THE ROWS THE API WOULD SERVE.
 *
 * Both refusals were driven against the real API and both are the server's:
 *
 *   a staff id      -> 404 unknown_member  "No such customer."   (a voucher is
 *                      bound to a `member`; `STF-NOURA` is not one)
 *   an erased member-> 409 member_erased   "That account has been erased."
 *
 * So these assertions are about the COURTESY, not the control — the endpoint
 * refuses both with this column deleted. What they pin is that the courtesy
 * agrees with the door, which is the failure `Accounts.tsx` already fixed once
 * for the reset button and would otherwise have to find again here.
 */
describe('the Vouchers cell is offered where the API would answer', () => {
  function row(account: PlatformAccount, open = false) {
    return render(
      <table>
        <tbody>
          <AccountRow
            account={account}
            sent={false}
            sending={false}
            onSend={() => {}}
            vouchersOpen={open}
            onVouchers={() => {}}
          />
        </tbody>
      </table>,
    );
  }

  it('offers it on a live customer', () => {
    row(DANA);
    const button = screen.getByRole('button', { name: 'Show vouchers for Dana Al-Sabah' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Nothing to point at while the panel is closed — see Accounts.tsx § the cell.
    expect(button.getAttribute('aria-controls')).toBeNull();
  });

  it('points at the open panel once it exists', () => {
    row(DANA, true);
    const button = screen.getByRole('button', { name: 'Hide vouchers for Dana Al-Sabah' });
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe('vouchers-8842');
  });

  it('offers nothing on a staff row — a voucher is bound to a member', () => {
    row({
      ...DANA,
      id: 'STF-NOURA',
      kind: 'staff',
      name: 'Noura Al-Rashid',
      handle: 'noura',
      role: 'owner',
    });
    expect(screen.queryByRole('button', { name: /vouchers for/i })).toBeNull();
  });

  it('offers nothing on a tombstone — the issue endpoint refuses one', () => {
    row({ ...DANA, status: 'erased' });
    expect(screen.queryByRole('button', { name: /vouchers for/i })).toBeNull();
  });

  it('still offers it on a deletion-requested account, which is still a live wallet', () => {
    row({ ...DANA, status: 'deletion_requested' });
    expect(screen.getByRole('button', { name: /vouchers for Dana Al-Sabah/ })).toBeTruthy();
  });
});

/**
 * NO SURFACE ON THIS SCREEN OFFERS CASH OR A CARD REVERSAL — non-negotiable #5.
 *
 * A SOURCE SCAN WITH COMMENTS BLANKED, for `consoleNavGates.test.ts`'s reason:
 * this file's own header discusses "cash", "refund" and "reversal" at length
 * while arguing that none of them belongs in the copy, so a naive `includes()`
 * would find the argument and report it as the violation. `stripComments` blanks
 * the prose and leaves the strings.
 *
 * It is a scan and not a render because the guarantee is about EVERY string in
 * the file, including ones only an error path reaches — and a render test can
 * only assert the branches it drives.
 */
describe('non-negotiable #5 — the copy never offers cash or a reversal', () => {
  it('contains no such word outside a comment', () => {
    const src = stripComments(
      readFileSync(join(__dirname, 'AccountVouchers.tsx'), 'utf8'),
    );
    for (const word of ['refund', 'cash', 'reversal', 'reverse', 'card back']) {
      expect(
        src.toLowerCase().includes(word),
        `AccountVouchers.tsx uses "${word}" in code or copy. A voucher is wallet ` +
          `credit; non-negotiable #5 allows no cash and no card reversal on any surface.`,
      ).toBe(false);
    }
  });

  it('says what a voucher is, in #5’s own terms', () => {
    const src = readFileSync(join(__dirname, 'AccountVouchers.tsx'), 'utf8');
    // The banner, which is the one place this is stated to the admin.
    expect(src).toContain('A voucher is wallet credit');
  });
});
