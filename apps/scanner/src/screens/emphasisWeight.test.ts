/**
 * INLINE EMPHASIS IS 600; A BADGE IS 700. DECISIONS.md #115.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS RATHER THAN A COMMENT.
 *
 * The design bundle renders a bare `<b>` at 700 — measured in a browser, not
 * assumed — and this lane reported that measurement and stopped, because nothing
 * in the bundle assigns 600 to the two spans it governs
 * (AVO Staff Scanner.dc.html:354 and :364). Trunk ruled on the whole bundle: of
 * 34 `<b>` elements exactly two carry an explicit weight and both say 600, and
 * `design/tokens/avo-tokens.json` contains no 700 anywhere in its type scale
 * (displayXL/L/M/S 500, money 600, label 600, body* 400). A weight absent from
 * the designer's own typed system is not the intended weight for body emphasis.
 *
 * THE ANCHOR THE ESCALATION MISSED, AND IT IS IN THIS FILE'S OWN SCREEN.
 * `MemberScreen` already drew emphasised body copy at 12.5/600 in two places
 * before this change — `typed-refusal-unknown` and `charge-unknown-outcome`,
 * both `ui(12.5, '600')`. So the two sites below were not merely ambiguous
 * against the bundle, they disagreed with their own file at the same size. Had
 * the earlier audit read the failure branches it could have resolved this inside
 * the column. Recorded because "I have no anchor in my column" was the whole
 * basis for escalating, and it was false.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ASSERTION IS AN EQUALITY, NOT A CEILING.
 *
 * Freezing the exact set of 700 call sites means a new badge has to be declared
 * here and a 700 that creeps back onto a sentence fails. A ratchet that only
 * counts up is a ratchet nobody updates.
 *
 * AND IT CHECKS THE RESOLVED FACE, NOT THE ARGUMENT. `ui()` maps family+weight
 * onto a single-weight registered face; `face()` silently falls back to 400 for
 * a weight that has none. Asserting the string '600' went in would pass even if
 * `Inter_600SemiBold` were unregistered and the text rendered Regular. The
 * fontFamily that comes out is the thing that draws.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ui } from '../theme';

const SRC = path.resolve(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
    return [p];
  });
}

/** Every `ui(size, 'weight')` call in the app, as `path:line ui(size,'weight')`. */
function uiCallsAtWeight(weight: string): string[] {
  const out: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file);
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        for (const m of line.matchAll(/\bui\(\s*([\d.]+)\s*,\s*'(\d{3})'\s*\)/g)) {
          if (m[2] === weight) out.push(`${rel}:${i + 1} ui(${m[1]},'${m[2]}')`);
        }
      });
  }
  return out.sort();
}

describe('inline emphasis in body copy is 600 — DECISIONS.md #115', () => {
  // AVO Staff Scanner.dc.html:354 (the held-deposit chip) and :364 (the
  // shortfall line). Both are product copy inside a tinted chip, not the
  // developer-addressed banner prose that the other bare <b>s are.
  it.each([
    ['screens/MemberScreen.tsx', 402, 'the held-deposit figure'],
    ['screens/MemberScreen.tsx', 475, 'the shortfall figure'],
  ])('%s:%d — %s is drawn at 600', (rel, line) => {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8').split('\n');
    expect(src[line - 1]).toContain("ui(12.5, '600')");
  });

  it('resolves 12.5/600 to the SemiBold face that is actually registered', () => {
    // App.tsx loads Inter_600SemiBold. If it did not, `face()` would fall back
    // to Inter_400Regular here and the emphasis would silently vanish — which
    // is the one way this ruling could have made the screen worse.
    expect(ui(12.5, '600')).toEqual({ fontSize: 12.5, fontFamily: 'Inter_600SemiBold' });
    expect(ui(12.5, '700').fontFamily).toBe('Inter_700Bold');
  });

  it('leaves 700 on badges only, and on exactly these', () => {
    // design/tokens/avo-tokens.json has no 700; every 700 in the bundle sits on
    // a badge, pill or tag. `bookingsNew` is the NEW pill at design:155.
    //
    // MOVED 268 → 368 → 486, AND THE SET STILL DID NOT GROW. The third move is
    // the reversed-booking pill ("Payment voided"), which took 600 for the same
    // ALERT-versus-DESCRIPTION reason: a void is finished, is somebody else's
    // action, and offers the artist no affordance at all — she holds neither
    // `perms.void` nor `perms.charges` — so drawing it at NEW's weight would
    // promise a response she cannot make. That row is kept from receding by
    // elevation and colour instead, which is why the type scale is untouched.
    // Reasoning at `BookingsScreen.tsx § VOIDED_PILL`.
    //
    // MOVED 268 → 368, AND THE SET DID NOT GROW. The booking status pill
    // ("Paid", and three siblings) landed in the slot directly below NEW and
    // took 600, so this equality caught the shift and nothing else. That is the
    // whole badge-versus-emphasis argument, executable: inside that one card the
    // deposit, tier and source pills are already 600 and only NEW is 700, which
    // makes the line ALERT versus DESCRIPTION rather than badge versus prose. A
    // finished appointment is the least alerting row on the screen. The
    // reasoning is at `BookingsScreen.tsx § STATUS_PILL`.
    //
    // REPORTED AGAIN, AND IT IS NOW COSTING MORE THAN IT REPORTS: pinning the
    // LINE makes this fail on any edit above it, including a comment. It moved
    // TWICE MORE inside the reversed-booking slice — once for the code and once
    // for a stale-comment fix three hundred lines above the call site, which is
    // a red gate for a change that could not possibly affect a font weight.
    // Four moves, zero membership changes. It moved twice inside one slice. The membership is the claim;
    // the line number is incidental to it. Asserting the call sites without
    // their line numbers, or keying them off a marker comment, would keep the
    // ratchet and drop the noise. Left alone here because changing how a
    // trunk-ruled test states its rule is not a thing to do inside the slice
    // that trips it.
    expect(uiCallsAtWeight('700')).toEqual([
      // THE LINE MOVED AGAIN — FIFTH TIME, STILL ZERO MEMBERSHIP CHANGES. The
      // zero-deposit and three-source slice added `SOURCE_PILL`, `clientName`
      // and their comment blocks above this call. `NEW` is still the only 700
      // in the app, which is the invariant this spec actually holds.
      //
      // Reported for the fifth time, and the count is now the argument: every
      // move has been a false red, and a reader who sees this fail learns
      // nothing about font weights. The fix is one line — strip `:NNN` before
      // comparing — and it is still not taken here, because rewriting how a
      // trunk-ruled test states its rule inside the slice that trips it is how
      // a ratchet gets quietly loosened by the person it caught.
      "screens/BookingsScreen.tsx:704 ui(10,'700')",
    ]);
  });
});
