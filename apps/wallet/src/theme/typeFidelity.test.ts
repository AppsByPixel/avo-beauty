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

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
    return [p];
  });
}

/** `styleName -> { weight, namesAFace }` for every `StyleSheet` entry in a file. */
function weightStyles(src: string): Map<string, { weight: string; namesAFace: boolean }> {
  const out = new Map<string, { weight: string; namesAFace: boolean }>();
  for (const line of src.split('\n')) {
    const m = /(\w+): *\{([^}]*fontWeight: *'(\d+)'[^}]*)\}/.exec(line);
    if (m) out.set(m[1]!, { weight: m[3]!, namesAFace: m[2]!.includes('fontFamily') });
  }
  return out;
}

/**
 * Every `styles.X` composed after a `text()` / `display()` / `ui()` base, where
 * `X` raises `fontWeight` without naming a face. Keyed `path#styleName`, so a
 * style used from three call sites counts once — the defect is in the style.
 *
 * SPLIT FROM THE FILE WALK so the detector can be pointed at a string. With the
 * recorded list now empty the suite's main assertion is "this returns nothing",
 * and an assertion of that shape passes just as well when the detector has been
 * broken as when the code is clean. `the detector can still see one` below feeds
 * it a source that IS defective and requires it to say so.
 */
function inertInSource(rel: string, src: string): string[] {
  const styles = weightStyles(src);
  if (styles.size === 0) return [];
  const found = new Set<string>();
  for (const line of src.split('\n')) {
    for (const comp of line.matchAll(/\[\s*(?:text|display|ui)\([^)]*\)\s*,([^\]]*)\]/g)) {
      for (const ref of comp[1]!.matchAll(/styles\.(\w+)/g)) {
        const s = styles.get(ref[1]!);
        if (s && !s.namesAFace) found.add(`${rel}#${ref[1]}`);
      }
    }
  }
  return [...found];
}

function inertOverrides(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const key of inertInSource(path.relative(SRC, file), src)) found.add(key);
  }
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
 * THE EMPTY LIST STAYS, AND THE ASSERTION STAYS AN EQUALITY. It is what stops
 * the next one: a new `fontWeight` in a style object composed after `text()` is
 * a new inert override, and this goes red the day it is written. A ceiling would
 * not — and a debt list deleted the moment it reaches zero is a debt list that
 * has to be rediscovered by driving the app, which is how this one was found.
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
   * TWO SITES THE DETECTOR ABOVE CANNOT SEE, FOUND 2026-09-17 AND REPORTED HERE
 * RATHER THAN FIXED. `inertInSource` only follows a `styles.X` REFERENCE into a
 * `StyleSheet.create` entry, which was the shape all 83 had. It is blind to the
 * same defect written any other way, and the language sweep at the foot of this
 * file turned up two:
 *
 *   components/booking/tokens.ts § micro()
 *       `{ ...text('bodyS', lang), fontSize: 10.5, fontWeight: '600' }` — a
 *       helper, not a StyleSheet entry. The family stays `*_400Regular` in both
 *       languages while the weight says 600.
 *   App.tsx:847 (the tab-bar label)
 *       `[text('bodyS', lang), { color: tint, fontWeight: '600', fontSize: 10.5 }]`
 *       — an inline object literal, so there is no `styles.X` to follow.
 *
 * Both are the inert-override defect exactly, both are one argument to fix
 * (`text('bodyS', lang, '600')`), and both change what is drawn — so they belong
 * in a slice that says so, together with widening the detector to cover the two
 * shapes. Left named here so the next reader finds them rather than the app.
 *
 * THE GUARD ON THE GUARD, AND IT REPLACES A TEST THAT HAD BECOME A TAUTOLOGY.
   *
   * `it('records the two this slice removed')` named `OrdersSheet#chipRetryText`
   * and `FulfilmentSection#chipRetryText` and asserted the scan did not contain
   * them. That was real evidence while the recorded set had 83 entries — it said
   * "these two specifically are gone". With the set empty the assertion above
   * already says no style anywhere is in it, so naming two of them proves
   * nothing the line before it did not.
   *
   * What is worth asserting instead is the thing an empty expectation cannot
   * say for itself: that the detector still WORKS. `toEqual([])` passes if the
   * regexes stop matching, if `sourceFiles` returns nothing, if a refactor
   * quietly inverts a condition — and it would go on passing while inert
   * overrides piled back up. So the detector is pointed at a source that is
   * defective on purpose, written in the exact shape the 83 had, and required to
   * find it and to leave its two innocent neighbours alone.
   */
  it('the detector can still see one — the empty set above is a result, not a silence', () => {
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

/** `text(` calls whose language is absent or hard-coded, keyed `path#token[@lit]`. */
export function languagePinnedInSource(rel: string, src: string): string[] {
  // Docblocks in this app quote `text('bodyL')` when explaining the trap, and a
  // scanner that counted prose would be unfixable. Block comments collapse to
  // their newlines so line-based reasoning elsewhere is unaffected.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
    .replace(/^[ \t]*\/\/.*$/gm, '');

  const found = new Set<string>();
  const call = /\btext\s*\(/g;
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

function languagePinnedSites(): Set<string> {
  const found = new Set<string>();
  const files = [...sourceFiles(SRC), path.join(SRC, '..', 'App.tsx')];
  for (const file of files) {
    const rel = path.relative(SRC, file).replace(/^\.\.\//, '');
    for (const key of languagePinnedInSource(rel, fs.readFileSync(file, 'utf8'))) found.add(key);
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
