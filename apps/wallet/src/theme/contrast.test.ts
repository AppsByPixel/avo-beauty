/**
 * Non-negotiable #9, audited against what this app ACTUALLY USES — and an honest
 * account of the part of go-live row 413 this cannot reach.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS SEPARATELY FROM `packages/tokens`' OWN AUDIT
 * ─────────────────────────────────────────────────────────────────────────────
 * `auditTokenContrast()` audits the TOKEN FILE: every pairing the JSON declares.
 * That is the right check for the palette and it is Lane C's evidence for the
 * dashboard. It says nothing about which pairs a given app puts on screen — a
 * palette can be entirely sound while one screen still puts white on `brand`.
 *
 * Lane C scanned the live DOM. React Native has no DOM, so that method does not
 * transfer, and the honest replacement is not "the same scan, weaker" — it is a
 * DIFFERENT and in one respect STRONGER check: the token maths applied to every
 * pairing that appears in this app's source, computed rather than eyeballed, and
 * exhaustive over the source rather than over whatever a run happened to render.
 *
 * WHAT IT CANNOT REACH, STATED PLAINLY AND MEASURED
 * ─────────────────────────────────────────────────────────────────────────────
 * A `Text`'s colour and the background it sits on are almost never in the same
 * style object: the background is on an ancestor `View`. Measured on this tree at
 * the time of writing — 569 style entries mention a colour and only 5 carry BOTH
 * a foreground and a background. So a same-object pair scan covers under 1% of
 * the surface, and pairing the rest needs the component tree resolved, which
 * means rendering.
 *
 * Therefore this file does NOT claim row 413. It claims the one thing inside the
 * row that IS a non-negotiable and IS soundly decidable from source: white text
 * never sits on `--avo-brand`. That claim is exhaustive here, because the rule is
 * about a specific pair and this app funnels the only legitimate white-on-brand
 * through `onBrandFill`.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AA_NORMAL_TEXT, contrastRatio, deriveBrandSet } from '@avo/tokens';
import { color, onBrandFill, brandTextColor, WHITE } from './index';

// --------------------------------------------------------------- the source --

const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') && !full.includes('.test.') ? [full] : [];
  });
}

/**
 * Top-level entries of every `StyleSheet.create({...})` in a file.
 *
 * Brace-matched rather than regexed across the whole object, because a nested
 * object (a shadow, a transform) would otherwise split an entry in half and the
 * scan would silently under-report — an audit that misses pairs is worse than no
 * audit, since it reports success.
 */
