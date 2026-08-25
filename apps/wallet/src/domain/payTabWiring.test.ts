/**
 * That the Pay button actually consults the rule — asserted structurally.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS, IN TRUNK'S WORDS.
 *
 * `payTab.test.ts` proves the rule, including the biconditional over every shape
 * `PaymentCodeView` can take. Nothing proved that the BUTTON asks it. Trunk
 * mutated `App.tsx`'s handler — `if (payTabAction(codeView) === 'enlarge')` to
 * `if (true)` — and all 434 tests stayed green. Someone could delete or inline
 * that call and the suite would applaud, and the defect is the one §4 exists to
 * prevent: a stale code held up at a counter, looking like the salon's fault.
 *
 * TWO THINGS CLOSE IT, AND THE FIRST IS NOT A TEST.
 *
 *   1. The gate moved to the render. `QrOverlay`'s `open` prop is
 *      `enlargedCodeIsOpen(payRequested, codeView)`, so the same mutation now
 *      flips a request flag and opens nothing. That is the safety property, and
 *      it is enforced by arithmetic rather than by a handler's good behaviour.
 *   2. This file, which asserts the prop really is that call — because a
 *      derivation someone quietly replaces with `open={payRequested}` is back
 *      where we started, and that edit is one word long.
 *
 * WHY SOURCE TEXT AND NOT A RENDER. This workspace has no renderer, and it is
 * not an oversight — `vitest.config.ts` says so and LANES.md puts component
 * testing in lane D's column. There is no jsdom, no testing-library and no
 * react-test-renderer anywhere in the monorepo, and adding one means
 * `pnpm-lock.yaml` at the repo root, which is outside this lane. So this follows
 * `theme/brandBootOrder.test.ts`, which defends an equally invisible property —
 * the brand boot order — by reading the source rather than importing it.
 *
 * WHAT THAT DOES NOT BUY. This asserts the code SAYS the right thing, not that
 * React renders it. A render test remains worth having and belongs to lane D;
 * it would subsume every assertion below. Reported rather than faked.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** apps/wallet — two levels up from src/domain. */
const APP_DIR = resolve(__dirname, '..', '..');
const APP = readFileSync(join(APP_DIR, 'App.tsx'), 'utf8');

/**
 * The text of one JSX element, `<Name` up to the matching `/>`.
 *
 * Deliberately crude and deliberately anchored: every element it is used on is
 * self-closing in this file, and a `>` inside a prop expression would be caught
 * by the known-positive below rather than silently returning half an element.
 */
function element(name: string): string {
  const start = APP.indexOf(`<${name}`);
  expect(start, `<${name} is not in App.tsx at all`).toBeGreaterThan(-1);
  const end = APP.indexOf('/>', start);
  expect(end, `<${name} has no self-closing tag`).toBeGreaterThan(start);
  return APP.slice(start, end + 2);
}

/** The body of a `const <name> = () => { ... };` arrow at module or hook scope. */
function handler(name: string): string {
  const start = APP.indexOf(`const ${name} = () => {`);
  expect(start, `${name} is not declared in App.tsx`).toBeGreaterThan(-1);
  const end = APP.indexOf('\n  };', start);
  expect(end, `${name} has no closing brace at hook scope`).toBeGreaterThan(start);
  return APP.slice(start, end);
}

describe('the reader reads the real file', () => {
  /**
   * KNOWN-POSITIVE FIRST, for `brandBootOrder.test.ts`'s reason: a reader that
   * resolved nothing would satisfy every "does not contain" below by finding
   * nothing at all — a green bought with an empty string.
   */
  it('has App.tsx, and it is the shell', () => {
    expect(APP.length).toBeGreaterThan(5000);
    expect(APP).toContain('function Wallet({');
    expect(APP).toContain('function BottomNav({');
    expect(APP).toContain('<PaymentCodeLayer');
  });

  it('extracts whole elements, not fragments', () => {
    expect(element('PaymentCodeLayer')).toMatch(/^<PaymentCodeLayer[\s\S]*\/>$/);
    expect(handler('onPay')).toContain('const onPay = () => {');
  });
});

