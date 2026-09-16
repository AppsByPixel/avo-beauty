/**
 * A CHANGED REASON MUST NOT REUSE A BURNT KEY — and the code must actually go.
 *
 * =============================================================================
 * THE DEFECT, AND HOW IT IS REACHED
 * =============================================================================
 * `attemptKey` is minted ONCE per sheet (`useRef(newIdempotencyKey())`), and
 * `reason` is state that can change after a confirm. `reasonCode` is in the
 * server's request hash — `hashRequestBody({ transactionId, reason, reasonCode })`,
 * api/src/routes/charges.ts — so:
 *
 *     pick "wrong" -> confirm -> the response is lost -> pick "dupe" -> confirm
 *         => same key, different body => 422 idempotency_key_reused
 *
 * The first confirm has to have COMMITTED for this to bite, and that is exactly
 * the case idempotency exists for. A refusal does not burn the key: `claimKey`
 * runs inside `performVoid`'s transaction, so a 403/409/window-closed rolls the
 * claim back with everything else. What burns it is the void succeeding and the
 * client not learning that — a dropped connection after commit, a timeout.
 *
 * REPRODUCED LIVE before it was fixed, on `avo_lane_b` against the API on :4700:
 *
 *     POST /voids  key=lane-b-void-309814078  reason="Wrong amount or service"
 *                  reasonCode=wrong                                  -> HTTP 200
 *     POST /voids  key=lane-b-void-309814078  reason="Duplicate charge"
 *                  reasonCode=dupe
 *       {"error":"idempotency_key_reused",
 *        "message":"That Idempotency-Key was already used for a different
 *                   request. Use a new key."}                        -> HTTP 422
 *
 * AND THE FIX IS NOT "IT NOW SUCCEEDS", which is the part worth being precise
 * about. With a fresh key the same second confirm answers:
 *
 *       {"error":"already_voided",
 *        "message":"That charge has already been voided. The customer was
 *                   refunded to her wallet."}                        -> HTTP 409
 *
 * — measured, same database, same charge. That is the TRUE answer and the sheet
 * already renders it (`err.message`). The 422 is a sentence about plumbing that
 * tells her to "use a new key", which she has no way to do; the 409 tells her
 * what happened to the customer's money. Minting the key changes which of those
 * two she reads.
 *
 * `MemberScreen.tsx` solved this exact shape for the charge —"EDITING THE FIGURE
 * OR THE REASON MINTS A NEW KEY" — and this sheet did not.
 *
 * =============================================================================
 * THE HARNESS
 * =============================================================================
 * The scanner has no renderer (DECISIONS.md § "#38 — two surfaces of three"), so
 * React's hooks are mocked with an index-keyed store and the component is called
 * as a function, the same way the screen tests walk `BookingCard`'s tree. That
 * is enough for this claim because the claim is about a ref and a state value,
 * not about layout: `renderSheet()` re-runs the component against the SAME
 * store, which is what makes "press, then press again" meaningful.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ------------------------------------------------------------- the hooks --

let store: unknown[] = [];
let cursor = 0;

vi.mock('react', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = cursor++;
      if (!(i in store)) store[i] = typeof init === 'function' ? (init as () => unknown)() : init;
      return [
        store[i],
        (next: unknown) => {
          store[i] = typeof next === 'function' ? (next as (p: unknown) => unknown)(store[i]) : next;
        },
      ];
    },
    useRef: (init: unknown) => {
      const i = cursor++;
      if (!(i in store)) store[i] = { current: init };
      return store[i];
    },
    useCallback: (fn: unknown) => fn,
  };
});

vi.mock('react-native', () => {
  const passthrough = (name: string) => name;
  return {
    Modal: passthrough('Modal'),
    View: passthrough('View'),
    Text: passthrough('Text'),
    Pressable: passthrough('Pressable'),
    StyleSheet: { create: (s: unknown) => s, flatten: (s: unknown) => s, hairlineWidth: 1 },
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios },
    ActivityIndicator: passthrough('ActivityIndicator'),
  };
});

const voidCharge = vi.fn();
vi.mock('../api/charges', () => ({ voidCharge: (...a: unknown[]) => voidCharge(...a) }));

const { VoidSheet } = await import('./VoidSheet');
const { ApiError } = await import('../api/client');
const { copy } = await import('../copy/en');

// ------------------------------------------------------------- the walker --

interface Node {
  props: Record<string, unknown>;
}

function flatten(node: unknown, out: Node[] = []): Node[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  const el = node as { props?: Record<string, unknown> };
  if (!el.props) return out;
  out.push({ props: el.props });
  flatten(el.props.children, out);
  return out;
}

const props = {
  transactionId: 'TX-7075011',
  accessToken: 'staff-token',
  onClose: () => {},
  onVoided: vi.fn(),
};

/** Re-runs the component against the SAME hook store — a re-render, not a remount. */
function renderSheet() {
  cursor = 0;
  const nodes = flatten(VoidSheet(props));
  return {
    press: async (testID: string) => {
      const node = nodes.find((n) => n.props.testID === testID);
      if (!node) throw new Error(`no node with testID ${testID}`);
      await (node.props.onPress as () => unknown | Promise<unknown>)();
    },
    checked: nodes
      .filter((n) => typeof n.props.testID === 'string' && String(n.props.testID).startsWith('void-reason-'))
      .filter((n) => (n.props.accessibilityState as { checked?: boolean } | undefined)?.checked)
      .map((n) => String(n.props.testID)),
  };
}

