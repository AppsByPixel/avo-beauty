/**
 * TYPE FIDELITY — does the weight a style asks for reach a face that can draw it?
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY A WEIGHT CAN BE DECLARED AND STILL NOT HAPPEN
 * ─────────────────────────────────────────────────────────────────────────────
 * `text()` pins `fontFamily` to ONE single-weight face — `Inter_400Regular`,
 * `Inter_600SemiBold`, and so on — because React Native resolves a numeric
 * weight to a face only if that face is registered, and the Google Fonts
 * packages register one family name per weight. That is the right design and
 * `theme/index.ts` explains it at length.
 *
 * Its consequence is the thing this file exists for. A later object in the same
 * style array that raises `fontWeight` does not move the family, so the style
 * ends up asking for a weight the named face cannot supply:
 *
 *     StyleSheet.flatten([text('bodyS', 'en'), { fontWeight: '600' }])
 *       // { fontSize: 12.5, fontWeight: '600', fontFamily: 'Inter_400Regular' }
 *
 * Nothing fails. Nothing warns. `Inter_600SemiBold` is loaded in App.tsx and is
 * demonstrably reachable — `text('label')` selects it — and this style simply
 * never asks for it.
 *
 * IN ARABIC IT IS NON-NEGOTIABLE #12, NOT A COSMETIC MISS. The same composition
 * resolves to `IBMPlexSansArabic_400Regular` while `IBMPlexSansArabic_600SemiBold`
 * sits loaded and unused. An emphasis the design specifies disappears in the
 * language the build agreement calls "a first-class layout, not a translation
 * pass". The face is there; the code does not ask for it.
 *
 * WHAT THIS FILE DOES NOT CLAIM. It does not claim these sites render at exactly
 * 400 on every platform — a browser will synthesise a faux bold, and the native
 * platforms differ. It claims the narrower and fully checkable thing: the real
 * SemiBold/Bold face this app loads is never selected at these sites, so what is
 * drawn is not the design's type either way.
 *
 * THE METHOD IS `contrast.test.ts`'s, AND FOR THE SAME REASON. React Native has
 * no DOM to scan, so the honest check is the source, read exhaustively, with the
 * resolution maths applied rather than eyeballed.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE, MEASURED 2026-09-15 AGAINST THE DESIGN BUNDLE
 *
 * The design's weight vocabulary, counted across all six `design/*.dc.html`:
 * 556 × 600, 193 × 500, 11 × 700, 2 × 400 — and `design/tokens/avo-tokens.json`
 * carries no 700 in the type scale at all. All eleven 700s are badges, pills and
 * tags. So a build 700 is correct on a badge and wrong on a sentence.
 *
 * The count above is of EXPLICIT `font-weight:` declarations only. The bundle
 * also carries 34 `<b>` elements with no `b {}` rule anywhere, which compute to
 * 700 in a browser — measured, not assumed. Seventeen of those are the
 * developer-addressed banner at the top of each file and are not product copy;
 * of the rest, exactly two are product copy inside this lane's column
 * (AVO Staff Scanner.dc.html:354 and :364).
 *
 * THOSE TWO NOW DRAW AT 600, AND THIS PARAGRAPH USED TO SAY THE OPPOSITE. It
 * read "`apps/scanner` already draws both at `ui(12.5, '700')` — `Inter_700Bold`,
 * the right face, matching", which was an accurate measurement resting on a
 * wrong premise: that a bare `<b>`'s rendered 700 is the design's intent. Trunk
 * ruled otherwise (DECISIONS.md #115) on the evidence that
 * `design/tokens/avo-tokens.json` carries no 700 at all, so inline emphasis in
 * body copy is 600 and 700 belongs to badges. The scanner's own
 * `MemberScreen` already drew 12.5/600 emphasis in its failure branches, so the
 * two sites also disagreed with their own file. `apps/scanner/src/screens/
 * emphasisWeight.test.ts` holds the line there; the sentence is corrected here
 * because this file's census is what a later reader will cite.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { StyleSheet } from 'react-native';
import { text } from './index';

const SRC = path.resolve(__dirname, '..');

/**
 * `App.tsx` SITS BESIDE `src/`, NOT INSIDE IT — AND THAT IS THE FIRST THING THE
 * WIDENING FOUND, BEFORE ANY REGEX CHANGED.
 *
 * `sourceFiles(SRC)` never reached it, so the weight scan below had simply never
 * read the file. The language scan at the foot of this file HAD noticed and
 * appended it by hand, and the two scans therefore disagreed, silently, about
 * what "the app" is. `App.tsx:843` was the plainest possible instance of the
 * defect — `[text('bodyS', lang), styles.navBadgeText]` over a faceless
 * `fontWeight: '700'`, the exact shape all 83 had — and it escaped the census
 * not because the detector was too narrow but because nothing opened the file.
 *
 * One list now, used by both scans, so the disagreement cannot come back.
 */
const APP_ENTRY = path.resolve(SRC, '..', 'App.tsx');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
    return [p];
  });
}

/** Every file in this lane's column that can hold a style. */
function allSources(): string[] {
  return [...sourceFiles(SRC), APP_ENTRY];
}

