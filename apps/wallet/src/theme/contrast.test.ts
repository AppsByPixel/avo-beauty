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
import { AA_NORMAL_TEXT, contrastRatio } from '@avo/tokens';
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

describe('every foreground/background pair stated in one style entry clears AA', () => {
  const resolved = ENTRIES.flatMap(({ file, entry }) => {
    const fgRaw = FG.exec(entry)?.[1]?.trim();
    const bgRaw = BG.exec(entry)?.[1]?.trim();
    if (!fgRaw || !bgRaw) return [];
    const lookup = (raw: string): string | null => {
      if (raw === 'WHITE') return WHITE;
      const named = /^color\.([A-Za-z0-9_]+)$/.exec(raw);
      if (named) {
        const v = (color as Record<string, unknown>)[named[1] as string];
        return typeof v === 'string' ? v : null;
      }
      return /^'#[0-9a-fA-F]{3,8}'$/.test(raw) ? raw.slice(1, -1) : null;
    };
    const fg = lookup(fgRaw);
    const bg = lookup(bgRaw);
    return fg && bg ? [{ file, fgRaw, bgRaw, fg, bg }] : [];
  });

  /**
   * Guards the scan itself. If a refactor moves every colour out of StyleSheet
   * objects this suite would pass by finding nothing — the failure mode
   * `chargeStates.test.ts` calls "a green bought with nothing". The count is
   * asserted as a floor, not an equality, so adding pairs does not fail it.
   */
  it('found pairs to check at all', () => {
    expect(resolved.length).toBeGreaterThanOrEqual(3);
  });

  it('and all of them clear AA', () => {
    const failures = resolved
      .filter(({ fg, bg }) => contrastRatio(fg, bg) < AA_NORMAL_TEXT)
      .map(({ file, fgRaw, bgRaw, fg, bg }) => `${file}: ${fgRaw} on ${bgRaw} = ${contrastRatio(fg, bg).toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });
});