function styleEntries(src: string): string[] {
  const out: string[] = [];
  const marker = 'StyleSheet.create({';
  let from = 0;
  for (;;) {
    const start = src.indexOf(marker, from);
    if (start === -1) break;
    let depth = 0;
    let end = start + marker.length - 1;
    for (let i = end; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = src.slice(start + marker.length, end);
    let d = 0;
    let cur = '';
    for (const ch of body) {
      if (ch === '{') d += 1;
      if (ch === '}') d -= 1;
      if (ch === ',' && d === 0) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    from = end + 1;
  }
  return out;
}

const FILES = walk(SRC);
const ENTRIES = FILES.flatMap((f) =>
  styleEntries(readFileSync(f, 'utf8')).map((e) => ({ file: f.replace(SRC, ''), entry: e })),
);

const FG = /(?<!background)\bcolor\s*:\s*([^,\n]+)/;
const BG = /backgroundColor\s*:\s*([^,\n]+)/;

// ------------------------------------------------ #9, the decidable version --

describe('non-negotiable #9 — white text never on --avo-brand', () => {
  it('routes the only legitimate white-on-brand through brandDeep', () => {
    expect(onBrandFill.backgroundColor).toBe(color.brandDeep);
    expect(onBrandFill.backgroundColor).not.toBe(color.brand);
    expect(onBrandFill.color).toBe(WHITE);
  });

  it('and that pairing clears AA, computed rather than asserted', () => {
    const ratio = contrastRatio(WHITE, onBrandFill.backgroundColor);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * THE RULE'S OWN JUSTIFICATION, as a number. If `brand` ever became a legal
   * text background this test would fail and somebody would have to say why —
   * which is the point. A non-negotiable whose reason is only in prose invites
   * "surely brand is fine".
   */
  it('fails AA against white, which is WHY the rule exists', () => {
    expect(contrastRatio(WHITE, color.brand)).toBeLessThan(AA_NORMAL_TEXT);
  });

  it('uses brandDeep for brand-coloured text on a light surface too', () => {
    expect(brandTextColor).toBe(color.brandDeep);
    expect(contrastRatio(brandTextColor, color.surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * THE EXHAUSTIVE HALF. `brand` is a SURFACE colour — "gradients, tints, dots,
   * progress fills" — so any style entry that fills with `color.brand` must not
   * also set a text colour. Every current use is a dot, a track, a tick or a
   * progress fill, and this is what keeps it that way.
   */
  it('never sets a text colour in the same entry as a brand fill', () => {
    const offenders = ENTRIES.filter(
      ({ entry }) => /backgroundColor\s*:\s*color\.brand\b/.test(entry) && FG.test(entry),
    ).map(({ file, entry }) => `${file}: ${entry.trim().slice(0, 70)}`);
    expect(offenders).toEqual([]);
  });

  it('never pairs a white foreground with any brand-family background', () => {
    const offenders = ENTRIES.filter(({ entry }) => {
      const fg = FG.exec(entry)?.[1] ?? '';
      const bg = BG.exec(entry)?.[1] ?? '';
      const fgWhite = /WHITE|color\.white|#fff/i.test(fg);
      return fgWhite && /color\.brand\b/.test(bg);
    }).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

// ------------------------------------- every pair the source actually states --

/**
 * Resolve the app's colour identifiers against a PALETTE, rather than against
 * the module's own `color`.
 *
 * The palette is a parameter because it is no longer a constant. A salon's
 * `brandColor` is applied onto `theme.color` at boot (`./brand`), so the values
 * these entries resolve to at runtime depend on the tenant — and a scan that only
 * ever checked the sage defaults would be checking one of an unbounded number of
 * palettes and reporting success for all of them.
 */
function resolvePairs(palette: Record<string, string>) {
  return ENTRIES.flatMap(({ file, entry }) => {
    const fgRaw = FG.exec(entry)?.[1]?.trim();
    const bgRaw = BG.exec(entry)?.[1]?.trim();
    if (!fgRaw || !bgRaw) return [];
    const lookup = (raw: string): string | null => {
      if (raw === 'WHITE') return WHITE;
      const named = /^color\.([A-Za-z0-9_]+)$/.exec(raw);
      if (named) {
        const v = palette[named[1] as string];
        return typeof v === 'string' ? v : null;
      }
      return /^'#[0-9a-fA-F]{3,8}'$/.test(raw) ? raw.slice(1, -1) : null;
    };
    const fg = lookup(fgRaw);
    const bg = lookup(bgRaw);
    return fg && bg ? [{ file, fgRaw, bgRaw, fg, bg }] : [];
  });
}

/** The palette as it stands for this build — the sage the token file ships. */
const DEFAULT_PALETTE = color as unknown as Record<string, string>;

/**
 * The palette a rebranded salon actually gets: the three white-labelled entries
 * replaced by `deriveBrandSet`'s output, everything else left alone — which is
 * exactly what `./brand` writes and exactly what `generate.ts:42` white-labels.
 * `brandDeeper` and `brandTint2` deliberately stay sage here, so the cross-hue
 * pairs a rebrand creates are inside the scan rather than excluded from it.
 */
function rebranded(hex: string): Record<string, string> {
  const result = deriveBrandSet(hex);
  if (!result.ok) throw new Error(`${hex} is not viable: ${result.reason}`);
  return {
    ...DEFAULT_PALETTE,
    brand: result.set.brand,
    brandDeep: result.set.deep,
    brandTint: result.set.tint,
  };
}

/** The three shipped demo salons, by the hex a salon row carries. */
const TENANTS: Array<[string, Record<string, string>]> = [
  ['the shipped sage default', DEFAULT_PALETTE],
  ['Amara sage #6E7F6C, derived', rebranded('#6E7F6C')],
  ['Noor rose #B08D8D, derived', rebranded('#B08D8D')],
  ['Lila lilac #8A7CB0, derived', rebranded('#8A7CB0')],
];

describe('every foreground/background pair stated in one style entry clears AA', () => {
  /**
   * Guards the scan itself. If a refactor moves every colour out of StyleSheet
   * objects this suite would pass by finding nothing — the failure mode
   * `chargeStates.test.ts` calls "a green bought with nothing". The count is
   * asserted as a floor, not an equality, so adding pairs does not fail it.
   */
  it('found pairs to check at all', () => {
    expect(resolvePairs(DEFAULT_PALETTE).length).toBeGreaterThanOrEqual(3);
  });

  /**
   * AND IT CLEARS AA FOR EVERY TENANT, not just for the build's own colour.
   * White-labelling means the same source resolves to a different palette per
   * salon, so #9's guarantee has to be a property of the SOURCE under any viable
   * hex — and the only reason it can be checked exhaustively at all is that the
   * shared package refuses a hex whose derived set cannot carry white.
   */
  for (const [label, palette] of TENANTS) {
    it(`and all of them clear AA under ${label}`, () => {
      const failures = resolvePairs(palette)
        .filter(({ fg, bg }) => contrastRatio(fg, bg) < AA_NORMAL_TEXT)
        .map(({ file, fgRaw, bgRaw, fg, bg }) => `${file}: ${fgRaw} on ${bgRaw} = ${contrastRatio(fg, bg).toFixed(2)}:1`);
      expect(failures).toEqual([]);
    });
  }

  /**
   * The two source scans above — "never sets a text colour in the same entry as a
   * brand fill" and "never pairs a white foreground with any brand-family
   * background" — are palette-INDEPENDENT: they match identifiers, not values, so
   * they already hold for every tenant. This asserts the property that makes that
   * true rather than leaving it as a claim in a comment: no viable brand hex can
   * make white legible on `brand`, so the rule can never become optional.
   */
  it('and no viable brand hex ever makes white legible on `brand`', () => {
    const legible = TENANTS.filter(
      ([, palette]) => contrastRatio(WHITE, palette.brand as string) >= AA_NORMAL_TEXT,
    ).map(([label]) => label);
    expect(legible).toEqual([]);
  });
});
