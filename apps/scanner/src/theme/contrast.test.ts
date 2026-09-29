/**
 * Non-negotiable #9 on the staff surface, plus this app's own extra risk — a dark
 * scan screen — audited against what the app actually uses.
 *
 * The method, and its stated limit, are set out at length in the wallet's
 * `src/theme/contrast.test.ts`. In short: `packages/tokens`' `auditTokenContrast`
 * audits the PALETTE, Lane C scanned the live DOM, and React Native has neither a
 * DOM nor a way to pair a `Text`'s colour with an ancestor `View`'s background
 * from source. So this claims the part of go-live row 413 that IS decidable
 * statically — #9 — and does not claim the row.
 *
 * THIS FILE'S OWN REASON TO EXIST beyond the wallet's: the scanner is the only
 * surface with a dark screen, so it is the only one where white text on a
 * near-black ground is the NORMAL case rather than the violation. That inverts
 * the usual risk — the danger here is a muted alpha over `dark.surface` dropping
 * under AA, not white on brand — and the token file's own audit cannot see the
 * alphas because they are composited locally rather than declared as tokens.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AA_NORMAL_TEXT, contrastRatio } from '@avo/tokens';
import { color, dark, onBrandFill, FOCUS_RING_LIGHT } from './index';

/**
 * Flatten `rgba(255,255,255,a)` over an opaque background.
 *
 * The muted text on the dark screen is an ALPHA, not a colour, so
 * `contrastRatio` cannot be handed it directly — it would need a hex. Compositing
 * it here is what makes the check real rather than skipped: these three alphas are
 * the actual foregrounds on the scan screen and nothing else audits them.
 */