/** The lost response: the void committed, the client never found out. */
const lostResponse = () =>
  voidCharge.mockRejectedValueOnce(
    new ApiError({ kind: 'offline', message: copy.errorBody, reference: 'SCN-1000-1000' }),
  );

beforeEach(() => {
  store = [];
  cursor = 0;
  voidCharge.mockReset();
});

describe('the sheet sends the code as well as the words', () => {
  /**
   * NON-NEGOTIABLE #2 IN ITS SMALLEST FORM: the code is the SERVER's, and it is
   * sent as the id the user chose, not re-derived from the label, the index or
   * anything else. Without it every void from this app stores NULL and the
   * artist's card stays blank.
   */
  it('sends reasonCode alongside the written label', async () => {
    voidCharge.mockResolvedValueOnce({ ok: true, refundedFils: 8000, visitRemoved: true });
    await renderSheet().press('void-confirm');

    const [input] = voidCharge.mock.calls[0]!;
    console.log('body sent:', JSON.stringify(input));
    expect(input).toEqual({
      transactionId: 'TX-7075011',
      reason: 'Wrong amount or service',
      reasonCode: 'wrong',
    });
  });

  it('sends the code the artist actually picked, not the default', async () => {
    voidCharge.mockResolvedValueOnce({ ok: true, refundedFils: 8000, visitRemoved: true });
    await renderSheet().press('void-reason-cust');
    const after = renderSheet();
    expect(after.checked).toEqual(['void-reason-cust']);
    await after.press('void-confirm');

    const [input] = voidCharge.mock.calls[0]!;
    expect(input).toEqual({
      transactionId: 'TX-7075011',
      reason: 'Customer did not receive service',
      reasonCode: 'cust',
    });
  });

  /**
   * THE LABEL IS STILL SENT, unchanged, and that is not belt-and-braces. It is
   * what lands in `transaction.note` and in the audit log's `detail`
   * (api/src/routes/charges.ts § writeAudit), where a merchant or the platform
   * console reads it as a sentence — "wrong" there would be meaningless. The
   * code is for the screen; the words are for the record.
   */
  it('still sends the written label, because that is what the audit log reads', async () => {
    voidCharge.mockResolvedValueOnce({ ok: true, refundedFils: 8000, visitRemoved: true });
    await renderSheet().press('void-confirm');
    const [input] = voidCharge.mock.calls[0]!;
    expect((input as { reason: string }).reason).toBe(copy.voidReasons[0].label);
  });
});

describe('a changed reason mints a new key', () => {
  /**
   * THE DEFECT. Before the fix both calls carried the SAME key with different
   * bodies, which is the 422 reproduced in this file's header.
   */
  it('does not reuse the key the first attempt burnt', async () => {
    lostResponse();
    await renderSheet().press('void-confirm');

    await renderSheet().press('void-reason-dupe');

    voidCharge.mockResolvedValueOnce({ ok: true, refundedFils: 8000, visitRemoved: true });
    await renderSheet().press('void-confirm');

    const [firstBody, firstKey] = voidCharge.mock.calls[0]!;
    const [secondBody, secondKey] = voidCharge.mock.calls[1]!;
    console.log('first :', JSON.stringify(firstBody), firstKey);
    console.log('second:', JSON.stringify(secondBody), secondKey);

    expect(firstBody).not.toEqual(secondBody);
    expect(secondKey).not.toBe(firstKey);
  });

  /**
   * THE OTHER HALF, and it is the one a careless fix breaks: minting on every
   * confirm would turn a genuine retry into a DOUBLE REFUND. Non-negotiable #4
   * is that one key names one attempt — a retry of the same attempt must replay,
   * not re-void. Same reason, pressed twice, one key.
   */
  it('keeps the key across a retry of the SAME reason, which is what #4 is for', async () => {
    lostResponse();
    await renderSheet().press('void-confirm');

    voidCharge.mockResolvedValueOnce({ ok: true, refundedFils: 8000, visitRemoved: true });
    await renderSheet().press('void-confirm');

    const [, firstKey] = voidCharge.mock.calls[0]!;
    const [, secondKey] = voidCharge.mock.calls[1]!;
    console.log('retry keys:', firstKey, secondKey);
    expect(secondKey).toBe(firstKey);
  });

  /**
   * Re-picking the reason she already had still mints. `MemberScreen`'s
   * `editReason` does the same and it is the safer direction: a key that is
   * merely fresh costs nothing, and a comparison here would have to know that
   * the id it is comparing is the whole of what the server hashes — which it is
   * not (`transactionId` and `reason` are in the hash too).
   */
  it('mints on any pick, without trying to be clever about whether it changed', async () => {
    lostResponse();
    await renderSheet().press('void-confirm');

    await renderSheet().press('void-reason-wrong');

    voidCharge.mockResolvedValueOnce({ ok: true, refundedFils: 8000, visitRemoved: true });
    await renderSheet().press('void-confirm');

    const [, firstKey] = voidCharge.mock.calls[0]!;
    const [, secondKey] = voidCharge.mock.calls[1]!;
    expect(secondKey).not.toBe(firstKey);
  });
});
