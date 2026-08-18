/**
 * A CONTRAST AUDIT THAT NEEDS NO BROWSER.
 *
 * Six AA failures shipped in this product and every one of them was found the
 * same way: a human driving the built app, scanning the live DOM by hand, in one
 * session. That is not a repeatable check — it is a lucky one. A class of defect
 * that needs a browser session to find is a class nobody finds twice, so this
 * module moves the check to where the values are declared.
 *
 * WHAT IT AUDITS. Text-on-background pairs that `avo-tokens.json` itself
 * declares, discovered structurally rather than listed by hand:
 *
 *   1. SIBLING PAIRS — any object holding both `<x>Text` and `<x>Bg`, or a bare
 *      `text` and `bg`. That is `color.warnText`/`warnBg`, every
 *      `tier.*.pillText`/`pillBg`, every `plan.*.text`/`bg`, and
 *      `audit.rulesText`/`rulesBg` + `accessText`/`accessBg`. Discovery is the
 *      point: a NEW pill group added to the JSON is audited the day it lands,
 *      with nobody remembering to add it here.
 *
 *   2. DECLARED CROSS-GROUP PAIRS — pairings a component makes that the JSON
 *      does not put in one object. `deep` on `tint` per brand preset is the one
 *      that shipped broken: `.avo-label`, `.avo-pill` and the branch-id chips
 *      all render brand-deep text on a brand-tint background, and no structural
 *      rule could infer that from two sibling keys, because they are siblings
 *      only by accident of both living under a preset.
 *
 * TRANSLUCENT TEXT IS COMPOSITED, NOT SKIPPED. `plan.starter.text` is
 * `rgba(28,27,25,0.6)`, and a checker that skipped what it could not parse would
 * report "pass" for the one value §2 spends a paragraph on — it raised muted
 * labels from 0.45 to 0.6 precisely because 0.45 measured ~3.3:1 and failed. A
 * silent skip is how that regresses. So alpha is composited over the background
 * and the result is measured like any other colour. Anything genuinely
 * unparseable is REPORTED as `skipped`, never counted as a pass.
 *
 * WHAT IT DOES NOT COVER, stated plainly so nobody reads a green run as more
 * than it is:
 *
 *   - A component that pairs two tokens the JSON does not associate and that is
 *     not in `CROSS_GROUP_PAIRS` below. Adding a pairing to a stylesheet is
 *     still a decision a human has to declare here.
 *   - Colours hardcoded in a component instead of taken from a token. Those are
 *     invisible to this and only a DOM scan finds them.
 *   - The runtime white-label derivation. `deriveBrandSet` validates its own two
 *     pairings — see derive.ts and derive.test.ts — which is the equivalent
 *     check for salons whose colours do not exist until they onboard.
 *   - `color.textMuted*`, which the JSON declares with NO background, because
 *     these sit on whatever surface a component puts them on. That is a real
 *     limit and it hides a real finding: §2 states `rgba(28,27,25,0.6)` measures
 *     "~5.2:1" and mandates it for 51 uppercase micro-labels, but composited on
 *     the app surface `#FBFAF8` it measures **4.48:1** — marginally UNDER the
 *     4.5 floor it was chosen to clear, and lower still on any darker surface.
 *     Escalated rather than changed: the token is used 154 times across four
 *     surfaces per the JSON's own note, so moving it is a trunk decision. The
 *     one place the JSON *did* declare that pairing — `plan.starter` on
 *     `#F0EEE9`, where 0.6 measured 4.32:1 — was caught by this audit on its
 *     first run and now uses the 0.7 step of the same scale.
 *
 * So this is the floor, not the ceiling. It makes the six known failures
 * impossible to reintroduce and makes a seventh of the same shape fail a test
 * run instead of waiting for someone to look.
 */

import { contrastRatio, rgbToHex, type Rgb } from './contrast.js';

/** WCAG AA for normal text. Every pair here is 11–12.5px pill, label or chip text. */
export const AA_NORMAL_TEXT = 4.5;

/**
 * Pairings a component makes that the token file does not express as siblings.
 *
 * Each entry names the components that render it, because the next person's
 * first question is "is this really used?" and the answer has to survive without
 * this comment.
 */
export const CROSS_GROUP_PAIRS: ReadonlyArray<{
  readonly label: string;
  readonly textPath: string;
  readonly bgPath: string;
  readonly renderedBy: string;
}> = [
  {
    label: 'brand deep on brand tint (amaraSage)',
    textPath: 'brandPresets.amaraSage.deep',
    bgPath: 'brandPresets.amaraSage.tint',
    renderedBy: '.avo-label, .avo-pill, .settings__branch-id',
  },
  {
    label: 'brand deep on brand tint (noorRose)',
    textPath: 'brandPresets.noorRose.deep',
    bgPath: 'brandPresets.noorRose.tint',
    renderedBy: '.avo-label, .avo-pill, .settings__branch-id',
  },
  {
    label: 'brand deep on brand tint (lilaLilac)',
    textPath: 'brandPresets.lilaLilac.deep',
    bgPath: 'brandPresets.lilaLilac.tint',
    renderedBy: '.avo-label, .avo-pill, .settings__branch-id',
  },
];