/** Keyed relative to `src/`, with `App.tsx`'s leading `../` flattened away. */
function relativeSource(file: string): string {
  return path.relative(SRC, file).replace(/^\.\.\//, '');
}

/**
 * Source with its comments blanked and its line count preserved.
 *
 * NOT AN OPTIMISATION — A CORRECTNESS REQUIREMENT OF THE WIDENING. This app
 * explains the defect by QUOTING it: `theme/index.ts:117` writes
 * `StyleSheet.flatten([text('bodyS', 'en'), { fontWeight: '600' }])` in a
 * docblock, and `WalletCard.tsx:181` names a `fontWeight: '500'` that used to
 * live in an object. The narrow detector could not see either, because it only
 * followed `styles.X`. The widened one reads inline objects, so the moment it
 * stopped stripping prose it would report three sites nobody can fix. The
 * language scan already did this for the same reason; it is now one function.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** The body of the `{`/`[` opening at `open`, balanced across nesting. */
function readBalanced(src: string, open: number): string {
  const opener = src[open]!;
  const closer = opener === '[' ? ']' : '}';
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === opener) depth += 1;
    else if (src[i] === closer) {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
}

/** A composition's elements, split on the commas that are not inside anything. */
function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let d = 0;
  for (const c of body) {
    if ('([{'.includes(c)) d += 1;
    if (')]}'.includes(c)) d -= 1;
    if (c === ',' && d === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  parts.push(cur.trim());
  return parts;
}

/** Every `{...}` written directly into a composition element. */
function objectLiterals(part: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < part.length; i += 1) {
    if (part[i] !== '{') continue;
    const body = readBalanced(part, i);
    out.push(body);
    i += body.length + 1;
  }
  return out;
}

const DECLARES_WEIGHT = /fontWeight:\s*'?(\d{3})'?/;
const NAMES_A_FACE = /fontFamily:/;

/** The nearest `function X` / `const X =` above a point — what owns the code there. */
function ownerOf(prefix: string): string | undefined {
  let name: string | undefined;
  for (const m of prefix.matchAll(/\b(?:function\s+(\w+)|const\s+(\w+)\s*[:=])/g)) {
    name = m[1] ?? m[2];
  }
  return name;
}

/**
 * `styleName -> { weight, namesAFace }` for every style object in a file.
 *
 * WIDENED FROM ONE LINE TO A BALANCED READ. The old form was a per-LINE regex,
 * `(\w+): *\{([^}]*fontWeight: *'(\d+)'[^}]*)\}`, so it saw a style only when
 * the whole object was written on a single line. Six entries in this app are
 * not: `AccountScreen#avatarInitial`, `TopUpCard#amountText`, `Fields#code`,
 * `ContactSheet#refValue`, `TransactionSheet#rowValue` and `#rowValueMoney`.
 * All six happen to name their own face, so widening this changed no finding
 * today — which is the point worth writing down, because "it found nothing"
 * and "it could not look" had been indistinguishable here.
 */
function weightStyles(src: string): Map<string, { weight: string; namesAFace: boolean }> {
  const code = stripComments(src);
  const out = new Map<string, { weight: string; namesAFace: boolean }>();
  const entry = /(\w+)\s*:\s*\{/g;
  for (let m = entry.exec(code); m; m = entry.exec(code)) {
    const body = readBalanced(code, m.index + m[0].length - 1);
    const w = DECLARES_WEIGHT.exec(body);
    if (w) out.set(m[1]!, { weight: w[1]!, namesAFace: NAMES_A_FACE.test(body) });
  }
  return out;
}

/** The three calls that resolve a face from a token, and are therefore roots. */
const FACE_ROOTS = ['text', 'display', 'ui'] as const;

/**
 * EVERY CALL THAT PINS A FACE — DERIVED, NOT LISTED, BECAUSE LISTING IT IS WHAT
 * HID `micro()`.
 *
 * `text`/`display`/`ui` are the roots. (`display` and `ui` have no call site in
 * this app at all — they are the scanner lane's names, kept so one detector
 * reads the same in both columns.) A composition headed by any of them has its
 * family already decided, which is what makes a later `fontWeight` inert.
 *
 * But a root can be WRAPPED, and then the wrapper heads the composition:
 *
 *     export function micro(lang: Language): TextStyle {
 *       return { ...text('bodyS', lang), fontSize: 10.5, fontWeight: '600' };
 *     }
 *
 * `micro(lang)` pins a face exactly as `text()` does, and heads two
 * compositions in `BookingParts.tsx` whose styles raise a weight over it. A
 * hard-coded list of three could not see any of that. So the set is grown from
 * the source: a name is a base if it is a root, if it holds a root's result, or
 * if it spreads one. Grown to a fixed point, so a wrapper around a wrapper is
 * still a base.
 *
 * TWO SETS COME BACK, AND THE SPLIT IS A BLAST-RADIUS DECISION, NOT TIDINESS.
 * `bases` is everything; `wrappers` is only the names derived from the SPREAD
 * rule. The weight scan takes `bases`, because a name there is only ever
 * consulted when it heads a `[` composition or a `...` spread — a false one
 * costs nothing, since nothing else has that shape. The language scan takes
 * `wrappers`, because it checks every CALL to a name it is given, anywhere in
 * the file. Hand it a one-letter alias picked up from `const t = text(...)` and
 * it would start reading every `t('key')` in the i18n layer as a type call. No
 * such alias exists in this column today — which is exactly the condition under
 * which a hazard gets left in — so the narrower set is what the wider scan gets.
 */
function faceBases(code: string): { bases: Set<string>; wrappers: Set<string> } {
  const bases = new Set<string>(FACE_ROOTS);
  const wrappers = new Set<string>();
  for (let pass = 0; pass < 8; pass += 1) {
    const before = bases.size;
    const call = `(?:${[...bases].join('|')})\\s*\\(`;
    // `const chip = text('bodyS', lang)` — a base held in a variable.
    for (const m of code.matchAll(new RegExp(`\\bconst\\s+(\\w+)\\s*=\\s*${call}`, 'g'))) {
      bases.add(m[1]!);
    }
    // `function micro() { return { ...text(...), … } }` — a base wrapped.
    for (const m of code.matchAll(new RegExp(`\\.\\.\\.\\s*${call}`, 'g'))) {
      const owner = ownerOf(code.slice(0, m.index));
      if (owner) {
        bases.add(owner);
        wrappers.add(owner);
      }
    }
    if (bases.size === before) break;
  }
  return { bases, wrappers };
}

/** `text('bodyS', lang)` -> `bodyS`: a name for an override that has none. */
function baseLabel(call: string): string {
  return /'([A-Za-z0-9]+)'/.exec(call)?.[1] ?? call.replace(/\s+/g, ' ').trim();
}

/**
 * Every weight declared over a base that has already pinned the face. Keyed
 * `path#name`, so a style used from three call sites counts once — the defect
 * is in the style, not the call.
 *
 * THREE SHAPES NOW, WHERE THERE WAS ONE, AND THE NEW TWO WERE FOUND BY READING
 * ALL 36 `fontWeight` OCCURRENCES IN THE COLUMN RATHER THAN BY GUESSING:
 *
 *   1. `[base(...), styles.X]` — the original, and the shape all 83 had. It is
 *      no longer read per LINE. Four of the five sites this widening fixed are
 *      compositions written across several lines, which is the ordinary way to
 *      write one with three or more elements, so the per-line regex was blind
 *      to the majority shape rather than to an exotic one.
 *   2. `[base(...), { fontWeight: '600' }]` — an object literal written in
 *      place. There is no `styles.X` to follow, and following one was the whole
 *      method. `App.tsx`'s tab-bar label is this.
 *   3. `{ ...base(...), fontWeight: '600' }` — the spread form, which is how a
 *      helper returns a style. `micro()` is this.
 *
 * WHAT IT STILL CANNOT SEE, stated rather than left to be rediscovered: a base
 * that is not the FIRST element of its composition (later entries win in React
 * Native, so a trailing base overrides the weight outright — a different defect
 * with a different fix); a style object reached through anything other than a
 * `styles.X` member expression; and a weight computed at runtime rather than
 * written as a literal. None of the three occurs in this column today, each was
 * checked by reading, and each would be a new shape to add here.
 *
 * SPLIT FROM THE FILE WALK so the detector can be pointed at a string — with
 * the recorded list empty the suite's main assertion is "this returns nothing",
 * and an assertion of that shape passes just as well when the detector has been
 * broken as when the code is clean. The fixtures below feed it one source per
 * shape that IS defective and require it to say so.
 */
function inertInSource(rel: string, src: string, bases?: Set<string>): string[] {
  const code = stripComments(src);
  const alt = [...(bases ?? faceBases(code).bases)].join('|');
  const styles = weightStyles(code);
  const found = new Set<string>();

  // SHAPES ONE AND TWO — `[base(...), <overrides>]`, where an override is
  // either a `styles.X` reference or an object literal written in place.
  const composition = new RegExp(`\\[\\s*(?:${alt})\\s*\\(`, 'g');
  for (let m = composition.exec(code); m; m = composition.exec(code)) {
    const parts = topLevelParts(readBalanced(code, m.index));
    const label = baseLabel(parts[0] ?? '');
    for (const part of parts.slice(1)) {
      for (const ref of part.matchAll(/styles\.(\w+)/g)) {
        const s = styles.get(ref[1]!);
        if (s && !s.namesAFace) found.add(`${rel}#${ref[1]}`);
      }
      for (const obj of objectLiterals(part)) {
        const w = DECLARES_WEIGHT.exec(obj);
        if (w && !NAMES_A_FACE.test(obj)) found.add(`${rel}#inline(${label}:${w[1]})`);
      }
    }
  }

  // SHAPE THREE — `{ ...base(...), fontWeight: '600' }`. Keyed by the function
  // that owns it, because the object has no name of its own to key by.
  const spread = new RegExp(`\\.\\.\\.\\s*(?:${alt})\\s*\\(`, 'g');
  for (let m = spread.exec(code); m; m = spread.exec(code)) {
    const open = code.lastIndexOf('{', m.index);
    if (open < 0) continue;
    const body = readBalanced(code, open);
    const w = DECLARES_WEIGHT.exec(body);
    if (w && !NAMES_A_FACE.test(body)) {
      found.add(`${rel}#${ownerOf(code.slice(0, open)) ?? baseLabel(body)}()`);
    }
  }

  return [...found];
}

/**
 * The app-wide base set, because a wrapper and the composition it heads are not
 * in the same file: `micro()` is declared in `components/booking/tokens.ts` and
 * heads two compositions in `components/booking/BookingParts.tsx`. A per-file
 * derivation would have found `micro` in the file that cannot misuse it and
 * missed it in the file that did.
 */
function inertOverrides(): Set<string> {
  const files = allSources().map(
    (file) => [relativeSource(file), stripComments(fs.readFileSync(file, 'utf8'))] as const,
  );
  const bases = new Set<string>();
  for (const [, code] of files) for (const b of faceBases(code).bases) bases.add(b);
  const found = new Set<string>();
  for (const [rel, code] of files) for (const key of inertInSource(rel, code, bases)) found.add(key);
  return found;
}

/**
 * THE STANDING DEBT — PAID, AND THE LIST IS KEPT AS THE GUARD.
 *
 * It was eighty-three styles that raised a weight which never reached a face.
 * Every one declared the weight the design declares, so it was never a fidelity
 * mismatch: it was a rendering-layer defect with one mechanical fix — move the
 * weight onto `text()`'s third argument and drop `fontWeight` from the
 * `StyleSheet` object. It could not be fixed by putting `fontFamily` in the
 * style object instead, because the correct face depends on `lang` and a
 * `StyleSheet.create` object does not know the language.
 *
 * Recorded 2026-09-15, reported to trunk as its own slice, and done: all 83, in
 * 32 files, with no exception. Every one turned out to be the same shape — a
 * single-line style object whose every call site was already a
 * `[text(token, lang), styles.X]` composition — so nothing had to be left
 * behind. Two things the work order asked to watch for did not bite anywhere and
 * are recorded so nobody looks for them again: no style object mixed
 * `fontWeight` with `letterSpacing` or `textTransform` (the two `text()` drops
 * in Arabic), and no style was shared by two call sites wanting different
 * weights.
 *
 * THEN EIGHT MORE, AND THE LIST WAS EMPTY THE WHOLE TIME THEY EXISTED. That is
 * the part worth keeping. The 83 were everything the detector could SEE, and
 * the paragraph above calls them "the same shape" — which was true of the 83
 * and false of the column. Widening the detector to the shapes named in
 * `inertInSource`'s docblock, plus reading `App.tsx` at all, turned up eight
 * sites that had been there throughout:
 *
 *   App.tsx#navBadgeText          the cart count on the tab bar, 700 on a
 *                                 badge — the design's one correct 700 — and
 *                                 it was drawing Regular. Missed because
 *                                 nothing read the file, not because of a
 *                                 regex.
 *   App.tsx#inline(bodyS:600)     the tab-bar label, an object literal.
 *   CartSheet#rowValue            the totals value, a multi-line composition.
 *   TransactionSheet#pillText     the receipt status pill. The style held
 *                                 nothing but the inert weight, so it was
 *                                 deleted rather than emptied.
 *   BookingParts#slotText         the time-slot chip.
 *   booking/tokens.ts#micro()     the 10.5/600 micro-label, a helper. Its own
 *                                 docblock said the FAMILY comes off the token
 *                                 so Arabic resolves correctly — true, and the
 *                                 weight beside it did not.
 *   BookingParts#badgeTextLive    the availability badge, in both tones.
 *   BookingParts#badgeTextSalon   Composed after `micro()`, so once the helper
 *                                 asked for 600 these two declared a weight
 *                                 that was already arriving. Dropped, not
 *                                 moved: two sites, one weight, one place.
 *
 * All eight took the same mechanical fix as the 83 — the weight onto the base
 * call's third argument, `fontWeight` out of the object — so nothing had to be
 * left in the list. If one had not, it would be in the list below with a
 * sentence, because an accurate non-empty list is worth more than an empty one
 * that is wrong.
 *
 * THE EMPTY LIST STAYS, AND THE ASSERTION STAYS AN EQUALITY. It is what stops
 * the next one: a new `fontWeight` in a style object composed after `text()` is
 * a new inert override, and this goes red the day it is written. A ceiling would
 * not — and a debt list deleted the moment it reaches zero is a debt list that
 * has to be rediscovered by driving the app, which is how this one was found.
 *
 * AND IT IS ONLY WORTH THE LINE IT OCCUPIES IF THE DETECTOR CAN SEE. `toEqual([])`
 * passes identically whether the column is clean or the scan stopped scanning,
 * and the eight above are the proof that this is not a theoretical worry: the
 * list read `[]` and was wrong by eight for two days. The fixtures below are
 * the answer — one per shape the detector claims to cover, each with an
 * innocent neighbour it must leave alone.
 */
const KNOWN_INERT: string[] = [];

/** The weight a face name encodes, e.g. `Inter_600SemiBold` -> `600`. */
function weightOfFace(family: string | undefined): string | undefined {
  return /_(\d{3})/.exec(family ?? '')?.[1];
}

describe("text()'s weight override resolves a real face", () => {
  it('selects the SemiBold face in both languages, not the Regular one', () => {
    expect(text('bodyS', 'en', '600').fontFamily).toBe('Inter_600SemiBold');
    // Non-negotiable #12. The face is loaded in App.tsx; before the override
    // existed, nothing in this app could ask for it outside the `label` token.
    expect(text('bodyS', 'ar', '600').fontFamily).toBe('IBMPlexSansArabic_600SemiBold');
  });

  it('leaves the token weight alone when no override is passed', () => {
    expect(text('bodyS', 'en').fontFamily).toBe('Inter_400Regular');
    expect(text('bodyS', 'en').fontWeight).toBe('400');
    expect(text('label', 'ar').fontFamily).toBe('IBMPlexSansArabic_600SemiBold');
  });

  it('keeps the Arabic rules it already had — no tracking, no uppercase', () => {
    const ar = text('label', 'ar', '700');
    expect(ar.fontFamily).toBe('IBMPlexSansArabic_700Bold');
    expect(ar.letterSpacing).toBeUndefined();
    expect(ar.textTransform).toBeUndefined();
  });

  it('never silently returns a face of a different weight than the one asked for', () => {
    // `face()` falls back to 400 when a family has no face at the requested
    // weight — Fraunces stops at 600 — so an override that cannot be honoured
    // would flatten silently. Every (token, weight) pair used below is checked
    // rather than trusted.
    for (const lang of ['en', 'ar'] as const) {
      for (const weight of ['400', '500', '600', '700'] as const) {
        const f = text('bodyS', lang, weight).fontFamily;
        expect(weightOfFace(f), `bodyS/${lang}/${weight} -> ${f}`).toBe(weight);
      }
    }
  });
});

describe('the retry chips draw the weight the design draws', () => {
  // design/AVO States.dc.html:103, :137 and :224 — every "Try again" and
  // "Retry" in the bundle is font-weight:600. There is no 700 on a text action
  // anywhere in the design. Both chips previously declared 700 AND resolved to
  // Inter_400Regular, so they disagreed with the design twice over.
  it.each(['en', 'ar'] as const)('%s: the retry label resolves to a 600 face', (lang) => {
    const flat = StyleSheet.flatten([
      text('bodyS', lang, '600'),
      { color: '#8f5a56', textDecorationLine: 'underline' as const },
    ]);
    expect(flat.fontWeight).toBe('600');
    expect(weightOfFace(flat.fontFamily)).toBe('600');
  });

  it.each([
    'components/OrdersSheet.tsx',
    'components/FulfilmentSection.tsx',
  ])('%s no longer declares 700 on chipRetryText', (rel) => {
    const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
    expect(src).toMatch(/chipRetryText: \{[^}]*\}/);
    expect(weightStyles(src).has('chipRetryText')).toBe(false);
    expect(src).toContain("text('bodyS', lang, '600'), styles.chipRetryText");
  });
});

describe('the standing inert-override debt', () => {
  it('is exactly the recorded set — nothing added, nothing quietly fixed', () => {
    expect([...inertOverrides()].sort()).toEqual([...KNOWN_INERT].sort());
  });

  /**
   * THE GUARD ON THE GUARD, AND IT NOW COVERS THE WIDER SURFACE.
   *
   * `it('records the two this slice removed')` used to name
   * `OrdersSheet#chipRetryText` and `FulfilmentSection#chipRetryText` and assert
   * the scan did not contain them. That was real evidence while the recorded set
   * had 83 entries — it said "these two specifically are gone". With the set
   * empty the assertion above already says no style anywhere is in it, so naming
   * two of them proves nothing the line before it did not.
   *
   * What is worth asserting instead is the thing an empty expectation cannot say
   * for itself: that the detector still WORKS. `toEqual([])` passes if the
   * regexes stop matching, if `sourceFiles` returns nothing, if a refactor
   * quietly inverts a condition — and it would go on passing while inert
   * overrides piled back up.
   *
   * That argument was made when the detector knew one shape, and it is the
   * argument that convicted the detector: the list read `[]` while eight sites
   * stood in the column, because "found nothing" and "could not look" are the
   * same output. So there is now one fixture per shape `inertInSource` claims —
   * each defective ON PURPOSE, each with an innocent neighbour the detector must
   * leave alone. A shape added to the docblock without a fixture here is a claim
   * with nothing behind it.
   */
  it('shape one: the `[base(...), styles.X]` reference all 83 had', () => {
    const defective = [
      "        <Text style={[text('bodyL', lang), styles.rowName]}>{name}</Text>",
      "        <Text style={[text('bodyS', lang, '600'), styles.fixedName]}>{name}</Text>",
      "        <Text style={[text('bodyS', lang), styles.plainName]}>{name}</Text>",
      'const styles = StyleSheet.create({',
      "  rowName: { color: color.ink, fontWeight: '600' },",
      "  fixedName: { color: color.ink },",
      "  plainName: { color: color.ink },",
      '});',
    ].join('\n');

    expect(inertInSource('components/Fixture.tsx', defective)).toEqual([
      'components/Fixture.tsx#rowName',
    ]);
  });

  /**
   * AND THE SAME REFERENCE WRITTEN DOWN THE PAGE. This is not an exotic shape —
   * it is how anyone writes a composition with three or more elements, and four
   * of the five `styles.X` sites this slice fixed are written this way. The old
   * detector read one LINE at a time, so the majority shape was the invisible
   * one.
   */
  it('shape one again: the composition spread over several lines', () => {
    const defective = [
      '        <Text',
      '          style={[',
      "            text('bodyL', lang),",
      '            styles.slotText,',
      '            selected && styles.slotTextOn,',
      '          ]}',
      '        >',
      '          {label}',
      '        </Text>',
      '        <Text',
      '          style={[',
      "            text('bodyL', lang, '600'),",
      '            styles.doneText,',
      '          ]}',
      '        >',
      '          {label}',
      '        </Text>',
      'const styles = StyleSheet.create({',
      "  slotText: { color: color.ink, fontWeight: '600' },",
      '  slotTextOn: { color: WHITE },',
      '  doneText: { color: color.ink },',
      '});',
    ].join('\n');

    expect(inertInSource('components/Fixture.tsx', defective)).toEqual([
      'components/Fixture.tsx#slotText',
    ]);
  });

  /**
   * AND THE STYLE OBJECT WRITTEN DOWN THE PAGE TOO, which is the other half of
   * the same blindness: `weightStyles` also read one line at a time, so a style
   * whose braces span lines carried no weight as far as the detector was
   * concerned. Six entries in this app are written that way. All six name a
   * face, so this fixture is the only place the widening is visible — which is
   * exactly why it is here and not left to be noticed later.
   */
  it('shape one again: the style object spread over several lines', () => {
    const defective = [
      "        <Text style={[text('bodyL', lang), styles.figure]}>{amount}</Text>",
      "        <Text style={[text('bodyL', lang), styles.branded]}>{amount}</Text>",
      'const styles = StyleSheet.create({',
      '  figure: {',
      '    fontSize: 17,',
      "    fontWeight: '600',",
      '    color: color.ink,',
      '  },',
      '  branded: {',
      "    fontFamily: 'Fraunces_600SemiBold',",
      "    fontWeight: '600',",
      '    fontSize: 21,',
      '  },',
      '});',
    ].join('\n');

    expect(inertInSource('components/Fixture.tsx', defective)).toEqual([
      'components/Fixture.tsx#figure',
    ]);
  });

  /**
   * SHAPE TWO — an object literal written straight into the composition. There
   * is no `styles.X` to follow, and following one was the entire method, so this
   * was invisible by construction rather than by accident. `App.tsx`'s tab-bar
   * label was this. It is keyed by the base's token because the object has no
   * name of its own; the two innocent neighbours are the same shape carrying no
   * weight, and the same shape naming its own face.
   */
  it('shape two: an object literal written into the composition', () => {
    const defective = [
      "      <Text style={[text('bodyS', lang), { color: tint, fontWeight: '600', fontSize: 10.5 }]}>",
      '        {label}',
      '      </Text>',
      "      <Text style={[text('bodyS', lang), { color: tint, fontSize: 10.5 }]}>{label}</Text>",
      "      <Text style={[text('bodyS', lang, '600'), { color: tint }]}>{label}</Text>",
      "      <Text style={[text('displayS', lang), { fontFamily: 'Fraunces_600SemiBold', fontWeight: '600' }]}>",
      '        {initial}',
      '      </Text>',
    ].join('\n');

    expect(inertInSource('components/Fixture.tsx', defective)).toEqual([
      'components/Fixture.tsx#inline(bodyS:600)',
    ]);
  });

  /**
   * SHAPE THREE — the spread form, which is how a helper returns a style.
   * `micro()` is this, and its own docblock explains at length that the FAMILY
   * comes off the token so Arabic resolves correctly. That was true. The weight
   * on the next line was not, and no detector was looking at it.
   */
  it('shape three: a helper that spreads a base and then raises the weight', () => {
    const defective = [
      'export function micro(lang: Language): TextStyle {',
      "  return { ...text('bodyS', lang), fontSize: 10.5, fontWeight: '600' };",
      '}',
      'export function fixed(lang: Language): TextStyle {',
      "  return { ...text('bodyS', lang, '600'), fontSize: 10.5 };",
      '}',
      'export function branded(lang: Language): TextStyle {',
      "  return { ...text('bodyS', lang), fontFamily: 'Fraunces_600SemiBold', fontWeight: '600' };",
      '}',
    ].join('\n');

    expect(inertInSource('components/booking/tokens.ts', defective)).toEqual([
      'components/booking/tokens.ts#micro()',
    ]);
  });

  /**
   * AND THE HELPER THEN BECOMES A BASE ITSELF, which is the shape that made the
   * fix two-sided: `micro(lang)` pins a face exactly as `text()` does, so a
   * `styles.X` composed after it is an inert override too. `faceBases()` derives
   * that from the source rather than being told, so the next wrapper is covered
   * the day it is written — a hard-coded list of three roots is what hid this
   * one.
   */
  it('a composition headed by a derived helper, not by text() itself', () => {
    const defective = [
      'export function micro(lang: Language): TextStyle {',
      "  return { ...text('bodyS', lang, '600'), fontSize: 10.5 };",
      '}',
      '        <Text style={[micro(lang), live ? styles.badgeLive : styles.badgeSalon]}>',
      '          {badge}',
      '        </Text>',
      '        <Text style={[micro(lang), styles.dayDow]}>{dow}</Text>',
      'const styles = StyleSheet.create({',
      "  badgeLive: { color: color.brandDeep, fontWeight: '600' },",
      '  badgeSalon: { color: AVAIL_SALON_TEXT },',
      '  dayDow: { color: color.textMuted },',
      '});',
    ].join('\n');

    expect(inertInSource('components/booking/BookingParts.tsx', defective)).toEqual([
      'components/booking/BookingParts.tsx#badgeLive',
    ]);
  });

  /**
   * AND IT DOES NOT READ THE DEFECT OUT OF A DOCBLOCK. This became load-bearing
   * with shape two: `theme/index.ts:117` quotes
   * `StyleSheet.flatten([text('bodyS', 'en'), { fontWeight: '600' }])` to
   * EXPLAIN the trap, and `WalletCard.tsx:181` names a `fontWeight: '500'` that
   * used to live in an object. A detector that read inline literals without
   * stripping prose would report two sites nobody can fix, and a guard that
   * reports the unfixable is a guard that gets an exception added to it.
   */
  it('ignores the same shapes written inside comments', () => {
    const prose = [
      '/**',
      " *     StyleSheet.flatten([text('bodyS', 'en'), { fontWeight: '600' }])",
      " *       // { fontSize: 12.5, fontWeight: '600', fontFamily: 'Inter_400Regular' }",
      ' */',
      "// this comment used to say it lived here: `fontWeight: '500'` in this object",
      "        <Text style={[text('bodyL', lang, '600'), styles.clean]}>{name}</Text>",
      'const styles = StyleSheet.create({',
      '  clean: { color: color.ink },',
      '});',
    ].join('\n');

    expect(inertInSource('components/Fixture.tsx', prose)).toEqual([]);
  });

  /**
   * AND IT DOES NOT FIRE ON A STYLE THAT NAMES ITS OWN FACE. `namesAFace` is the
   * one legitimate way to carry a weight in a style object, and a detector that
   * flagged it would push the next author toward a `fontFamily` literal that
   * cannot know the language — the exact fix the docblock above rules out.
   */
  it('leaves a style that names its own face alone', () => {
    const explicit = [
      "        <Text style={[text('bodyL', lang), styles.branded]}>{name}</Text>",
      'const styles = StyleSheet.create({',
      "  branded: { fontFamily: 'Fraunces_600SemiBold', fontWeight: '600' },",
      '});',
    ].join('\n');

    expect(inertInSource('components/Fixture.tsx', explicit)).toEqual([]);
  });

  /**
   * AND THE WALK REACHES `App.tsx`, which no regex above would have fixed. Two
   * of the eight sites were in this one file, and it had never been opened by
   * this scan — while the language scan at the foot of the file had appended it
   * by hand and was therefore reading a different app. The assertion is on the
   * shared list, so the two cannot drift apart again.
   */
  it('the walk includes App.tsx, which sits beside src/ rather than in it', () => {
    const files = allSources().map(relativeSource);
    expect(files).toContain('App.tsx');
    expect(new Set(files).size).toBe(files.length);
    expect(fs.existsSync(APP_ENTRY)).toBe(true);
  });
});

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SECOND HALF OF THE SAME RULE: A FACE IS ONLY RIGHT IF THE LANGUAGE IS.
 * ─────────────────────────────────────────────────────────────────────────────
 * Everything above asks whether the WEIGHT a style declares reaches a face that
 * can draw it. This asks the question one step earlier: whether the call knew
 * which SCRIPT it was drawing.
 *
 * `text(token, lang = 'en', weight?)` defaults the language, and the default is
 * a real choice with no warning attached. `text('bodyL')` and
 * `text('bodyL', 'en')` are the same call, and both return an Inter face. Point
 * one at Arabic copy and the app asks Inter to draw Arabic.
 *
 * WHAT THAT ACTUALLY DOES, MEASURED 2026-09-17 AND NOT ASSUMED. It is not tofu,
 * which is why it hid. `Inter_600SemiBold.ttf` carries 2849 codepoints and
 * exactly one of them lies in any Arabic range — U+FEFF, a zero-width mark — so
 * it can draw no Arabic letter at all. react-native-web then emits the family as
 * a bare `font-family: Inter_600SemiBold` with no fallback list (read off a
 * rendered `PrimaryButton`'s inline style), and the BROWSER's per-character
 * fallback silently supplies the OS default Arabic face. Driven in Chrome
 * against the real ttf: "العودة للرئيسية" in `Inter_600SemiBold` measured
 * 58.94px, the identical string in a family that does not exist at all measured
 * 58.94px, and in `IBMPlexSansArabic_600SemiBold` — the face App.tsx loads —
 * 54.90px. Identical-to-nonexistent is the signature of a substitution.
 *
 * So the customer gets legible Arabic in the platform's font at a synthesised
 * bold, instead of the design's. That is non-negotiable #12 — "a first-class
 * layout, not a translation pass" — and it is worse than cosmetic twice over:
 * the substitute is the platform's pick, so it varies by device and an Android
 * build without a system Arabic face has nothing to substitute; and `QrOverlay`
 * already met a case where the substituted glyph for أ read as a "1".
 *
 * WHY THE CHECK IS A SOURCE SCAN AND NOT N RENDER ASSERTIONS. The same argument
 * this file already makes for the weight, and `contrast.test.ts` for colour:
 * React Native has no DOM to walk, so a render-time check can only assert one
 * site at a time and would be a restatement of one rule once per screen. The
 * rule is "no site that draws copy calls `text()` without a runtime language",
 * and the honest way to check a rule of that shape is to read every call.
 *
 * WHAT COUNTS AS A VIOLATION. Both shapes that pin the script at authoring time:
 * a call with no language argument at all, and a call whose language argument is
 * a string LITERAL. `text('bodyS', next, '600')` is fine — `next` is a runtime
 * value, and `LanguageToggle` deliberately sets its label in the OTHER language.
 * `text('body', localised.translated ? lang : 'en')` is fine for the same
 * reason: the expression decides at runtime, and `PolicySheet` has a published
 * clause that may not be translated.
 *
 * THE ALLOW-LIST IS THE POINT. Some sites genuinely must pin the script, because
 * their content is Latin in BOTH languages and passing `lang` would break them
 * rather than fix them — a money figure set in IBM Plex Sans Arabic is a
 * regression, not a translation. Those are named below with the reason, and the
 * assertion is a frozen equality in `KNOWN_INERT`'s style: a new language-less
 * call fails, and removing one from the list without removing it from the code
 * fails too. "We checked once" becomes "it stays checked".
 * ═════════════════════════════════════════════════════════════════════════════
 */

/**
 * Calls that pin the script, keyed `path#token[@lit]`.
 *
 * THIS SCAN DOES NOT SHARE THE WEIGHT SCAN'S BLIND SPOT, AND THE REASON IS
 * WORTH STATING RATHER THAN ASSUMED. The work order expected it to, on the
 * grounds that it "presumably walks the same compositions". It does not: it
 * walks CALLS. Every `text(` in the file is parsed wherever it stands, so an
 * inline object literal, a multi-line composition and a call buried inside a
 * helper are all equally visible — `micro()`'s own `text('bodyS', lang)` in
 * `components/booking/tokens.ts` was already being read, and passes because
 * `lang` is a parameter. That is why the language sweep is what FOUND the two
 * sites the weight scan could not see.
 *
 * IT HAD THE ANALOGOUS HOLE ONE LEVEL UP, THOUGH, AND THAT IS WIDENED HERE. A
 * helper that wraps `text()` takes the language as its OWN argument, so
 * `micro('en')` pins the script just as hard as `text('bodyS', 'en')` and there
 * is no `text(` on the line to find. Both of `micro`'s call sites pass `lang`
 * today; the check exists so that stays a fact rather than a coincidence. The
 * helpers are `faceBases()`'s `wrappers` — the spread-derived names ONLY, not
 * every base, for the blast-radius reason that function's docblock gives — so a
 * new wrapper is covered the day it is written.
 *
 * A helper's language is not positional — `micro(lang)` takes it first,
 * `text(token, lang)` second — so the rule for one is the weaker, checkable
 * thing: no argument of a face-helper call may be a bare `'en'` or `'ar'`.
 */
export function languagePinnedInSource(rel: string, src: string, helpers?: Set<string>): string[] {
  // Docblocks in this app quote `text('bodyL')` when explaining the trap, and a
  // scanner that counted prose would be unfixable. Block comments collapse to
  // their newlines so line-based reasoning elsewhere is unaffected.
  const code = stripComments(src);

  const found = new Set<string>();
  const wrappers = [...(helpers ?? faceBases(code).wrappers)];
  const call = new RegExp(`\\b(text${wrappers.map((w) => `|${w}`).join('')})\\s*\\(`, 'g');
  for (let m = call.exec(code); m; m = call.exec(code)) {
    // `export function text(` is the declaration, not a call site.
    if (/\bfunction\s*$/.test(code.slice(0, m.index))) continue;

    let i = m.index + m[0].length;
    let depth = 1;
    while (depth > 0 && i < code.length) {
      const c = code[i]!;
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    const args: string[] = [];
    let cur = '';
    let d = 0;
    for (const c of code.slice(m.index + m[0].length, i - 1)) {
      if ('([{'.includes(c)) d += 1;
      if (')]}'.includes(c)) d -= 1;
      if (c === ',' && d === 0) {
        args.push(cur.trim());
        cur = '';
      } else cur += c;
    }
    args.push(cur.trim());

    // A wrapper takes the language wherever its own signature puts it, so it is
    // checked across every argument and keyed by the helper rather than by a
    // type token it does not have.
    if (m[1] !== 'text') {
      const pinned = args.map((a) => /^'(en|ar)'$/.exec(a)?.[1]).find(Boolean);
      if (pinned) found.add(`${rel}#${m[1]}()@${pinned}`);
      continue;
    }

    // A token held in an expression — `text(emphasis ? 'bodyL' : 'bodyS', lang)`
    // — still has to be checked, so it is keyed by its source text rather than
    // skipped. Skipping it would be a hole exactly where a reader is least
    // likely to look for one.
    const literalToken = /^'([A-Za-z0-9]+)'$/.exec(args[0] ?? '')?.[1];
    const token = literalToken ?? (args[0] ?? '').replace(/\s+/g, ' ');
    const lang = args[1] ?? '';
    if (lang === '') found.add(`${rel}#${token}`);
    else {
      const literal = /^'(en|ar)'$/.exec(lang)?.[1];
      if (literal) found.add(`${rel}#${token}@${literal}`);
    }
  }
  return [...found];
}

/** The same file list the weight scan uses. It used to be a second, hand-kept one. */
function languagePinnedSites(): Set<string> {
  const files = allSources().map(
    (file) => [relativeSource(file), stripComments(fs.readFileSync(file, 'utf8'))] as const,
  );
  const helpers = new Set<string>();
  for (const [, code] of files) for (const b of faceBases(code).wrappers) helpers.add(b);
  const found = new Set<string>();
  for (const [rel, code] of files) {
    for (const key of languagePinnedInSource(rel, code, helpers)) found.add(key);
  }
  return found;
}

/**
 * EVERY SITE THAT MAY PIN THE SCRIPT, AND WHY IT MAY.
 *
 * The test is the keys; the values are what makes the keys reviewable. The bar
 * for an entry is not "this looked deliberate" — it is "passing `lang` here
 * would make the app worse", which for all six below is the same fact: the
 * string is Latin in Arabic too, and the design sets it in Fraunces in both.
 *
 * Adding a line to this list is the moment to check that claim, because after
 * that nothing else will.
 */
const LANGUAGE_PINNED: Record<string, string> = {
  'components/Money.tsx#money':
    "SignedAmount's activity figure. `text('money')` supplies Fraunces and the " +
    "weight; `text('money', 'ar')` would return IBM Plex Sans Arabic and set an " +
    'activity amount in the body face. Money is Western digits in the display ' +
    'face in both languages — non-negotiable #12.',
  'components/Money.tsx#bodyL':
    'The same figure, and only `fontSize` is destructured from it. The design ' +
    'pairs the display face with body size and no single token names that ' +
    'pairing; the language cannot reach the rendered style from here at all.',
  'components/WalletCard.tsx#displayXL':
    'The balance figure handed to `Money` as `figureStyle`, which layers ' +
    '`moneyFigureFace()` over it. Same rule as above: this call is the SIZE, and ' +
    'the unit beside it — the half that changes script — does take `lang`.',
  'components/PaymentCode.tsx#displayS':
    'The member id, "AVO-1204". A Latin identifier in both languages, wrapped in ' +
    'LRI/PDI so bidi cannot reorder it, and set in Fraunces exactly as the panel ' +
    'around it is.',
  'components/QrOverlay.tsx#displayM':
    'The same member id on the enlarged panel, under the same rule. Note that ' +
    "this file's OTHER initial — the salon's — is NOT here: it comes off the " +
    'localised name, it was language-less once, and it drew a substituted glyph ' +
    'that read as "1". It takes `lang`.',
  'components/booking/BookingParts.tsx#displayS@en':
    "The artist avatar initial. `artistInitial` is handed `artist.name`, the " +
    'Latin name — never `artistName(artist, lang)` and never `nameAr` — so the ' +
    'character is Latin in both languages. This is the one entry whose ' +
    'justification lives in a fact the scanner cannot see, which is why the call ' +
    'site carries the same note.',
};

describe('no site that draws copy pins the script at authoring time', () => {
  it('is exactly the allow-list — nothing added, nothing quietly removed', () => {
    expect([...languagePinnedSites()].sort()).toEqual(Object.keys(LANGUAGE_PINNED).sort());
  });

  it('every entry carries a reason, not just a name', () => {
    for (const [site, why] of Object.entries(LANGUAGE_PINNED)) {
      expect(why.length, site).toBeGreaterThan(40);
    }
  });

  /**
   * THE GUARD ON THE GUARD, for the reason the inert-override suite states: an
   * equality against a fixed list passes just as well when the scanner has
   * stopped scanning. So it is pointed at a source carrying one of each shape
   * this rule cares about, and required to separate them.
   */
  it('the scanner still sees both shapes — and leaves runtime languages alone', () => {
    const fixture = [
      "        <Text style={[text('bodyL'), styles.a]}>{copy.a}</Text>",
      "        <Text style={[text('bodyS', 'en', '600'), styles.b]}>{copy.b}</Text>",
      "        <Text style={[text('body', lang), styles.c]}>{copy.c}</Text>",
      "        <Text style={[text('bodyS', next, '600'), styles.d]}>{copy.d}</Text>",
      "        <Text style={[text('label', x ? lang : 'en'), styles.e]}>{copy.e}</Text>",
      // A computed token with no language is still a violation, and is keyed by
      // its source rather than dropped for having nothing static to name.
      "        <Text style={[text(big ? 'bodyL' : 'bodyS'), styles.f]}>{copy.f}</Text>",
    ].join('\n');

    expect(languagePinnedInSource('components/Fixture.tsx', fixture).sort()).toEqual([
      "components/Fixture.tsx#big ? 'bodyL' : 'bodyS'",
      'components/Fixture.tsx#bodyL',
      "components/Fixture.tsx#bodyS@en",
    ]);
  });

  /**
   * AND THE SHAPES THE WEIGHT SCAN WAS BLIND TO ARE NOT BLIND SPOTS HERE — which
   * is a claim the docblock on `languagePinnedInSource` makes and this is what
   * backs it. The work order expected this scanner to share the weight
   * scanner's hole on the reasonable ground that it "presumably walks the same
   * compositions". It walks CALLS, so an inline object literal, a composition
   * written down the page, and a call buried inside a helper are all read
   * exactly where they stand. That is not a lucky property: it is why the
   * language sweep is what FOUND `micro()` and the tab-bar label in the first
   * place, and it needs a fixture so it stays true through the next refactor.
   */
  it('reads a language-less call in every shape the weight scan could not see', () => {
    const fixture = [
      "      <Text style={[text('bodyS'), { color: tint, fontWeight: '600' }]}>{label}</Text>",
      '        <Text',
      '          style={[',
      "            text('bodyL'),",
      '            styles.slot,',
      '          ]}',
      '        >',
      '          {label}',
      '        </Text>',
      'export function micro(lang: Language): TextStyle {',
      "  return { ...text('label'), fontSize: 10.5 };",
      '}',
    ].join('\n');

    expect(languagePinnedInSource('components/Fixture.tsx', fixture).sort()).toEqual([
      'components/Fixture.tsx#bodyL',
      'components/Fixture.tsx#bodyS',
      'components/Fixture.tsx#label',
    ]);
  });

  /**
   * THE HOLE IT DID HAVE WAS ONE LEVEL UP, AND THIS IS THE WIDENING. A helper
   * that wraps `text()` takes the language as its OWN argument, so `micro('en')`
   * pins the script exactly as hard as `text('bodyS', 'en')` and there is no
   * `text(` on the line to find. Both of `micro`'s real call sites pass `lang`,
   * so this found nothing in the column — the fixture is what makes that a
   * checked fact rather than a coincidence of there being one helper today.
   *
   * The helpers come from the same `faceBases()` derivation the weight scan
   * uses — its `wrappers` half — so a new wrapper is covered the day it is
   * written rather than the day someone remembers to add it here.
   */
  it('a face helper called with a hard-coded language is a pin too', () => {
    const fixture = [
      'export function micro(lang: Language): TextStyle {',
      "  return { ...text('bodyS', lang, '600'), fontSize: 10.5 };",
      '}',
      "        <Text style={[micro('en'), styles.a]}>{copy.a}</Text>",
      "        <Text style={[micro(lang), styles.b]}>{copy.b}</Text>",
      "        <Text style={[micro(x ? lang : 'en'), styles.c]}>{copy.c}</Text>",
    ].join('\n');

    expect(languagePinnedInSource('components/booking/Fixture.tsx', fixture)).toEqual([
      'components/booking/Fixture.tsx#micro()@en',
    ]);
  });

  /**
   * AND IT DOES NOT READ PROSE. Three files in this app explain the trap by
   * quoting the defective call, `Buttons.tsx` at length. A scanner that counted
   * those would report sites nobody can fix and the list would have to be
   * padded with comments — which is how a guard becomes noise and then becomes
   * ignored.
   */
  it('ignores the same call written inside a comment', () => {
    const prose = [
      '/**',
      " * These two calls were `text('bodyL')`, which means they were ALREADY",
      ' * resolving English.',
      ' */',
      "// and `text('displayM')` here too",
      "        <Text style={[text('bodyL', lang), styles.a]}>{copy.a}</Text>",
    ].join('\n');

    expect(languagePinnedInSource('components/Fixture.tsx', prose)).toEqual([]);
  });

  /**
   * THE BUTTONS ARE NAMED, because they are what this suite was written for and
   * because the allow-list above can only ever say what is ABSENT from it. A
   * reader asking "did the button fix survive?" should not have to reason from
   * an equality to an empty intersection.
   */
  it('the shared buttons take the reading language from the provider', () => {
    const src = fs.readFileSync(path.join(SRC, 'components/Buttons.tsx'), 'utf8');
    expect(src).toContain("const { lang } = useLanguage();");
    expect(src).toContain("text('bodyL', lang, '600')");
    expect(languagePinnedInSource('components/Buttons.tsx', src)).toEqual([]);
  });
});