function overSurface(rgba: string, bgHex: string): string {
  const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(rgba);
  if (!m) throw new Error(`not an rgba: ${rgba}`);
  const [fr, fg, fb, fa] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const bg = bgHex.replace('#', '');
  const [br, bgn, bb] = [
    parseInt(bg.slice(0, 2), 16),
    parseInt(bg.slice(2, 4), 16),
    parseInt(bg.slice(4, 6), 16),
  ];
  const mix = (f: number, b: number) => Math.round(f * fa + b * (1 - fa));
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(mix(fr, br))}${hex(mix(fg, bgn))}${hex(mix(fb, bb))}`;
}

describe('non-negotiable #9 on the staff surface', () => {
  it('is structural — one constant, and it is brandDeep', () => {
    expect(onBrandFill).toBe(color.brandDeep);
    expect(onBrandFill).not.toBe(color.brand);
  });

  it('clears AA with white, computed', () => {
    expect(contrastRatio(color.white, onBrandFill)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * WHY WHITE MAY NOT SIT ON `brand`, AS A PROPERTY RATHER THAN AS A FIGURE.
   *
   * This asserted `ratio.toFixed(2) === '4.27'` — the number the theme header
   * cited — on the reasoning that a figure in a comment is the thing this build
   * keeps finding stale. The reasoning was right and the remedy was backwards: it
   * pinned the stale figure into a spec as well, so when trunk revised the brand
   * ramp the spec went red while saying nothing about whether #9 still held. It
   * did hold. Only the number had moved.
   *
   * What #9 actually requires is an ORDERING: `brand` is below the AA floor (so
   * white cannot sit on it), `brandDeep` is above it (so white can), and the fill
   * the app uses is the latter. All three survive the ramp moving; none of them
   * needs a hex or a ratio written down. If a future ramp ever put `brand` above
   * the floor, this goes red and somebody has to say why `brand` may now carry
   * text — which is the question the old spec only appeared to be asking.
   */
  it('keeps white off `brand` because `brand` is below the AA floor', () => {
    expect(contrastRatio(color.white, color.brand)).toBeLessThan(AA_NORMAL_TEXT);
  });

  it('and the fill it uses instead is strictly more legible', () => {
    expect(contrastRatio(color.white, onBrandFill)).toBeGreaterThan(
      contrastRatio(color.white, color.brand),
    );
  });
});

describe('the dark scan screen — where white on near-black is the normal case', () => {
  it('puts its primary text well clear of AA', () => {
    expect(contrastRatio(dark.text, dark.surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * The muted and faint alphas, composited. `textFaint` at 0.4 is the one most
   * likely to have been chosen by eye, and it is the one this asserts hardest.
   */
  it('keeps the muted alpha clear of AA once composited', () => {
    const muted = overSurface(dark.textMuted, dark.surface);
    expect(contrastRatio(muted, dark.surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * EVERY text token in `dark`, not a hand-listed subset — so adding one puts it
   * under the floor automatically. This is what found `textFaint`
   * (`rgba(255,255,255,0.4)`, 3.84:1 composited, zero uses): a token nothing read
   * and that could not legally carry text. It was removed rather than documented,
   * and this assertion is why it cannot come back unnoticed.
   */
  it('has no text token that fails AA once composited', () => {
    const failures = Object.entries(dark)
      .filter(([k]) => k === 'text' || k.startsWith('text'))
      .map(([k, v]) => {
        const hex = v.startsWith('rgba') ? overSurface(v, dark.surface) : v;
        return { k, ratio: contrastRatio(hex, dark.surface) };
      })
      .filter(({ ratio }) => ratio < AA_NORMAL_TEXT)
      .map(({ k, ratio }) => `dark.${k} = ${ratio.toFixed(2)}:1`);
    expect(failures).toEqual([]);
  });

  /**
   * interaction-spec.md §2 specifies a DIFFERENT ring on dark, because the light
   * one does not carry. That is a contrast claim and it is checkable.
   */
  it('uses a focus ring on dark that is not the light one, and carries', () => {
    expect(dark.focus).not.toBe(FOCUS_RING_LIGHT);
    expect(contrastRatio(dark.focus, dark.surface)).toBeGreaterThan(
      contrastRatio(FOCUS_RING_LIGHT, dark.surface),
    );
  });
});

describe('the light focus ring', () => {
  /**
   * `brandDeep`, never `brand`. §2 writes the ring as the literal `2px solid
   * #6E7F6C` — the `brand` value of the day, since superseded by the revised ramp
   * — and that generalises to a FAILING ring on a rebranded salon: a focus
   * indicator is a non-text graphic, WCAG 1.4.11 asks 3:1 against the adjacent
   * surface, and `brand` measures 2.86:1 on Noor rose. The generated stylesheet
   * already made this deviation for the web; this is the native half of it. The
   * per-tenant property is asserted in `brand.test.ts`, computed rather than
   * copied.
   */
  it('is brandDeep, not brand', () => {
    expect(FOCUS_RING_LIGHT).toBe(color.brandDeep);
    expect(FOCUS_RING_LIGHT).not.toBe(color.brand);
  });

  it('and clears the 3:1 non-text floor against the surface it sits on', () => {
    expect(contrastRatio(FOCUS_RING_LIGHT, color.surface)).toBeGreaterThanOrEqual(3);
  });
});

// --------------------------------------------------------------- the source --

const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') && !full.includes('.test.') ? [full] : [];
  });
}

const FILES = walk(SRC);

// ------------------------- #9 across style entries: the split-entry pairing --