describe('the overlay cannot open behind the rule', () => {
  /**
   * THE ASSERTION THIS FILE WAS WRITTEN FOR.
   *
   * `open` must be the derived gate. `open={payRequested}` or `open={true}` puts
   * a 246pt payment code on the screen in states where `interaction-spec.md` §4
   * says there must be none.
   */
  it('gates QrOverlay on enlargedCodeIsOpen, not on the raw request', () => {
    const layer = element('PaymentCodeLayer');
    expect(layer).toContain('open={enlargedCodeIsOpen(payRequested, codeView)}');
    expect(layer).not.toMatch(/open=\{payRequested\}/);
    expect(layer).not.toMatch(/open=\{true\}/);
  });

  it('imports that gate from the module that owns the rule', () => {
    expect(APP).toMatch(
      /import \{[^}]*\benlargedCodeIsOpen\b[^}]*\} from '\.\/src\/domain\/payTab'/,
    );
  });

  it('keeps exactly one overlay, so there is one place to get this wrong', () => {
    expect(APP.split('<PaymentCodeLayer').length - 1).toBe(1);
    expect(APP.split('<QrOverlay').length - 1).toBe(1);
  });

  /**
   * The request flag is set to a DECISION, never to a bare `true`, in the Pay
   * handler. The wallet card's panel is the one place a literal `true` is
   * correct — design:254 and design:627 are the same handler, and that call site
   * is reachable only from the `ready` panel and passes the gate above anyway.
   */
  it('never opens the code from a hard-coded true outside the ready panel', () => {
    const literals = APP.split('setPayRequested(true)').length - 1;
    expect(literals).toBe(1);
    expect(element('HomeScreen')).toContain('onEnlargeCode={() => setPayRequested(true)}');
  });
});

describe('the Pay button asks payTabAction', () => {
  it('reads the decision once and applies both halves of it', () => {
    const onPay = handler('onPay');
    expect(onPay).toContain('payTabAction(codeView)');
    // Both arms, from the one read — they must not be able to disagree.
    expect(onPay).toContain("setPayRequested(action === 'enlarge')");
    expect(onPay).toContain("if (action === 'home') goHome();");
  });

  it('is what the Pay button is actually bound to', () => {
    const nav = APP.slice(APP.indexOf('<BottomNav'), APP.indexOf('/>', APP.indexOf('<BottomNav')));
    expect(nav).toContain('onPay={onPay}');
    // And the nav item itself is wired to that prop, not to something adjacent.
    const payItem = APP.slice(APP.indexOf('label={copy.navPay}'));
    expect(payItem.slice(0, 400)).toContain('onPress={onPay}');
  });

  it('takes the decision from the same codeView the panel renders', () => {
    // One `paymentCodeView(` call in the whole shell. Two would be two opinions
    // about when a QR may be shown, and the one that mattered would be whichever
    // ran offline.
    expect(APP.split('paymentCodeView({').length - 1).toBe(1);
    expect(element('HomeScreen')).toContain('codeView={codeView}');
    expect(element('PaymentCodeLayer')).toContain('codeView={codeView}');
  });
});

describe('the bottom nav is the four buttons design:623-627 draws', () => {
  const nav = APP.slice(APP.indexOf('function BottomNav('), APP.indexOf('function NavItem('));

  it('renders four items and no more', () => {
    expect(nav.split('<NavItem').length - 1).toBe(4);
  });

  it('labels them from the design line that defines all four', () => {
    expect(nav).toContain('label={copy.navHome}');
    expect(nav).toContain('label={copy.navBook}');
    expect(nav).toContain('label={copy.navShop}');
    // The one that was missing for months while the other three cited the very
    // design line that defines it.
    expect(nav).toContain('label={copy.navPay}');
  });

  it('renders Pay inactive unconditionally, per design:1897', () => {
    // `navPayStyle: this.navStyle(false)` where the other three are computed
    // from `s.screen`. It opens a layer; there is no screen for it to be on.
    const payItem = nav.slice(nav.indexOf('label={copy.navPay}'));
    expect(payItem).toContain('active={false}');
    expect(payItem).not.toMatch(/active=\{screen === 'pay'\}/);
  });

  it('announces Pay as a button and the other three as tabs', () => {
    const payItem = nav.slice(nav.indexOf('label={copy.navPay}'), nav.indexOf('label={copy.navPay}') + 400);
    expect(payItem).toContain('role="button"');
    expect(nav.split('role="button"').length - 1).toBe(1);
  });

  /**
   * design:623 is literally `justify-content:space-between`. It was
   * `space-around` while the nav held two, then three items; with the design's
   * own four it is the design's own value, and this is a visual change to a
   * shipped screen that should not drift back unnoticed.
   */
  it('uses the design\'s own justification', () => {
    const navStyle = APP.slice(APP.indexOf('  nav: {'), APP.indexOf('  overlayLayer: {'));
    expect(navStyle).toContain("justifyContent: 'space-between'");
    expect(navStyle).not.toContain("justifyContent: 'space-around'");
  });
});