export interface ContrastFinding {
  label: string;
  textPath: string;
  bgPath: string;
  text: string;
  background: string;
  /** Composited and measured. `null` when a value could not be parsed. */
  ratio: number | null;
  required: number;
  status: 'pass' | 'fail' | 'skipped';
  /** Why it was skipped. Only set when `status === 'skipped'`. */
  note?: string;
}

/** `#RRGGBB` or `rgb()/rgba()`. Anything else is unparseable on purpose. */
function parseColor(value: unknown): { rgb: Rgb; a: number } | null {
  if (typeof value !== 'string') return null;
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return { rgb: { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }, a: 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    value.trim(),
  );
  if (!fn) return null;
  const a = fn[4] === undefined ? 1 : Number.parseFloat(fn[4]);
  return {
    rgb: { r: Number.parseFloat(fn[1]!), g: Number.parseFloat(fn[2]!), b: Number.parseFloat(fn[3]!) },
    a: Number.isFinite(a) ? a : 1,
  };
}

/** Source-over composite, so translucent text is measured rather than waved through. */
function flatten(text: { rgb: Rgb; a: number }, bg: Rgb): string {
  const mix = (t: number, b: number) => t * text.a + b * (1 - text.a);
  return rgbToHex({ r: mix(text.rgb.r, bg.r), g: mix(text.rgb.g, bg.g), b: mix(text.rgb.b, bg.b) });
}

function at(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[key];
  }, root);
}

function measure(
  label: string,
  textPath: string,
  bgPath: string,
  textValue: unknown,
  bgValue: unknown,
): ContrastFinding {
  const base = { label, textPath, bgPath, required: AA_NORMAL_TEXT } as const;
  const fg = parseColor(textValue);
  const bg = parseColor(bgValue);
  const asString = (v: unknown) => (typeof v === 'string' ? v : String(v));

  if (!fg || !bg) {
    return {
      ...base,
      text: asString(textValue),
      background: asString(bgValue),
      ratio: null,
      status: 'skipped',
      note: !fg ? 'text colour could not be parsed' : 'background colour could not be parsed',
    };
  }
  if (bg.a !== 1) {
    // A translucent BACKGROUND depends on whatever is behind it, which a token
    // file cannot know. Reported rather than guessed.
    return {
      ...base,
      text: asString(textValue),
      background: asString(bgValue),
      ratio: null,
      status: 'skipped',
      note: 'background is translucent; the real backdrop is only known at render time',
    };
  }

  const flat = flatten(fg, bg.rgb);
  const ratio = Math.round(contrastRatio(flat, rgbToHex(bg.rgb)) * 100) / 100;
  return {
    ...base,
    text: asString(textValue),
    background: asString(bgValue),
    ratio,
    status: ratio >= AA_NORMAL_TEXT ? 'pass' : 'fail',
  };
}

/** Structural discovery: `<x>Text` beside `<x>Bg`, and bare `text` beside `bg`. */
function siblingPairs(root: unknown): ContrastFinding[] {
  const found: ContrastFinding[] = [];

  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;

    for (const key of Object.keys(obj)) {
      let prefix: string | null = null;
      if (key === 'text') prefix = '';
      else if (key.endsWith('Text')) prefix = key.slice(0, -'Text'.length);
      if (prefix === null) continue;

      const bgKey = prefix === '' ? 'bg' : `${prefix}Bg`;
      if (!(bgKey in obj)) continue;

      const where = path === '' ? '' : `${path}.`;
      found.push(
        measure(`${path || 'root'}.${key} on ${bgKey}`, `${where}${key}`, `${where}${bgKey}`, obj[key], obj[bgKey]),
      );
    }

    for (const [key, value] of Object.entries(obj)) {
      visit(value, path === '' ? key : `${path}.${key}`);
    }
  };

  visit(root, '');
  return found;
}

/**
 * Every declared text-on-background pair, measured. Deterministic order so a
 * failure list is diffable.
 */
export function auditTokenContrast(tokens: unknown): ContrastFinding[] {
  const cross = CROSS_GROUP_PAIRS.map((p) =>
    measure(p.label, p.textPath, p.bgPath, at(tokens, p.textPath), at(tokens, p.bgPath)),
  );
  return [...siblingPairs(tokens), ...cross].sort((a, b) => a.textPath.localeCompare(b.textPath));
}

/** One line per finding, for a test failure message someone can act on. */
export function formatFindings(findings: ContrastFinding[]): string {
  return findings
    .map(
      (f) =>
        `${f.status.toUpperCase().padEnd(7)} ${f.textPath} (${f.text}) on ${f.bgPath} (${f.background}) = ` +
        `${f.ratio === null ? 'unmeasured' : `${f.ratio.toFixed(2)}:1`}, needs ${f.required}:1` +
        (f.note ? ` — ${f.note}` : ''),
    )
    .join('\n');
}