/**
 * WHITE ON `brand` WHEN THE FILL AND THE TEXT LIVE IN DIFFERENT STYLE ENTRIES.
 *
 * Ported from the wallet's `src/theme/contrast.test.ts`, where it was written
 * against the wallet's booking tick: the fill on the `View` (`tickOn`), the
 * white on the `Text` inside it (`tickMark`). Each entry was innocent alone and
 * the pair was a #9 violation at ~3.5:1. The wallet header measures why that
 * shape is the norm — a text colour and its background are almost never in the
 * same entry — and the scanner has no same-entry scan at all, so here this is
 * the only source check of #9 beyond the `onBrandFill` constant.
 *
 * So this resolves the JSX, not the style table. It parses every `.tsx` with the
 * TypeScript compiler, maps each `StyleSheet.create` entry to its fill and its
 * text colour, and for every element whose `style` can resolve to a `color.brand`
 * fill — unconditionally or behind a `selected &&` — it walks that element and
 * its JSX descendants for anything painted white: a style entry whose `color` is
 * white, an inline `{ color: WHITE }`, or an icon prop (`color`, `tintColor`,
 * `fill`, `stroke`). A descendant that paints its own non-brand background ends
 * the walk, because what sits inside it sits on that instead.
 *
 * WHAT IT STILL CANNOT SEE: a fill in one component and the white text in a
 * CHILD COMPONENT defined elsewhere (`<Fill><Badge /></Fill>`, where `Badge`
 * sets the white). Resolving that is rendering. Every current brand fill is a
 * leaf or holds its content inline — read by hand for this change, not proved
 * by the scan. The floor test below only proves the scan is finding fills.
 */

const WHITE_RAW = /^(WHITE|color\.white|dark\.text|onBrandFill\.color|'#fff(fff)?'|"#fff(fff)?"|'white'|"white")$/i;
const BRAND_FILL_RAW = /^color\.brand$/;
const ICON_COLOUR_PROPS = new Set(['color', 'tintColor', 'fill', 'stroke']);

type Paint = { bg?: string; fg?: string };

/** `styles.tickOn` → `{ bg: 'color.brand' }`, for every `StyleSheet.create` in the file. */
function styleTable(sf: ts.SourceFile): Map<string, Paint> {
  const table = new Map<string, Paint>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(sf) === 'StyleSheet.create' &&
      node.initializer.arguments[0] &&
      ts.isObjectLiteralExpression(node.initializer.arguments[0])
    ) {
      for (const prop of node.initializer.arguments[0].properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) continue;
        table.set(`${node.name.text}.${prop.name.getText(sf)}`, paintOf(prop.initializer, sf));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return table;
}

function paintOf(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): Paint {
  const paint: Paint = {};
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = p.name.getText(sf);
    if (key === 'backgroundColor') paint.bg = p.initializer.getText(sf).trim();
    if (key === 'color') paint.fg = p.initializer.getText(sf).trim();
  }
  return paint;
}

/** Every paint a `style={...}` expression can resolve to, across arrays, `&&` and ternaries. */
function stylePaints(el: ts.JsxOpeningLikeElement, table: Map<string, Paint>, sf: ts.SourceFile) {
  const found: Array<{ ref: string; paint: Paint }> = [];
  for (const attr of el.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== 'style') continue;
    const walkExpr = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n)) {
        const ref = n.getText(sf);
        const paint = table.get(ref);
        if (paint) found.push({ ref, paint });
      } else if (ts.isObjectLiteralExpression(n)) {
        found.push({ ref: 'inline', paint: paintOf(n, sf) });
        return;
      }
      ts.forEachChild(n, walkExpr);
    };
    if (attr.initializer) walkExpr(attr.initializer);
  }
  return found;
}

function paintsWhite(el: ts.JsxOpeningLikeElement, table: Map<string, Paint>, sf: ts.SourceFile): string | null {
  const viaStyle = stylePaints(el, table, sf).find(({ paint }) => paint.fg && WHITE_RAW.test(paint.fg));
  if (viaStyle) return viaStyle.ref;
  for (const attr of el.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
    const name = attr.name.getText(sf);
    if (!ICON_COLOUR_PROPS.has(name)) continue;
    const raw = ts.isJsxExpression(attr.initializer)
      ? (attr.initializer.expression?.getText(sf).trim() ?? '')
      : attr.initializer.getText(sf).trim();
    if (WHITE_RAW.test(raw)) return `${name}=${raw}`;
  }
  return null;
}

const opening = (n: ts.Node): ts.JsxOpeningLikeElement | null =>
  ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;

/** Every white glyph, icon or text that can sit on a `color.brand` fill, in one file's source. */
function whiteOnBrandFill(source: string, file = 'fixture.tsx') {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const table = styleTable(sf);
  const fills: string[] = [];
  const offenders: string[] = [];
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  const underFill = (n: ts.Node, fillRef: string): void => {
    const el = opening(n);
    if (el) {
      const paints = stylePaints(el, table, sf);
      const ownGround = paints.find(
        ({ paint }) => paint.bg && !BRAND_FILL_RAW.test(paint.bg) && paint.bg !== "'transparent'",
      );
      if (ownGround) return;
      const white = paintsWhite(el, table, sf);
      if (white) offenders.push(`${at(n)} ${white} on ${fillRef}`);
    }
    ts.forEachChild(n, (c) => underFill(c, fillRef));
  };

  const visit = (n: ts.Node): void => {
    const el = opening(n);
    const fill = el && stylePaints(el, table, sf).find(({ paint }) => paint.bg && BRAND_FILL_RAW.test(paint.bg));
    if (el && fill) {
      fills.push(`${at(n)} ${fill.ref}`);
      const self = paintsWhite(el, table, sf);
      if (self) offenders.push(`${at(n)} ${self} on ${fill.ref}`);
      if (ts.isJsxElement(n)) for (const c of n.children) underFill(c, fill.ref);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { fills, offenders };
}

/**
 * The old booking tick, verbatim in shape: fill on the `View`, white on the
 * `Text` inside it, each in its own entry, the fill behind `selected &&`. Kept as
 * a fixture so the scan is proved able to fail on the thing it was written for,
 * rather than trusted to.
 */
const OLD_TICK = `
  const styles = StyleSheet.create({
    tick: { width: 22, borderColor: color.borderControl },
    tickOn: { backgroundColor: color.brand, borderColor: color.brand },
    tickMark: { color: WHITE, fontSize: 12 },
    deep: { backgroundColor: color.brandDeep },
  });
  export const Tick = ({ selected }) => (
    <View style={[styles.tick, selected && styles.tickOn]}>
      {selected ? <Text style={[text('bodyS'), styles.tickMark]}>✓</Text> : null}
    </View>
  );
  export const Icon = () => <View style={styles.tickOn}><Check color={WHITE} /></View>;
  export const Grounded = () => (
    <View style={styles.tickOn}><View style={styles.deep}><Text style={styles.tickMark}>ok</Text></View></View>
  );
`;

describe('non-negotiable #9 across style entries — white never inside a brand fill', () => {
  it('catches the split shape the booking tick had, and a white icon prop', () => {
    const { offenders } = whiteOnBrandFill(OLD_TICK);
    expect(offenders).toEqual([
      'fixture.tsx:10 styles.tickMark on styles.tickOn',
      'fixture.tsx:13 color=WHITE on styles.tickOn',
    ]);
  });

  it('does not flag white that sits on its own non-brand ground inside the fill', () => {
    const { fills, offenders } = whiteOnBrandFill(OLD_TICK);
    expect(fills).toHaveLength(3);
    expect(offenders.some((o) => o.startsWith('fixture.tsx:15'))).toBe(false);
  });

  const SCANNED = FILES.map((f) => whiteOnBrandFill(readFileSync(f, 'utf8'), f.replace(SRC, '')));

  /** A green bought with nothing: if the JSX stops resolving, this goes red first. */
  it('found brand fills in the JSX to check at all', () => {
    expect(SCANNED.flatMap((s) => s.fills).length).toBeGreaterThanOrEqual(6);
  });

  it('puts no white glyph, icon or text on a `color.brand` fill anywhere in the scanner', () => {
    expect(SCANNED.flatMap((s) => s.offenders)).toEqual([]);
  });
});
